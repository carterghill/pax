package com.carter.pax

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

internal object PaxNotificationBadge {
    // Android makes badge settings immutable after channel creation. Keep the
    // existing alert preferences when moving previews to a non-badging channel.
    private const val LEGACY_ALERTS = "pax_messages"
    const val ALERTS = "pax_message_alerts"
    private const val CHANNEL = "pax_unread_messages"
    private const val TAG = "pax-unread"
    private const val COUNT = "unread_badge_count"
    private const val ACTIVE = "badge_session_active"

    private fun manager(context: Context) =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun prefs(context: Context) =
        context.getSharedPreferences(PaxFCMService.PREFS_NAME, Context.MODE_PRIVATE)

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = manager(context)
        val previous = manager.getNotificationChannel(LEGACY_ALERTS)
        if (manager.getNotificationChannel(ALERTS) == null) {
            val importance = previous?.importance ?: NotificationManager.IMPORTANCE_HIGH
            val alerts = NotificationChannel(ALERTS, "Messages", importance).apply {
                description = "Matrix message notifications"
                setShowBadge(false)
                if (previous != null) {
                    setSound(previous.sound, previous.audioAttributes)
                    vibrationPattern = previous.vibrationPattern
                    enableVibration(previous.shouldVibrate())
                    lightColor = previous.lightColor
                    enableLights(previous.shouldShowLights())
                    lockscreenVisibility = previous.lockscreenVisibility
                }
            }
            manager.createNotificationChannel(alerts)
        }
        if (manager.getNotificationChannel(CHANNEL) == null) {
            val unread = NotificationChannel(CHANNEL, "Unread messages", NotificationManager.IMPORTANCE_MIN).apply {
                description = "The unread notification count on the Pax app icon"
                setShowBadge(previous?.let { it.canShowBadge() && it.importance != NotificationManager.IMPORTANCE_NONE } ?: true)
            }
            manager.createNotificationChannel(unread)
        }
    }

    fun sessionActive(context: Context): Boolean = prefs(context).getBoolean(ACTIVE, true)

    fun pushRegistrationActive(context: Context): Boolean = prefs(context).getBoolean(ACTIVE, false)

    @Synchronized
    fun setSessionActive(context: Context, active: Boolean) {
        prefs(context).edit().putBoolean(ACTIVE, active).apply()
        if (!active) {
            update(context, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = manager(context)
                for (alert in manager.activeNotifications) {
                    val channel = alert.notification.channelId
                    if (channel == ALERTS || channel == LEGACY_ALERTS) {
                        manager.cancel(alert.tag, alert.id)
                    }
                }
            }
        }
    }

    @Synchronized
    fun sync(context: Context, count: Int) {
        if (sessionActive(context)) update(context, count.coerceAtLeast(0))
    }

    @Synchronized
    fun refresh(context: Context) {
        sync(context, prefs(context).getInt(COUNT, 0))
    }

    @Synchronized
    fun onMessage(context: Context, count: Int?, tag: String?) {
        if (!sessionActive(context)) return
        if (count != null) {
            update(context, count)
        } else if (tag == null || manager(context).activeNotifications.none { it.tag == tag }) {
            val previous = prefs(context).getInt(COUNT, 0)
            update(context, previous.coerceAtMost(Int.MAX_VALUE - 1) + 1)
        }
    }

    private fun update(context: Context, count: Int) {
        prefs(context).edit().putInt(COUNT, count).apply()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = manager(context)
        val legacy = manager.activeNotifications.filter { it.notification.channelId == LEGACY_ALERTS }
        if (count == 0) {
            for (alert in legacy) manager.cancel(alert.tag, alert.id)
        }
        // Notifications posted by older versions can still contribute to the
        // launcher count until they are read or dismissed.
        val legacyCount = if (manager.getNotificationChannel(LEGACY_ALERTS)?.canShowBadge() == true) {
            legacy.size
        } else {
            0
        }
        val badgeCount = count - legacyCount
        if (badgeCount <= 0) {
            manager.cancel(TAG, 0)
            return
        }
        if (!manager.areNotificationsEnabled()) return
        createChannels(context)
        if (manager.getNotificationChannel(CHANNEL)?.canShowBadge() != true) {
            manager.cancel(TAG, 0)
            return
        }
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_pax)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.resources.getQuantityString(R.plurals.pax_unread_notifications, count, count))
            .setNumber(badgeCount)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(open)
            .build()
        try {
            manager.notify(TAG, 0, notification)
        } catch (error: RuntimeException) {
            Log.w("PaxBadge", "Could not post unread notification badge", error)
        }
    }
}
