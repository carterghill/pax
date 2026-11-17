use super::*;
use crate::commands::auth::{
    authenticate_password, request_password_session, submit_registration, PasswordLoginError,
    SavedSession,
};
use matrix_sdk::{
    authentication::{matrix::MatrixSession, SessionTokens},
    config::RequestConfig,
    encryption::{BackupDownloadStrategy, EncryptionSettings},
    SessionMeta,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const USER: &str = "@alice:example.org";
const PASSWORD: &str = "four unrelated words 🔐";

#[test]
fn derivation_is_stable_and_domain_separated() {
    let keys = derive_sync(USER, PASSWORD).unwrap();
    // These synthetic values are frozen as the interoperability test vector.
    assert_eq!(
        keys.credential.as_str(),
        "Pax1!Ji_0bqSl8AZPOFxW2TRjlOEVDDD5doxnjTjaikh_b-U"
    );
    assert_eq!(
        URL_SAFE_NO_PAD.encode(&keys.wrapping_key[..]),
        "-jFAnBAxQShomFRiN8Gg7TVGhNV05cKXWT9QQ2PmZX4"
    );
    assert_eq!(keys.credential.len(), 48); // Below bcrypt's 72-byte limit.
    assert_ne!(
        &keys.credential[5..],
        URL_SAFE_NO_PAD.encode(&keys.wrapping_key[..])
    );
    let other = derive_sync("@alice:other.org", PASSWORD).unwrap();
    assert_ne!(*keys.credential, *other.credential);
    assert_ne!(*keys.wrapping_key, *other.wrapping_key);
    assert_ne!(
        *keys.credential,
        *derive_sync(USER, &format!("{PASSWORD} "))
            .unwrap()
            .credential
    );
}

#[test]
fn envelope_rejects_wrong_password_tampering_and_account_or_key_substitution() {
    let keys = PaxKeys {
        credential: Zeroizing::new("unused".into()),
        wrapping_key: Zeroizing::new([42; 32]),
    };
    let wrong = PaxKeys {
        credential: Zeroizing::new("unused".into()),
        wrapping_key: Zeroizing::new([43; 32]),
    };
    let envelope =
        RecoveryEnvelope::encrypt(USER, "ssss-id", "random recovery secret", &keys).unwrap();
    assert_eq!(
        envelope.decrypt(USER, "ssss-id", &keys).unwrap().as_str(),
        "random recovery secret"
    );
    assert!(envelope.decrypt(USER, "ssss-id", &wrong).is_err());
    assert!(envelope
        .decrypt("@bob:example.org", "ssss-id", &keys)
        .is_err());
    assert!(envelope.decrypt(USER, "other-id", &keys).is_err());
    let another =
        RecoveryEnvelope::encrypt(USER, "ssss-id", "random recovery secret", &keys).unwrap();
    assert_ne!(envelope.nonce, another.nonce);
    let mut edited = envelope.clone();
    let mut bytes = URL_SAFE_NO_PAD.decode(&edited.ciphertext).unwrap();
    bytes[0] ^= 1;
    edited.ciphertext = URL_SAFE_NO_PAD.encode(bytes);
    assert!(edited.decrypt(USER, "ssss-id", &keys).is_err());
    edited = envelope.clone();
    edited.credential_revision = 2;
    assert!(edited.decrypt(USER, "ssss-id", &keys).is_err());
    edited = envelope;
    edited.nonce = "bad".into();
    assert!(edited.decrypt(USER, "ssss-id", &keys).is_err());
}

// A local Matrix HTTP server, with real SDK-generated cross-signing keys,
// Secret Storage records and encrypted message-key backups. It deliberately
// knows neither the human password nor any encryption private key.
#[derive(Default)]
struct ServerState {
    requests: Vec<(String, String, Value)>,
    credential: Option<String>,
    profile: Value,
    account_data: HashMap<String, Value>,
    devices: serde_json::Map<String, Value>,
    signing: serde_json::Map<String, Value>,
    backup: Option<Value>,
    rooms: serde_json::Map<String, Value>,
    fail_envelope: bool,
    fail_signing: bool,
    login_status: Option<u16>,
    profile_status: Option<u16>,
}
struct Server {
    home: String,
    state: Arc<Mutex<ServerState>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let home = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(ServerState {
            profile: json!({}),
            ..Default::default()
        }));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let shared = shared.clone();
                tokio::spawn(async move {
                    serve(socket, shared).await;
                });
            }
        });
        Self { home, state, task }
    }
}

