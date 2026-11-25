package com.carter.pax

import android.content.Context
import org.json.JSONObject

internal object PaxMessagePreview {
    private const val PREF = "show_message_previews"
    private const val MAX_LENGTH = 500
    private const val GENERIC = "New message"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PaxFCMService.PREFS_NAME, Context.MODE_PRIVATE)

    fun enabled(context: Context): Boolean = prefs(context).getBoolean(PREF, true)

    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(PREF, enabled).apply()
    }

    fun payloadBody(data: Map<String, String>): String? {
        if (data["type"] == "m.room.encrypted") return null
        data["content_body"]?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        val content = data["content"] ?: return null
        return runCatching { JSONObject(content).opt("body") as? String }
            .getOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    }

    data class Header(val title: String, val subText: String?)

    fun header(sender: String?, room: String?, isDirect: Boolean?): Header {
        if (sender == null) return Header(room ?: "Someone", null)
        // When room state is unavailable, avoid repeating the sender's name.
        val omitRoom = isDirect ?: sender.equals(room, ignoreCase = true)
        return Header(sender, if (omitRoom) null else room)
    }

    fun notificationBody(enabled: Boolean, resolved: String?, payload: String?): String {
        if (!enabled) return GENERIC
        val text = resolved?.trim()?.takeIf { it.isNotEmpty() } ?: payload ?: return GENERIC
        return if (text.length <= MAX_LENGTH) text else text.take(MAX_LENGTH - 1) + "…"
    }
}
