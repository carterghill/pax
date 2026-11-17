use super::*;
use matrix_sdk::{
    authentication::{matrix::MatrixSession, SessionTokens},
    config::RequestConfig,
    encryption::{BackupDownloadStrategy, EncryptionSettings},
    ruma::api::MatrixVersion,
    SessionMeta,
};

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pax-history-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn client(path: &Path, device: &str) -> Client {
    let client = Client::builder()
        .homeserver_url("http://127.0.0.1:9")
        .server_versions([MatrixVersion::V1_11])
        .request_config(RequestConfig::new().disable_retry())
        .with_encryption_settings(EncryptionSettings {
            auto_enable_cross_signing: false,
            auto_enable_backups: false,
            backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
        })
        .sqlite_store(path, None)
        .build()
        .await
        .unwrap();
    client
        .restore_session(MatrixSession {
            meta: SessionMeta {
                user_id: "@alice:example.org".try_into().unwrap(),
                device_id: device.into(),
            },
            tokens: SessionTokens {
                access_token: "offline-test-token".into(),
                refresh_token: None,
            },
        })
        .await
        .unwrap();
    client
}

#[tokio::test]
async fn offline_snapshot_restores_on_a_fresh_device_without_recovery_or_identity_secrets() {
    let dir = TestDir::new();
    let original = client(&dir.0.join("original"), "ORIGINAL").await;
    let fixture = include_str!("fixtures/test-room-key-export.txt");
    assert_eq!(
        import_contents(&original, fixture, "1234")
            .await
            .unwrap()
            .imported_count,
        1
    );
    assert!(!original.encryption().backups().are_enabled().await);
    assert!(!original
        .encryption()
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete()));

    let downloads = dir.0.join("Downloads");
    let password = "a separate file password";
    let exported = export_to_directory(&original, &downloads, password)
        .await
        .unwrap();
    assert_eq!(exported.key_count, 1);
    let encrypted = fs::read_to_string(&exported.saved_path).unwrap();
    assert!(encrypted.starts_with(HEADER));
    assert!(!encrypted.contains(password));
    assert!(!encrypted.contains("session_key"));
    assert!(!encrypted.contains("@alice:example.org"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&exported.saved_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let second = export_to_directory(&original, &downloads, password)
        .await
        .unwrap();
    assert_ne!(exported.saved_path, second.saved_path);
    assert_eq!(
        fs::read_to_string(&exported.saved_path).unwrap(),
        encrypted,
        "An earlier backup must never be overwritten"
    );
    assert_eq!(
        fs::read_dir(&downloads).unwrap().count(),
        2,
        "Temporary encrypted files must be cleaned up"
    );

    let restored_path = dir.0.join("restored");
    let restored = client(&restored_path, "FRESH").await;
    assert!(require_account(&restored, "@bob:example.org").is_err());
    assert!(require_account(&restored, "@alice:example.org").is_ok());
    assert!(import_contents(&restored, &encrypted, "wrong password")
        .await
        .is_err());
    let mut tampered = STANDARD_NO_PAD
        .decode(encrypted.lines().nth(1).unwrap())
        .unwrap();
    *tampered.last_mut().unwrap() ^= 1;
    let tampered = format!("{HEADER}\n{}\n{FOOTER}", STANDARD_NO_PAD.encode(tampered));
    assert!(import_contents(&restored, &tampered, password)
        .await
        .is_err());
    let result = import_contents(&restored, &encrypted, password)
        .await
        .unwrap();
    assert_eq!(
        (result.imported_count, result.total_count),
        (1, 1),
        "Neither failed import may insert keys"
    );
    assert_eq!(result.rooms.len(), 1);
    assert!(!restored.encryption().backups().are_enabled().await);
    assert!(!restored
        .encryption()
        .cross_signing_status()
        .await
        .is_some_and(|s| s.is_complete()));
    drop(restored);
    let reopened = client(&restored_path, "FRESH").await;
    let duplicate = import_contents(&reopened, &encrypted, password)
        .await
        .unwrap();
    assert_eq!(
        (duplicate.imported_count, duplicate.total_count),
        (0, 1),
        "Restored keys must survive restart and repeated imports"
    );
    assert_eq!(
        import_contents(&original, fixture, "1234")
            .await
            .unwrap()
            .imported_count,
        0
    );
    assert!(dir.0.join("original").exists());
}

#[tokio::test]
async fn an_empty_device_or_weak_password_does_not_leave_an_unusable_backup() {
    let dir = TestDir::new();
    let empty = client(&dir.0.join("empty"), "EMPTY").await;
    let downloads = dir.0.join("Downloads");
    fs::create_dir(&downloads).unwrap();
    fs::write(downloads.join("keep.txt"), "An earlier user file").unwrap();
    assert!(export_to_directory(&empty, &downloads, "short")
        .await
        .is_err());
    assert!(
        export_to_directory(&empty, &downloads, "valid backup password")
            .await
            .err()
            .unwrap()
            .contains("No message keys")
    );
    assert_eq!(fs::read_dir(&downloads).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(downloads.join("keep.txt")).unwrap(),
        "An earlier user file"
    );
}

#[test]
fn malformed_archives_and_unbounded_password_work_are_rejected_before_decryption() {
    assert!(validate_archive("[{\"session_key\":\"plaintext\"}]").is_err());
    assert!(validate_archive(&format!("{HEADER}\nnot-base64!\n{FOOTER}")).is_err());
    let fixture = include_str!("fixtures/test-room-key-export.txt");
    assert!(validate_archive(fixture).is_ok());
    let mut bytes = STANDARD_NO_PAD
        .decode(fixture.lines().nth(1).unwrap())
        .unwrap();
    bytes[33..37].copy_from_slice(&u32::MAX.to_be_bytes());
    let expensive = format!("{HEADER}\n{}\n{FOOTER}", STANDARD_NO_PAD.encode(&bytes));
    assert!(validate_archive(&expensive)
        .unwrap_err()
        .contains("password-hardening"));
    bytes[0] = 255;
    assert!(validate_archive(&format!(
        "{HEADER}\n{}\n{FOOTER}",
        STANDARD_NO_PAD.encode(bytes)
    ))
    .is_err());
    assert!(validate_archive(&"x".repeat(MAX_ARCHIVE_BYTES + 1))
        .unwrap_err()
        .contains("64 MiB"));
}
