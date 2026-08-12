package ai.nullai.dgagent

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    // CSS safe-area variables are not consistently populated by older Android
    // WebView releases. Apply system bars at the native boundary, then consume
    // only those inset types so newer WebViews do not add the same space again.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
      val handledTypes =
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val insets = windowInsets.getInsets(handledTypes)
      view.setPadding(insets.left, insets.top, insets.right, insets.bottom)

      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(handledTypes, Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(webView)
  }
}
