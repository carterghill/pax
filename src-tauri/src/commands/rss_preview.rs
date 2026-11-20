mod metadata;

use std::{
    collections::HashMap,
    io,
    net::IpAddr,
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{dns, header, redirect, Client, Url};
use tokio::sync::{Mutex, OnceCell, Semaphore};

use self::metadata::{ArticlePreview, FeedDocument};

const FEED_LIMIT: usize = 4 * 1024 * 1024;
const PAGE_LIMIT: usize = 768 * 1024;
const IMAGE_LIMIT: usize = 1024 * 1024;
const FEED_TTL: Duration = Duration::from_secs(300);
const FEED_CACHE_SIZE: usize = 24;

fn public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !matches!(
                    (a, b, c),
                    (100, 64..=127, _)
                        | (169, 254, _)
                        | (172, 16..=31, _)
                        | (192, 0, 0 | 2)
                        | (192, 88, 99)
                        | (192, 168, _)
                        | (198, 18 | 19, _)
                        | (198, 51, 100)
                        | (203, 0, 113)
                )
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return public_address(mapped.into());
            }
            let [first, second, ..] = ip.segments();
            (0x2000..0x4000).contains(&first)
                && first != 0x2002
                && !(first == 0x2001 && (second < 0x200 || second == 0xdb8))
                && first != 0x3fff
        }
    }
}

fn public_web_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.as_str().len() <= 4096
        && url.host_str().is_some_and(|host| {
            if let Ok(address) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
                return public_address(address);
            }
            let host = host.trim_end_matches('.');
            host.contains('.') && !host.ends_with(".local") && !host.ends_with(".localhost")
        })
}

fn preview_url(raw: &str) -> Option<Url> {
    if raw.len() > 4096 {
        return None;
    }
    let mut url = Url::parse(raw).ok()?;
    url.set_fragment(None);
    public_web_url(&url).then_some(url)
}

fn is_google_news(url: &Url) -> bool {
    url.domain() == Some("news.google.com")
}

struct PublicResolver;

impl dns::Resolve for PublicResolver {
    fn resolve(&self, name: dns::Name) -> dns::Resolving {
        Box::pin(async move {
            let addresses: Vec<_> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|socket| public_address(socket.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(io::Error::other("No public preview address").into());
            }
            Ok(Box::new(addresses.into_iter()) as dns::Addrs)
        })
    }
}

// Preview requests have no Matrix credentials or proxy. The resolver filters the addresses
// used for the actual connection, including requests reached through redirects.
static CLIENT: LazyLock<Result<Client, reqwest::Error>> = LazyLock::new(|| {
    Client::builder()
        .no_proxy()
        .dns_resolver(Arc::new(PublicResolver))
        .timeout(Duration::from_secs(7))
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !public_web_url(attempt.url()) {
                attempt.error("Blocked preview redirect")
            } else {
                attempt.follow()
            }
        }))
        .user_agent("Mozilla/5.0 (compatible; Pax RSS preview)")
        .build()
});
static REQUEST_SLOTS: Semaphore = Semaphore::const_new(6);

enum Resource {
    Feed,
    Page,
    Image,
}

impl Resource {
    fn accept(&self) -> &'static str {
        match self {
            Self::Feed => "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json, */*;q=0.1",
            Self::Page => "text/html, application/xhtml+xml",
            Self::Image => "image/png, image/jpeg, image/webp, image/avif, image/gif, image/x-icon, image/vnd.microsoft.icon",
        }
    }

    fn limit(&self) -> usize {
        match self {
            Self::Feed => FEED_LIMIT,
            Self::Page => PAGE_LIMIT,
            Self::Image => IMAGE_LIMIT,
        }
    }

    fn accepts_type(&self, content_type: &str) -> bool {
        match self {
            Self::Feed => !content_type.starts_with("image/"),
            Self::Page => matches!(content_type, "text/html" | "application/xhtml+xml" | ""),
            Self::Image => matches!(
                content_type,
                "image/png"
                    | "image/jpeg"
                    | "image/webp"
                    | "image/avif"
                    | "image/gif"
                    | "image/x-icon"
                    | "image/vnd.microsoft.icon"
            ),
        }
    }
}

