use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Open Graph / meta-tag metadata extracted from a URL.
#[derive(Debug, Clone, Serialize)]
pub struct UrlMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
    pub video_url: Option<String>,
}

/* ------------------------------------------------------------------ */
/*  fxtwitter JSON API types                                           */
/* ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
struct FxTweetResponse {
    code: u32,
    tweet: Option<FxTweet>,
}

#[derive(Debug, Deserialize)]
struct FxTweet {
    text: Option<String>,
    author: Option<FxAuthor>,
    media: Option<FxMedia>,
}

#[derive(Debug, Deserialize)]
struct FxAuthor {
    name: Option<String>,
    screen_name: Option<String>,
    #[allow(dead_code)]
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FxMedia {
    photos: Option<Vec<FxPhoto>>,
    videos: Option<Vec<FxVideo>>,
}

#[derive(Debug, Deserialize)]
struct FxPhoto {
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FxVideo {
    url: Option<String>,
    thumbnail_url: Option<String>,
}

/* ------------------------------------------------------------------ */
/*  Twitter / X → fxtwitter JSON API                                   */
/* ------------------------------------------------------------------ */

/// Check if a URL is a Twitter/X status link. Returns the API URL if so.
fn twitter_api_url(url: &str) -> Option<String> {
    let re = regex::Regex::new(
        r"^https?://(twitter\.com|x\.com)/([^/]+)/status/(\d+)"
    ).unwrap();
    let caps = re.captures(url)?;
    let user = &caps[2];
    let id = &caps[3];
    Some(format!("https://api.fxtwitter.com/{user}/status/{id}"))
}

