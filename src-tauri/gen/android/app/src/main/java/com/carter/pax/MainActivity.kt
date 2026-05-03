package com.carter.pax

import android.content.Context
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView

    // Fetch the FCM token and inject it into the WebView.
    // The frontend hook reads `window.__paxFcmToken` to register
    // the pusher with the Matrix homeserver.
    injectFcmToken(webView)

    // TauriActivity sets handleBackNavigation = false, so the default is to leave the app.
    // Dispatch a CustomEvent the web UI listens for; only consume back when the web layer opts in.
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

  /**
   * Fetch the FCM device token (async) and inject it into the WebView
   * as `window.__paxFcmToken`. Also check SharedPreferences for a
   * previously-cached token from [PaxFCMService.onNewToken].
   */
  private fun injectFcmToken(webView: WebView) {
    // First, check if we have a cached token from a previous onNewToken call
    val prefs = getSharedPreferences(PaxFCMService.PREFS_NAME, Context.MODE_PRIVATE)
    val cachedToken = prefs.getString(PaxFCMService.PREF_FCM_TOKEN, null)
    if (cachedToken != null) {
      setTokenInWebView(webView, cachedToken)
    }

    // Also fetch the current token from Firebase (may be the same, may be newer)
    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
      if (!task.isSuccessful) return@addOnCompleteListener
      val token = task.result ?: return@addOnCompleteListener

      // Persist for next launch
      prefs.edit().putString(PaxFCMService.PREF_FCM_TOKEN, token).apply()

      // Inject into WebView on the main thread
      runOnUiThread {
        setTokenInWebView(webView, token)
      }
    }
  }

  private fun setTokenInWebView(webView: WebView, token: String) {
    // Escape the token for safe JS string injection
    val escaped = token.replace("\\", "\\\\").replace("'", "\\'")
    webView.evaluateJavascript(
      "(function(){" +
        "window.__paxFcmToken='$escaped';" +
        "window.dispatchEvent(new CustomEvent('pax-fcm-token',{detail:{token:'$escaped'}}));" +
        "})()",
      null
    )
  }
}