async fn serve(mut socket: TcpStream, state: Arc<Mutex<ServerState>>) {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let (header_len, content_len) = loop {
        let count = socket.read(&mut buffer).await.unwrap_or(0);
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > 2_000_000 {
            return;
        }
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&bytes[..end]);
            let length = header
                .lines()
                .find_map(|l| {
                    l.split_once(':')
                        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            break (end + 4, length);
        }
    };
    while bytes.len() < header_len + content_len {
        let count = socket.read(&mut buffer).await.unwrap_or(0);
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    let header = String::from_utf8_lossy(&bytes[..header_len]);
    let mut first = header.lines().next().unwrap().split_whitespace();
    let method = first.next().unwrap();
    let path = urlencoding::decode(first.next().unwrap().split('?').next().unwrap())
        .unwrap()
        .into_owned();
    let body: Value =
        serde_json::from_slice(&bytes[header_len..header_len + content_len]).unwrap_or(json!({}));
    let (status, response) = {
        let mut state = state.lock().unwrap();
        state
            .requests
            .push((method.into(), path.clone(), body.clone()));
        respond(&mut state, method, &path, &body)
    };
    let response = serde_json::to_vec(&response).unwrap();
    let header = format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len());
    let _ = socket.write_all(header.as_bytes()).await;
    let _ = socket.write_all(&response).await;
}

fn respond(s: &mut ServerState, method: &str, path: &str, body: &Value) -> (u16, Value) {
    let missing = || (404, json!({"errcode":"M_NOT_FOUND", "error":"Missing"}));
    if path.ends_with("/versions") {
        return (200, json!({"versions":["v1.16"]}));
    }
    if path == "/_matrix/key/v2/server" {
        return (200, json!({"server_name":"example.org"}));
    }
    if path.ends_with("/register") {
        let flows = json!([{"stages":["m.login.registration_token", "m.login.dummy"]}]);
        match body["auth"]["type"].as_str() {
            None => return (401, json!({"session":"registration", "flows":flows})),
            Some("m.login.registration_token") => {
                assert_eq!(body["auth"]["token"], "invite");
                return (
                    401,
                    json!({"session":"registration", "flows":flows, "completed":["m.login.registration_token"]}),
                );
            }
            _ => {
                s.credential = Some(body["password"].as_str().unwrap().into());
                return (
                    200,
                    json!({"user_id":USER,"device_id":"ORIGINAL", "access_token":"token"}),
                );
            }
        }
    }
    if path.ends_with("/login") {
        if let Some(status) = s.login_status {
            return (status, json!({"errcode":"M_LIMIT_EXCEEDED"}));
        }
        if body["password"].as_str() != s.credential.as_deref() {
            return (403, json!({"errcode":"M_FORBIDDEN"}));
        }
        return (
            200,
            json!({"user_id":USER,"device_id":body.get("device_id").cloned().unwrap_or(json!("FRESH")), "access_token":"new-token"}),
        );
    }
    if path.contains("/profile/") {
        if let Some(status) = s.profile_status {
            return (status, json!({"errcode":"M_NOT_FOUND"}));
        }
        if method == "PUT" {
            s.profile[PROFILE_FIELD] = body[PROFILE_FIELD].clone();
            return (200, json!({}));
        }
        return (200, s.profile.clone());
    }
    if let Some((_, key)) = path.split_once("/account_data/") {
        if method == "PUT" {
            if key == RECOVERY_TYPE && s.fail_envelope {
                return (400, json!({"errcode":"M_BAD_JSON"}));
            }
            s.account_data.insert(key.into(), body.clone());
            return (200, json!({}));
        }
        return s
            .account_data
            .get(key)
            .cloned()
            .map(|v| (200, v))
            .unwrap_or_else(missing);
    }
    if path.ends_with("/keys/upload") {
        if let Some(device) = body["device_keys"]["device_id"].as_str() {
            s.devices.insert(device.into(), body["device_keys"].clone());
        }
        return (200, json!({"one_time_key_counts":{"signed_curve25519":50}}));
    }
    if path.ends_with("/keys/query") {
        let mut response = json!({"failures":{}, "device_keys": {USER: s.devices}, "master_keys":{}, "self_signing_keys":{}, "user_signing_keys":{}});
        for (field, request_field) in [
            ("master_keys", "master_key"),
            ("self_signing_keys", "self_signing_key"),
            ("user_signing_keys", "user_signing_key"),
        ] {
            if let Some(value) = s.signing.get(request_field) {
                response[field][USER] = value.clone();
            }
        }
        return (200, response);
    }
    if path.ends_with("/keys/device_signing/upload") {
        if s.fail_signing {
            return (400, json!({"errcode":"M_BAD_JSON"}));
        }
        if body.get("auth").is_none() {
            return (
                401,
                json!({"session":"encryption", "flows":[{"stages":["m.login.password"]}]}),
            );
        }
        assert_eq!(body["auth"]["password"].as_str(), s.credential.as_deref());
        assert_eq!(body["auth"]["session"], "encryption");
        for field in ["master_key", "self_signing_key", "user_signing_key"] {
            if let Some(v) = body.get(field) {
                s.signing.insert(field.into(), v.clone());
            }
        }
        return (200, json!({}));
    }
    if path.ends_with("/keys/signatures/upload") {
        if let Some(objects) = body[USER].as_object() {
            for (id, signed) in objects {
                if s.devices.contains_key(id) {
                    s.devices.insert(id.clone(), signed.clone());
                }
            }
        }
        return (200, json!({"failures":{}}));
    }
    if path.contains("/room_keys/version") {
        if method == "POST" {
            s.backup = Some(body.clone());
            return (200, json!({"version":"1"}));
        }
        return s
            .backup
            .as_ref()
            .map(|b| {
                let mut v = b.clone();
                v["version"] = json!("1");
                v["count"] = json!(s.rooms.len());
                v["etag"] = json!("etag");
                (200, v)
            })
            .unwrap_or_else(missing);
    }
    if let Some((_, room)) = path.split_once("/room_keys/keys/") {
        return s
            .rooms
            .get(room)
            .cloned()
            .map(|v| (200, v))
            .unwrap_or_else(missing);
    }
    if path.ends_with("/room_keys/keys") {
        if method == "PUT" {
            if let Some(rooms) = body["rooms"].as_object() {
                s.rooms.extend(rooms.clone());
            }
            return (200, json!({"count":s.rooms.len(),"etag":"etag"}));
        }
        return (200, json!({"rooms":s.rooms}));
    }
    if path.ends_with("/sync") {
        return (
            200,
            json!({"next_batch":"s1", "rooms":{}, "device_one_time_keys_count":{"signed_curve25519":50},
            "account_data":{"events":s.account_data.iter().map(|(t,c)|json!({"type":t,"content":c})).collect::<Vec<_>>()}}),
        );
    }
    if path.contains("/sendToDevice/") {
        return (200, json!({}));
    }
    missing()
}

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pax-auth-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn client(home: &str, path: &Path, session: SavedSession) -> Client {
    let client = Client::builder()
        .homeserver_url(home)
        .sqlite_store(path, None)
        .request_config(RequestConfig::new().disable_retry())
        .with_encryption_settings(EncryptionSettings {
            auto_enable_cross_signing: false,
            auto_enable_backups: false,
            backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
        })
        .build()
        .await
        .unwrap();
    client
        .restore_session(MatrixSession {
            meta: SessionMeta {
                user_id: USER.try_into().unwrap(),
                device_id: session.device_id.into(),
            },
            tokens: SessionTokens {
                access_token: session.access_token,
                refresh_token: None,
            },
        })
        .await
        .unwrap();
    client
        .sync_once(matrix_sdk::config::SyncSettings::default())
        .await
        .unwrap();
    client
}

