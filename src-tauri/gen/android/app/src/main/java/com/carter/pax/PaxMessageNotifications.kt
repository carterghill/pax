package com.carter.pax

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicInteger

internal object PaxMessageNotifications {
    private const val TAG = "PaxNotifications"
    private val nextId = AtomicInteger()

    fun post(
        context: Context,
        roomId: String,
        eventId: String,
        title: String,
        body: String,
        subText: String? = null,
        tag: String? = eventId.takeIf { it.isNotEmpty() },
        missedCall: Boolean = false,
        silent: Boolean = false,
    ) {
        if (!PaxNotificationBadge.sessionActive(context)) return
        // Tap opens the app (MainActivity is singleTask, so it'll reuse the existing instance).
        // `event_id` lets the WebView scroll to the notified message after switching rooms.
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("room_id", roomId)
            if (eventId.isNotEmpty()) putExtra("event_id", eventId)
        }
        val pendingIntent = PendingIntent.getActivity(
            context, roomId.hashCode() xor eventId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        fun buildNotification(smallIcon: Int) =
            NotificationCompat.Builder(context, PaxNotificationBadge.ALERTS)
                .setSmallIcon(smallIcon)
                .setContentTitle(title)
                .setSubText(subText)
                .setContentText(body)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setSilent(silent)
                .setOnlyAlertOnce(eventId.isNotEmpty())
                .setContentIntent(pendingIntent)
                .apply {
                    if (missedCall) {
                        setStyle(NotificationCompat.BigTextStyle().bigText(body))
                        setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                    }
                }
                .build()

        val id = if (tag == null) nextId.getAndIncrement() else 0
        try {
            manager.notify(tag, id, buildNotification(R.drawable.ic_stat_pax))
        } catch (e: RuntimeException) {
            Log.w(TAG, "Posting notification with ic_stat_pax failed; using system fallback icon", e)
            manager.notify(tag, id, buildNotification(android.R.drawable.ic_dialog_info))
        }
    }
}
