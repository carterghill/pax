use super::*;
use crate::commands::pax_auth::tests::{client, client_without_sync, Server, TestDir, USER};

const OLD: &str = "ordinary Matrix password";
const NEW: &str = "a distinct memorable Pax password 🔐";

#[tokio::test]
async fn resume_requires_local_password_proof_before_old_password_authentication() {
    let server = Server::start().await;
    let http = reqwest::Client::new();
    server.state.lock().unwrap().credential = Some(OLD.into());
    let keys = pax_auth::derive(USER, NEW).await.unwrap();
    let wrong = pax_auth::derive(USER, "incorrect but long password")
        .await
        .unwrap();
    let local = ConversionJournal {
        homeserver: server.home.clone(),
        store_dir: "original".into(),
        device_id: "ORIGINAL".into(),
        record: ConversionRecord::new(USER, &keys).unwrap(),
    };
    assert!(
        authenticate_resume(&http, &server.home, USER, USER, &wrong, OLD, Some(&local))
            .await
            .is_err()
    );
    assert!(
        server.state.lock().unwrap().requests.is_empty(),
        "An incorrect Pax password must not send any login request when local proof exists"
    );
    assert!(
        authenticate_resume(&http, &server.home, USER, USER, &keys, OLD, None)
            .await
            .is_err()
    );
    assert_eq!(server.state.lock().unwrap().requests.len(), 1);
    assert_eq!(
        server.state.lock().unwrap().requests[0].2["password"],
        keys.credential.as_str(),
        "Fresh installations can only send a derived credential"
    );
    server.state.lock().unwrap().requests.clear();
    server.state.lock().unwrap().login_status = Some(429);
    assert!(
        authenticate_resume(&http, &server.home, USER, USER, &keys, OLD, Some(&local))
            .await
            .is_err()
    );
    assert_eq!(
        server.state.lock().unwrap().requests.len(),
        1,
        "Rate limits must not fall back to the old password"
    );
    server.state.lock().unwrap().login_status = None;
    server.state.lock().unwrap().requests.clear();
    let (session, changed) =
        authenticate_resume(&http, &server.home, USER, USER, &keys, OLD, Some(&local))
            .await
            .unwrap();
    assert!(!changed);
    assert_eq!(session.device_id, "ORIGINAL");
    {
        let state = server.state.lock().unwrap();
        assert_eq!(state.requests.len(), 2);
        assert_eq!(state.requests[0].2["password"], keys.credential.as_str());
        assert_eq!(state.requests[1].2["password"], OLD);
    }
    server.state.lock().unwrap().credential = Some(keys.credential.to_string());
    server.state.lock().unwrap().requests.clear();
    let (_, changed) = authenticate_resume(&http, &server.home, USER, USER, &keys, "", None)
        .await
        .unwrap();
    assert!(changed);
    assert_eq!(server.state.lock().unwrap().requests.len(), 1);
}

async fn original(server: &Server, dir: &TestDir) -> Client {
    server.state.lock().unwrap().credential = Some(OLD.into());
    client(
        &server.home,
        &dir.0.join("original"),
        auth::SavedSession {
            user_id: USER.into(),
            device_id: "ORIGINAL".into(),
            access_token: "token".into(),
        },
    )
    .await
}

