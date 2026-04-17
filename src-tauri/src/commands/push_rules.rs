//! Matrix push-rule plumbing.
//!
//! Thin HTTP wrappers over the Matrix Client-Server push-rules API
//! (`/_matrix/client/v3/pushrules/…`).  All endpoints live under scope
//! `global` — Matrix only defines per-user push rules.  "Room" and "sender"
//! are *kinds* of rules (keyed by room ID / MXID); there's no per-room
//! *scope* in the protocol sense.
//!
//! matrix-sdk 0.16 exposes some push-rule helpers via `client.account()` but
//! falls short for our needs (updating `enabled` in isolation, preserving
//! unknown fields on round-trip, PUTing arbitrary actions).  We go direct via
//! `state.http_client` — same pattern as `commands::presence::sync_presence`.
//!
//! Higher-level concepts — notification *levels* like "All", "UserMentions",
//! etc. — are not in this module.  Those will live in
//! `commands::notification_levels` (Pass 2) and synthesise onto the primitives
//! here.  Keeping this module purely mechanical means the synthesis layer can
//! be unit-tested against a mock ruleset without any HTTP.
//!
//! ### Rule ID namespacing
//!
//! Pax-managed rules are prefixed `pax.*` (e.g. `pax.room_mute.!foo:server`).
//! The reconciler filters to that namespace so it won't touch user-authored
//! rules or rules Element installed.  Not enforced at this layer — this
//! module will PUT/DELETE whatever it's asked to — but worth stating.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::AppState;

use super::{fmt_error_chain, get_client};

// ---------- Helpers ----------

/// Return `(homeserver_base, access_token)` for the current session.
async fn hs_auth(state: &AppState) -> Result<(String, String), String> {
    let client = get_client(state).await?;
    let access_token = client
        .access_token()
        .ok_or_else(|| "No access token".to_string())?;
    let hs = client.homeserver().to_string();
    let hs = hs.trim_end_matches('/').to_string();
    Ok((hs, access_token))
}

/// Validate a push-rule kind against the five kinds the spec defines.
fn validate_kind(kind: &str) -> Result<&str, String> {
    match kind {
        "override" | "content" | "room" | "sender" | "underride" => Ok(kind),
        other => Err(format!("Invalid push rule kind: {other}")),
    }
}

/// Non-command helper used by both `get_push_rules` and the `.m.rule.master`
/// reader below so the latter doesn't need to go through the Tauri State layer.
async fn load_push_rules(state: &AppState) -> Result<Value, String> {
    let (hs, token) = hs_auth(state).await?;
    let url = format!("{hs}/_matrix/client/v3/pushrules/");
    let resp = state
        .http_client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch push rules: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GET pushrules failed: HTTP {status} — {body}"));
    }

    resp.json::<Value>()
        .await
        .map_err(|e| format!("Malformed pushrules response: {}", fmt_error_chain(&e)))
}

/// Non-command helper so `set_notifications_enabled_globally` can drive the
/// master rule without going through the Tauri command layer.
async fn do_set_push_rule_enabled(
    state: &AppState,
    kind: &str,
    rule_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let kind = validate_kind(kind)?;
    let (hs, token) = hs_auth(state).await?;
    let encoded_rule = urlencoding::encode(rule_id);
    let url =
        format!("{hs}/_matrix/client/v3/pushrules/global/{kind}/{encoded_rule}/enabled");

    let resp = state
        .http_client
        .put(&url)
        .bearer_auth(&token)
        .json(&serde_json::json!({ "enabled": enabled }))
        .send()
        .await
        .map_err(|e| format!("Failed to PUT push rule enabled: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "PUT pushrule/enabled failed: HTTP {status} — {body}"
        ));
    }

    Ok(())
}

// ---------- Commands: raw push-rule CRUD ----------

/// GET `/_matrix/client/v3/pushrules/` — the full ruleset for the logged-in
/// user as raw JSON.  Returned as an untyped `Value` so:
///
///   * server-extensible fields (e.g. custom conditions) aren't silently
///     stripped by a partial model;
///   * the Pass 2 classifier can read the structure directly rather than
///     going through a typed shape that would need to evolve alongside the
///     spec.
///
/// Top-level shape: `{ "global": { "override": [...], "content": [...],
/// "room": [...], "sender": [...], "underride": [...] } }`.
#[tauri::command]
pub async fn get_push_rules(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    load_push_rules(&state).await
}

/// Input for `set_push_rule`.  Which of `conditions`/`pattern` is allowed
/// depends on `kind`; the homeserver enforces the combination and returns
/// M_BAD_JSON on mismatch, which we surface verbatim.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutPushRuleInput {
    pub kind: String,
    pub rule_id: String,
    pub actions: Vec<Value>,
    /// Only meaningful for `override` / `underride`.  Dropped otherwise.
    #[serde(default)]
    pub conditions: Option<Vec<Value>>,
    /// Only meaningful for `content`.  Dropped otherwise.
    #[serde(default)]
    pub pattern: Option<String>,
    /// `?before=<ruleId>` query param — insert this rule before the named
    /// rule (same kind).  Must not reference a default (`.m.rule.*`) rule.
    #[serde(default)]
    pub before: Option<String>,
    /// `?after=<ruleId>` query param — insert after the named rule.
    #[serde(default)]
    pub after: Option<String>,
}

