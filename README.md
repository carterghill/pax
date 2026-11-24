# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Linux media dependencies

On Debian-based Linux, install the Pax `.deb` with APT (for example, `sudo apt install ./pax_0.1.0_arm64.deb`) so it resolves the GStreamer dependencies. When running Pax from source, use `npm run setup:linux-media` before `npm start`. The setup command reads the same dependency list and uses APT to install missing packages. Restart Pax if it was already running.

Build AppImages on Ubuntu with the GStreamer packages installed so Tauri can include the media framework.

## Room and space invitations

**Invite people → Email** uses Matrix third-party invitations. Pax checks the active account's identity-service preference and the homeserver's Matrix discovery information. If the identity service publishes terms, Pax asks the sender to review them before sending. The identity service handles delivery and controls where its emails open.

**Invite people → Room link** can copy a Matrix permalink or a `pax:` link. The Pax link opens the installed app in clients that support custom links. **Share by email** opens a draft with both links. Recipients sign in on their own homeserver and can join if the room's access settings allow it. Invite-only rooms require a Matrix invitation. Rooms that allow requests to join can receive them from Pax.

Verified HTTPS links that open an installed app require a domain associated with the app. The Pax link uses the native URL scheme and works independently of the recipient's homeserver.

## Unavailable encrypted messages

Encrypted events that cannot currently be decrypted remain in the timeline as **Message unavailable on this device**, with their sender and timestamp. Opening a chat with such messages shows a notice rather than silently hiding a reply.

- **Clear notification** sends a private Matrix read receipt through the newest observed server event, independently of decryption. It clears the room, sidebar and tray counts without publishing a read receipt. The placeholders remain, and new incoming messages still notify normally. Jump to recent first if viewing older history.
- **Try recovery** opens the existing encryption recovery controls. Restored keys replace the placeholders with readable content.
- **Ignore** hides the warning for that conversation on this device, including after reopening it or restarting Pax. It does not clear notifications or remove message placeholders.
- **Clear notification** is also available by right-clicking any room or conversation in the sidebar, whether its messages are readable or unavailable and whether the chat is open or closed.

Unacknowledged unavailable incoming messages block automatic read receipts. A timeline containing unavailable messages uses private receipts even when public receipts are enabled. Acknowledged event IDs are stored in private room account data and survive reopening the chat or using another installation. No message contents or encryption keys are stored in that record.

Validation: `npm run test:unavailable-messages` and `cd src-tauri && cargo test --lib unavailable_messages`. The native integration tests cover undecrypted SDK events, private-only receipts, persistent acknowledgement, failed requests, a new message arriving while clearing is in flight, and clearing readable/unavailable/empty conversations from the room menu.

## Encrypted history and recovery

New accounts default to **Pax sign-in**: a single password authenticates and unlocks encrypted recovery automatically. The signup form has a subtle **Sign-in** preference and a question-mark explanation. Login detects the account type automatically. The algorithm, formats, trust assumptions, and migration behavior are documented in [Authentication.md](Authentication.md).

Pax signup needs stable custom public profile fields, private account data, password authentication, and key backup. The profile feature is detected from Matrix 1.16+ support or the explicit `uk.tcpip.msc4133.stable` capability flag, which is also advertised by Synapse versions that claim an earlier Matrix specification. No custom homeserver code is used. It requires HTTPS and uses the configured `PAX_HOMESERVER`. Account IDs are resolved using `/_matrix/key/v2/server`; if that endpoint is unavailable at the client URL, set `PAX_SERVER_NAME` in the app's build environment to the Matrix account domain (which may differ from the URL host). Builds without a configured homeserver trust the HTTPS server explicitly entered by the user. Discovery is unsigned in this first version and trusts that server.

To test Pax signup with a dummy account:

1. Choose **Sign Up**, leave **Pax (recommended)** selected, and use a new username and a password of at least 12 characters.
2. Create the account and confirm **Settings → Encryption** shows recovery ready, without asking you to save a recovery key.
3. Exchange encrypted messages and wait for message keys to finish backing up (or use **Back up keys now**).
4. Sign out, sign back in using the same password, and open older encrypted messages. Repeat on another computer or a separate app installation, with no recovery key and with the first device offline.
5. If signup says the account was created but setup was interrupted, use **Sign in to finish setup** on that original installation with the same password.

