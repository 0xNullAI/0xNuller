package ai.nullai.dgagent

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var pushWebView: WebView? = null
  private var pendingPushIntent: Intent? = null
  private val pushRegistrationListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
    if (key == "installation_id") runOnUiThread {
      pushWebView?.evaluateJavascript(
        "window.dispatchEvent(new Event('0xnullai:push-registration'))",
        null,
      )
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    getSharedPreferences("android_push", Context.MODE_PRIVATE)
      .registerOnSharedPreferenceChangeListener(pushRegistrationListener)
    pendingPushIntent = intent?.takeIf { PushSupport.routeFromIntent(this, it) != null }

    // btleplug 0.12 registers its JNI callbacks and captures Android's global
    // BLE adapter here. The Rust entry point is a no-op unless Gate 0 was
    // compiled in, so normal builds keep the experiment unreachable.
    if (!initializeButtplugGate0()) {
      Log.d(TAG, "Buttplug Gate 0 is disabled or native initialization failed")
    }
  }

  private external fun initializeButtplugGate0(): Boolean
  private external fun requestNativeLifecycleSafety(): Boolean

  override fun onPause() {
    // Native output and active scanning must stop before Android suspends the
    // WebView. Scanner ownership is released only after native cleanup.
    if (!requestNativeLifecycleSafety()) {
      Log.d(TAG, "Native lifecycle safety is unavailable")
    }
    super.onPause()
  }

  override fun onDestroy() {
    requestNativeLifecycleSafety()
    getSharedPreferences("android_push", Context.MODE_PRIVATE)
      .unregisterOnSharedPreferenceChangeListener(pushRegistrationListener)
    pushWebView = null
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (PushSupport.routeFromIntent(this, intent) == null) return
    pendingPushIntent = intent
    pushWebView?.evaluateJavascript("window.dispatchEvent(new Event('0xnullai:push-open'))", null)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    pushWebView = webView
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
    fun isPushConfigured(): Boolean = PushSupport.configured(this@MainActivity)

    @JavascriptInterface
    fun hasNotificationPermission(): Boolean = PushSupport.hasPermission(this@MainActivity)

    @JavascriptInterface
    fun requestNotificationPermission() {
      if (Build.VERSION.SDK_INT >= 33 && !PushSupport.hasPermission(this@MainActivity)) {
        runOnUiThread {
          requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            NOTIFICATION_PERMISSION_REQUEST_CODE,
          )
        }
      }
    }

    @JavascriptInterface
    fun ensurePushChannels() = PushSupport.ensureChannels(this@MainActivity)

    @JavascriptInterface
    fun setPushAccountId(accountId: String) = PushSupport.setAccount(this@MainActivity, accountId)

    @JavascriptInterface
    fun registerPush() = PushSupport.register(this@MainActivity)

    @JavascriptInterface
    fun unregisterPush() = PushSupport.unregister(this@MainActivity)

    @JavascriptInterface
    fun getPushRegistrationId(): String = PushSupport.installationId(this@MainActivity)

    @JavascriptInterface
    fun getPushInstallationKey(): String = PushSupport.installationKey(this@MainActivity)

    @JavascriptInterface
    fun getPreviousPushRegistrationId(): String = PushSupport.previousInstallationId(this@MainActivity)

    @JavascriptInterface
    fun consumePushRoute(): String = synchronized(this@MainActivity) {
      val route = PushSupport.routeFromIntent(this@MainActivity, pendingPushIntent).orEmpty()
      pendingPushIntent = null
      route
    }

    @JavascriptInterface
    fun consumePushTarget(): String = synchronized(this@MainActivity) {
      val pending = pendingPushIntent
      val route = PushSupport.routeFromIntent(this@MainActivity, pending)
      pendingPushIntent = null
      val accountId = pending?.getStringExtra("ai.nullai.dgagent.PUSH_ACCOUNT")
      if (route == null || accountId.isNullOrEmpty()) ""
      else JSONObject().put("accountId", accountId).put("route", route).toString()
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
    const val TAG = "0xNuller"
    const val BLE_PERMISSION_REQUEST_CODE = 4101
    const val CAMERA_PERMISSION_REQUEST_CODE = 4102
    const val NOTIFICATION_PERMISSION_REQUEST_CODE = 4103
  }
}
