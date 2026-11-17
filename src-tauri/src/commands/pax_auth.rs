//! Versioned Pax credentials and encrypted Matrix recovery. The human password
//! is never an authentication field for a Pax account. Discovery is unsigned
//! in this first version and is restricted to the configured trusted server.

use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, Password, UserIdentifier};
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use zeroize::Zeroizing;

use crate::AuthConfig;

pub const PROFILE_FIELD: &str = "com.carter.pax.authentication";
pub const RECOVERY_TYPE: &str = "com.carter.pax.recovery";
pub const DERIVATION_PROFILE: &str = "pax-password-v1";

#[cfg(test)]
#[path = "pax_auth_tests.rs"]
mod tests;

#[derive(Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum AccountMode {
    #[default]
    #[serde(rename = "matrix-password")]
    Matrix,
    #[serde(rename = "pax-password")]
    Pax,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Descriptor {
    pub schema_version: u32,
    pub user_id: String,
    pub mode: AccountMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derivation_profile: Option<String>,
    pub credential_revision: u32,
    pub state: String,
}

impl Descriptor {
    pub fn new(user_id: &str, mode: AccountMode, ready: bool) -> Self {
        Self {
            schema_version: 1,
            user_id: user_id.into(),
            mode,
            derivation_profile: (mode == AccountMode::Pax).then(|| DERIVATION_PROFILE.into()),
            credential_revision: 1,
            state: if ready { "ready" } else { "pending" }.into(),
        }
    }

    pub fn validate(&self, expected_user: &str) -> Result<(), String> {
        if self.schema_version != 1
            || self.user_id != expected_user
            || self.credential_revision != 1
            || !matches!(self.state.as_str(), "pending" | "ready")
            || (self.mode == AccountMode::Pax
                && self.derivation_profile.as_deref() != Some(DERIVATION_PROFILE))
            || (self.mode == AccountMode::Matrix && self.derivation_profile.is_some())
        {
            return Err(
                "This account's sign-in settings are invalid or require a newer version of Pax."
                    .into(),
            );
        }
        Ok(())
    }
}

// Deliberately no Debug or Serialize implementation for derived secrets.
pub struct PaxKeys {
    pub credential: Zeroizing<String>,
    wrapping_key: Zeroizing<[u8; 32]>,
}

fn derive_sync(user_id: &str, password: &str) -> Result<PaxKeys, String> {
    let salt_input =
        serde_json::to_vec(&["pax.password-salt", "v1", user_id]).map_err(|e| e.to_string())?;
    let salt = Sha256::digest(salt_input);
    let params = Params::new(65_536, 3, 1, Some(32))
        .map_err(|_| "Invalid password derivation parameters")?;
    let mut master = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, &mut master[..])
        .map_err(|_| "Could not derive account credentials")?;
    let hkdf = Hkdf::<Sha256>::new(Some(b"pax.hkdf.v1"), &master[..]);
    let mut auth = Zeroizing::new([0u8; 32]);
    let mut wrapping_key = Zeroizing::new([0u8; 32]);
    hkdf.expand(
        &serde_json::to_vec(&["pax.matrix-login", "v1", user_id]).unwrap(),
        &mut auth[..],
    )
    .map_err(|_| "Could not derive login credential")?;
    hkdf.expand(
        &serde_json::to_vec(&["pax.recovery-unlock", "v1", user_id]).unwrap(),
        &mut wrapping_key[..],
    )
    .map_err(|_| "Could not derive recovery key")?;
    Ok(PaxKeys {
        credential: Zeroizing::new(format!("Pax1!{}", URL_SAFE_NO_PAD.encode(&auth[..]))),
        wrapping_key,
    })
}

pub async fn derive(user_id: &str, password: &str) -> Result<PaxKeys, String> {
    let user_id = user_id.to_owned();
    let password = Zeroizing::new(password.to_owned());
    tokio::task::spawn_blocking(move || derive_sync(&user_id, &password))
        .await
        .map_err(|_| "Password derivation could not finish".to_string())?
}