#[tokio::test]
async fn conversion_preserves_identity_backup_and_recovers_message_keys_on_a_new_device() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let server = Server::start().await;
        let http = reqwest::Client::new();
        let dir = TestDir::new();
        let original = original(&server, &dir).await;
        pax_auth::bootstrap_identity(&original, OLD).await.unwrap();
        let old_recovery_key =
            Zeroizing::new(original.encryption().recovery().enable().await.unwrap());
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
            .with_delay(Duration::from_millis(1))
            .await
            .unwrap();
        let identity = server.state.lock().unwrap().signing.clone();
        let backup = server.state.lock().unwrap().backup.clone();
        let old_data = server.state.lock().unwrap().account_data.clone();
        let keys = pax_auth::derive(USER, NEW).await.unwrap();
        let mut record = ConversionRecord::new(USER, &keys).unwrap();
        let journal_file = dir.0.join("conversion.json");
        let mut save = |r: &ConversionRecord| {
            pax_auth::atomic_write(&journal_file, &serde_json::to_vec(r).unwrap())
        };
        prepare_switch(&http, &original, &keys, OLD, &mut record, &mut save)
            .await
            .unwrap();
        assert!(record.password_change_requested);
        assert!(!record.complete);
        assert_eq!(
            record.original_recovery["m.secret_storage.default_key"],
            old_data["m.secret_storage.default_key"]
        );
        for kind in [
            "m.cross_signing.master",
            "m.cross_signing.self_signing",
            "m.cross_signing.user_signing",
            "m.megolm_backup.v1",
        ] {
            assert_eq!(record.original_recovery[kind], old_data[kind]);
            for (id, encrypted) in old_data[kind]["encrypted"].as_object().unwrap() {
                assert_eq!(
                    server.state.lock().unwrap().account_data[kind]["encrypted"][id],
                    *encrypted,
                    "The old recovery key's encrypted slots must remain available"
                );
            }
        }
        let plain = std::fs::read_to_string(&journal_file).unwrap();
        for secret in [
            OLD,
            NEW,
            old_recovery_key.as_str(),
            keys.credential.as_str(),
        ] {
            assert!(
                !plain.contains(secret),
                "The journal must contain only protected recovery information"
            );
        }
        // A transition stops ordinary login BEFORE any password request.
        let count = server.state.lock().unwrap().requests.len();
        let error = auth::authenticate_password(
            &http,
            &server.home,
            USER,
            USER,
            NEW,
            None,
            &crate::AuthConfig::default(),
            false,
        )
        .await
        .err()
        .unwrap();
        assert!(error.starts_with("PAX_CONVERSION_PENDING:"));
        assert!(server.state.lock().unwrap().requests[count..]
            .iter()
            .all(|(_, p, _)| !p.ends_with("/login")));

        assert!(
            change_password(&http, &original, "wrong old password", &keys.credential)
                .await
                .is_err()
        );
        assert_eq!(
            server.state.lock().unwrap().credential.as_deref(),
            Some(OLD)
        );
        change_password(&http, &original, OLD, &keys.credential)
            .await
            .unwrap();
        let same_device_session = auth::request_password_session(
            &http,
            &server.home,
            USER,
            &keys.credential,
            Some("ORIGINAL"),
        )
        .await
        .unwrap();
        let reopened =
            client_without_sync(&server.home, &dir.0.join("original"), same_device_session).await;
        pax_auth::unlock(&reopened, &keys, record.envelope.as_ref().unwrap())
            .await
            .unwrap();
        assert_eq!(
            reopened
                .encryption()
                .import_room_keys(fixture.clone(), "1234")
                .await
                .unwrap()
                .imported_count,
            0,
            "Reauthentication in the same SDK store must retain the original device's message keys"
        );
        let session =
            auth::request_password_session(&http, &server.home, USER, &keys.credential, None)
                .await
                .unwrap();
        let fresh = client_without_sync(&server.home, &dir.0.join("fresh"), session).await;
        // The new installation retrieves private progress using derived auth.
        let downloaded = fetch_record(&fresh).await.unwrap().unwrap();
        downloaded.check_password(&keys).unwrap();
        finalize_remote(&http, &fresh, &keys, &downloaded)
            .await
            .unwrap();
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
            "The pre-conversion key must already have been recovered from the unchanged backup"
        );
        let status = fresh.encryption().cross_signing_status().await.unwrap();
        assert!(status.is_complete());
        {
            let state = server.state.lock().unwrap();
            assert_eq!(state.signing, identity);
            assert_eq!(state.backup, backup);
            assert_eq!(state.profile[pax_auth::PROFILE_FIELD]["state"], "ready");
            assert_eq!(
                state
                    .requests
                    .iter()
                    .filter(|(m, p, _)| m == "POST" && p.ends_with("/room_keys/version"))
                    .count(),
                1
            );
            assert!(state
                .requests
                .iter()
                .all(|(_, p, b)| !p.ends_with("/register") && !b.to_string().contains(NEW)));
            assert!(state
                .requests
                .iter()
                .filter(|(_, p, _)| p.ends_with("/account/password"))
                .all(|(_, _, b)| b["new_password"].as_str() == Some(keys.credential.as_str())));
        }
        let login = auth::authenticate_password(
            &http,
            &server.home,
            USER,
            USER,
            NEW,
            None,
            &crate::AuthConfig::default(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(login.mode, AccountMode::Pax);
    })
    .await
    .expect("Conversion and backup recovery should not hang");
}

