package ai.nullai.dgagent

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.provider.Settings
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var pageWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The app opens dark; the page updates this through setSystemBarTheme.
    applySystemBarTheme(dark = true)

    // btleplug 0.12 registers its JNI callbacks and captures Android's global
    // BLE adapter here. The Rust entry point is a no-op unless Gate 0 was
    // compiled in, so normal builds keep the experiment unreachable.
    if (!initializeButtplugGate0()) {
      Log.d(TAG, "Buttplug Gate 0 is disabled or native initialization failed")
    }
  }

  /** Edge-to-edge shows the window background behind the system bars. */
  private fun applySystemBarTheme(dark: Boolean) {
    window.decorView.setBackgroundColor(if (dark) DARK_SYSTEM_BAR else LIGHT_SYSTEM_BAR)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !dark
      isAppearanceLightNavigationBars = !dark
    }
  }

  private external fun initializeButtplugGate0(): Boolean
  private external fun requestNativeLifecycleSafety(): Boolean

  override fun onPause() {
    // Ask the page to stop DG-Lab output now, before the WebView is paused: the
    // stop it issues is carried out natively even after the page stops running.
    pageWebView?.evaluateJavascript(
      "window.dispatchEvent(new Event('0xnullai:native-pause'))",
      null,
    )
    // Native output and active scanning must stop before Android suspends the
    // WebView. Scanner ownership is released only after native cleanup.
    if (!requestNativeLifecycleSafety()) {
      Log.d(TAG, "Native lifecycle safety is unavailable")
    }
    super.onPause()
  }

  override fun onDestroy() {
    requestNativeLifecycleSafety()
    pageWebView = null
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    pageWebView = webView
    webView.addJavascriptInterface(AndroidSystemBridge(), "AndroidSystem")

    // CSS safe-area variables are not consistently populated by older Android
    // WebView releases. Padding the WebView itself does not move its document
    // viewport. Update its native layout margins so the document itself sits
    // between the status/navigation bars, including on older MIUI WebViews.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, windowInsets ->
      val handledTypes =
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val insets = windowInsets.getInsets(handledTypes)
      val imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      val params = webView.layoutParams as? ViewGroup.MarginLayoutParams
      params?.setMargins(insets.left, insets.top, insets.right, maxOf(insets.bottom, imeInsets.bottom))
      if (params != null) webView.layoutParams = params

      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(handledTypes or WindowInsetsCompat.Type.ime(), Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /** Narrow, local-only bridge for Android state that the WebView cannot query. */
  private inner class AndroidSystemBridge {
    @JavascriptInterface
    fun getSdkInt(): Int = Build.VERSION.SDK_INT

    @JavascriptInterface
    fun isLocationEnabled(): Boolean {
      val manager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        manager.isLocationEnabled
      } else {
        manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
          manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
      }
    }

    @JavascriptInterface
    fun isBlePermissionPermanentlyDenied(): Boolean {
      val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        Manifest.permission.BLUETOOTH_SCAN
      } else {
        Manifest.permission.ACCESS_FINE_LOCATION
      }
      return checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED &&
        !shouldShowRequestPermissionRationale(permission)
    }

    @JavascriptInterface
    fun hasBleScanPermission(): Boolean {
      val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        Manifest.permission.BLUETOOTH_SCAN
      } else {
        Manifest.permission.ACCESS_FINE_LOCATION
      }
      return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    }

    @JavascriptInterface
    fun hasCameraPermission(): Boolean =
      checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    @JavascriptInterface
    fun requestCameraPermission() {
      runOnUiThread {
        requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST_CODE)
      }
    }

    @JavascriptInterface
    fun requestBleScanPermission() {
      val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
      } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
      }
      runOnUiThread { requestPermissions(permissions, BLE_PERMISSION_REQUEST_CODE) }
    }

    /**
     * WebView ignores `<a download>`, so page exports (memories, chats, cards)
     * are handed over as base64 and written to the system Downloads folder
     * (MediaStore on Android 10+, which needs no storage permission; the app's
     * own Downloads folder before that).
     */
    @JavascriptInterface
    fun saveDownload(fileName: String, mimeType: String, base64: String): Boolean {
      if (base64.length > MAX_DOWNLOAD_BASE64) return false
      val name = fileName.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(120).ifBlank { "download" }
      val type = mimeType.ifBlank { "application/octet-stream" }
      return try {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, type)
            put(MediaStore.Downloads.IS_PENDING, 1)
          }
          val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return false
          contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
          values.clear()
          values.put(MediaStore.Downloads.IS_PENDING, 0)
          contentResolver.update(uri, values, null, null)
        } else {
          val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return false
          java.io.File(dir, name).writeBytes(bytes)
        }
        true
      } catch (error: Exception) {
        Log.w(TAG, "Saving a download failed", error)
        false
      }
    }

    @JavascriptInterface
    fun setSystemBarTheme(dark: Boolean) {
      runOnUiThread { applySystemBarTheme(dark) }
    }

    @JavascriptInterface
    fun openAppSettings() = launchSettings(
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
    )

    @JavascriptInterface
    fun openBluetoothSettings() = launchSettings(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))

    @JavascriptInterface
    fun openLocationSettings() = launchSettings(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))

    private fun launchSettings(intent: Intent) {
      runOnUiThread { startActivity(intent) }
    }
  }

  private companion object {
    const val TAG = "0xNuller"
    const val DARK_SYSTEM_BAR = 0xFF080808.toInt()
    const val LIGHT_SYSTEM_BAR = 0xFFFFFFFF.toInt()
    const val BLE_PERMISSION_REQUEST_CODE = 4101
    const val CAMERA_PERMISSION_REQUEST_CODE = 4102
    /** About 24 MB of file data; larger exports would stall the JS bridge. */
    const val MAX_DOWNLOAD_BASE64 = 32 * 1024 * 1024
  }
}
