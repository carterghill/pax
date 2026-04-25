//! User-level space sidebar ordering, stored as Matrix account data.
//!
//! Pax stores the user's preferred order of top-level spaces in a custom
//! account-data event:
//!
//! ```text
//! type:     app.pax.space_order
//! content:  { "order": [ "!spaceA:hs", "!spaceB:hs", ... ] }
//! ```
//!
//! This is purely a per-user sidebar-layout preference and is NOT any kind of
//! Matrix spec standard.  Matrix deliberately leaves client-side ordering to
//! clients (see MSC4186 Simplified Sliding Sync, which explicitly removed
//! server-determined room-list ordering).  Element's own space-panel order
//! lives under `im.vector.*` account data; we use our own namespace to avoid
//! stomping on theirs and to keep our schema free to evolve.
//!
//! ### Namespace
//!
//! We use `app.pax.*` as the reverse-DNS namespace for Pax-client-specific
//! account data.  Pax doesn't own any `.ca` domain, and the user's server
//! (whoever hosts it) is unrelated to the app itself, so an explicit
//! `app.pax.*` prefix is both unambiguous and portable.
//!
//! ### Concurrency
//!
//! A module-local async mutex serialises read-modify-write cycles so two
//! rapid drag-reorders can't race.  We don't do any RMW here — we just write
//! the full vector — so the lock really only prevents interleaved PUTs from
//! landing out of order.
//!
//! ### Missing / stale entries
//!
//! The stored order can contain space ids the user has since left (stale
//! entries) and omit spaces they've joined since (new entries).  The client
//! handles both cases when applying the order — stale entries are dropped,
//! new entries sort after known entries.  We don't scrub stale entries here
//! because that would require loading the full joined-space list on every
//! write; instead the frontend prunes as it writes.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::AppState;

use super::{fmt_error_chain, get_client};

/// Account-data event type that holds the user's preferred sidebar order of
/// top-level spaces.  Custom to Pax.
const SPACE_ORDER_TYPE: &str = "app.pax.space_order";

/// Serialises writes so rapid drag-and-drops produce a single consistent
/// final state rather than interleaved PUTs.
static SPACE_ORDER_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Wire format for the `app.pax.space_order` event.  Keeping unknown fields
/// round-tripping via `#[serde(flatten)]` means a future Pax version can add
/// sibling fields (e.g. per-space collapsed state) without older versions
/// silently dropping them on write.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceOrderContent {
    /// Ordered list of Matrix room ids (spaces) in the user's preferred
    /// top-down order.  Ids not present here should be appended at the end
    /// by the client using its fallback (alphabetical) order.
    #[serde(default)]
    order: Vec<String>,
    #[serde(flatten)]
    extra: std::collections::HashMap<String, Value>,
}

impl Default for SpaceOrderContent {
    fn default() -> Self {
        Self {
            order: Vec::new(),
            extra: std::collections::HashMap::new(),
        }
    }
}

// ---------- HTTP helpers ----------
//
// Small and duplicated-with-pax_settings on purpose: this module owns a
// separate event type and has no reason to share state / locks with
// pax_settings' read-modify-write cycles.

async fn fetch_account_data_raw(
    state: &AppState,
    event_type: &str,
) -> Result<Option<Value>, String> {
    let client = get_client(state).await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "No user ID".to_string())?
        .to_string();
    let access_token = client
        .access_token()
        .ok_or_else(|| "No access token".to_string())?;
    let hs = client.homeserver().to_string();
    let hs = hs.trim_end_matches('/');

    let url = format!(
        "{hs}/_matrix/client/v3/user/{}/account_data/{}",
        urlencoding::encode(&user_id),
        urlencoding::encode(event_type),
    );

    let resp = state
        .http_client
        .get(&url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch account data: {}", fmt_error_chain(&e)))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "GET account_data/{event_type} failed: HTTP {status} — {body}"
        ));
    }

    resp.json::<Value>()
        .await
        .map(Some)
        .map_err(|e| format!("Malformed account_data response: {}", fmt_error_chain(&e)))
}

async fn put_account_data_raw(
    state: &AppState,
    event_type: &str,
    body: &Value,
) -> Result<(), String> {
    let client = get_client(state).await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "No user ID".to_string())?
        .to_string();
    let access_token = client
        .access_token()
        .ok_or_else(|| "No access token".to_string())?;
    let hs = client.homeserver().to_string();
    let hs = hs.trim_end_matches('/');

    let url = format!(
        "{hs}/_matrix/client/v3/user/{}/account_data/{}",
        urlencoding::encode(&user_id),
        urlencoding::encode(event_type),
    );

    let resp = state
        .http_client
        .put(&url)
        .bearer_auth(&access_token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Failed to PUT account data: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "PUT account_data/{event_type} failed: HTTP {status} — {body}"
        ));
    }

    Ok(())
}

// ---------- Commands ----------

/// Read the user's preferred top-level space sidebar order.  Returns an
/// empty vector when the account-data event doesn't exist yet (first run).
#[tauri::command]
pub async fn get_space_order(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    let state_ref: &AppState = &state;
    let raw = fetch_account_data_raw(state_ref, SPACE_ORDER_TYPE).await?;
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    // Tolerate malformed content: fall back to empty rather than erroring so
    // that a corrupt event from a misbehaving client doesn't wedge the
    // sidebar.  The next write from Pax will overwrite it.
    let parsed: SpaceOrderContent = serde_json::from_value(raw).unwrap_or_default();
    Ok(parsed.order)
}

/// Replace the user's preferred top-level space sidebar order.  Serialises
/// with itself via `SPACE_ORDER_LOCK` so back-to-back drag events can't race.
///
/// The frontend is responsible for pruning space ids the user has left; we
/// trust the order as given and don't validate that every id is a currently
/// joined space (leaving stale ids is usually harmless and self-healing).
#[tauri::command]
pub async fn set_space_order(
    state: State<'_, Arc<AppState>>,
    order: Vec<String>,
) -> Result<(), String> {
    // Basic sanity: a billion-entry payload would be abuse, not genuine use.
    if order.len() > 10_000 {
        return Err("Refusing to write an unreasonably large space order list.".to_string());
    }

    let _guard = SPACE_ORDER_LOCK.lock().await;
    let state_ref: &AppState = &state;

    // Read-modify-write so we can preserve any `extra` fields future Pax
    // versions might have added (additive migration safety).
    let existing = fetch_account_data_raw(state_ref, SPACE_ORDER_TYPE).await?;
    let mut parsed: SpaceOrderContent = existing
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    parsed.order = order;

    let body = serde_json::to_value(&parsed)
        .map_err(|e| format!("Failed to serialise space order: {e}"))?;

    put_account_data_raw(state_ref, SPACE_ORDER_TYPE, &body).await
}