#[tokio::test]
async fn signup_and_new_device_restore_real_encrypted_room_keys() {
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        let server = Server::start().await;
        let http = reqwest::Client::new();
        check_profile_support(&http, &server.home).await.unwrap();
        assert_eq!(
            account_id(&http, &server.home, "alice", &AuthConfig::default())
                .await
                .unwrap(),
            USER
        );
        let keys = derive(USER, PASSWORD).await.unwrap();
        let session = submit_registration(&http, &server.home, "alice", &keys.credential, "invite")
            .await
            .unwrap();
        let dir = TestDir::new();
        let original = client(&server.home, &dir.0.join("original"), session).await;
        publish(
            &http,
            &original,
            &Descriptor::new(USER, AccountMode::Pax, false),
        )
        .await
        .unwrap();
        complete_enrollment(&http, &original, &keys, true)
            .await
            .unwrap();
        assert_eq!(
            discover(&http, &server.home, USER)
                .await
                .unwrap()
                .unwrap()
                .state,
            "ready"
        );
        let fixture = dir.0.join("fixture.enc");
        std::fs::write(&fixture, include_str!("fixtures/test-room-key-export.txt")).unwrap();
        let imported = original
            .encryption()
            .import_room_keys(fixture.clone(), "1234")
            .await
            .unwrap();
        assert_eq!(imported.imported_count, 1);
        let room = imported.keys.keys().next().unwrap().clone();
        original
            .encryption()
            .backups()
            .wait_for_steady_state()
            .with_delay(std::time::Duration::from_millis(1))
            .await
            .unwrap();
        assert!(!server.state.lock().unwrap().rooms.is_empty());
        drop(original);
        let authentication = authenticate_password(
            &http,
            &server.home,
            USER,
            PASSWORD,
            None,
            &AuthConfig::default(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(authentication.mode, AccountMode::Pax);
        let fresh_keys = authentication.keys.unwrap();
        let fresh = client(&server.home, &dir.0.join("fresh"), authentication.session).await;
        let envelope = fetch_envelope(&fresh).await.unwrap().unwrap();
        unlock(&fresh, &fresh_keys, &envelope).await.unwrap();
        fresh
            .encryption()
            .backups()
            .download_room_keys_for_room(&room)
            .await
            .unwrap();
        assert_eq!(
            fresh
                .encryption()
                .import_room_keys(fixture, "1234")
                .await
                .unwrap()
                .imported_count,
            0,
            "The old room key must already be present from the encrypted server backup"
        );
        let requests = &server.state.lock().unwrap().requests;
        assert!(
            !serde_json::to_string(requests).unwrap().contains(PASSWORD),
            "The memorable password must never leave a Pax client"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(_, p, _)| p.ends_with("/register"))
                .count(),
            3
        );
        assert!(
            requests
                .iter()
                .any(|(_, p, b)| p.ends_with("/keys/device_signing/upload")
                    && b.get("auth").is_some())
        );
    })
    .await
    .expect("Pax registration/recovery should not hang");
}

