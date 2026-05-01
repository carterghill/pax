package com.carter.pax

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
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
}
