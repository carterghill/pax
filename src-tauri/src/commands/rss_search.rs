use std::{sync::Arc, time::Duration};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::rss::parse_feed_url;
use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedSearchResult {
    url: String,
    title: String,
    description: Option<String>,
    website: Option<String>,
    image_url: Option<String>,
    icon_url: Option<String>,
}

#[derive(Deserialize)]
struct FeedlySearchResponse {
    results: Vec<FeedlyFeed>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedlyFeed {
    feed_id: Option<String>,
    title: Option<String>,
    description: Option<String>,
    website: Option<String>,
    cover_url: Option<String>,
    visual_url: Option<String>,
    icon_url: Option<String>,
}

fn web_url(url: Option<String>) -> Option<String> {
    parse_feed_url(url.as_deref()?)
        .ok()
        .map(|url| url.to_string())
}

impl FeedlyFeed {
    fn into_result(self) -> Option<FeedSearchResult> {
        let raw_url = self.feed_id.as_deref()?.strip_prefix("feed/")?;
        let url = parse_feed_url(raw_url).ok()?.to_string();
        let title = self
            .title
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| url.clone());
        let description = self
            .description
            .filter(|description| !description.trim().is_empty());
        Some(FeedSearchResult {
            url,
            title,
            description,
            website: web_url(self.website),
            image_url: web_url(self.cover_url).or_else(|| web_url(self.visual_url)),
            icon_url: web_url(self.icon_url),
        })
    }
}

#[tauri::command]
pub async fn search_rss_feeds(
    state: State<'_, Arc<AppState>>,
    query: String,
) -> Result<Vec<FeedSearchResult>, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 512 {
        return Err("Enter a search query of 1 to 512 characters.".into());
    }
    let response = state
        .http_client
        .get("https://cloud.feedly.com/v3/search/feeds")
        .query(&[("query", query), ("count", "12")])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "Could not reach Feedly. Try again or paste a feed URL.")?;

    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err("Feedly is limiting searches. Try again in a moment.".into());
    }
    let response = response
        .error_for_status()
        .map_err(|_| "Feedly search is unavailable. Try again or paste a feed URL.")?
        .json::<FeedlySearchResponse>()
        .await
        .map_err(|_| "Could not read the Feedly results. Try again or paste a feed URL.")?;

    Ok(response
        .results
        .into_iter()
        .filter_map(FeedlyFeed::into_result)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedly_results_use_subscribable_urls_in_provider_order() {
        let response: FeedlySearchResponse = serde_json::from_value(serde_json::json!({
            "results": [
                {
                    "feedId": "feed/https://example.org/rss",
                    "website": "https://example.org",
                    "title": "Example",
                    "description": "Updates",
                    "coverUrl": "https://example.org/cover.jpg",
                    "visualUrl": "https://example.org/visual.jpg",
                    "iconUrl": "https://example.org/icon.png"
                },
                { "feedId": "user/123/category/tech" },
                { "feedId": "feed/https://user:password@example.org/rss" },
                { "feedId": "feed/file:///tmp/feed.xml" },
                { "feedId": "feed/https://example.net/atom.xml" }
            ]
        }))
        .unwrap();
        let results: Vec<_> = response
            .results
            .into_iter()
            .filter_map(FeedlyFeed::into_result)
            .collect();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://example.org/rss");
        assert_eq!(results[0].title, "Example");
        assert_eq!(results[0].description.as_deref(), Some("Updates"));
        assert_eq!(
            results[0].image_url.as_deref(),
            Some("https://example.org/cover.jpg")
        );
        assert_eq!(
            results[0].icon_url.as_deref(),
            Some("https://example.org/icon.png")
        );
        assert_eq!(results[1].url, "https://example.net/atom.xml");
        assert_eq!(results[1].title, results[1].url);
    }
}
