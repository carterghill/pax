package com.carter.pax

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.Locale
import java.util.UUID

internal object PaxCallPush {
    init { System.loadLibrary("pax_lib") }

    external fun resolve(dataDir: String, roomId: String, eventId: String): String?
    external fun decline(dataDir: String, roomId: String, callId: String, matrixRingEventId: String): Boolean
}

internal object PaxCallNotifications {
    const val OPEN = "com.carter.pax.call.OPEN"
    const val ANSWER = "com.carter.pax.call.ANSWER"
    const val DECLINE = "com.carter.pax.call.DECLINE"
    private const val CHANNEL = "pax_calls"
    private const val TAG = "PaxCalls"
    private const val ACTIVE = "incoming"
    private const val ACTION = "action"
    private const val FINISHED = "finished"
    private const val RING_EVENT = "ring_event"
    private const val NOTIFICATION_ID = 1
    private const val MAX_RING_MS = 150_000L
    private val main = Handler(Looper.getMainLooper())

    @Volatile var busy = false
    @Volatile var activity: WeakReference<MainActivity>? = null

    data class Call(
        val id: String, val roomId: String, val caller: String, val expiresAt: Long,
        val matrixVoip: Boolean = false, val ringEventId: String = "",
    ) {
        fun json() = JSONObject().put("callId", id).put("roomId", roomId)
            .put("expiresAt", expiresAt).put("matrixVoip", matrixVoip).put("ringEventId", ringEventId)
    }

