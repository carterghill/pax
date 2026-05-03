package com.carter.pax

import android.content.Context
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import com.google.firebase.messaging.FirebaseMessaging
import android.util.Log

import android.webkit.JavascriptInterface

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(PaxBridge(), "PaxAndroid")
    webViewRef = webView

    webView.webViewClient = object : android.webkit.WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            Log.d("PaxPush", "page finished, injecting token")
            injectFcmToken(webView)
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

  private fun injectFcmToken(webView: WebView) {
    Log.d("PaxPush", "injectFcmToken called")

    val prefs = getSharedPreferences(PaxFCMService.PREFS_NAME, Context.MODE_PRIVATE)
    val cachedToken = prefs.getString(PaxFCMService.PREF_FCM_TOKEN, null)

    if (cachedToken != null) {
        writeTokenFile(cachedToken)
    }

    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        Log.d("PaxPush", "token task complete, success=${task.isSuccessful}")
        if (!task.isSuccessful) {
            Log.e("PaxPush", "token fetch failed", task.exception)
            return@addOnCompleteListener
        }
        val token = task.result ?: return@addOnCompleteListener
        Log.d("PaxPush", "got token: ${token.take(10)}...")
        prefs.edit().putString(PaxFCMService.PREF_FCM_TOKEN, token).apply()
        writeTokenFile(token)
    }
  }

  private fun writeTokenFile(token: String) {
      try {
          val file = java.io.File(filesDir, "fcm_token.txt")
          file.writeText(token)
          Log.d("PaxPush", "wrote token to ${file.absolutePath}")
      } catch (e: Exception) {
          Log.e("PaxPush", "failed to write token file", e)
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

  inner class PaxBridge {
    @JavascriptInterface
    fun getFcmToken(): String {
        val prefs = getSharedPreferences(PaxFCMService.PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(PaxFCMService.PREF_FCM_TOKEN, "") ?: ""
    }
  }

}