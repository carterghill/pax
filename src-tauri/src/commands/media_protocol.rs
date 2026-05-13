use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use matrix_sdk::media::{MediaFormat, MediaRequestParameters};
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::Client;
use reqwest::header::{
    ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
};
use reqwest::Version;
use tauri::{AppHandle, Manager};

use crate::AppState;

use super::{fmt_error_chain, get_client};

/// matrix-sdk sets **no HTTP timeout** for media downloads (`Duration::MAX` in
/// `Media::get_media_content`), so slow or stuck federation can block the UI for a very long time.
/// We wrap each fetch so the app fails fast with a clear message instead.
pub(super) const MATRIX_IMAGE_THUMB_FETCH_TIMEOUT: Duration = Duration::from_secs(45);
/// Full-file downloads (GIF originals, video) can be large; federation may be slow.
pub(super) const MATRIX_IMAGE_FULL_FETCH_TIMEOUT: Duration = Duration::from_secs(300);
const MATRIX_MEDIA_RANGE_WINDOW: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy)]
struct MediaByteRange {
    start: u64,
    end: u64,
}

impl MediaByteRange {
    fn len(self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
}

pub(super) async fn get_matrix_media_bytes_with_timeout(
    client: &matrix_sdk::Client,
    params: &MediaRequestParameters,
    use_cache: bool,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    match tokio::time::timeout(timeout, client.media().get_media_content(params, use_cache)).await {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(e)) => Err(fmt_error_chain(&e)),
        Err(_) => Err(format!(
            "timed out after {}s (media download; federation can be slow)",
            timeout.as_secs()
        )),
    }
}

fn matrix_plain_file_download_urls(
    client: &Client,
    params: &MediaRequestParameters,
) -> Result<[String; 2], String> {
    if !matches!(params.format, MediaFormat::File) {
        return Err("direct media fetch only supports full files".to_string());
    }

    let MediaSource::Plain(mxc) = &params.source else {
        return Err("direct media fetch only supports unencrypted MXC media".to_string());
    };

    let server_name = mxc
        .server_name()
        .map_err(|e| format!("Invalid MXC server name: {e}"))?
        .as_str();
    let media_id = mxc
        .media_id()
        .map_err(|e| format!("Invalid MXC media id: {e}"))?;
    let homeserver = client.homeserver().to_string();

    let base = homeserver.trim_end_matches('/');
    let server_enc = urlencoding::encode(server_name);
    let media_enc = urlencoding::encode(media_id);

    Ok([
        format!("{base}/_matrix/client/v1/media/download/{server_enc}/{media_enc}"),
        format!("{base}/_matrix/media/v3/download/{server_enc}/{media_enc}"),
    ])
}

pub(super) async fn get_plain_matrix_file_bytes_direct(
    state: &AppState,
    client: &Client,
    params: &MediaRequestParameters,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let access_token = client.access_token().ok_or("No access token")?;
    let urls = matrix_plain_file_download_urls(client, params)?;

    let mut last_err = String::new();
    for url in urls {
        let resp = state
            .http_client
            .get(&url)
            .version(Version::HTTP_11)
            .timeout(timeout)
            .bearer_auth(access_token.to_string())
            .send()
            .await
            .map_err(|e| format!("direct media download failed: {}", fmt_error_chain(&e)))?;

        if resp.status().is_success() {
            return resp.bytes().await.map(|b| b.to_vec()).map_err(|e| {
                format!("direct media download body failed: {}", fmt_error_chain(&e))
            });
        }

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        last_err = format!("direct media download failed ({status}): {body}");
    }

    Err(last_err)
}

fn media_protocol_response(
    status: u16,
    body: impl Into<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("access-control-allow-origin", "*")
        .body(body.into())
        .unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(500)
                .body(Vec::new())
                .expect("static response builds")
        })
}

fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            urlencoding::decode(value).ok().map(|v| v.into_owned())
        } else {
            None
        }
    })
}

fn parse_media_byte_range(range_header: &str) -> Option<MediaByteRange> {
    let range = range_header.strip_prefix("bytes=")?;
    let first_range = range.split(',').next()?.trim();
    let (start, end) = first_range.split_once('-')?;
    if start.is_empty() {
        return None;
    }

    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        start.saturating_add(MATRIX_MEDIA_RANGE_WINDOW - 1)
    } else {
        end.parse::<u64>().ok()?
    };

    if end < start {
        return None;
    }

    Some(MediaByteRange { start, end })
}

fn media_range_header(range: MediaByteRange) -> String {
    format!("bytes={}-{}", range.start, range.end)
}

fn sniff_iso_bmff_brand(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return None;
    }

    let major = String::from_utf8_lossy(&bytes[8..12]).to_string();
    let mut compatible = Vec::new();
    let mut offset = 16usize;
    while offset + 4 <= bytes.len() && compatible.len() < 8 {
        compatible.push(String::from_utf8_lossy(&bytes[offset..offset + 4]).to_string());
        offset += 4;
    }

    Some(format!("major={major} compatible={}", compatible.join(",")))
}