To test conversion, sign into a standard Matrix dummy account and open **Settings → Account → Switch to Pax sign-in**. Enter its current Matrix password and choose a different new Pax password. No registration token or separate recovery-key ceremony is needed when the existing encryption secrets are unlocked. If Pax asks you to unlock recovery or verify the device first, do that under **Encryption**, then retry. The switch preserves the current identity, backup, SDK store, and available message keys; it cannot recover keys already lost. Test older encrypted messages, sign out/in with the new password, and repeat on a separate installation. If interrupted, use **Finish switching** with the same new Pax password (and the old Matrix password if the change has not taken effect yet). After the password change takes effect, another installation can also finish using the new Pax password alone.

This version does not implement reverse conversion, Pax password changes, credential/emergency exports, importing superseded recovery snapshots, or signed discovery. The memorable Pax password does not work in other Matrix clients. A server-side password reset does not recover the encrypted history. These are testing-stage accounts pending cryptographic review and device benchmarking.

The instructions below apply to **standard Matrix** accounts.

Pax uses the Matrix Rust SDK for encrypted key backup, recovery, and verification of your own devices. Open **Settings → Encryption** to set up recovery, restore with an existing recovery key or passphrase, verify another device using emojis or numbers, and check backup progress. Recovery setup is also offered after signing in.

If recovery was never configured but setup asks you to verify another device, the account can still have an existing encryption identity or an automatically created message backup. When no device has those secrets, choose **Settings → Encryption → Set up recovery from this device**. The confirmation explains that missing verification keys require a new identity and that only history this device can decrypt will be protected. Enter the current Matrix password, save the resulting recovery key, and then test the switch to Pax sign-in. Older backup versions and their encrypted contents are retained; this action cannot unlock them. If interrupted, choose **Finish recovery setup on this device**. This option is explicit, applies to standard accounts without configured Secret Storage, and never runs automatically during login or conversion.

Save the recovery key outside Pax. Your account password alone does not unlock encrypted history on a new installation. Keys are backed up while Pax is running; historical keys are downloaded as you read conversations. Recovery setup preserves existing backups and identities. Creating a replacement recovery key requires a separate explicit action.

Pax renews access automatically when the homeserver provides a refresh token. If the server requests reauthentication for the same device, signing in again reuses its local encryption store. Revocation or sign-out clears that device's local session. Sign-out checks recovery and attempts to finish pending uploads before asking the homeserver to revoke the device.

If you do not have a recovery key or account recovery cannot be unlocked, open **Settings → Encryption → Back up available history → Back up this device’s history**. Choose and confirm a backup file password of at least 12 characters. Pax saves an encrypted `pax-history-….txt` file to **Downloads** and shows how many message keys it contains. Move a copy somewhere safe and keep its password in your password manager. Both the file and its password are needed to restore it. This option is available for standard Matrix and Pax accounts even when the server recovery-status check fails.

On another installation, sign in to the same account, open **Settings → Encryption → Restore from backup file**, select the file, and enter its backup password. Pax adds the keys without resetting account verification or replacing the existing server backup. This uses the standard Matrix encrypted message-key export format and also accepts compatible exports from other Matrix apps.

File backups are snapshots of message keys present on that device. They do not include future keys, account identity secrets, message bodies, or attachments. Messages/media must still be available on the homeserver; already-lost keys cannot be recreated. Files are limited to 64 MiB, and imports reject unsupported or excessively costly key-derivation parameters. Export/import works offline once the account’s local store is open.

To validate against a homeserver:

1. On the original device, set up recovery, save the key, and choose **Back up keys now**. Check that the stored keys have finished backing up.
2. Sign in to the same account on another computer or a separate installation. Restore with the recovery key, or choose **Verify with another device** and compare the emojis or numbers on both devices.
3. Open an existing encrypted conversation and scroll through older messages. Restored keys should update the displayed history without reopening the room.
4. Restart Pax on each device and confirm the history remains readable. Repeat with a fresh installation using only the saved recovery key.

Local regression checks: `npm run build` and, from `src-tauri`, `cargo test --lib --offline`. Pax integration tests start a local loopback HTTP server and need permission to bind a port. They exercise real Secret Storage/backup encryption and restoration on a fresh device, interrupted setup, and rejection of malformed discovery and recovery records. The encryption tests also exercise key persistence, encrypted transfer to a new device, account isolation, and guards against replacing existing recovery data. These checks do not replace the homeserver test above.