#[derive(Clone, Deserialize, Serialize)]
pub struct RecoveryEnvelope {
    schema_version: u32,
    user_id: String,
    derivation_profile: String,
    credential_revision: u32,
    secret_storage_key_id: String,
    nonce: String,
    ciphertext: String,
}

impl RecoveryEnvelope {
    fn aad(user_id: &str, key_id: &str) -> Vec<u8> {
        serde_json::to_vec(&[
            "pax.recovery-envelope",
            "v1",
            user_id,
            DERIVATION_PROFILE,
            "1",
            key_id,
        ])
        .unwrap()
    }

    pub fn encrypt(
        user_id: &str,
        key_id: &str,
        recovery_key: &str,
        keys: &PaxKeys,
    ) -> Result<Self, String> {
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let cipher = XChaCha20Poly1305::new_from_slice(&keys.wrapping_key[..]).unwrap();
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: recovery_key.as_bytes(),
                    aad: &Self::aad(user_id, key_id),
                },
            )
            .map_err(|_| "Could not protect account recovery")?;
        Ok(Self {
            schema_version: 1,
            user_id: user_id.into(),
            derivation_profile: DERIVATION_PROFILE.into(),
            credential_revision: 1,
            secret_storage_key_id: key_id.into(),
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        })
    }

    pub fn decrypt(
        &self,
        user_id: &str,
        key_id: &str,
        keys: &PaxKeys,
    ) -> Result<Zeroizing<String>, String> {
        if self.schema_version != 1
            || self.user_id != user_id
            || self.derivation_profile != DERIVATION_PROFILE
            || self.credential_revision != 1
            || self.secret_storage_key_id != key_id
            || self.ciphertext.len() > 4096
        {
            return Err("The account recovery record does not match this account.".into());
        }
        let nonce = URL_SAFE_NO_PAD
            .decode(&self.nonce)
            .map_err(|_| "Invalid recovery record")?;
        if nonce.len() != 24 {
            return Err("Invalid recovery record".into());
        }
        let ciphertext = URL_SAFE_NO_PAD
            .decode(&self.ciphertext)
            .map_err(|_| "Invalid recovery record")?;
        let cipher = XChaCha20Poly1305::new_from_slice(&keys.wrapping_key[..]).unwrap();
        let decrypted = cipher.decrypt(
            XNonce::from_slice(&nonce),
            Payload { msg: &ciphertext, aad: &Self::aad(user_id, key_id) },
        ).map_err(|_| "Could not unlock account recovery. Check your password; the original encryption data has been preserved.")?;
        let plain = Zeroizing::new(decrypted);
        std::str::from_utf8(&plain)
            .map(|s| Zeroizing::new(s.to_owned()))
            .map_err(|_| "Invalid recovery secret".into())
    }
}

/// No secret fields: this file is both a setup journal and a local pin against
/// downgrading a previously enrolled account to ordinary password authentication.
#[derive(Clone, Deserialize, Serialize)]
pub struct Enrollment {
    pub user_id: String,
    pub homeserver: String,
    pub store_dir: String,
    pub device_id: Option<String>,
    pub registered: bool,
    pub ready: bool,
}

fn record_path(app: &tauri::AppHandle, home: &str, user_id: &str) -> Result<PathBuf, String> {
    let name = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("{}\0{user_id}", home.trim_end_matches('/')).as_bytes(),
    );
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pax_accounts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{name}.json")))
}

pub fn read_enrollment(
    app: &tauri::AppHandle,
    home: &str,
    user_id: &str,
) -> Result<Option<Enrollment>, String> {
    let path = record_path(app, home, user_id)?;
    match std::fs::read(path) {
        Ok(bytes) => {
            let record: Enrollment = serde_json::from_slice(&bytes)
                .map_err(|_| "Could not read account setup progress")?;
            if record.user_id != user_id
                || record.homeserver.trim_end_matches('/') != home.trim_end_matches('/')
                || Path::new(&record.store_dir).is_absolute()
                || Path::new(&record.store_dir)
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err("Invalid account setup progress".into());
            }
            Ok(Some(record))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read account setup progress".into()),
    }
}

