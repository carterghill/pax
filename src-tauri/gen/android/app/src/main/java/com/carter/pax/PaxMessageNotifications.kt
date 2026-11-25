package com.carter.pax

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicInteger

internal object PaxMessageNotifications {
    private const val TAG = "PaxNotifications"
    private const val ALERTS = "pax_message_alerts"
    private const val LEGACY_ALERTS = "pax_messages"
    private const val LEGACY_UNREAD = "pax_unread_messages"
    private const val ACTIVE = "badge_session_active"
    private const val EXTRA_SILENT = "com.carter.pax.silent"
    private val nextId = AtomicInteger()

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        // Retire the separate unread-count notification on upgrade, including any visible copy.
        if (manager.getNotificationChannel(LEGACY_UNREAD) != null) {
            manager.cancel("pax-unread", 0)
            manager.deleteNotificationChannel(LEGACY_UNREAD)
        }
        if (manager.getNotificationChannel(ALERTS) != null) return
        val previous = manager.getNotificationChannel(LEGACY_ALERTS)
        val importance = previous?.importance ?: NotificationManager.IMPORTANCE_HIGH
        val alerts = NotificationChannel(ALERTS, "Messages", importance).apply {
            description = "Matrix message notifications"
            if (previous != null) {
                setShowBadge(previous.canShowBadge())
                setSound(previous.sound, previous.audioAttributes)
                vibrationPattern = previous.vibrationPattern
                enableVibration(previous.shouldVibrate())
                lightColor = previous.lightColor
                enableLights(previous.shouldShowLights())
                lockscreenVisibility = previous.lockscreenVisibility
            } else {
                enableVibration(true)
            }
        }
        manager.createNotificationChannel(alerts)
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PaxFCMService.PREFS_NAME, Context.MODE_PRIVATE)

    fun sessionActive(context: Context): Boolean = prefs(context).getBoolean(ACTIVE, true)

    fun pushRegistrationActive(context: Context): Boolean = prefs(context).getBoolean(ACTIVE, false)

    @Synchronized
    fun setSessionActive(context: Context, active: Boolean) {
        prefs(context).edit().putBoolean(ACTIVE, active).apply()
        if (!active && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            for (alert in manager.activeNotifications) {
                val channel = alert.notification.channelId
                if (channel == ALERTS || channel == LEGACY_ALERTS) {
                    manager.cancel(alert.tag, alert.id)
                }
            }
        }
    }

    @Synchronized
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
        if (!sessionActive(context)) return
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
        val previous = tag?.let {
            manager.activeNotifications.firstOrNull { alert -> alert.tag == tag && alert.id == 0 }?.notification
        }
        val wasSilent = previous != null && (previous.extras.getBoolean(EXTRA_SILENT) ||
            NotificationCompat.getGroupAlertBehavior(previous) == NotificationCompat.GROUP_ALERT_SUMMARY)
        // A retry can resolve a previously quiet encrypted push. Let the same
        // notification alert once, and keep a later unresolved retry from downgrading it.
        if (silent && previous != null && !wasSilent) return

        fun buildNotification(smallIcon: Int) =
            NotificationCompat.Builder(context, ALERTS)
                .setSmallIcon(smallIcon)
                .setContentTitle(title)
                .setSubText(subText)
                .setContentText(body)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setSilent(silent)
                .setOnlyAlertOnce(eventId.isNotEmpty() && (silent || !wasSilent))
                .setContentIntent(pendingIntent)
                .apply {
                    if (silent) extras.putBoolean(EXTRA_SILENT, true)
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O && !silent) {
                        setDefaults(NotificationCompat.DEFAULT_SOUND or NotificationCompat.DEFAULT_VIBRATE)
                    }
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
