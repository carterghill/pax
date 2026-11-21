use super::*;
use crate::commands::{
    auth::SavedSession,
    pax_auth::tests::{client, Server, TestDir, USER},
};

const PASSWORD: &str = "ordinary Matrix password";

async fn device(server: &Server, dir: &TestDir, name: &str) -> Client {
    server.state.lock().unwrap().credential = Some(PASSWORD.into());
    client(
        &server.home,
        &dir.0.join(name),
        SavedSession {
            user_id: USER.into(),
            device_id: name.into(),
            access_token: "token".into(),
            refresh_token: None,
        },
    )
    .await
}

#[tokio::test]
async fn first_recovery_setup_completes_uiaa_with_the_original_locally_generated_identity() {
    let server = Server::start().await;
    let dir = TestDir::new();
    let current = device(&server, &dir, "FIRST").await;
    let service = EncryptionService::default();
    assert!(status(&current, &service).await.unwrap().can_setup);
    let error = super::super::prepare_recovery_setup(&current, &service, None)
        .await
        .unwrap_err();
    assert!(error.contains("Enter your account password"));
    let generated = server
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .find(|(_, p, _)| p.ends_with("/keys/device_signing/upload"))
        .unwrap()
        .2["master_key"]
        .clone();
    assert!(server.state.lock().unwrap().signing.is_empty());
    super::super::prepare_recovery_setup(&current, &service, Some(PASSWORD))
        .await
        .unwrap();
    assert_eq!(
        server.state.lock().unwrap().signing["master_key"],
        generated
    );
    let key = current.encryption().recovery().enable().await.unwrap();
    let fresh = device(&server, &dir, "FRESH").await;
    fresh.encryption().recovery().recover(&key).await.unwrap();
    assert!(fresh
        .encryption()
        .cross_signing_status()
        .await
        .unwrap()
        .is_complete());
    assert!(fresh.encryption().backups().are_enabled().await);
}

#[tokio::test]
async fn explicit_restart_preserves_old_backup_and_recovers_available_history() {
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        let server = Server::start().await;
        let dir = TestDir::new();
        let original = device(&server, &dir, "OLD").await;
        pax_auth::bootstrap_identity(&original, PASSWORD)
            .await
            .unwrap();
        // There is an automatically created backup, but no recovery key has
        // ever been set up. The original device's secrets are then unavailable.
        original
            .encryption()
            .recovery()
            .enable_backup()
            .await
            .unwrap();
        let fixture = dir.0.join("fixture.enc");
        std::fs::write(&fixture, include_str!("fixtures/test-room-key-export.txt")).unwrap();
        original
            .encryption()
            .import_room_keys(fixture.clone(), "1234")
            .await
            .unwrap();
        original
            .encryption()
            .backups()
            .wait_for_steady_state()
            .with_delay(std::time::Duration::from_millis(1))
            .await
            .unwrap();
        let old_identity = server.state.lock().unwrap().signing.clone();
        let old_backup = server.state.lock().unwrap().backup.clone().unwrap();
        drop(original);
        let current = device(&server, &dir, "CURRENT").await;
        let service = EncryptionService::default();
        let blocked = status(&current, &service).await.unwrap();
        assert!(!blocked.secret_storage_exists);
        assert!(!blocked.can_setup);
        assert!(blocked.has_identity && !blocked.cross_signing_ready);
        assert!(blocked.backup_exists && !blocked.backup_enabled);
        assert!(
            super::super::prepare_recovery_setup(&current, &service, Some(PASSWORD))
                .await
                .unwrap_err()
                .contains("private keys are missing")
        );
        assert_eq!(server.state.lock().unwrap().signing, old_identity);
        assert_eq!(
            server.state.lock().unwrap().backup.as_ref(),
            Some(&old_backup)
        );
        // Simulate history this device can actually see. Starting recovery may
        // retain these keys, but cannot invent keys it doesn't have.
        let imported = current
            .encryption()
            .import_room_keys(fixture.clone(), "1234")
            .await
            .unwrap();
        assert_eq!(imported.imported_count, 1);
        let room = imported.keys.keys().next().unwrap().clone();
        let record = snapshot(&current).await.unwrap();
        assert_eq!(record.original_backup.as_ref().unwrap()["version"], "1");
        archive(&current, &record).await.unwrap();
        prepare_new_recovery(&current, PASSWORD).await.unwrap();
        assert_ne!(server.state.lock().unwrap().signing, old_identity);
        assert_eq!(
            server.state.lock().unwrap().backup_archives["1"].0,
            old_backup
        );
        assert!(!server.state.lock().unwrap().backup_archives["1"]
            .1
            .is_empty());
        assert_eq!(
            current
                .encryption()
                .import_room_keys(fixture.clone(), "1234")
                .await
                .unwrap()
                .imported_count,
            0
        );
        let key = current.encryption().recovery().enable().await.unwrap();
        current
            .encryption()
            .backups()
            .wait_for_steady_state()
            .with_delay(std::time::Duration::from_millis(1))
            .await
            .unwrap();
        let new_identity = server.state.lock().unwrap().signing.clone();
        let new_backup = server.state.lock().unwrap().backup.clone();
        prepare_new_recovery(&current, PASSWORD).await.unwrap();
        assert_eq!(
            server.state.lock().unwrap().signing,
            new_identity,
            "Retry must retain the prepared identity"
        );
        assert_eq!(
            server.state.lock().unwrap().backup,
            new_backup,
            "Retry must retain the prepared backup"
        );
        let fresh = device(&server, &dir, "FRESH").await;
        fresh.encryption().recovery().recover(&key).await.unwrap();
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
            "The new recovery key must restore the history preserved from the current device"
        );
        assert!(fresh
            .encryption()
            .cross_signing_status()
            .await
            .unwrap()
            .is_complete());
        assert_eq!(
            server.state.lock().unwrap().credential.as_deref(),
            Some(PASSWORD)
        );
        assert!(
            server
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(method, _, _)| method != "DELETE"),
            "Older backups must never be deleted by this action"
        );
    })
    .await
    .expect("New recovery should not hang");
}

