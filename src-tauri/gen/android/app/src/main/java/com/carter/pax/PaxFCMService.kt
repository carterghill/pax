package com.carter.pax

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
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
     * Sygnal's `event_id_only` format sends minimal fields:
     *   - `event_id`, `room_id`, `type`, `prio`, `unread`, `counts`
     *
     * With the full format it also includes:
     *   - `sender`, `sender_display_name`, `room_name`, `content`
     *
     * We handle both: if display fields are present we use them,
     * otherwise we show a generic "New message" notification.
     */
    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        if (data.isEmpty()) return

        val roomName = data["room_name"] ?: data["room_alias"]
        val senderName = data["sender_display_name"] ?: data["sender"]
        val roomId = data["room_id"] ?: ""

        // Build notification text
        val title: String
        val body: String

        if (senderName != null && roomName != null) {
            title = "$senderName ($roomName)"
            body = data["content"]?.let { parseContentBody(it) } ?: "Sent a message"
        } else if (senderName != null) {
            title = senderName
            body = data["content"]?.let { parseContentBody(it) } ?: "Sent a message"
        } else {
            title = "Pax"
            body = "New message"
        }

        // Tap opens the app (MainActivity is singleTask, so it'll reuse the existing instance)
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("room_id", roomId)
        }
        val pendingIntent = PendingIntent.getActivity(
            this, roomId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info) // TODO: replace with Pax icon resource
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .build()

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(notificationIdCounter++, notification)
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

    /**
     * Best-effort parse of the `content` field from Sygnal.
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
}