pub fn save_enrollment(app: &tauri::AppHandle, record: &Enrollment) -> Result<(), String> {
    let path = record_path(app, &record.homeserver, &record.user_id)?;
    atomic_write(
        &path,
        &serde_json::to_vec(record).map_err(|e| e.to_string())?,
    )
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map_err(|_| {
        "Could not save account setup progress. Your encryption store has been preserved.".into()
    })
}

pub fn ensure_trusted(home: &str, config: &AuthConfig) -> Result<(), String> {
    if let Some(default) = &config.default_homeserver {
        if default.trim_end_matches('/') != home.trim_end_matches('/') {
            return Err("Pax sign-in is currently available on the configured Pax homeserver. Standard Matrix sign-up is available for other servers.".into());
        }
    }
    let url = reqwest::Url::parse(home).map_err(|_| "Enter a valid homeserver URL")?;
    if url.scheme() != "https" && !(cfg!(test) && url.scheme() == "http") {
        return Err("Pax sign-in requires an HTTPS homeserver.".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Enter a homeserver URL without credentials, a query, or a fragment.".into());
    }
    Ok(())
}

pub async fn account_id(
    http: &reqwest::Client,
    home: &str,
    username: &str,
    config: &AuthConfig,
) -> Result<String, String> {
    let username = username.trim();
    if username.starts_with('@') {
        return matrix_sdk::ruma::UserId::parse(username)
            .map(|id| id.to_string())
            .map_err(|_| "Enter a valid Matrix account ID".into());
    }
    let server_name = if config
        .default_homeserver
        .as_deref()
        .is_some_and(|h| h.trim_end_matches('/') == home.trim_end_matches('/'))
        && config.server_name.is_some()
    {
        config.server_name.clone().unwrap()
    } else {
        let response = http
            .get(format!(
                "{}/_matrix/key/v2/server",
                home.trim_end_matches('/')
            ))
            .timeout(std::time::Duration::from_secs(12))
            .send()
            .await
            .map_err(|_| {
                "Could not look up this homeserver's account domain. Check your connection."
            })?;
        if !response.status().is_success() {
            return Err("Could not determine this homeserver's account domain. Configure PAX_SERVER_NAME or use your full Matrix account ID when signing in.".into());
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| "Invalid homeserver discovery response")?;
        value
            .get("server_name")
            .and_then(Value::as_str)
            .ok_or("Homeserver discovery did not include its account domain")?
            .into()
    };
    matrix_sdk::ruma::UserId::parse(format!("@{username}:{server_name}"))
        .map(|id| id.to_string())
        .map_err(|_| "Enter a valid account name".into())
}

pub async fn check_profile_support(http: &reqwest::Client, home: &str) -> Result<(), String> {
    let response = http
        .get(format!(
            "{}/_matrix/client/versions",
            home.trim_end_matches('/')
        ))
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|_| "Could not check homeserver support")?;
    if !response.status().is_success() {
        return Err("Could not check homeserver support".into());
    }
    let versions: Value = response
        .json()
        .await
        .map_err(|_| "Invalid homeserver support response")?;
    let supported = versions["versions"].as_array().is_some_and(|versions| {
        versions.iter().any(|v| {
            let Some(version) = v.as_str().and_then(|v| v.strip_prefix('v')) else {
                return false;
            };
            let mut parts = version.split('.').filter_map(|v| v.parse::<u32>().ok());
            match (parts.next(), parts.next()) {
                (Some(major), Some(minor)) => major > 1 || (major == 1 && minor >= 16),
                _ => false,
            }
        })
    });
    if !supported {
        return Err("This homeserver must support Matrix 1.16 custom profile fields for Pax sign-up. Standard Matrix sign-up is still available.".into());
    }
    Ok(())
}

#[derive(Debug)]
pub enum DiscoveryError {
    Unavailable(String),
    Invalid(String),
}
impl From<DiscoveryError> for String {
    fn from(error: DiscoveryError) -> Self {
        match error {
            DiscoveryError::Unavailable(message) | DiscoveryError::Invalid(message) => message,
        }
    }
}

