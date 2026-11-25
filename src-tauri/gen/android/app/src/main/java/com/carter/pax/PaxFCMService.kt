package com.carter.pax

import android.app.NotificationManager
import android.content.Context
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * Receives FCM data messages forwarded by Sygnal (Matrix push gateway).
 *
 * Sygnal sends data-only messages (no `notification` block), so
 * [onMessageReceived] fires whether the app is foreground or background.
 * We build and show an Android system notification directly — no need
 * to route through the WebView / Tauri layer, which may not be alive.
 *
 * [onNewToken] saves the latest token and schedules Matrix pusher registration.
 */
class PaxFCMService : FirebaseMessagingService() {

    companion object {
        const val PREFS_NAME = "pax_push"
        const val PREF_FCM_TOKEN = "fcm_token"
    }

    override fun onCreate() {
        super.onCreate()
        PaxNotificationBadge.createChannels(this)
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_FCM_TOKEN, token)
            .commit()
        PaxPushJob.schedule(this, replacePending = true)
    }

    /**
     * Called for every data message from Sygnal.
     *
     * Homeserver + Sygnal normally send (among others):
     *   - `sender`, `sender_display_name`, `room_name`, `room_alias`, `room_id`, `event_id`
     *   - `content` (legacy FCM: JSON string with `body`) or `content_body` (FCM HTTP v1)
     *
     * An event ID and room ID let us resolve a missing body on this device.
     */
    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        if (data.isEmpty() || !PaxNotificationBadge.sessionActive(this)) return

        var roomName = data["room_name"]?.trim()?.takeIf { it.isNotEmpty() }
        val roomAlias = data["room_alias"]?.trim()?.takeIf { it.isNotEmpty() }
        var isDirect = data["is_direct"]?.toBooleanStrictOrNull()
        var senderName = data["sender_display_name"]?.trim()?.takeIf { it.isNotEmpty() }
            ?: data["sender"]?.trim()?.takeIf { it.isNotEmpty() }
        val roomId = data["room_id"] ?: ""
        val eventId = data["event_id"]?.trim()?.takeIf { it.isNotEmpty() } ?: ""
        val type = data["type"]
        val unreadCount = data["unread"]?.toLongOrNull()?.takeIf { it >= 0 }
            ?.coerceAtMost(Int.MAX_VALUE.toLong())?.toInt()
        if (eventId.isEmpty() && type.isNullOrBlank() && ("unread" in data || "missed_calls" in data)) {
            unreadCount?.let { PaxNotificationBadge.sync(this, it) }
            return
        }

        val directCallEvent = type == "com.carter.pax.direct_call" || type?.startsWith("m.call.") == true ||
            type in setOf("org.matrix.msc4075.rtc.notification", "m.rtc.notification", "org.matrix.msc4310.rtc.decline", "m.rtc.decline", "com.carter.pax.rtc.answer")
        val payloadPreview = PaxMessagePreview.payloadBody(data)
        var resolvedPreview: String? = null
        // An unresolved encrypted event could be a call the recipient silenced.
        var silent = type == "m.room.encrypted" || type == null
        val inspectEvent = directCallEvent || silent || (type == "m.room.message" && payloadPreview == null)
        if (roomId.isNotEmpty() && (inspectEvent || type == "m.room.message")) {
            val resolved = runCatching {
                val targetEvent = eventId.takeIf { inspectEvent && it.isNotEmpty() }
                PaxCallPush.resolve(applicationInfo.dataDir, roomId, targetEvent)?.let { JSONObject(it) }
            }.getOrNull()
            if (resolved != null) {
                when (resolved.optString("kind")) {
                    "ring" -> {
                        PaxCallNotifications.parse(resolved)?.let { PaxCallNotifications.show(this, it, eventId) }
                        return
                    }
                    "ended" -> {
                        PaxCallNotifications.parse(resolved)?.let { PaxCallNotifications.close(this, it.id, true) }
                        return
                    }
                    "missed" -> {
                        val call = PaxCallNotifications.parse(resolved) ?: return
                        val ringEventId = resolved.optString("ringEventId").ifBlank { eventId }
                        PaxCallNotifications.close(this, call.id, true)
                        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        manager.cancel(eventId, 0)
                        manager.cancel(ringEventId, 0)
                        val tag = "missed:${call.id}"
                        PaxNotificationBadge.onMessage(this, unreadCount, tag)
                        PaxMessageNotifications.post(
                            this,
                            call.roomId,
                            ringEventId,
                            getString(R.string.pax_missed_call),
                            call.caller,
                            tag = tag,
                            missedCall = true,
                        )
                        return
                    }
                    "ignore" -> return
                    "message", "room" -> {
                        isDirect = resolved.opt("isDirect") as? Boolean ?: isDirect
                        roomName = resolved.optString("roomName", "").trim().takeIf { it.isNotEmpty() } ?: roomName
                        senderName = resolved.optString("sender", "").trim().takeIf { it.isNotEmpty() } ?: senderName
                        resolvedPreview = resolved.opt("preview") as? String
                        silent = resolved.optBoolean("silent", silent)
                    }
                }
            }
        }
        if (directCallEvent || PaxCallNotifications.hasSeenRing(this, eventId)) return

        val header = PaxMessagePreview.header(senderName, roomName ?: roomAlias, isDirect)
        val body = PaxMessagePreview.notificationBody(
            PaxMessagePreview.enabled(this), resolvedPreview, payloadPreview,
        )

        PaxNotificationBadge.onMessage(this, unreadCount, eventId.takeIf { it.isNotEmpty() })
        PaxMessageNotifications.post(this, roomId, eventId, header.title, body, subText = header.subText, silent = silent)
    }
}