#[tokio::test]
async fn interrupted_enrollment_preserves_identity_and_needs_original_device() {
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        let server = Server::start().await;
        let http = reqwest::Client::new();
        let keys = derive(USER,PASSWORD).await.unwrap();
        let session = submit_registration(&http,&server.home,"alice",&keys.credential,"invite").await.unwrap();
        let dir = TestDir::new();
        let original = client(&server.home,&dir.0.join("original"),session.clone()).await;
        // Crash/failure after private keys were generated but before upload.
        server.state.lock().unwrap().fail_signing = true;
        assert!(complete_enrollment(&http,&original,&keys,true).await.is_err());
        let first_master = server.state.lock().unwrap().requests.iter()
            .find(|(_,p,_)|p.ends_with("/keys/device_signing/upload")).unwrap().2["master_key"].clone();
        drop(original);
        let original = client(&server.home,&dir.0.join("original"),session.clone()).await;
        server.state.lock().unwrap().fail_signing = false;
        server.state.lock().unwrap().fail_envelope = true;
        assert!(complete_enrollment(&http,&original,&keys,true).await.is_err());
        assert_eq!(server.state.lock().unwrap().signing["master_key"],first_master,
            "Resumption must upload the same identity, not silently keep it local or generate a replacement");
        let identity = server.state.lock().unwrap().signing.clone();
        let backup = server.state.lock().unwrap().backup.clone();
        drop(original);
        let original = client(&server.home,&dir.0.join("original"),session).await;
        let fresh_session = request_password_session(&http,&server.home,USER,&keys.credential,None).await.unwrap();
        let fresh = client(&server.home,&dir.0.join("fresh"),fresh_session).await;
        assert!(complete_enrollment(&http,&fresh,&keys,false).await.unwrap_err().contains("computer where you created"));
        assert!(complete_enrollment(&http,&fresh,&keys,true).await.unwrap_err().contains("original encryption identity"));
        server.state.lock().unwrap().fail_envelope = false;
        complete_enrollment(&http,&original,&keys,true).await.unwrap();
        assert_eq!(server.state.lock().unwrap().signing,identity);
        assert_eq!(server.state.lock().unwrap().backup,backup);
        let envelope = fetch_envelope(&fresh).await.unwrap().unwrap();
        unlock(&fresh,&keys,&envelope).await.unwrap();
    }).await.expect("Interrupted setup should remain resumable");
}

#[tokio::test]
async fn discovery_and_login_errors_are_not_legacy_credentials() {
    let server = Server::start().await;
    let http = reqwest::Client::new();
    let mut descriptor =
        serde_json::to_value(Descriptor::new(USER, AccountMode::Pax, true)).unwrap();
    descriptor["derivation_profile"] = json!("unsupported");
    server.state.lock().unwrap().profile = json!({PROFILE_FIELD:descriptor});
    assert!(discover(&http, &server.home, USER).await.is_err());
    server.state.lock().unwrap().profile = json!({PROFILE_FIELD:null});
    assert!(discover(&http, &server.home, USER).await.is_err());
    server.state.lock().unwrap().login_status = Some(429);
    assert!(matches!(
        request_password_session(&http, &server.home, USER, "credential", None).await,
        Err(PasswordLoginError::Other(_))
    ));
    server.state.lock().unwrap().login_status = None;
    assert!(matches!(
        request_password_session(&http, &server.home, USER, "credential", None).await,
        Err(PasswordLoginError::Rejected)
    ));
}

