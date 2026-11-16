# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Encrypted history and recovery

Pax uses the Matrix Rust SDK for encrypted key backup, recovery, and verification of your own devices. Open **Settings → Encryption** to set up recovery, restore with an existing recovery key or passphrase, verify another device using emojis or numbers, and check backup progress. Recovery setup is also offered after signing in.

Save the recovery key outside Pax. Your account password alone does not unlock encrypted history on a new installation. Keys are backed up while Pax is running; historical keys are downloaded as you read conversations. Recovery setup preserves existing backups and identities. Creating a replacement recovery key requires a separate explicit action.

Local key databases survive logout and reauthentication. When saved credentials identify an existing device, password reauthentication reuses its database and device ID. Keys can also be transferred from a previous local session of the same account without deleting its original store. Sign-out checks recovery and attempts to finish pending uploads first.

To validate against a homeserver:

1. On the original device, set up recovery, save the key, and choose **Back up keys now**. Check that the stored keys have finished backing up.
2. Sign in to the same account on another computer or a separate installation. Restore with the recovery key, or choose **Verify with another device** and compare the emojis or numbers on both devices.
3. Open an existing encrypted conversation and scroll through older messages. Restored keys should update the displayed history without reopening the room.
4. Restart Pax on each device and confirm the history remains readable. Repeat with a fresh installation using only the saved recovery key.

Local regression checks: `npm run build` and, from `src-tauri`, `cargo test --lib encryption --offline`. The latter exercises key persistence, encrypted transfer to a new device, account isolation, and guards against replacing existing recovery data. It does not replace the homeserver test above.