/// Fetch tweet metadata via the fxtwitter JSON API, which returns direct
/// video.twimg.com MP4 URLs instead of embed player URLs.
async fn fetch_twitter_metadata(
    client: &reqwest::Client,
    api_url: &str,
) -> Result<UrlMetadata, String> {
    let resp = client
        .get(api_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("fxtwitter fetch failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("fxtwitter HTTP {}", resp.status()));
    }

    let data: FxTweetResponse = resp
        .json()
        .await
        .map_err(|e| format!("fxtwitter JSON parse error: {e}"))?;

    if data.code != 200 {
        return Err(format!("fxtwitter returned code {}", data.code));
    }

    let tweet = data.tweet.ok_or("fxtwitter: no tweet in response")?;

    let author = tweet.author.as_ref();
    let title = match (
        author.and_then(|a| a.name.as_deref()),
        author.and_then(|a| a.screen_name.as_deref()),
    ) {
        (Some(name), Some(handle)) => Some(format!("{name} (@{handle})")),
        (Some(name), None) => Some(name.to_string()),
        (None, Some(handle)) => Some(format!("@{handle}")),
        _ => None,
    };

    let description = tweet.text;
    let media = tweet.media.as_ref();

    // Prefer video thumbnail, then first photo
    let image = media
        .and_then(|m| m.videos.as_ref())
        .and_then(|v| v.first())
        .and_then(|v| v.thumbnail_url.clone())
        .or_else(|| {
            media
                .and_then(|m| m.photos.as_ref())
                .and_then(|p| p.first())
                .and_then(|p| p.url.clone())
        });

    // Direct MP4 URL from Twitter's CDN
    let video_url = media
        .and_then(|m| m.videos.as_ref())
        .and_then(|v| v.first())
        .and_then(|v| v.url.clone());

    Ok(UrlMetadata {
        title,
        description,
        image,
        site_name: Some("Twitter".to_string()),
        video_url,
    })
}

/* ------------------------------------------------------------------ */
/*  Generic OG metadata scraper                                        */
/* ------------------------------------------------------------------ */

/// Fetch Open Graph metadata from a URL by downloading the HTML and parsing
/// `<meta property="og:*">` and `<meta name="twitter:*">` tags.
async fn fetch_og_metadata(
    client: &reqwest::Client,
    url: &str,
) -> Result<UrlMetadata, String> {
    let resp = client
        .get(url)
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Body read error: {e}"))?;
    let head = if let Some(end) = body.find("</head>") {
        &body[..end + 7]
    } else {
        &body[..body.len().min(256 * 1024)]
    };

    let mut title: Option<String> = None;
    let mut description: Option<String> = None;
    let mut image: Option<String> = None;
    let mut site_name: Option<String> = None;
    let mut video_url: Option<String> = None;

    let meta_re = regex::Regex::new(
        r#"(?i)<meta\s+(?:[^>]*?\s)?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?\s?content\s*=\s*["']([^"']*)["']"#,
    )
    .unwrap();

    let meta_re_rev = regex::Regex::new(
        r#"(?i)<meta\s+(?:[^>]*?\s)?content\s*=\s*["']([^"']*)["'][^>]*?\s?(?:property|name)\s*=\s*["']([^"']+)["']"#,
    )
    .unwrap();

    let mut apply = |prop: &str, content: &str| {
        if content.is_empty() {
            return;
        }
        match prop {
            "og:title" | "twitter:title" => {
                if title.is_none() {
                    title = Some(html_decode(content));
                }
            }
            "og:description" | "twitter:description" => {
                if description.is_none() {
                    description = Some(html_decode(content));
                }
            }
            "og:image" | "twitter:image" | "twitter:image:src" => {
                if image.is_none() {
                    image = Some(content.to_string());
                }
            }
            "og:site_name" => {
                if site_name.is_none() {
                    site_name = Some(html_decode(content));
                }
            }
            "og:video" | "og:video:url" | "og:video:secure_url" | "twitter:player:stream" => {
                if video_url.is_none() {
                    video_url = Some(content.to_string());
                }
            }
            _ => {}
        }
    };

    for cap in meta_re.captures_iter(head) {
        let prop = cap[1].to_lowercase();
        apply(&prop, &cap[2]);
    }

    for cap in meta_re_rev.captures_iter(head) {
        let prop = cap[2].to_lowercase();
        apply(&prop, &cap[1]);
    }

    if title.is_none() {
        let title_re = regex::Regex::new(r#"(?is)<title[^>]*>(.*?)</title>"#).unwrap();
        if let Some(cap) = title_re.captures(head) {
            let t = cap[1].trim().to_string();
            if !t.is_empty() {
                title = Some(html_decode(&t));
            }
        }
    }

    Ok(UrlMetadata {
        title,
        description,
        image,
        site_name,
        video_url,
    })
}

/* ------------------------------------------------------------------ */
/*  Public Tauri command                                                */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub async fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Mozilla/5.0 (compatible; PaxBot/1.0)")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Twitter / X: use fxtwitter's JSON API for direct media URLs.
    if let Some(api_url) = twitter_api_url(&url) {
        return fetch_twitter_metadata(&client, &api_url).await;
    }

    // Everything else: scrape OG tags from HTML.
    fetch_og_metadata(&client, &url).await
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/// Decode common HTML entities.
fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&#x2F;", "/")
}

/* ------------------------------------------------------------------ */
/*  Media proxy command                                                */
/* ------------------------------------------------------------------ */

/// Domains allowed through the media proxy (security: prevent open proxy).
const ALLOWED_MEDIA_HOSTS: &[&str] = &[
    "video.twimg.com",
    "pbs.twimg.com",
    "abs.twimg.com",
];

fn is_allowed_media_host(url: &str) -> bool {
    ALLOWED_MEDIA_HOSTS.iter().any(|&allowed| {
        url.starts_with(&format!("https://{allowed}/"))
            || url.starts_with(&format!("https://{allowed}?"))
            || url == format!("https://{allowed}")
    })
}

/// Build the deterministic temp file path for a media URL.
fn media_temp_path(app: &tauri::AppHandle, url: &str) -> Result<std::path::PathBuf, String> {
    let temp_dir = app
        .path()
        .temp_dir()
        .map_err(|e| format!("Failed to get temp dir: {e}"))?;

    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let hash = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        url.hash(&mut h);
        h.finish()
    };
    Ok(temp_dir.join(format!("pax_media_{hash:016x}.mp4")))
}