    private fun prefs(context: Context) = context.getSharedPreferences("pax_calls", Context.MODE_PRIVATE)
    private fun manager(context: Context) = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH)
        channel.description = "Incoming Pax voice calls"
        channel.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build(),
        )
        manager(context).createNotificationChannel(channel)
    }

    fun canPost(context: Context): Boolean {
        val notifications = manager(context)
        if (!notifications.areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            (notifications.getNotificationChannel(CHANNEL)?.importance ?: NotificationManager.IMPORTANCE_NONE) >
                NotificationManager.IMPORTANCE_NONE
    }
    private fun validId(value: String): Boolean = runCatching {
        UUID.fromString(value).toString() == value.lowercase(Locale.ROOT)
    }.getOrDefault(false)

    fun parse(value: JSONObject): Call? {
        val id = value.optString("callId")
        val room = value.optString("roomId")
        if (!validId(id) || room.isBlank()) return null
        return Call(id, room, value.optString("caller"), value.optLong("expiresAt"),
            value.optBoolean("matrixVoip"), value.optString("ringEventId"))
    }

    private fun current(context: Context): Call? = prefs(context).getString(ACTIVE, null)?.let {
        runCatching { parse(JSONObject(it)) }.getOrNull()
    }

    private fun discardExpired(context: Context, now: Long): JSONObject {
        val stored = prefs(context).getString(FINISHED, null)
        val ids = stored?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
        val expired = ids.keys().asSequence().filter { ids.optLong(it) <= now }.toList()
        expired.forEach { ids.remove(it) }
        return ids
    }

    @Synchronized
    fun show(context: Context, call: Call, eventId: String? = null) {
        val now = System.currentTimeMillis()
        val duration = call.expiresAt - now
        if (!validId(call.id) || duration !in 1L..MAX_RING_MS) return
        if (!eventId.isNullOrBlank()) {
            prefs(context).edit().putString(RING_EVENT, eventId).apply()
            manager(context).cancel(eventId, 0)
        }
        if (busy) return
        if (discardExpired(context, now).has(call.id)) return
        val current = current(context)
        if (current != null && current.expiresAt > now && current.id != call.id) return

        createChannel(context)
        if (!canPost(context)) {
            Log.d(TAG, "Incoming call notification is disabled by Android notification settings")
            return
        }
        val caller = call.caller.ifBlank { "Pax contact" }
        val heading = context.getString(R.string.pax_incoming_call_from, caller)
        val controls = RemoteViews(context.packageName, R.layout.notification_incoming_call).apply {
            setTextViewText(R.id.pax_call_heading, heading)
            setOnClickPendingIntent(R.id.pax_call_decline, intent(context, call.id, DECLINE))
            setOnClickPendingIntent(R.id.pax_call_answer, intent(context, call.id, ANSWER))
        }
        // Firebase can post this directly. Android reserves CallStyle for notifications
        // attached to a foreground service, user-initiated job, or full-screen intent.
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_pax)
            .setContentTitle(heading)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(duration)
            .setContentIntent(intent(context, call.id, OPEN))
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
            .setCustomHeadsUpContentView(controls)
            .setCustomBigContentView(controls)
            .build()
        try {
            manager(context).notify(call.id, NOTIFICATION_ID, notification)
        } catch (error: IllegalArgumentException) {
            Log.w(TAG, "Android rejected the incoming call notification", error)
            return
        } catch (error: SecurityException) {
            Log.w(TAG, "Android blocked the incoming call notification", error)
            return
        }
        val saved = if (eventId.isNullOrBlank()) call else call.copy(ringEventId = eventId)
        prefs(context).edit().putString(ACTIVE, saved.json().toString()).apply()
        val app = context.applicationContext
        main.postDelayed({ close(app, call.id, false) }, duration)
    }

    fun hasSeenRing(context: Context, eventId: String): Boolean =
        eventId.isNotEmpty() && prefs(context).getString(RING_EVENT, null) == eventId

    private fun intent(context: Context, id: String, action: String): PendingIntent {
        val target = if (action == DECLINE) PaxCallActionReceiver::class.java else MainActivity::class.java
        val intent = Intent(context, target).setAction(action)
            .setData(Uri.Builder().scheme("pax-call").authority("notification").appendPath(id).build())
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        if (action == DECLINE) return PendingIntent.getBroadcast(context, 0, intent, flags)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, flags)
    }

    @Synchronized
    fun close(context: Context, id: String, ended: Boolean) {
        if (!validId(id)) return
        val changes = prefs(context).edit()
        if (ended) {
            val now = System.currentTimeMillis()
            val finished = discardExpired(context, now)
            finished.put(id, now + MAX_RING_MS * 2)
            changes.putString(FINISHED, finished.toString())
        }
        if (current(context)?.id == id) changes.remove(ACTIVE)
        changes.apply()
        manager(context).cancel(id, NOTIFICATION_ID)
    }

    @Synchronized
    fun select(context: Context, intent: Intent): Call? {
        val call = current(context) ?: return null
        if (call.id != intent.data?.lastPathSegment || call.expiresAt <= System.currentTimeMillis()) return null
        close(context, call.id, true)
        return call
    }

    @Synchronized
    fun queueAction(context: Context, call: Call, action: String) {
        val payload = JSONObject().put("callId", call.id).put("expiresAt", call.expiresAt).put("action", action)
        prefs(context).edit().putString(ACTION, payload.toString()).apply()
        main.post { activity?.get()?.dispatchCallNotificationAction() }
    }

    @Synchronized
    fun takeAction(context: Context): String {
        val prefs = prefs(context)
        val payload = prefs.getString(ACTION, "").orEmpty()
        if (payload.isNotEmpty()) prefs.edit().remove(ACTION).apply()
        return payload
    }
}

class PaxCallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != PaxCallNotifications.DECLINE) return
        val call = PaxCallNotifications.select(context, intent) ?: return
        val pending = goAsync()
        Thread {
            try {
                val declined = runCatching {
                    PaxCallPush.decline(context.applicationInfo.dataDir, call.roomId, call.id,
                        if (call.matrixVoip) call.ringEventId else "")
                }
                    .getOrDefault(false)
                PaxCallNotifications.queueAction(context, call, if (declined) "dismiss" else "decline")
            } finally {
                pending.finish()
            }
        }.start()
    }
}
