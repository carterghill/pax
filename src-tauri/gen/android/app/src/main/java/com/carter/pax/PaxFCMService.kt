package com.carter.pax

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.carter.pax.R
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives FCM data messages forwarded by Sygnal (Matrix push gateway).
 *
 * Sygnal sends data-only messages (no `notification` block), so
 * [onMessageReceived] fires whether the app is foreground or background.
 * We build and show an Android system notification directly — no need
 * to route through the WebView / Tauri layer, which may not be alive.
 *
 * Token lifecycle:
 *   - [onNewToken] saves the token to SharedPreferences.
 *   - [MainActivity] reads it on startup and injects it into the WebView
 *     so the frontend can register the pusher with the homeserver.
 */
class PaxFCMService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "PaxFCM"
        private const val MAX_PREVIEW_LEN = 500
        const val CHANNEL_ID = "pax_messages"
        const val PREFS_NAME = "pax_push"
        const val PREF_FCM_TOKEN = "fcm_token"
        private var notificationIdCounter = 0
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    /**
     * Called when the FCM token is created or rotated.
     * Persisted in SharedPreferences; the frontend reads it on next launch
     * and re-registers the pusher.
     */
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_FCM_TOKEN, token)
            .apply()
    }

    /**
     * Called for every data message from Sygnal.
     *
     * Homeserver + Sygnal normally send (among others):
     *   - `sender`, `sender_display_name`, `room_name`, `room_alias`, `room_id`, `event_id`
     *   - `content` (legacy FCM: JSON string with `body`) or `content_body` (FCM HTTP v1)
     *
     * If the pusher was registered with `event_id_only`, most of these are absent
     * and we fall back to a generic notification.
     */
    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        if (data.isEmpty()) return

        val roomName = data["room_name"]?.trim()?.takeIf { it.isNotEmpty() }
        val roomAlias = data["room_alias"]?.trim()?.takeIf { it.isNotEmpty() }
        val senderName = (data["sender_display_name"] ?: data["sender"])
            ?.trim()?.takeIf { it.isNotEmpty() }
        val roomId = data["room_id"] ?: ""
        val eventId = data["event_id"]?.trim()?.takeIf { it.isNotEmpty() } ?: ""

        val preview = messagePreview(data)
        val roomLabel = roomContextLabel(roomName, roomAlias, senderName)

        val title: String
        val body: String
        when {
            senderName != null && roomLabel != null -> {
                title = senderName
                body = "$roomLabel · $preview"
            }
            senderName != null -> {
                title = senderName
                body = preview
            }
            roomLabel != null -> {
                title = roomLabel
                body = preview
            }
            else -> {
                title = "Pax"
                body = preview
            }
        }

        // Tap opens the app (MainActivity is singleTask, so it'll reuse the existing instance).
        // `event_id` lets the WebView scroll to the notified message after switching rooms.
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("room_id", roomId)
            if (eventId.isNotEmpty()) putExtra("event_id", eventId)
        }
        val pendingIntent = PendingIntent.getActivity(
            this, roomId.hashCode() xor eventId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        fun buildNotification(smallIcon: Int) =
            NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(smallIcon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pendingIntent)
                .build()

        val id = notificationIdCounter++
        try {
            manager.notify(id, buildNotification(R.drawable.ic_stat_pax))
        } catch (e: RuntimeException) {
            Log.w(TAG, "Posting notification with ic_stat_pax failed; using system fallback icon", e)
            manager.notify(id, buildNotification(android.R.drawable.ic_dialog_info))
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Messages",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Matrix message notifications"
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    /** Where the message lives: room display name, alias, or DM vs unknown. */
    private fun roomContextLabel(
        roomName: String?,
        roomAlias: String?,
        senderDisplay: String?,
    ): String? {
        if (roomName != null && senderDisplay != null &&
            roomName.equals(senderDisplay, ignoreCase = true)
        ) {
            return "Direct message"
        }
        if (roomName != null) return roomName
        if (roomAlias != null) return roomAlias
        return null
    }

    /**
     * Human-readable one-line preview: Sygnal FCM v1 uses `content_body`;
     * legacy sends `content` as a JSON string with `body`.
     */
    private fun messagePreview(data: Map<String, String>): String {
        data["content_body"]?.trim()?.takeIf { it.isNotEmpty() }?.let {
            return truncate(it, MAX_PREVIEW_LEN)
        }
        val content = data["content"] ?: return "New message"
        val fromJson = parseContentBody(content)?.trim()?.takeIf { it.isNotEmpty() }
        if (fromJson != null) return truncate(fromJson, MAX_PREVIEW_LEN)
        return "New message"
    }

    /**
     * Best-effort parse of the `content` field from Sygnal (legacy).
     * Sygnal sends it as a JSON string; we try to extract `body`.
     */
    private fun parseContentBody(content: String): String? {
        return try {
            val json = org.json.JSONObject(content)
            json.optString("body", null)
        } catch (_: Exception) {
            null
        }
    }

    private fun truncate(s: String, max: Int): String {
        if (s.length <= max) return s
        return s.substring(0, max - 1) + "…"
    }
}