/// Download a video URL server-side (bypasses webview CORS), save to a
/// temp file, and return the file path.  The frontend uses convertFileSrc()
/// to create an asset:// URL the <video> element can play.
#[tauri::command]
pub async fn proxy_media(app: tauri::AppHandle, url: String) -> Result<String, String> {
    if !is_allowed_media_host(&url) {
        return Err(format!("Host not allowed for media proxy: {url}"));
    }

    let file_path = media_temp_path(&app, &url)?;

    // Return immediately if already cached — skip the download entirely.
    if file_path.exists() {
        let path_str = file_path
            .to_str()
            .ok_or("Temp file path is not valid UTF-8")?
            .to_string();
        log::info!("[Pax Media] Cache hit: {path_str}");
        return Ok(path_str);
    }

    log::info!("[Pax Media] Proxying: {url}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Proxy HTTP client error: {e}"))?;

    let resp = client
        .get(&url)
        .header("Referer", "https://twitter.com/")
        .header("Origin", "https://twitter.com")
        .send()
        .await
        .map_err(|e| format!("Proxy fetch failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Proxy HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Proxy body read error: {e}"))?;

    log::info!("[Pax Media] Downloaded {} bytes", bytes.len());

    std::fs::write(&file_path, &bytes)
        .map_err(|e| format!("Failed to write temp file: {e}"))?;

    let path_str = file_path
        .to_str()
        .ok_or("Temp file path is not valid UTF-8")?
        .to_string();

    log::info!("[Pax Media] Saved to: {path_str}");

    Ok(path_str)
}

/// Delete a single proxied media temp file.
/// The frontend calls this when a video embed unmounts.
#[tauri::command]
pub async fn cleanup_proxy_media(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file_path = std::path::Path::new(&path);

    // Security: only allow deleting files inside our temp dir with our prefix.
    let temp_dir = app
        .path()
        .temp_dir()
        .map_err(|e| format!("Failed to get temp dir: {e}"))?;

    let canonical_file = file_path
        .canonicalize()
        .map_err(|_| "File does not exist".to_string())?;
    let canonical_temp = temp_dir
        .canonicalize()
        .map_err(|_| "Temp dir does not exist".to_string())?;

    if !canonical_file.starts_with(&canonical_temp) {
        return Err("Path is outside temp directory".to_string());
    }

    let fname = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if !fname.starts_with("pax_media_") || !fname.ends_with(".mp4") {
        return Err("Not a pax media temp file".to_string());
    }

    match std::fs::remove_file(&canonical_file) {
        Ok(()) => {
            log::info!("[Pax Media] Cleaned up: {path}");
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete temp file: {e}")),
    }
}

/// Bulk-delete all proxied media temp files.  Called once at startup to
/// clear leftovers from the previous session.
#[tauri::command]
pub async fn cleanup_all_proxy_media(app: tauri::AppHandle) -> Result<u32, String> {
    let temp_dir = app
        .path()
        .temp_dir()
        .map_err(|e| format!("Failed to get temp dir: {e}"))?;

    if !temp_dir.exists() {
        return Ok(0);
    }

    let mut count = 0u32;
    let entries = std::fs::read_dir(&temp_dir)
        .map_err(|e| format!("Failed to read temp dir: {e}"))?;

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("pax_media_") && name_str.ends_with(".mp4") {
            if std::fs::remove_file(entry.path()).is_ok() {
                count += 1;
            }
        }
    }

    if count > 0 {
        log::info!("[Pax Media] Startup cleanup: removed {count} temp files");
    }
    Ok(count)
}