#[tokio::test]
async fn automatic_login_preserves_standard_accounts_and_refuses_downgrades() {
    let server = Server::start().await;
    let http = reqwest::Client::new();
    let config = AuthConfig::default();
    // A real older account with no marker is detected automatically. The raw
    // password is sent only after a successful profile read and M_FORBIDDEN.
    submit_registration(&http, &server.home, "alice", PASSWORD, "invite")
        .await
        .unwrap();
    let standard = authenticate_password(&http, &server.home, USER, PASSWORD, None, &config, false)
        .await
        .unwrap();
    assert_eq!(standard.mode, AccountMode::Matrix);
    assert!(standard.keys.is_none());
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, p, _)| p.ends_with("/login"))
            .count(),
        2
    );
    server.state.lock().unwrap().requests.clear();
    server.state.lock().unwrap().profile =
        json!({PROFILE_FIELD:Descriptor::new(USER,AccountMode::Matrix,true)});
    assert_eq!(
        authenticate_password(&http, &server.home, USER, PASSWORD, None, &config, false)
            .await
            .unwrap()
            .mode,
        AccountMode::Matrix
    );
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, p, _)| p.ends_with("/login"))
            .count(),
        1
    );
    server.state.lock().unwrap().requests.clear();
    assert!(
        authenticate_password(&http, &server.home, USER, PASSWORD, None, &config, true)
            .await
            .is_err()
    );
    assert!(!server
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(_, p, _)| p.ends_with("/login")));

    // A Pax marker never allows ordinary-password fallback, even if the raw
    // human password would actually authenticate on this lying test server.
    server.state.lock().unwrap().profile =
        json!({PROFILE_FIELD:Descriptor::new(USER,AccountMode::Pax,true)});
    server.state.lock().unwrap().requests.clear();
    assert!(
        authenticate_password(&http, &server.home, USER, PASSWORD, None, &config, false)
            .await
            .is_err()
    );
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, p, _)| p.ends_with("/login"))
            .count(),
        1
    );
    assert!(
        !serde_json::to_string(&server.state.lock().unwrap().requests)
            .unwrap()
            .contains(PASSWORD)
    );

    server.state.lock().unwrap().profile = json!({});
    for status in [429, 500] {
        server.state.lock().unwrap().requests.clear();
        server.state.lock().unwrap().login_status = Some(status);
        assert!(
            authenticate_password(&http, &server.home, USER, PASSWORD, None, &config, false)
                .await
                .is_err()
        );
        assert_eq!(
            server
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|(_, p, _)| p.ends_with("/login"))
                .count(),
            1
        );
        assert!(
            !serde_json::to_string(&server.state.lock().unwrap().requests)
                .unwrap()
                .contains(PASSWORD)
        );
    }
    server.state.lock().unwrap().login_status = None;
    server.state.lock().unwrap().profile_status = Some(404);
    server.state.lock().unwrap().requests.clear();
    assert!(
        authenticate_password(&http, &server.home, USER, PASSWORD, None, &config, false)
            .await
            .is_err()
    );
    assert!(!server
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(_, p, _)| p.ends_with("/login")));
    // Locally pinned enrollment can resume without its failed public write.
    let keys = derive(USER, PASSWORD).await.unwrap();
    server.state.lock().unwrap().credential = Some(keys.credential.to_string());
    assert_eq!(
        authenticate_password(&http, &server.home, USER, PASSWORD, None, &config, true)
            .await
            .unwrap()
            .mode,
        AccountMode::Pax
    );
    assert!(
        !serde_json::to_string(&server.state.lock().unwrap().requests)
            .unwrap()
            .contains(PASSWORD)
    );
    server.state.lock().unwrap().profile_status = None;
    server.state.lock().unwrap().profile = json!({PROFILE_FIELD:{"schema_version":999}});
    server.state.lock().unwrap().requests.clear();
    assert!(
        authenticate_password(&http, &server.home, USER, PASSWORD, None, &config, true)
            .await
            .is_err()
    );
    assert!(!server
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(_, p, _)| p.ends_with("/login")));
}