## Incoming call notifications

Pax prefers LiveKit for direct calls when the peer has advertised support and the room's LiveKit service can issue a token. For other direct calls, Pax uses the Matrix two-party VoIP protocol with native WebRTC audio, optional camera video, and the homeserver's TURN service when available. The member menu places a two-party Matrix call in the current room and addresses the invitation to the selected member. The phone button in a group chat joins its MatrixRTC voice session and sends an `org.matrix.msc4075.rtc.notification` to the other joined members. Group chats use the same LiveKit service as voice channels.

Windows and Linux show call alerts while Pax runs in the background. An installed Windows build uses the Windows notification center. Linux exposes Answer and Decline on desktop notification services that support actions. A bundled macOS `.app` can show the system banner even while Pax has focus. An unbundled macOS development build shows an actionable floating alert.

Android registers its FCM token with the signed-in homeserver when `PAX_PUSH_GATEWAY_URL` is set at build time. Set it to the HTTPS origin or the full `/_matrix/push/v1/notify` URL of a gateway authorized to send to that build's Firebase project. If the variable is absent, Pax skips push registration. Android retries transient registration failures and replaces old pushers when FCM rotates its token. Pax uses saved room keys to resolve encrypted calls and apply Matrix push rules to decrypted messages. When the keys are unavailable, Android can show a silent generic notification.

The iOS CallKit integration can present calls received by a running app. To deliver calls while the app is suspended, sign the `com.carter.pax` iOS target with an APNs-enabled provisioning profile and set `PAX_IOS_VOIP_PUSH_GATEWAY_URL`. Pax registers a separate Matrix pusher with app ID `com.carter.pax.voip`. The gateway must send APNs pushes only for verified new calls, with push type `voip`, topic `com.carter.pax.voip`, and a short APNs expiration. The payload contains `callPolicyVersion: 1`, the Matrix call UUID, caller label, and absolute deadline in milliseconds in `callId`, `caller`, and `expiresAt`. Include `video: true` for a video invitation so CallKit can display the call type before the app syncs. Call-end updates use Matrix sync. An ordinary Sygnal push cannot identify a call in encrypted Matrix traffic. Waking iOS for those calls requires a notification service extension with device-side decryption and Apple’s notification-filtering entitlement, or a separate verified call-delivery service.

For this pusher Pax uses `/pax/call-policy/v1/_matrix/push/v1/notify`. A gateway implementing this route must verify that the caller and recipient are joined, that the caller can start the call under the room power levels, and that the recipient can answer. Before sending a VoIP push it must check the recipient’s current private `ca.brandxtech.pax.notification_settings` account data on their homeserver. In `calls`, combine `global`, `rooms[roomId]` and `users[senderId]` using the most restrictive of `ring`, `silent` and `block`. Missing settings allow ringing except that public rooms default to silent when neither the room nor the caller has an explicit setting. Suppress the push for ignored users, for silent or blocked calls, or if verification fails. The gateway needs authorized access to this information on the recipient’s homeserver.

For a standard `m.call.invite`, derive the CallKit `callId` with UUIDv5 in the OID namespace. The UTF-8 input is `matrix-voip`, a NUL byte, the room ID, a NUL byte, then the event's `content.call_id`. For a targeted invite, deliver the alert only to the account in `content.invitee`. For a group ring, verify the referenced caller membership and the recipient in `m.mentions.user_ids`. Derive its UUID the same way using `matrix-rtc`, a NUL byte, the room ID, a NUL byte, and the notification’s Matrix event ID. These IDs link system call actions to the invitation received through sync.

### App icon badges

While Pax is running, the icon badge follows the unread notification count from Matrix sync. Linux needs a dock that supports Unity LauncherEntry updates and associates Pax with `pax.desktop`. Android’s launcher chooses whether to render a number or a dot, and its notification permission and badge settings apply.

To update the iOS badge while Pax is suspended, set `PAX_IOS_BADGE_PUSH_GATEWAY_URL` for a gateway that accepts the `com.carter.pax.badge` Matrix pusher. Pax registers a regular APNs token for this pusher with `event_id_only` format. For both event pushes and count-only updates, send `{"aps":{"badge":<notification.counts.unread>}}` to that token using APNs push type `alert` and topic `com.carter.pax`. Forward zero to clear the badge and skip payloads that omit the count. This badge route uses the standard APNs token and runs alongside the VoIP gateway.