async fn fetch(url: Url, resource: Resource) -> Option<(Url, String, Vec<u8>)> {
    let _slot = REQUEST_SLOTS.acquire().await.ok()?;
    let client = CLIENT.as_ref().ok()?;
    let mut response = client
        .get(url)
        .header(header::ACCEPT, resource.accept())
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let resolved_url = response.url().clone();
    let mime = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase();
    if !resource.accepts_type(&mime) {
        return None;
    }
    let limit = resource.limit();
    let page = matches!(resource, Resource::Page);
    if !page && response.content_length().is_some_and(|n| n > limit as u64) {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        let remaining = limit - body.len();
        if chunk.len() > remaining && !page {
            return None;
        }
        body.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
        // Large pages still have usable metadata near the start. Reading a bounded
        // prefix also leaves room for byline photos published below the article.
        if page && body.len() == limit {
            break;
        }
    }
    Some((resolved_url, mime, body))
}

type FeedCell = Arc<OnceCell<Option<FeedDocument>>>;
type FeedCache = HashMap<Url, (Instant, FeedCell)>;
static FEEDS: LazyLock<Mutex<FeedCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

async fn fetch_feed(url: Url) -> FeedCell {
    let cell = {
        let mut feeds = FEEDS.lock().await;
        feeds.retain(|_, (started, _)| started.elapsed() < FEED_TTL);
        if let Some((_, cached)) = feeds.get(&url) {
            cached.clone()
        } else {
            if feeds.len() >= FEED_CACHE_SIZE {
                if let Some(oldest) = feeds
                    .iter()
                    .min_by_key(|(_, (started, _))| *started)
                    .map(|(url, _)| url.clone())
                {
                    feeds.remove(&oldest);
                }
            }
            let cell = Arc::new(OnceCell::new());
            feeds.insert(url.clone(), (Instant::now(), cell.clone()));
            cell
        }
    };
    cell.get_or_init(|| async {
        let (base, _, body) = fetch(url, Resource::Feed).await?;
        metadata::parse_feed(&String::from_utf8_lossy(&body), &base)
    })
    .await;
    cell
}

#[tauri::command]
pub async fn get_rss_article_preview(
    feed_url: Option<String>,
    article_url: String,
) -> Option<ArticlePreview> {
    let article = preview_url(&article_url)?;
    let google_news_link = is_google_news(&article);
    let feed = if let Some(url) = feed_url.as_deref().and_then(preview_url) {
        Some(fetch_feed(url).await)
    } else {
        None
    };
    let feed = feed.as_ref().and_then(|cell| cell.get()?.as_ref());
    let mut preview = feed.and_then(|feed| feed.preview_for(&article));
    let page = fetch(article, Resource::Page).await.filter(|(base, _, _)| {
        // The redirect can stop on a Google interstitial or a publisher homepage.
        !google_news_link
            || (base.path() != "/"
                && !base
                    .domain()
                    .is_some_and(|host| host == "google.com" || host.ends_with(".google.com")))
    });
    if let Some((base, _, body)) = page {
        if preview.is_none() {
            preview = feed.and_then(|feed| feed.preview_for(&base));
        }
        let preview = preview.get_or_insert_with(ArticlePreview::default);
        let feed_author = match preview.authors.as_slice() {
            [author] => Some(author.as_str()),
            _ => None,
        };
        let page = metadata::parse_article(&String::from_utf8_lossy(&body), &base, feed_author);
        preview.fill_from(page);
    }
    preview.map(ArticlePreview::with_publisher_icon)
}

#[tauri::command]
pub async fn get_rss_preview_image(url: String) -> Option<String> {
    let (_, mime, bytes) = fetch(preview_url(&url)?, Resource::Image).await?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::preview_url;

    #[test]
    fn preview_requests_are_limited_to_public_web_urls() {
        for url in [
            "file:///tmp/test",
            "http://localhost/",
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://[::ffff:192.168.1.1]/",
            "http://169.254.169.254/",
            "http://100.64.0.1/",
            "http://10.0.0.1/",
            "https://user:token@example.com/",
            "http://example.com:10000/",
        ] {
            assert!(preview_url(url).is_none(), "accepted {url}");
        }
        assert!(preview_url("https://cdn.example.com/article.jpg").is_some());
    }
}