pub async fn discover(
    http: &reqwest::Client,
    home: &str,
    user_id: &str,
) -> Result<Option<Descriptor>, DiscoveryError> {
    use DiscoveryError::{Invalid, Unavailable};
    let response = http
        .get(format!(
            "{}/_matrix/client/v3/profile/{}",
            home.trim_end_matches('/'),
            urlencoding::encode(user_id)
        ))
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|_| {
            Unavailable("Could not check account sign-in settings. Check your connection.".into())
        })?;
    if !response.status().is_success() {
        return Err(Unavailable(
            "Could not read account sign-in settings. Check the account name and try again.".into(),
        ));
    }
    let profile: Value = response
        .json()
        .await
        .map_err(|_| Invalid("Invalid account profile response".into()))?;
    if !profile.is_object() {
        return Err(Invalid("Invalid account profile response".into()));
    }
    match profile.get(PROFILE_FIELD) {
        None => Ok(None),
        Some(value) => {
            let descriptor: Descriptor = serde_json::from_value(value.clone())
                .map_err(|_| Invalid("Invalid account sign-in settings".into()))?;
            descriptor.validate(user_id).map_err(Invalid)?;
            Ok(Some(descriptor))
        }
    }
}

pub async fn publish(
    http: &reqwest::Client,
    client: &Client,
    descriptor: &Descriptor,
) -> Result<(), String> {
    descriptor.validate(client.user_id().ok_or("Not logged in")?.as_str())?;
    let response = http
        .put(format!(
            "{}/_matrix/client/v3/profile/{}/{}",
            client.homeserver().as_str().trim_end_matches('/'),
            urlencoding::encode(&descriptor.user_id),
            PROFILE_FIELD
        ))
        .bearer_auth(client.access_token().ok_or("Not logged in")?)
        .timeout(std::time::Duration::from_secs(15))
        .json(&json!({ PROFILE_FIELD: descriptor }))
        .send()
        .await
        .map_err(|_| "Could not save account sign-in settings")?;
    if !response.status().is_success() {
        return Err("This homeserver could not save custom profile fields. The account and its local encryption keys have been preserved.".into());
    }
    let verified = discover(http, client.homeserver().as_str(), &descriptor.user_id)
        .await?
        .ok_or("The homeserver did not retain the account sign-in settings")?;
    if serde_json::to_value(&verified).unwrap() != serde_json::to_value(descriptor).unwrap() {
        return Err("The homeserver returned inconsistent sign-in settings".into());
    }
    Ok(())
}

async fn secret_key_id(client: &Client) -> Result<String, String> {
    let raw = client
        .encryption()
        .secret_storage()
        .fetch_default_key_id()
        .await
        .map_err(|_| "Could not check encrypted recovery storage")?
        .ok_or("Encrypted recovery storage is missing")?;
    raw.deserialize()
        .map(|data| data.key_id)
        .map_err(|_| "Invalid encrypted recovery storage".into())
}

pub async fn fetch_envelope(client: &Client) -> Result<Option<RecoveryEnvelope>, String> {
    let raw = client
        .account()
        .fetch_account_data(matrix_sdk::ruma::events::GlobalAccountDataEventType::from(
            RECOVERY_TYPE,
        ))
        .await
        .map_err(|_| "Could not download account recovery information")?;
    raw.map(|raw| {
        serde_json::from_str(raw.json().get())
            .map_err(|_| "Invalid account recovery information".into())
    })
    .transpose()
}

pub async fn unlock(
    client: &Client,
    keys: &PaxKeys,
    envelope: &RecoveryEnvelope,
) -> Result<(), String> {
    let user_id = client.user_id().ok_or("Not logged in")?;
    let key_id = secret_key_id(client).await?;
    let recovery_key = envelope.decrypt(user_id.as_str(), &key_id, keys)?;
    client.encryption().recovery().recover(&recovery_key).await
        .map_err(|_| "Sign-in succeeded, but encrypted history could not be restored. Your encryption data has been preserved.")?;
    if !client
        .encryption()
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete())
    {
        return Err("Sign-in succeeded, but the encryption identity could not be restored. Your existing encryption data has been preserved.".into());
    }
    if !client.encryption().backups().are_enabled().await {
        return Err("Sign-in succeeded, but the message-key backup could not be unlocked. Your existing encryption data has been preserved.".into());
    }
    Ok(())
}

