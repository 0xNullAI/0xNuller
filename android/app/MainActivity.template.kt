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
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import android.provider.Settings
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.security.KeyStore
import java.util.Collections
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class MainActivity : TauriActivity() {
  private var pageWebView: WebView? = null
  private val secureStore by lazy { SecureStore(applicationContext) }
  private val permissionHistory by lazy {
    getSharedPreferences(PERMISSION_HISTORY_PREFS, Context.MODE_PRIVATE)
  }
  /** Media permissions with a system sheet open; the page polls until it closes. */
  private val pendingMediaPermissions = Collections.synchronizedSet(mutableSetOf<String>())

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The app opens dark; the page updates this through setSystemBarTheme.
    applySystemBarTheme(dark = true)
  }

  /** Edge-to-edge shows the window background behind the system bars. */
  private fun applySystemBarTheme(dark: Boolean) {
    window.decorView.setBackgroundColor(if (dark) DARK_SYSTEM_BAR else LIGHT_SYSTEM_BAR)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !dark
      isAppearanceLightNavigationBars = !dark
    }
  }

  private external fun requestNativeLifecycleSafety(): Boolean

  override fun onPause() {
    // Ask the page to stop DG-Lab output now, before the WebView is paused: the
    // stop it issues is carried out natively even after the page stops running.
    pageWebView?.evaluateJavascript(
      "window.dispatchEvent(new Event('0xnullai:native-pause'))",
      null,
    )
    // Active scanning must stop before Android suspends the WebView. Scanner
    // ownership is released only after native cleanup.
    if (!requestNativeLifecycleSafety()) {
      Log.d(TAG, "Native lifecycle safety is unavailable")
    }
    super.onPause()
  }

  @Suppress("OVERRIDE_DEPRECATION")
  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    // A cancelled request reports empty arrays, so release every pending media request.
    if (requestCode == MEDIA_PERMISSION_REQUEST_CODE) pendingMediaPermissions.clear()
  }

  private fun mediaPermission(name: String): String? = when (name) {
    "camera" -> Manifest.permission.CAMERA
    "microphone" -> Manifest.permission.RECORD_AUDIO
    else -> null
  }

  private fun markPermissionAsked(permission: String) {
    permissionHistory.edit().putBoolean(permission, true).apply()
  }

  private fun requestMediaPermissionNow(permission: String) {
    if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return
    pendingMediaPermissions.add(permission)
    // Without this flag "never asked" and "denied with don't ask again" look the same.
    markPermissionAsked(permission)
    runOnUiThread {
      requestPermissions(arrayOf(permission), MEDIA_PERMISSION_REQUEST_CODE)
    }
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
    fun requestCameraPermission() = requestMediaPermissionNow(Manifest.permission.CAMERA)

    /** `name` is "camera" or "microphone". */
    @JavascriptInterface
    fun requestMediaPermission(name: String) {
      mediaPermission(name)?.let { requestMediaPermissionNow(it) }
    }

    /**
     * granted, requesting (system sheet open), prompt (never asked), denied (may ask again) or
     * blocked (denied with "don't ask again": only App settings can grant it). Permissions the
     * WebView asked for itself are recorded when the page reads a denial here.
     */
    @JavascriptInterface
    fun getMediaPermissionStatus(name: String): String {
      val permission = mediaPermission(name) ?: return "unsupported"
      if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return "granted"
      if (pendingMediaPermissions.contains(permission)) return "requesting"
      if (shouldShowRequestPermissionRationale(permission)) {
        markPermissionAsked(permission)
        return "denied"
      }
      return if (permissionHistory.getBoolean(permission, false)) "blocked" else "prompt"
    }

    /** Keeps the display on during a voice call; the page clears it on hang-up. */
    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
      runOnUiThread {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }

    /** Account token and remembered API keys. Values are never logged. */
    @JavascriptInterface
    fun secureGet(key: String): String? = secureStore.get(key)

    @JavascriptInterface
    fun secureSet(key: String, value: String): Boolean = secureStore.set(key, value)

    @JavascriptInterface
    fun secureRemove(key: String): Boolean = secureStore.remove(key)

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
    const val MEDIA_PERMISSION_REQUEST_CODE = 4102
    const val PERMISSION_HISTORY_PREFS = "0xnuller.permission-history"
    /** About 24 MB of file data; larger exports would stall the JS bridge. */
    const val MAX_DOWNLOAD_BASE64 = 32 * 1024 * 1024
  }
}

/**
 * Small encrypted key-value store for secrets the page must keep across starts.
 *
 * Each value is sealed with AES-GCM under a non-exportable Android Keystore key and bound to its
 * entry name; only the ciphertext reaches this app's private SharedPreferences. App backup is
 * disabled, and a restored or migrated ciphertext could not be opened without the key anyway.
 * Values and names are never logged.
 */
private class SecureStore(context: Context) {
  private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  private var cachedKey: SecretKey? = null

  @Synchronized
  fun get(name: String): String? {
    if (!validName(name)) return null
    val stored = prefs.getString(name, null) ?: return null
    return try {
      val separator = stored.indexOf(':')
      if (separator <= 0) throw IllegalArgumentException("malformed entry")
      val iv = Base64.decode(stored.substring(0, separator), Base64.NO_WRAP)
      val sealed = Base64.decode(stored.substring(separator + 1), Base64.NO_WRAP)
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, iv))
      cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
      String(cipher.doFinal(sealed), Charsets.UTF_8)
    } catch (error: Exception) {
      // An entry that can never be opened again (lost key, tampering) is dropped so the page
      // asks the user to sign in once instead of failing on every read. Transient Keystore
      // errors keep the entry for the next read.
      if (
        error is AEADBadTagException ||
        error is KeyPermanentlyInvalidatedException ||
        error is IllegalArgumentException
      ) {
        prefs.edit().remove(name).commit()
      }
      Log.w(TAG, "Secure entry unreadable: ${error.javaClass.simpleName}")
      null
    }
  }

  @Synchronized
  fun set(name: String, value: String): Boolean {
    if (!validName(name) || value.length > MAX_VALUE_LENGTH) return false
    return try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.ENCRYPT_MODE, key())
      cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
      val sealed = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
      val entry =
        Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
          Base64.encodeToString(sealed, Base64.NO_WRAP)
      prefs.edit().putString(name, entry).commit()
    } catch (error: Exception) {
      Log.w(TAG, "Secure entry not saved: ${error.javaClass.simpleName}")
      false
    }
  }

  @Synchronized
  fun remove(name: String): Boolean = validName(name) && prefs.edit().remove(name).commit()

  private fun validName(name: String) = NAME_PATTERN.matches(name)

  private fun key(): SecretKey {
    cachedKey?.let { return it }
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    val key = (keyStore.getKey(KEY_ALIAS, null) as? SecretKey) ?: KeyGenerator
      .getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
      .apply {
        init(
          KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
          )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build(),
        )
      }
      .generateKey()
    cachedKey = key
    return key
  }

  private companion object {
    const val TAG = "0xNuller"
    const val KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "0xnuller.secure-store.v1"
    const val PREFS_NAME = "0xnuller.secure-store"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val GCM_TAG_BITS = 128
    const val MAX_VALUE_LENGTH = 64 * 1024
    val NAME_PATTERN = Regex("[A-Za-z0-9._:-]{1,128}")
  }
}