fn normalize_stream_content_type(content_type: &str, body: &[u8]) -> String {
    if content_type.eq_ignore_ascii_case("video/quicktime") && sniff_iso_bmff_brand(body).is_some()
    {
        // WebKitGTK/GStreamer can demux ISO BMFF; the HTML media layer is more willing
        // to keep probing when it sees the common MP4 media type instead of QuickTime.
        "video/mp4".to_string()
    } else {
        content_type.to_string()
    }
}

async fn collect_upstream_range(
    resp: reqwest::Response,
    range: MediaByteRange,
) -> Result<Vec<u8>, String> {
    let mut stream = resp.bytes_stream();
    let mut skipped = 0u64;
    let mut collected = Vec::with_capacity(range.len().min(usize::MAX as u64) as usize);

    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| format!("media proxy body failed: {}", fmt_error_chain(&e)))?;
        let chunk_start = skipped;
        let chunk_end = skipped.saturating_add(chunk.len() as u64).saturating_sub(1);
        skipped = skipped.saturating_add(chunk.len() as u64);

        if chunk_end < range.start {
            continue;
        }
        if chunk_start > range.end {
            break;
        }

        let copy_start = range.start.saturating_sub(chunk_start) as usize;
        let copy_end = if range.end < chunk_end {
            (range.end - chunk_start + 1) as usize
        } else {
            chunk.len()
        };
        collected.extend_from_slice(&chunk[copy_start..copy_end]);

        if skipped > range.end {
            break;
        }
    }

    Ok(collected)
}

