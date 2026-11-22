use matrix_sdk::{
    authentication::{matrix::MatrixSession, SessionTokens},
    config::StoreConfig,
    ruma::{api::MatrixVersion, user_id},
    Client, SessionMeta,
};
use rusqlite::{Connection, OpenFlags};
use zeroize::Zeroizing;

use super::*;
use crate::commands::pax_auth::tests::TestDir;

fn key(_: &Path, _: bool) -> Result<vault::Key, String> {
    Ok(Zeroizing::new([42; 32]))
}

fn wrong_key(_: &Path, _: bool) -> Result<vault::Key, String> {
    Ok(Zeroizing::new([7; 32]))
}

fn directory() -> TestDir {
    let directory =
        TestDir(std::env::temp_dir().join(format!("pax-crypto-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&directory.0).unwrap();
    directory
}

async fn device(store: SqliteCryptoStore) -> Client {
    let client = Client::builder()
        .homeserver_url("http://127.0.0.1:9")
        .server_versions([MatrixVersion::V1_11])
        .store_config(StoreConfig::new("main".into()).crypto_store(store))
        .build()
        .await
        .unwrap();
    client
        .restore_session(MatrixSession {
            meta: SessionMeta {
                user_id: user_id!("@alice:example.org").to_owned(),
                device_id: "PAXDEVICE".into(),
            },
            tokens: SessionTokens {
                access_token: "local-test".into(),
                refresh_token: None,
            },
        })
        .await
        .unwrap();
    client
}

fn raw_account(path: &Path) -> Vec<u8> {
    let store = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    store
        .query_row("SELECT value FROM kv WHERE key = 'account'", [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[tokio::test]
async fn preserves_the_device_and_room_keys_and_reopens_the_encrypted_store_offline() {
    let dir = directory();
    let root = session_path(&dir.0, "old-session").unwrap();
    let legacy = root.join(DATABASE);
    let fixture = dir.0.join("room-keys.txt");
    fs::write(
        &fixture,
        include_bytes!("../commands/fixtures/test-room-key-export.txt"),
    )
    .unwrap();
    let original = device(SqliteCryptoStore::open(&root, None).await.unwrap()).await;
    let signing_key = original.encryption().ed25519_key().await.unwrap();
    assert_eq!(
        original
            .encryption()
            .import_room_keys(fixture.clone(), "1234")
            .await
            .unwrap()
            .imported_count,
        1
    );
    let old_record = raw_account(&legacy);
    drop(original);

    let during_conversion = open_crypto_with(&dir.0, &root, OpenMode::DeferMigration, wrong_key)
        .await
        .unwrap();
    let during_conversion = device(during_conversion).await;
    assert_eq!(
        during_conversion
            .encryption()
            .ed25519_key()
            .await
            .as_deref(),
        Some(signing_key.as_str())
    );
    assert!(legacy.exists());
    assert!(!root.join(PROTECTED).exists());
    drop(during_conversion);

    drop(
        open_crypto_with(&dir.0, &root, OpenMode::Migrate, key)
            .await
            .unwrap(),
    );
    assert!(!legacy.exists());
    assert!(!root.join(STAGING).exists());
    assert_ne!(
        raw_account(&root.join(PROTECTED).join(DATABASE)),
        old_record
    );
    assert!(
        open_crypto_with(&dir.0, &root, OpenMode::Existing, wrong_key)
            .await
            .is_err()
    );

    // Background readers and subsequent foreground opens use the same store.
    let reopened = device(
        open_crypto_with(&dir.0, &root, OpenMode::Existing, key)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        reopened.encryption().ed25519_key().await.as_deref(),
        Some(signing_key.as_str())
    );
    let duplicate = reopened
        .encryption()
        .import_room_keys(fixture, "1234")
        .await
        .unwrap();
    assert_eq!(duplicate.total_count, 1);
    assert_eq!(duplicate.imported_count, 0);
}

#[tokio::test]
async fn unsupported_schema_leaves_the_source_readable_and_can_be_retried() {
    let dir = directory();
    let root = dir.0.join("old-session");
    let original = device(SqliteCryptoStore::open(&root, None).await.unwrap()).await;
    let original_key = original.encryption().ed25519_key().await.unwrap();
    drop(original);
    let db = Connection::open(root.join(DATABASE)).unwrap();
    db.execute_batch("CREATE TABLE future_sdk_table (key BLOB)")
        .unwrap();

    assert!(open_crypto_with(&dir.0, &root, OpenMode::Migrate, key)
        .await
        .is_err());
    assert!(root.join(DATABASE).exists());
    assert!(!root.join(PROTECTED).exists());
    db.execute_batch("DROP TABLE future_sdk_table").unwrap();
    drop(db);

    let migrated = device(
        open_crypto_with(&dir.0, &root, OpenMode::Migrate, key)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        migrated.encryption().ed25519_key().await.as_deref(),
        Some(original_key.as_str())
    );
    assert!(!root.join(DATABASE).exists());
}

#[tokio::test]
async fn conversion_on_a_fresh_install_creates_an_encrypted_store() {
    let dir = directory();
    let root = dir.0.join("new-session");
    drop(
        open_crypto_with(&dir.0, &root, OpenMode::DeferMigration, key)
            .await
            .unwrap(),
    );
    assert!(!root.join(DATABASE).exists());
    assert!(root.join(PROTECTED).join(DATABASE).exists());
}
