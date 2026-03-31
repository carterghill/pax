use serde::Serialize;

/// Open Graph / meta-tag metadata extracted from a URL.
#[derive(Debug, Clone, Serialize)]
pub struct UrlMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
    pub video_url: Option<String>,
}

/// Fetch Open Graph metadata from a URL by downloading the HTML and parsing
/// `<meta property="og:*">` and `<meta name="twitter:*">` tags.
///
/// This is intentionally lightweight — no full HTML parser crate, just enough
/// regex to pull the tags we need.  Works for the vast majority of sites that
/// support OG tags (Twitter, Reddit, news sites, etc.).
#[tauri::command]
pub async fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
    // Twitter/X serves minimal OG tags to non-browser user agents.
    // Rewrite to fxtwitter.com which returns rich metadata (tweet text, author, media).
    let fetch_url = rewrite_for_metadata(&url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Mozilla/5.0 (compatible; PaxBot/1.0)")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get(&fetch_url)
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    // Only read the first ~256 KB — we only need <head> content.
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Body read error: {e}"))?;
    let head = if let Some(end) = body.find("</head>") {
        &body[..end + 7]
    } else {
        // No </head> found — just use first 256 KB
        &body[..body.len().min(256 * 1024)]
    };

    let mut title: Option<String> = None;
    let mut description: Option<String> = None;
    let mut image: Option<String> = None;
    let mut site_name: Option<String> = None;
    let mut video_url: Option<String> = None;

    // Match <meta> tags with property= or name= attributes.
    // Handles both single and double quotes, and content before/after property.
    let meta_re = regex::Regex::new(
        r#"(?i)<meta\s+(?:[^>]*?\s)?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?\s?content\s*=\s*["']([^"']*)["']"#,
    )
    .unwrap();

    // Also match content-first order: <meta content="..." property="...">
    let meta_re_rev = regex::Regex::new(
        r#"(?i)<meta\s+(?:[^>]*?\s)?content\s*=\s*["']([^"']*)["'][^>]*?\s?(?:property|name)\s*=\s*["']([^"']+)["']"#,
    )
    .unwrap();

    // Process property=X content=Y order
    for cap in meta_re.captures_iter(head) {
        let prop = cap[1].to_lowercase();
        let content = cap[2].to_string();
        if content.is_empty() {
            continue;
        }
        match prop.as_str() {
            "og:title" | "twitter:title" => {
                if title.is_none() {
                    title = Some(html_decode(&content));
                }
            }
            "og:description" | "twitter:description" => {
                if description.is_none() {
                    description = Some(html_decode(&content));
                }
            }
            "og:image" | "twitter:image" | "twitter:image:src" => {
                if image.is_none() {
                    image = Some(content);
                }
            }
            "og:site_name" => {
                if site_name.is_none() {
                    site_name = Some(html_decode(&content));
                }
            }
            "og:video" | "og:video:url" | "og:video:secure_url" | "twitter:player:stream" => {
                if video_url.is_none() {
                    video_url = Some(content);
                }
            }
            _ => {}
        }
    }

    // Process content=Y property=X order
    for cap in meta_re_rev.captures_iter(head) {
        let content = cap[1].to_string();
        let prop = cap[2].to_lowercase();
        if content.is_empty() {
            continue;
        }
        match prop.as_str() {
            "og:title" | "twitter:title" => {
                if title.is_none() {
                    title = Some(html_decode(&content));
                }
            }
            "og:description" | "twitter:description" => {
                if description.is_none() {
                    description = Some(html_decode(&content));
                }
            }
            "og:image" | "twitter:image" | "twitter:image:src" => {
                if image.is_none() {
                    image = Some(content);
                }
            }
            "og:site_name" => {
                if site_name.is_none() {
                    site_name = Some(html_decode(&content));
                }
            }
            "og:video" | "og:video:url" | "og:video:secure_url" | "twitter:player:stream" => {
                if video_url.is_none() {
                    video_url = Some(content);
                }
            }
            _ => {}
        }
    }

    // Fallback: try <title> tag if no OG title found
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

/// Rewrite certain URLs to proxy services that return richer OG metadata.
/// The original URL is preserved for display; only the fetch target changes.
fn rewrite_for_metadata(url: &str) -> String {
    // Twitter / X → fxtwitter.com (serves full tweet text, author, media as OG tags)
    let twitter_re =
        regex::Regex::new(r"^https?://(twitter\.com|x\.com)/").unwrap();
    if twitter_re.is_match(url) {
        return twitter_re.replace(url, "https://fxtwitter.com/").to_string();
    }
    url.to_string()
}