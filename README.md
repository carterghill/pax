# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Encrypted history and recovery

New accounts default to **Pax sign-in**: a single password authenticates and unlocks encrypted recovery automatically. The signup form has a subtle **Sign-in** preference and a question-mark explanation. Login detects the account type automatically. The algorithm, formats, trust assumptions, and future migration work are documented in [Authentication.md](Authentication.md).

Pax signup needs standard Matrix 1.16 custom public profile fields, private account data, password authentication, and key backup. No custom homeserver code is used. It requires HTTPS and uses the configured `PAX_HOMESERVER`. Account IDs are resolved using `/_matrix/key/v2/server`; if that endpoint is unavailable at the client URL, set `PAX_SERVER_NAME` in the app's build environment to the Matrix account domain (which may differ from the URL host). Builds without a configured homeserver trust the HTTPS server explicitly entered by the user. Discovery is unsigned in this first version and trusts that server.

To test Pax signup with a dummy account:

1. Choose **Sign Up**, leave **Pax (recommended)** selected, and use a new username and a password of at least 12 characters.
2. Create the account and confirm **Settings → Encryption** shows recovery ready, without asking you to save a recovery key.
3. Exchange encrypted messages and wait for message keys to finish backing up (or use **Back up keys now**).
4. Sign out, sign back in using the same password, and open older encrypted messages. Repeat on another computer or a separate app installation, with no recovery key and with the first device offline.
5. If signup says the account was created but setup was interrupted, use **Sign in to finish setup** on that original installation with the same password.

This version does not implement conversion of existing accounts, Pax password changes, credential/emergency exports, or signed discovery. The memorable Pax password does not work in other Matrix clients. A server-side password reset does not recover the encrypted history. These are testing-stage accounts pending cryptographic review and device benchmarking.

The instructions below apply to **standard Matrix** accounts.

Pax uses the Matrix Rust SDK for encrypted key backup, recovery, and verification of your own devices. Open **Settings → Encryption** to set up recovery, restore with an existing recovery key or passphrase, verify another device using emojis or numbers, and check backup progress. Recovery setup is also offered after signing in.

Save the recovery key outside Pax. Your account password alone does not unlock encrypted history on a new installation. Keys are backed up while Pax is running; historical keys are downloaded as you read conversations. Recovery setup preserves existing backups and identities. Creating a replacement recovery key requires a separate explicit action.

Local key databases survive logout and reauthentication. When saved credentials identify an existing device, password reauthentication reuses its database and device ID. Keys can also be transferred from a previous local session of the same account without deleting its original store. Sign-out checks recovery and attempts to finish pending uploads first.

If you do not have a recovery key or account recovery cannot be unlocked, open **Settings → Encryption → Back up available history → Back up this device’s history**. Choose and confirm a backup file password of at least 12 characters. Pax saves an encrypted `pax-history-….txt` file to **Downloads** and shows how many message keys it contains. Move a copy somewhere safe and keep its password in your password manager. Both the file and its password are needed to restore it. This option is available for standard Matrix and Pax accounts even when the server recovery-status check fails.

On another installation, sign in to the same account, open **Settings → Encryption → Restore from backup file**, select the file, and enter its backup password. Pax adds the keys without resetting account verification or replacing the existing server backup. This uses the standard Matrix encrypted message-key export format and also accepts compatible exports from other Matrix apps.

File backups are snapshots of message keys present on that device. They do not include future keys, account identity secrets, message bodies, or attachments. Messages/media must still be available on the homeserver; already-lost keys cannot be recreated. Files are limited to 64 MiB, and imports reject unsupported or excessively costly key-derivation parameters. Export/import works offline once the account’s local store is open.

To validate against a homeserver:

1. On the original device, set up recovery, save the key, and choose **Back up keys now**. Check that the stored keys have finished backing up.
2. Sign in to the same account on another computer or a separate installation. Restore with the recovery key, or choose **Verify with another device** and compare the emojis or numbers on both devices.
3. Open an existing encrypted conversation and scroll through older messages. Restored keys should update the displayed history without reopening the room.
4. Restart Pax on each device and confirm the history remains readable. Repeat with a fresh installation using only the saved recovery key.

Local regression checks: `npm run build` and, from `src-tauri`, `cargo test --lib --offline`. Pax integration tests start a local loopback HTTP server and need permission to bind a port. They exercise real Secret Storage/backup encryption and restoration on a fresh device, interrupted setup, and rejection of malformed discovery and recovery records. The encryption tests also exercise key persistence, encrypted transfer to a new device, account isolation, and guards against replacing existing recovery data. These checks do not replace the homeserver test above.