async fn handle_matrix_media_protocol_request_async(
    app: AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let started_at = Instant::now();
    let inbound_method = request.method().clone();
    let inbound_uri = request.uri().to_string();
    let inbound_range = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let parsed_range = inbound_range.as_deref().and_then(parse_media_byte_range);
    log::info!(
        "[matrix media stream] inbound method={} uri={} range={}",
        inbound_method,
        inbound_uri,
        inbound_range.as_deref().unwrap_or("<none>"),
    );

    let request_json = match query_param(request.uri().query(), "request") {
        Some(value) => value,
        None => {
            log::warn!("[matrix media stream] reject: missing request");
            return media_protocol_response(400, "missing request");
        }
    };
    let params: MediaRequestParameters = match serde_json::from_str(&request_json) {
        Ok(params) => params,
        Err(e) => {
            log::warn!("[matrix media stream] reject: invalid media request: {e}");
            return media_protocol_response(400, format!("invalid media request: {e}"));
        }
    };
    let state = app.state::<Arc<AppState>>();
    let client = match get_client(&state).await {
        Ok(client) => client,
        Err(e) => {
            log::warn!("[matrix media stream] reject: {e}");
            return media_protocol_response(401, e);
        }
    };
    let access_token = match client.access_token() {
        Some(token) => token.to_string(),
        None => {
            log::warn!("[matrix media stream] reject: no access token");
            return media_protocol_response(401, "No access token");
        }
    };
    let urls = match matrix_plain_file_download_urls(&client, &params) {
        Ok(urls) => urls,
        Err(e) => {
            log::warn!("[matrix media stream] reject: {e}");
            return media_protocol_response(400, e);
        }
    };

    let mut last_status = 502;
    let mut last_body = Vec::new();
    for (attempt, url) in urls.into_iter().enumerate() {
        let endpoint = if url.contains("/_matrix/client/v1/media/download/") {
            "client-v1"
        } else {
            "media-v3"
        };
        let mut outbound = state
            .http_client
            .get(&url)
            .version(Version::HTTP_11)
            .timeout(MATRIX_IMAGE_FULL_FETCH_TIMEOUT)
            .bearer_auth(&access_token);
        if let Some(range) = parsed_range {
            outbound = outbound.header(RANGE, media_range_header(range));
        } else if let Some(range) = inbound_range.as_deref() {
            outbound = outbound.header(RANGE, range);
        }
        let outbound_range_log = parsed_range
            .map(media_range_header)
            .or_else(|| inbound_range.clone())
            .unwrap_or_else(|| "<none>".to_string());
        log::info!(
            "[matrix media stream] outbound attempt={} endpoint={} inbound_range={} outbound_range={}",
            attempt + 1,
            endpoint,
            inbound_range.as_deref().unwrap_or("<none>"),
            outbound_range_log,
        );

        let resp = match outbound.send().await {
            Ok(resp) => resp,
            Err(e) => {
                log::warn!(
                    "[matrix media stream] outbound failed endpoint={} elapsed_ms={}: {}",
                    endpoint,
                    started_at.elapsed().as_millis(),
                    fmt_error_chain(&e)
                );
                return media_protocol_response(
                    502,
                    format!("media proxy failed: {}", fmt_error_chain(&e)),
                );
            }
        };
        let status = resp.status();
        let headers = resp.headers().clone();
        let content_type = headers
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("<none>")
            .to_string();
        let content_length = headers
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("<none>")
            .to_string();
        let content_range = headers
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("<none>")
            .to_string();
        let accept_ranges = headers
            .get(ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("<none>")
            .to_string();
        let content_disposition = headers
            .get(CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("<none>")
            .to_string();
        let emulated_range = parsed_range.filter(|_| status == reqwest::StatusCode::OK);
        let body = if let Some(range) = emulated_range {
            match collect_upstream_range(resp, range).await {
                Ok(body) => body,
                Err(e) => {
                    log::warn!(
                        "[matrix media stream] range body failed endpoint={} status={} range={}-{} elapsed_ms={}: {}",
                        endpoint,
                        status,
                        range.start,
                        range.end,
                        started_at.elapsed().as_millis(),
                        e
                    );
                    return media_protocol_response(502, e);
                }
            }
        } else {
            match resp.bytes().await {
                Ok(body) => body.to_vec(),
                Err(e) => {
                    log::warn!(
                        "[matrix media stream] body failed endpoint={} status={} elapsed_ms={}: {}",
                        endpoint,
                        status,
                        started_at.elapsed().as_millis(),
                        fmt_error_chain(&e)
                    );
                    return media_protocol_response(
                        502,
                        format!("media proxy body failed: {}", fmt_error_chain(&e)),
                    );
                }
            }
        };

        let normalized_content_type = normalize_stream_content_type(&content_type, &body);

        log::info!(
            "[matrix media stream] matrix response endpoint={} status={} content_type={} normalized_content_type={} content_length={} content_range={} accept_ranges={} content_disposition={} emulated_range={} iso_bmff={} body_bytes={} elapsed_ms={}",
            endpoint,
            status,
            content_type,
            normalized_content_type,
            content_length,
            content_range,
            accept_ranges,
            content_disposition,
            emulated_range
                .map(|r| format!("{}-{}", r.start, r.end))
                .unwrap_or_else(|| "<none>".to_string()),
            sniff_iso_bmff_brand(&body).unwrap_or_else(|| "<none>".to_string()),
            body.len(),
            started_at.elapsed().as_millis(),
        );

        if status.is_success() {
            let response_status = if emulated_range.is_some() {
                reqwest::StatusCode::PARTIAL_CONTENT
            } else {
                status
            };
            let mut builder = tauri::http::Response::builder()
                .status(response_status.as_u16())
                .header("access-control-allow-origin", "*")
                .header("cache-control", "private, max-age=3600");

            for header in [CONTENT_TYPE, CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES] {
                if emulated_range.is_some()
                    && (header == CONTENT_LENGTH
                        || header == CONTENT_RANGE
                        || header == ACCEPT_RANGES)
                {
                    continue;
                }
                if let Some(value) = headers.get(&header).and_then(|v| v.to_str().ok()) {
                    let value = if header == CONTENT_TYPE {
                        normalized_content_type.clone()
                    } else {
                        value.to_string()
                    };
                    builder = builder.header(header.as_str(), value);
                }
            }
            builder = builder.header(CONTENT_DISPOSITION.as_str(), "inline");

            if let Some(range) = emulated_range {
                if body.is_empty() {
                    log::warn!(
                        "[matrix media stream] emulated range returned no bytes range={}-{} elapsed_ms={}",
                        range.start,
                        range.end,
                        started_at.elapsed().as_millis(),
                    );
                    return media_protocol_response(416, "range not satisfiable");
                }
                let total_len = content_length.parse::<u64>().ok();
                let actual_end = range
                    .start
                    .saturating_add(body.len() as u64)
                    .saturating_sub(1);
                let content_range_value = total_len
                    .map(|total| format!("bytes {}-{}/{}", range.start, actual_end, total))
                    .unwrap_or_else(|| format!("bytes {}-{}/*", range.start, actual_end));
                builder = builder
                    .header(CONTENT_RANGE.as_str(), content_range_value)
                    .header(CONTENT_LENGTH.as_str(), body.len().to_string())
                    .header(ACCEPT_RANGES.as_str(), "bytes");
            }

            log::info!(
                "[matrix media stream] return status={} body_bytes={} elapsed_ms={}",
                response_status,
                body.len(),
                started_at.elapsed().as_millis(),
            );
            return builder
                .body(body)
                .unwrap_or_else(|_| media_protocol_response(500, Vec::new()));
        }

        last_status = status.as_u16();
        last_body = body;
    }

    log::warn!(
        "[matrix media stream] all endpoints failed status={} body_bytes={} elapsed_ms={}",
        last_status,
        last_body.len(),
        started_at.elapsed().as_millis(),
    );
    media_protocol_response(last_status, last_body)
}

pub fn handle_matrix_media_protocol_request(
    app: AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::async_runtime::block_on(handle_matrix_media_protocol_request_async(app, request))
}
