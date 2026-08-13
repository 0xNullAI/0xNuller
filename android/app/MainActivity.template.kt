package ai.nullai.dgagent

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ViewGroup
import android.webkit.JavascriptInterface
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
    fun requestBleScanPermission() {
      val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
      } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
      }
      runOnUiThread { requestPermissions(permissions, BLE_PERMISSION_REQUEST_CODE) }
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
    const val BLE_PERMISSION_REQUEST_CODE = 4101
  }
}
