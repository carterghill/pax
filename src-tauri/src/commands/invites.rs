use std::{collections::BTreeSet, sync::Arc, time::Duration};

use matrix_sdk::ruma::{
    api::client::{
        account::request_openid_token,
        error::ErrorKind,
        membership::{invite_user, Invite3pidInit},
    },
    matrix_uri::{MatrixId, UriAction},
    room::JoinRuleSummary,
    thirdparty::Medium,
    MatrixToUri, MatrixUri, OwnedRoomId, OwnedServerName, RoomId, RoomOrAliasId, ServerName,
};
use matrix_sdk::RoomState;
use once_cell::sync::Lazy;
use reqwest::{Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::AppState;

use super::{get_authed_client, get_client, resolve_room, AuthedClient};

const IDENTITY_DATA: &str = "m.identity_server";
const TERMS_DATA: &str = "m.accepted_terms";
const IDENTITY_API: &str = "/_matrix/identity/v2";
static ROOM_PREVIEW_LOOKUPS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .expect("build Matrix identity HTTP client")
});

#[derive(Serialize)]
pub struct RoomShareLinks {
    matrix: String,
    pax: String,
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomLink {
    room_id: String,
    via_servers: Vec<String>,
}

fn matrix_room_link(id: &MatrixId, via: &[OwnedServerName]) -> Result<RoomLink, String> {
    let room_id = match id {
        MatrixId::Room(id) => id.to_string(),
        MatrixId::RoomAlias(alias) => alias.to_string(),
        _ => return Err("This link does not point to a Matrix room.".into()),
    };
    if via.len() > 3 {
        return Err("This link has too many Matrix routing servers.".into());
    }
    Ok(RoomLink {
        room_id,
        via_servers: via.iter().map(ToString::to_string).collect(),
    })
}

#[tauri::command]
pub async fn room_share_links(
    state: State<'_, Arc<AppState>>,
    room_id: String,
) -> Result<RoomShareLinks, String> {
    let client = get_client(&state).await?;
    let room = resolve_room(&client, &room_id)?;
    let permalink = room
        .matrix_to_permalink()
        .await
        .map_err(|_| "Could not create a room link.")?;
    let mut pax = Url::parse("pax://room").expect("valid Pax link");
    {
        let mut params = pax.query_pairs_mut();
        // Use the stable room ID even if the shareable HTTPS link uses an alias.
        params.append_pair("id", room.room_id().as_str());
        if permalink.via().is_empty() {
            if let Some(user_id) = client.user_id() {
                params.append_pair("via", user_id.server_name().as_str());
            }
        } else {
            for server in permalink.via() {
                params.append_pair("via", server.as_str());
            }
        }
    }
    Ok(RoomShareLinks {
        matrix: permalink.to_string(),
        pax: pax.into(),
    })
}

#[tauri::command]
pub fn parse_room_link(url: String) -> Result<RoomLink, String> {
    let invalid = || "This is not a valid Matrix room link.".to_owned();
    if url.len() > 4096 {
        return Err(invalid());
    }
    if let Some(fragment) = url.strip_prefix("https://matrix.to/#/") {
        let target = fragment.split('?').next().unwrap_or_default();
        if target.is_empty() || target.contains('/') {
            return Err(invalid());
        }
        let permalink = MatrixToUri::parse(&url).map_err(|_| invalid())?;
        return matrix_room_link(permalink.id(), permalink.via());
    }
    if let Some(rest) = url.strip_prefix("matrix:") {
        let path = rest.split('?').next().unwrap_or_default();
        let (kind, target) = path.split_once('/').ok_or_else(invalid)?;
        if !matches!(kind, "r" | "room" | "roomid") || target.is_empty() || target.contains('/') {
            return Err(invalid());
        }
        let permalink = MatrixUri::parse(&url).map_err(|_| invalid())?;
        if !matches!(permalink.action(), None | Some(UriAction::Join)) {
            return Err(invalid());
        }
        return matrix_room_link(permalink.id(), permalink.via());
    }
    let url = Url::parse(&url).map_err(|_| invalid())?;
    if url.scheme() != "pax"
        || url.host_str() != Some("room")
        || !matches!(url.path(), "" | "/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let mut room_id = None;
    let mut via_servers = Vec::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "id" if room_id.is_none() => {
                let id = <&RoomOrAliasId>::try_from(value.as_ref()).map_err(|_| invalid())?;
                room_id = Some(id.to_string());
            }
            "via" if via_servers.len() < 3 => {
                let server = <&ServerName>::try_from(value.as_ref()).map_err(|_| invalid())?;
                via_servers.push(server.to_string());
            }
            _ => return Err(invalid()),
        }
    }
    Ok(RoomLink {
        room_id: room_id.ok_or_else(invalid)?,
        via_servers,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRoomPreview {
    room_id: String,
    via_servers: Vec<String>,
    name: Option<String>,
    avatar_url: Option<String>,
    is_space: bool,
    membership: Option<&'static str>,
    join_rule: Option<String>,
    allowed_room_ids: Vec<OwnedRoomId>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RoomPreviewError {
    InvalidLink,
    RoomNotFound,
    Unavailable,
}

fn link_membership(state: RoomState) -> &'static str {
    match state {
        RoomState::Joined => "joined",
        RoomState::Invited => "invited",
        RoomState::Knocked => "knocked",
        RoomState::Banned => "banned",
        RoomState::Left => "left",
    }
}

#[tauri::command]
pub async fn get_linked_room_preview(
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<LinkedRoomPreview, RoomPreviewError> {
    let link = parse_room_link(url).map_err(|_| RoomPreviewError::InvalidLink)?;
    let client = get_client(&state)
        .await
        .map_err(|_| RoomPreviewError::Unavailable)?;
    let _permit = ROOM_PREVIEW_LOOKUPS
        .acquire()
        .await
        .map_err(|_| RoomPreviewError::Unavailable)?;
    let target = <&RoomOrAliasId>::try_from(link.room_id.as_str())
        .map_err(|_| RoomPreviewError::InvalidLink)?;
    let mut via: Vec<OwnedServerName> = link
        .via_servers
        .iter()
        .filter_map(|server| ServerName::parse(server).ok())
        .collect();
    let room_id = match <&RoomId>::try_from(target) {
        Ok(room_id) => room_id.to_owned(),
        Err(alias) => {
            let resolution =
                tokio::time::timeout(Duration::from_secs(5), client.resolve_room_alias(alias))
                    .await
                    .map_err(|_| RoomPreviewError::Unavailable)?
                    .map_err(|error| match error.client_api_error_kind() {
                        Some(ErrorKind::NotFound) => RoomPreviewError::RoomNotFound,
                        _ => RoomPreviewError::Unavailable,
                    })?;
            for server in resolution.servers {
                if via.len() == 3 {
                    break;
                }
                if !via.contains(&server) {
                    via.push(server);
                }
            }
            resolution.room_id
        }
    };
    let mut result = LinkedRoomPreview {
        room_id: room_id.to_string(),
        via_servers: via.iter().map(ToString::to_string).collect(),
        name: None,
        avatar_url: None,
        is_space: false,
        membership: None,
        join_rule: None,
        allowed_room_ids: Vec::new(),
    };
    // Invites come from the signed-in account's sync state. That state can already
    // include the stripped name/avatar even when the remote summary is unavailable.
    if let Some(room) = client.get_room(&room_id) {
        result.membership = Some(link_membership(room.state()));
        match room.state() {
            RoomState::Invited => {
                let ignored = state.ignored_users.users(&client).await;
                if !ignored.is_empty()
                    && room
                        .get_member_no_sync(room.own_user_id())
                        .await
                        .ok()
                        .flatten()
                        .is_some_and(|member| ignored.contains(member.event().sender()))
                {
                    result.membership = None;
                    return Ok(result);
                }
            }
            RoomState::Banned => return Ok(result),
            _ => {}
        }
        if room.state() != RoomState::Left {
            result.name = room
                .name()
                .or_else(|| room.canonical_alias().map(|alias| alias.to_string()));
            result.avatar_url = state.avatars.cached(room.avatar_url().as_deref()).await;
            result.is_space = room.is_space();
            return Ok(result);
        }
    }
    if let Ok(Ok(preview)) = tokio::time::timeout(
        Duration::from_secs(6),
        client.get_room_preview((&*room_id).into(), via),
    )
    .await
    {
        result.name = preview
            .name
            .or_else(|| preview.canonical_alias.map(|alias| alias.to_string()));
        result.is_space = preview
            .room_type
            .as_ref()
            .is_some_and(|kind| kind.as_str() == "m.space");
        result.membership = preview.state.map(link_membership).or(result.membership);
        if let Some(rule) = preview.join_rule {
            result.join_rule = Some(rule.as_str().to_owned());
            if let JoinRuleSummary::Restricted(summary) | JoinRuleSummary::KnockRestricted(summary) =
                rule
            {
                result.allowed_room_ids = summary.allowed_room_ids;
            }
        }
        if let Some(avatar) = preview.avatar_url.as_deref() {
            result.avatar_url = tokio::time::timeout(
                Duration::from_secs(2),
                state.avatars.session().load(&client, avatar),
            )
            .await
            .ok()
            .and_then(Result::ok);
        }
    }
    Ok(result)
}

fn https_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

fn identity_url(raw: &str) -> Option<Url> {
    https_url(raw).filter(|url| url.query().is_none() && url.fragment().is_none())
}

async fn matrix_json(response: Response) -> Result<Value, String> {
    let status = response.status();
    let body = response.json::<Value>().await;
    if status.is_success() {
        return body.map_err(|_| "The Matrix service returned invalid data.".to_owned());
    }
    Err(body
        .ok()
        .and_then(|body| body["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("The Matrix service returned HTTP {status}.")))
}

fn account_data_url(account: &AuthedClient, event: &str) -> Result<String, String> {
    let user_id = account.client.user_id().ok_or("Sign in first.")?;
    Ok(format!(
        "{}/_matrix/client/v3/user/{}/account_data/{event}",
        account.homeserver,
        urlencoding::encode(user_id.as_str())
    ))
}

async fn account_data(account: &AuthedClient, event: &str) -> Result<Option<Value>, String> {
    let response = HTTP
        .get(account_data_url(account, event)?)
        .bearer_auth(&account.access_token)
        .send()
        .await
        .map_err(|_| "Could not read your Matrix account settings.")?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    matrix_json(response).await.map(Some)
}

async fn identity_service(state: &AppState, account: &AuthedClient) -> Result<Url, String> {
    if let Some(settings) = account_data(account, IDENTITY_DATA).await? {
        if let Some(base_url) = settings.get("base_url") {
            return if base_url.is_null() {
                Err("Your Matrix account has disabled its identity service.".into())
            } else {
                base_url.as_str().and_then(identity_url).ok_or_else(|| {
                    "Your Matrix account has an invalid identity service URL.".to_owned()
                })
            };
        }
    }
    let user_id = account.client.user_id().ok_or("Sign in first.")?;
    let discovery = format!(
        "https://{}/.well-known/matrix/client",
        user_id.server_name()
    );
    if let Ok(response) = state
        .http_client
        .get(discovery)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        if response.status().is_success() && response.url().scheme() == "https" {
            if let Ok(config) = response.json::<Value>().await {
                if let Some(url) = config["m.identity_server"]["base_url"]
                    .as_str()
                    .and_then(identity_url)
                {
                    return Ok(url);
                }
            }
        }
    }
    Err("No Matrix identity service is configured for this account. You can share a room link or invite by Matrix ID.".into())
}

fn identity_endpoint(service: &Url, endpoint: &str) -> String {
    format!(
        "{}{IDENTITY_API}/{endpoint}",
        service.as_str().trim_end_matches('/')
    )
}

#[derive(Serialize)]
pub struct IdentityPolicy {
    name: String,
    url: String,
}

#[derive(Deserialize)]
pub struct IdentityConsent {
    service: String,
    urls: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EmailInviteResult {
    Sent,
    Terms {
        service: String,
        policies: Vec<IdentityPolicy>,
    },
}

fn policy_links(
    policies: &Value,
    accepted: &BTreeSet<String>,
) -> Result<Vec<IdentityPolicy>, String> {
    let policies = policies["policies"]
        .as_object()
        .ok_or("The Matrix identity service returned invalid terms.")?;
    let mut links = Vec::new();
    for policy in policies.values() {
        let translations = policy
            .as_object()
            .ok_or("Invalid identity service policy.")?;
        let valid = translations
            .values()
            .filter_map(|translation| {
                let name = translation["name"].as_str()?;
                let url = translation["url"].as_str()?;
                https_url(url)?;
                Some(IdentityPolicy {
                    name: name.into(),
                    url: url.into(),
                })
            })
            .collect::<Vec<_>>();
        if valid
            .iter()
            .any(|translation| accepted.contains(&translation.url))
        {
            continue;
        }
        let english = translations
            .get("en")
            .and_then(|translation| translation["url"].as_str());
        let selected = valid
            .iter()
            .position(|translation| Some(translation.url.as_str()) == english)
            .unwrap_or(0);
        let link = valid
            .into_iter()
            .nth(selected)
            .ok_or("The identity service did not supply a readable policy.")?;
        links.push(link);
    }
    Ok(links)
}

#[tauri::command]
pub async fn invite_by_email(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    email: String,
    consent: Option<IdentityConsent>,
) -> Result<EmailInviteResult, String> {
    let email = email.trim();
    if email.len() > 254
        || email.chars().any(|c| c.is_whitespace() || c.is_control())
        || !email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && !domain.is_empty() && !domain.contains('@')
        })
    {
        return Err("Enter a valid email address.".into());
    }
    let account = get_authed_client(&state).await?;
    let room = resolve_room(&account.client, &room_id)?;
    let user_id = account.client.user_id().ok_or("Sign in first.")?;
    let service = identity_service(&state, &account).await?;
    let mut accepted: BTreeSet<String> = account_data(&account, TERMS_DATA)
        .await?
        .and_then(|data| serde_json::from_value(data["accepted"].clone()).ok())
        .unwrap_or_default();
    let terms_url = identity_endpoint(&service, "terms");

    // Fetch terms before providing the service with credentials or a recipient address.
    let response = HTTP
        .get(&terms_url)
        .send()
        .await
        .map_err(|_| "Could not reach the Matrix identity service.")?;
    let policies = if response.status() == StatusCode::NOT_FOUND {
        Vec::new()
    } else {
        policy_links(&matrix_json(response).await?, &accepted)?
    };
    let urls: BTreeSet<String> = policies.iter().map(|policy| policy.url.clone()).collect();
    if !urls.is_empty()
        && !consent
            .is_some_and(|consent| consent.service == service.as_str() && consent.urls == urls)
    {
        return Ok(EmailInviteResult::Terms {
            service: service.into(),
            policies,
        });
    }

    let openid = account
        .client
        .send(request_openid_token::v3::Request::new(user_id.to_owned()))
        .await
        .map_err(|_| "Your homeserver could not authorize the Matrix identity service.")?;
    let response = HTTP
        .post(identity_endpoint(&service, "account/register"))
        .json(&json!({
            "access_token": openid.access_token,
            "expires_in": openid.expires_in.as_secs(),
            "matrix_server_name": openid.matrix_server_name,
            "token_type": openid.token_type,
        }))
        .send()
        .await
        .map_err(|_| "Could not reach the Matrix identity service.")?;
    let data = matrix_json(response).await?;
    let token = data["token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or("The Matrix identity service did not issue an access token.")?;

    if !urls.is_empty() {
        let response = HTTP
            .post(&terms_url)
            .bearer_auth(token)
            .json(&json!({ "user_accepts": urls }))
            .send()
            .await
            .map_err(|_| "Could not record your agreement with the Matrix identity service.")?;
        matrix_json(response).await?;
        accepted.extend(urls);
        let response = HTTP
            .put(account_data_url(&account, TERMS_DATA)?)
            .bearer_auth(&account.access_token)
            .json(&json!({ "accepted": accepted }))
            .send()
            .await
            .map_err(|_| "Could not save your accepted terms to your Matrix account.")?;
        matrix_json(response).await?;
    }

    let host = service.host_str().expect("validated identity service host");
    let recipient = Invite3pidInit {
        id_server: service
            .port()
            .map_or_else(|| host.to_owned(), |port| format!("{host}:{port}")),
        id_access_token: token.into(),
        medium: Medium::Email,
        address: email.into(),
    };
    account
        .client
        .send(invite_user::v3::Request::new(
            room.room_id().to_owned(),
            invite_user::v3::InvitationRecipient::ThirdPartyId(recipient.into()),
        ))
        .await
        .map_err(|error| super::fmt_error_chain(&error))?;
    Ok(EmailInviteResult::Sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_links_for_rooms_on_different_homeservers() {
        for target in [
            "!room:one.example",
            "!domainlessRoomId",
            "#alias:other.example",
        ] {
            let mut url = Url::parse("pax://room").unwrap();
            url.query_pairs_mut()
                .append_pair("id", target)
                .append_pair("via", "remote.example:8448");
            assert_eq!(
                parse_room_link(url.into()).unwrap(),
                RoomLink {
                    room_id: target.into(),
                    via_servers: vec!["remote.example:8448".into()],
                }
            );
        }
        assert_eq!(
            parse_room_link("https://matrix.to/#/%23alias:other.example?via=other.example".into())
                .unwrap(),
            RoomLink {
                room_id: "#alias:other.example".into(),
                via_servers: vec!["other.example".into()]
            },
        );
    }

    #[test]
    fn rejects_links_with_a_server_url_or_extra_parameters() {
        for url in [
            "https://one.example/invite",
            "pax://invite?id=%21room%3Aone.example",
            "pax://room?id=invalid",
            "pax://room?id=%21room%3Aone.example&via=https%3A%2F%2Fexample.org%2F",
            "pax://room?id=%21room%3Aone.example&token=unexpected",
        ] {
            assert!(parse_room_link(url.into()).is_err());
        }
    }

    #[test]
    fn terms_use_english_when_available_and_skip_previously_accepted_translations() {
        let url = "https://id.example/privacy";
        let policies = json!({"policies": {
            "privacy": {
                "fr": {"name": "Confidentialité", "url": "https://id.example/confidentialite"},
                "en": {"name": "Privacy", "url": url}, "version": "1",
            },
        }});
        let links = policy_links(&policies, &BTreeSet::new()).unwrap();
        assert_eq!(links[0].url, url);
        assert!(policy_links(
            &policies,
            &BTreeSet::from(["https://id.example/confidentialite".into()])
        )
        .unwrap()
        .is_empty());
    }
}