#[tokio::test]
async fn conversion_resumes_failed_writes_and_a_lost_password_change_response() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let server = Server::start().await;
        let http = reqwest::Client::new();
        let dir = TestDir::new();
        let original = original(&server, &dir).await;
        let keys = pax_auth::derive(USER, NEW).await.unwrap();
        let wrong_keys = pax_auth::derive(USER, "another different new password")
            .await
            .unwrap();
        let mut record = ConversionRecord::new(USER, &keys).unwrap();
        let mut saved = serde_json::to_vec(&record).unwrap();
        let mut save = |r: &ConversionRecord| {
            saved = serde_json::to_vec(r).unwrap();
            Ok(())
        };
        server.state.lock().unwrap().fail_conversion_write = true;
        assert!(
            prepare_switch(&http, &original, &keys, OLD, &mut record, &mut save)
                .await
                .is_err()
        );
        assert_eq!(
            server.state.lock().unwrap().credential.as_deref(),
            Some(OLD)
        );
        server.state.lock().unwrap().fail_conversion_write = false;
        server.state.lock().unwrap().profile_status = Some(500);
        assert!(
            prepare_switch(&http, &original, &keys, OLD, &mut record, &mut save)
                .await
                .is_err()
        );
        server.state.lock().unwrap().profile_status = None;
        server.state.lock().unwrap().fail_envelope = true;
        assert!(
            prepare_switch(&http, &original, &keys, OLD, &mut record, &mut save)
                .await
                .is_err()
        );
        assert!(record.envelope.is_some());
        assert!(!record.password_change_requested);
        let envelope = serde_json::to_value(&record.envelope).unwrap();
        let identity = server.state.lock().unwrap().signing.clone();
        let backup = server.state.lock().unwrap().backup.clone();
        let competing = ConversionRecord::new(USER, &wrong_keys).unwrap();
        let mut discard_local = |_: &ConversionRecord| Ok(());
        assert!(
            persist(&original, &competing, &mut discard_local)
                .await
                .is_err(),
            "Another device must not overwrite an unfinished conversion record"
        );
        assert_eq!(
            fetch_record(&original)
                .await
                .unwrap()
                .unwrap()
                .transaction_id,
            record.transaction_id
        );
        let request_count = server.state.lock().unwrap().requests.len();
        assert!(
            prepare_switch(&http, &original, &wrong_keys, OLD, &mut record, &mut save)
                .await
                .is_err()
        );
        // Only capability GETs precede the password check; no mutating request.
        assert!(server.state.lock().unwrap().requests[request_count..]
            .iter()
            .all(|(m, _, _)| m == "GET"));
        server.state.lock().unwrap().fail_envelope = false;
        prepare_switch(&http, &original, &keys, OLD, &mut record, &mut save)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&record.envelope).unwrap(),
            envelope,
            "Retry must reuse the prepared recovery key"
        );
        // A proxy error after commit cannot justify rollback to standard auth.
        server.state.lock().unwrap().fail_password_response = true;
        assert!(change_password(&http, &original, OLD, &keys.credential)
            .await
            .is_err());
        assert_eq!(
            server.state.lock().unwrap().credential.as_deref(),
            Some(keys.credential.as_str())
        );
        assert_eq!(
            server.state.lock().unwrap().profile[pax_auth::PROFILE_FIELD]["state"],
            "converting"
        );
        drop(save);
        let saved: ConversionRecord = serde_json::from_slice(&saved).unwrap();
        saved.validate(USER).unwrap();
        saved.check_password(&keys).unwrap();
        assert!(saved.password_change_requested);
        drop(original);
        let session = auth::request_password_session(
            &http,
            &server.home,
            USER,
            &keys.credential,
            Some("ORIGINAL"),
        )
        .await
        .unwrap();
        let restored = client(&server.home, &dir.0.join("original"), session).await;
        server.state.lock().unwrap().profile_status = Some(500);
        assert!(finalize_remote(&http, &restored, &keys, &saved)
            .await
            .is_err());
        server.state.lock().unwrap().profile_status = None;
        finalize_remote(&http, &restored, &keys, &saved)
            .await
            .unwrap();
        assert_eq!(server.state.lock().unwrap().signing, identity);
        assert_eq!(server.state.lock().unwrap().backup, backup);
        assert_eq!(
            serde_json::to_value(fetch_record(&restored).await.unwrap().unwrap().envelope).unwrap(),
            envelope
        );
        let remote = fetch_record(&restored).await.unwrap().unwrap();
        assert!(remote.check_password(&wrong_keys).is_err());
    })
    .await
    .expect("Interrupted conversion should remain resumable");
}

