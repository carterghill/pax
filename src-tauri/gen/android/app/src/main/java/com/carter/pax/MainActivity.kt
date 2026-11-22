package com.carter.pax

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import android.webkit.JavascriptInterface
import org.json.JSONObject
import org.webrtc.ContextUtils
import java.lang.ref.WeakReference

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null
  /** Cold start: intent arrives before the WebView exists — flush after first page load. */
  private var pendingNotificationOpen: Pair<String, String?>? = null
  private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    if (granted) PaxNotificationBadge.refresh(this)
    if (granted && PaxCallNotifications.canPost(this)) {
      webViewRef?.evaluateJavascript("window.dispatchEvent(new Event('pax-notification-permission-granted'))", null)
    }
  }
  private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    webViewRef?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('pax-microphone-permission',{detail:$granted}))",
      null,
    )
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    ContextUtils.initialize(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    PaxCallNotifications.createChannel(this)
    PaxNotificationBadge.createChannels(this)
    PaxCallNotifications.activity = WeakReference(this)
    handleNotificationIntent(intent)
  }

  override fun onDestroy() {
    if (PaxCallNotifications.activity?.get() == this) PaxCallNotifications.activity = null
    super.onDestroy()
  }

  override fun onResume() {
    super.onResume()
    PaxPushJob.schedule(this)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleNotificationIntent(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(PaxBridge(), "PaxAndroid")
    webViewRef = webView

    webView.webViewClient = object : android.webkit.WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            val pending = pendingNotificationOpen
            if (pending != null) {
              dispatchOpenNotification(webView, pending.first, pending.second)
              pendingNotificationOpen = null
            }
        }
    }

    onBackPressedDispatcher.addCallback(
        this,
        object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){try{if(window.__paxAndroidBackHandlesNav){" +
                        "window.dispatchEvent(new CustomEvent('pax-android-back'));return true;}" +
                        "return false;}catch(e){return false;}})()"
                ) { result ->
                    val consumed =
                        result == "true" ||
                            result == "\"true\""
                    if (!consumed) {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        }
    )
  }

  private fun handleNotificationIntent(intent: Intent?) {
    val i = intent ?: return
    if (i.action == PaxCallNotifications.ANSWER || i.action == PaxCallNotifications.OPEN) {
      val call = PaxCallNotifications.select(this, i) ?: return
      if (i.action == PaxCallNotifications.ANSWER) {
        PaxCallNotifications.queueAction(this, call, "answer")
      }
      return
    }
    val roomId = i.getStringExtra("room_id")?.trim() ?: return
    if (roomId.isEmpty()) return
    val eventId = i.getStringExtra("event_id")?.trim()?.takeIf { it.isNotEmpty() }
    val wv = webViewRef
    if (wv != null) {
      dispatchOpenNotification(wv, roomId, eventId)
    } else {
      pendingNotificationOpen = roomId to eventId
    }
  }

  internal fun dispatchCallNotificationAction() {
    webViewRef?.evaluateJavascript("window.dispatchEvent(new Event('pax-call-notification-action'))", null)
  }

  /**
   * Mirrors desktop `pax-notification-clicked` so MainLayout can open the room
   * and ChatView can scroll to [eventId] when present.
   */
  private fun dispatchOpenNotification(webView: WebView, roomId: String, eventId: String?) {
    val rid = JSONObject.quote(roomId)
    val evPart =
      if (eventId != null && eventId.isNotEmpty()) ",eventId:${JSONObject.quote(eventId)}" else ""
    val js =
      "(function(){var d={roomId:$rid$evPart};" +
        "window.dispatchEvent(new CustomEvent('pax-notification-clicked',{detail:d}));})()"
    webView.post {
      webView.evaluateJavascript(js, null)
    }
  }

  inner class PaxBridge {
    @JavascriptInterface
    fun setBadgeCount(count: Int) = PaxNotificationBadge.sync(this@MainActivity, count)

    @JavascriptInterface
    fun setBadgeSessionActive(active: Boolean) {
      PaxNotificationBadge.setSessionActive(this@MainActivity, active)
      if (active) {
        PaxPushJob.schedule(this@MainActivity, replacePending = true)
      } else {
        PaxPushJob.cancel(this@MainActivity)
      }
    }

    @JavascriptInterface
    fun requestNotificationPermission() {
      runOnUiThread {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
          checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        ) return@runOnUiThread
        val prefs = getSharedPreferences(PaxFCMService.PREFS_NAME, Context.MODE_PRIVATE)
        val requested = "notification_permission_requested"
        if (prefs.getBoolean(requested, false)) return@runOnUiThread
        prefs.edit().putBoolean(requested, true).apply()
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
      }
    }

    @JavascriptInterface
    fun canPostIncomingCalls(): Boolean = PaxCallNotifications.canPost(this@MainActivity)

    @JavascriptInterface
    fun hasMicrophonePermission(): Boolean =
      checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    @JavascriptInterface
    fun requestMicrophonePermission() {
      runOnUiThread { microphonePermission.launch(Manifest.permission.RECORD_AUDIO) }
    }

    @JavascriptInterface
    fun showIncomingCall(id: String, roomId: String, caller: String, expiresAt: Long, eventId: String, matrixVoip: Boolean) {
      PaxCallNotifications.show(this@MainActivity, PaxCallNotifications.Call(id, roomId, caller, expiresAt, matrixVoip), eventId)
    }

    @JavascriptInterface
    fun closeIncomingCall(id: String, ended: Boolean) {
      PaxCallNotifications.close(this@MainActivity, id, ended)
    }

    @JavascriptInterface
    fun takeCallNotificationAction(): String = PaxCallNotifications.takeAction(this@MainActivity)

    @JavascriptInterface
    fun setCallNotificationBusy(busy: Boolean) { PaxCallNotifications.busy = busy }

    @JavascriptInterface
    fun getFcmToken(): String {
        val prefs = getSharedPreferences(PaxFCMService.PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(PaxFCMService.PREF_FCM_TOKEN, "") ?: ""
    }
  }

}