#[tokio::test]
async fn interrupted_identity_setup_keeps_the_original_backup_and_reuses_the_accepted_identity() {
    let server = Server::start().await;
    let dir = TestDir::new();
    let original = device(&server, &dir, "OLD").await;
    pax_auth::bootstrap_identity(&original, PASSWORD)
        .await
        .unwrap();
    original
        .encryption()
        .recovery()
        .enable_backup()
        .await
        .unwrap();
    let old_identity = server.state.lock().unwrap().signing.clone();
    let old_backup = server.state.lock().unwrap().backup.clone();
    let current = device(&server, &dir, "CURRENT").await;
    let record = snapshot(&current).await.unwrap();
    archive(&current, &record).await.unwrap();
    server.state.lock().unwrap().requests.clear();
    server.state.lock().unwrap().fail_signing = true;
    assert!(prepare_new_recovery(&current, PASSWORD).await.is_err());
    assert_eq!(server.state.lock().unwrap().signing, old_identity);
    assert_eq!(server.state.lock().unwrap().backup, old_backup);
    server.state.lock().unwrap().fail_signing = false;
    assert!(prepare_new_recovery(&current, "wrong password")
        .await
        .is_err());
    assert_eq!(server.state.lock().unwrap().signing, old_identity);
    assert_eq!(server.state.lock().unwrap().backup, old_backup);
    drop(current);
    let current = device(&server, &dir, "CURRENT").await;
    prepare_new_recovery(&current, PASSWORD).await.unwrap();
    assert_ne!(server.state.lock().unwrap().signing, old_identity);
    let accepted = server.state.lock().unwrap().signing.clone();
    let backup = server.state.lock().unwrap().backup.clone();
    drop(current);
    let current = device(&server, &dir, "CURRENT").await;
    prepare_new_recovery(&current, PASSWORD).await.unwrap();
    assert_eq!(
        server.state.lock().unwrap().signing,
        accepted,
        "Retry after a completed upload must retain the accepted identity"
    );
    assert_eq!(server.state.lock().unwrap().backup, backup);
    assert_eq!(
        server.state.lock().unwrap().backup_archives["1"].0,
        old_backup.unwrap()
    );
}