pub async fn bootstrap_identity(client: &Client, credential: &str) -> Result<(), String> {
    client
        .encryption()
        .wait_for_e2ee_initialization_tasks()
        .await;
    let user_id = client.user_id().ok_or("Not logged in")?;
    let has_identity = client
        .encryption()
        .request_user_identity(user_id)
        .await
        .map_err(|_| "Could not check your existing encryption identity")?
        .is_some();
    let complete = client
        .encryption()
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete());
    if has_identity && !complete {
        return Err("The original encryption identity is unavailable. Your existing encryption data has been preserved.".into());
    }
    // Re-upload the same locally held keys on resumption, too: an earlier
    // request may have generated them without reaching the server. The SDK's
    // `if_needed` helper only inspects local identity existence.
    if let Err(error) = client.encryption().bootstrap_cross_signing(None).await {
        let challenge = error
            .as_uiaa_response()
            .ok_or("Could not initialize your encryption identity")?;
        let mut auth = Password::new(
            UserIdentifier::UserIdOrLocalpart(client.user_id().ok_or("Not logged in")?.to_string()),
            credential.to_owned(),
        );
        auth.session = challenge.session.clone();
        // This API reuses those keys (it does not reset the identity).
        client
            .encryption()
            .bootstrap_cross_signing(Some(AuthData::Password(auth)))
            .await
            .map_err(|_| "Could not verify encryption setup with the homeserver")?;
    }
    if !client
        .encryption()
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete())
    {
        return Err("The original encryption identity is unavailable. Your existing encryption data has been preserved.".into());
    }
    Ok(())
}

/// Creation is authorized only by a confirmed local registration journal. A
/// missing envelope on an established account must never create a new identity.
pub async fn complete_enrollment(
    http: &reqwest::Client,
    client: &Client,
    keys: &PaxKeys,
    locally_registered: bool,
) -> Result<(), String> {
    let user_id = client.user_id().ok_or("Not logged in")?.as_str();
    if let Some(envelope) = fetch_envelope(client).await? {
        unlock(client, keys, &envelope).await?;
    } else {
        if !locally_registered {
            return Err("Finish account setup on the computer where you created it. No recovery information has been replaced.".into());
        }
        bootstrap_identity(client, &keys.credential).await?;
        let recovery = client.encryption().recovery();
        let recovery_key = Zeroizing::new(
            if client
                .encryption()
                .secret_storage()
                .is_enabled()
                .await
                .map_err(|_| "Could not check recovery setup")?
            {
                if !client.encryption().backups().are_enabled().await {
                    return Err(
                        "The existing key backup must be restored before setup can continue."
                            .into(),
                    );
                }
                // Resume only this newly registered account's interrupted setup.
                // Preserve all underlying identity and message-backup keys.
                recovery
                    .reset_key()
                    .await
                    .map_err(|_| "Could not resume encrypted recovery setup")?
            } else {
                recovery
                    .enable()
                    .await
                    .map_err(|_| "Could not initialize encrypted recovery")?
            },
        );
        let key_id = secret_key_id(client).await?;
        let envelope = RecoveryEnvelope::encrypt(user_id, &key_id, &recovery_key, keys)?;
        let raw = matrix_sdk::ruma::serde::Raw::new(&envelope)
            .map_err(|_| "Could not encode account recovery")?
            .cast_unchecked();
        client
            .account()
            .set_account_data_raw(RECOVERY_TYPE.into(), raw)
            .await
            .map_err(|_| "Could not upload encrypted recovery information")?;
        let downloaded = fetch_envelope(client)
            .await?
            .ok_or("The homeserver did not retain account recovery information")?;
        unlock(client, keys, &downloaded).await?;
    }
    publish(
        http,
        client,
        &Descriptor::new(user_id, AccountMode::Pax, true),
    )
    .await
}