#[tokio::test]
async fn conversion_refuses_inaccessible_secrets_and_disabled_password_changes() {
    let server = Server::start().await;
    let dir = TestDir::new();
    let http = reqwest::Client::new();
    let original = original(&server, &dir).await;
    pax_auth::bootstrap_identity(&original, OLD).await.unwrap();
    original.encryption().recovery().enable().await.unwrap();
    let original_data = server.state.lock().unwrap().account_data.clone();
    let identity = server.state.lock().unwrap().signing.clone();
    let backup = server.state.lock().unwrap().backup.clone();
    let fresh = client(
        &server.home,
        &dir.0.join("locked"),
        auth::SavedSession {
            user_id: USER.into(),
            device_id: "LOCKED".into(),
            access_token: "token".into(),
        },
    )
    .await;
    assert!(ensure_recovery_access(&fresh)
        .await
        .unwrap_err()
        .contains("Unlock"));
    server.state.lock().unwrap().password_disabled = true;
    assert!(preflight(&http, &original)
        .await
        .unwrap_err()
        .contains("does not allow password changes"));
    let state = server.state.lock().unwrap();
    assert_eq!(state.account_data, original_data);
    assert_eq!(state.signing, identity);
    assert_eq!(state.backup, backup);
    assert_eq!(state.credential.as_deref(), Some(OLD));
    assert!(state
        .requests
        .iter()
        .all(|(_, p, _)| !p.ends_with("/account/password")));
}

#[tokio::test]
async fn conversion_record_binds_password_account_and_transition_identifier() {
    let keys = pax_auth::derive(USER, NEW).await.unwrap();
    let mut record = ConversionRecord::new(USER, &keys).unwrap();
    record.validate(USER).unwrap();
    record.check_password(&keys).unwrap();
    assert!(record.validate("@other:example.org").is_err());
    record.descriptor().validate(USER).unwrap();
    record.transaction_id = uuid::Uuid::new_v4().to_string();
    assert!(record.check_password(&keys).is_err());
    let mut invalid = record.descriptor();
    invalid.state = "ready".into();
    assert!(invalid.validate(USER).is_err());
    invalid.state = "converting".into();
    invalid.conversion_id = None;
    assert!(invalid.validate(USER).is_err());
    assert!(validate_passwords(OLD, OLD).is_err());
    assert!(validate_passwords(OLD, "short").is_err());
}