/// PUT `/_matrix/client/v3/pushrules/global/{kind}/{ruleId}` — create or
/// replace a user push rule.
#[tauri::command]
pub async fn set_push_rule(
    state: State<'_, Arc<AppState>>,
    input: PutPushRuleInput,
) -> Result<(), String> {
    let kind = validate_kind(&input.kind)?;
    let (hs, token) = hs_auth(&state).await?;
    let encoded_rule = urlencoding::encode(&input.rule_id);
    let url = format!("{hs}/_matrix/client/v3/pushrules/global/{kind}/{encoded_rule}");

    // Build the body with only the fields valid for this kind so the server
    // doesn't bounce the request with M_BAD_JSON.
    let mut body = serde_json::Map::new();
    body.insert("actions".into(), Value::Array(input.actions));
    if matches!(kind, "override" | "underride") {
        if let Some(conditions) = input.conditions {
            body.insert("conditions".into(), Value::Array(conditions));
        }
    }
    if kind == "content" {
        if let Some(pattern) = input.pattern {
            body.insert("pattern".into(), Value::String(pattern));
        }
    }

    let mut req = state
        .http_client
        .put(&url)
        .bearer_auth(&token)
        .json(&Value::Object(body));
    if let Some(before) = input.before.as_deref() {
        req = req.query(&[("before", before)]);
    }
    if let Some(after) = input.after.as_deref() {
        req = req.query(&[("after", after)]);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Failed to PUT push rule: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("PUT pushrule failed: HTTP {status} — {body}"));
    }

    Ok(())
}

/// DELETE `/_matrix/client/v3/pushrules/global/{kind}/{ruleId}`.
///
/// Built-in rules (those starting with `.m.`) can't be deleted — the
/// homeserver returns M_NOT_FOUND — which we propagate as an error so the
/// caller can distinguish it from success.
#[tauri::command]
pub async fn delete_push_rule(
    state: State<'_, Arc<AppState>>,
    kind: String,
    rule_id: String,
) -> Result<(), String> {
    let kind = validate_kind(&kind)?;
    let (hs, token) = hs_auth(&state).await?;
    let encoded_rule = urlencoding::encode(&rule_id);
    let url = format!("{hs}/_matrix/client/v3/pushrules/global/{kind}/{encoded_rule}");

    let resp = state
        .http_client
        .delete(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to DELETE push rule: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("DELETE pushrule failed: HTTP {status} — {body}"));
    }

    Ok(())
}

/// PUT `/_matrix/client/v3/pushrules/global/{kind}/{ruleId}/enabled`.
///
/// Independent of the rule's body — toggling this off preserves the rule's
/// actions/conditions for later.  Used by the global master toggle and, in
/// Pass 2, by the reconciler to pause Pax-managed rules without deleting.
#[tauri::command]
pub async fn set_push_rule_enabled(
    state: State<'_, Arc<AppState>>,
    kind: String,
    rule_id: String,
    enabled: bool,
) -> Result<(), String> {
    do_set_push_rule_enabled(&state, &kind, &rule_id, enabled).await
}

/// PUT `/_matrix/client/v3/pushrules/global/{kind}/{ruleId}/actions`.
///
/// Update actions without touching enabled / conditions / pattern.  Typical
/// use: flipping an existing rule between `notify` and `dont_notify`.
#[tauri::command]
pub async fn set_push_rule_actions(
    state: State<'_, Arc<AppState>>,
    kind: String,
    rule_id: String,
    actions: Vec<Value>,
) -> Result<(), String> {
    let kind = validate_kind(&kind)?;
    let (hs, token) = hs_auth(&state).await?;
    let encoded_rule = urlencoding::encode(&rule_id);
    let url =
        format!("{hs}/_matrix/client/v3/pushrules/global/{kind}/{encoded_rule}/actions");

    let resp = state
        .http_client
        .put(&url)
        .bearer_auth(&token)
        .json(&serde_json::json!({ "actions": actions }))
        .send()
        .await
        .map_err(|e| format!("Failed to PUT push rule actions: {}", fmt_error_chain(&e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "PUT pushrule/actions failed: HTTP {status} — {body}"
        ));
    }

    Ok(())
}

// ---------- Commands: global master-rule convenience ----------

/// `.m.rule.master` is a built-in override rule that ships DISABLED and, when
/// enabled, suppresses ALL notifications.  That's inverted from how users
/// think about a "notifications on/off" switch, so we wrap it.
///
///     notifications globally on   ←→  .m.rule.master is disabled (or absent)
///     notifications globally off  ←→  .m.rule.master is enabled
///
/// These two commands hide the inversion so the settings UI doesn't have to
/// carry the caveat.

/// Returns `true` when notifications are globally enabled — i.e. the master
/// rule is either disabled or absent from the ruleset.
#[tauri::command]
pub async fn get_notifications_enabled_globally(
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let rules = load_push_rules(&state).await?;
    let master = rules
        .get("global")
        .and_then(|g| g.get("override"))
        .and_then(|arr| arr.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|r| r.get("rule_id") == Some(&Value::String(".m.rule.master".into())))
        });

    let muted = master
        .and_then(|r| r.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(!muted)
}

/// Toggle the global notifications switch.  `enabled=true` disables the
/// master rule (notifications flow through); `enabled=false` enables it
/// (everything muted).
#[tauri::command]
pub async fn set_notifications_enabled_globally(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    do_set_push_rule_enabled(&state, "override", ".m.rule.master", !enabled).await
}