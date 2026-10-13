package ai.nullai.dgagent

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
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
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.security.KeyStore
import java.util.Collections
import java.util.Locale
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
  @Volatile private var notificationPermissionPending = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The app opens dark; the page updates this through setSystemBarTheme.
    applySystemBarTheme(dark = true)
    // The channel exists before the page asks for permission, so a user who switched it off in
    // the system settings reads as "blocked" instead of "granted".
    DeviceOutputService.ensureChannel(this)
    BackgroundKeep.pageEvents = { script -> pageWebView?.evaluateJavascript(script, null) }
  }

  /** Edge-to-edge shows the window background behind the system bars. */
  private fun applySystemBarTheme(dark: Boolean) {
    window.decorView.setBackgroundColor(if (dark) DARK_SYSTEM_BAR else LIGHT_SYSTEM_BAR)
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !dark
      isAppearanceLightNavigationBars = !dark
    }
  }

  /** Stops the active BLE scan and releases its lease; output stops have their own entry. */
  private external fun requestNativeLifecycleSafety(): Boolean

  override fun onResume() {
    super.onResume()
    BackgroundKeep.activityForeground = true
    // Back on screen: no background deadline any more. The page lifts its own hold on
    // visibilitychange; the service (if output is still active) shows 「设备输出中」 again.
    BackgroundKeep.keptUntil = 0L
    DeviceOutputService.current?.enterForeground()
    syncOutputService()
  }

  override fun onPause() {
    BackgroundKeep.activityForeground = false
    // The one keep decision. It is recorded before the page hears about the pause, so the
    // page's own hide handling (which reads it through getBackgroundKeepUntil) cannot disagree.
    val now = System.currentTimeMillis()
    val until = if (BackgroundKeep.mayKeep(notificationsAllowed())) now + BackgroundKeep.keepMs else 0L
    val service = DeviceOutputService.current
    if (until > 0L && service != null && service.enterBackground(until)) {
      BackgroundKeep.keptUntil = until
    } else {
      BackgroundKeep.keptUntil = 0L
      // Today's behaviour: stop every device natively now, before the WebView is paused; the
      // page's own stop below is carried out natively even after the page stops running.
      if (!NativeOutputSafety.stop()) Log.d(TAG, "Native output stop is unavailable")
      DeviceOutputService.stopOrderly(this)
    }
    val kept = BackgroundKeep.keptUntil > 0L
    pageWebView?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('0xnullai:native-pause'," +
        "{detail:{kept:$kept,until:${BackgroundKeep.keptUntil},at:$now}}))",
      null,
    )
    // Active scanning must stop before Android suspends the WebView, kept or not. Scanner
    // ownership is released only after native cleanup.
    if (!requestNativeLifecycleSafety()) {
      Log.d(TAG, "Native lifecycle safety is unavailable")
    }
    super.onPause()
  }

  /** Start the keep service only from the foreground; stop it when it is no longer wanted. */
  private fun syncOutputService() {
    val wanted = BackgroundKeep.wantsService() && notificationsAllowed()
    if (wanted) {
      if (BackgroundKeep.activityForeground && DeviceOutputService.current == null) {
        DeviceOutputService.start(this)
      }
      return
    }
    if (DeviceOutputService.current == null) return
    if (BackgroundKeep.keptUntil > 0L) {
      // Disarmed while kept in the background (the page stopped, or keep no longer applies):
      // nothing may keep running, so stop natively as onPause would have.
      BackgroundKeep.keptUntil = 0L
      NativeOutputSafety.stop()
    }
    DeviceOutputService.stopOrderly(this)
  }

  /** Notifications for this app and the 设备输出 channel are on (POST_NOTIFICATIONS on 13+). */
  private fun notificationsAllowed(): Boolean {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }
    if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return false
    val channel = getSystemService(NotificationManager::class.java)
      ?.getNotificationChannel(DeviceOutputService.CHANNEL_ID)
    return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
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
    if (requestCode == NOTIFICATION_PERMISSION_REQUEST_CODE) {
      notificationPermissionPending = false
      syncOutputService()
    }
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
    // The page is going away: nothing may keep running without it, kept or not.
    BackgroundKeep.keptUntil = 0L
    BackgroundKeep.outputActive = false
    NativeOutputSafety.stop()
    DeviceOutputService.stopOrderly(this)
    requestNativeLifecycleSafety()
    BackgroundKeep.pageEvents = null
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

    /** Version of the background keep bridge below; absent on APKs without it. */
    @JavascriptInterface
    fun getBackgroundKeepCapability(): Int = BackgroundKeep.CAPABILITY

    /** granted, requesting, prompt, denied or blocked, like getMediaPermissionStatus. */
    @JavascriptInterface
    fun getNotificationPermissionStatus(): String {
      if (notificationsAllowed()) return "granted"
      if (notificationPermissionPending) return "requesting"
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        // No runtime permission before Android 13: notifications were switched off in settings.
        return "blocked"
      }
      val permission = Manifest.permission.POST_NOTIFICATIONS
      if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
        // Granted, but the app's notifications or the 设备输出 channel are switched off.
        return "blocked"
      }
      if (shouldShowRequestPermissionRationale(permission)) {
        markPermissionAsked(permission)
        return "denied"
      }
      return if (permissionHistory.getBoolean(permission, false)) "blocked" else "prompt"
    }

    /** Only for the local 「设备输出中」 notification; there is no push. */
    @JavascriptInterface
    fun requestNotificationPermission() {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
      val permission = Manifest.permission.POST_NOTIFICATIONS
      if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) return
      notificationPermissionPending = true
      markPermissionAsked(permission)
      runOnUiThread {
        requestPermissions(arrayOf(permission), NOTIFICATION_PERMISSION_REQUEST_CODE)
      }
    }

    /**
     * The page's keep state: the user's keep duration (0 when off or not allowed) and whether
     * any device output is active. Returns whether the keep service is wanted for it; the
     * service itself starts on the UI thread, only while the app is in the foreground.
     */
    @JavascriptInterface
    fun setBackgroundKeep(enabled: Boolean, keepMs: Long, outputActive: Boolean): Boolean {
      BackgroundKeep.update(enabled, keepMs, outputActive)
      runOnUiThread { syncOutputService() }
      return BackgroundKeep.wantsService() && notificationsAllowed()
    }

    /** End of the current native keep (wall clock), set at onPause; 0 when nothing is kept. */
    @JavascriptInterface
    fun getBackgroundKeepUntil(): Long = BackgroundKeep.keptUntil

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
    const val NOTIFICATION_PERMISSION_REQUEST_CODE = 4103
    const val PERMISSION_HISTORY_PREFS = "0xnuller.permission-history"
    /** About 24 MB of file data; larger exports would stall the JS bridge. */
    const val MAX_DOWNLOAD_BASE64 = 32 * 1024 * 1024
  }
}

/**
 * The Rust layer's native output stop: plugin-blec writes every connected device's registered
 * stop packet ahead of any queued write, without the WebView. Safe to call from any thread; it
 * only schedules the writes.
 */
object NativeOutputSafety {
  @JvmStatic private external fun requestNativeOutputStop(): Boolean

  fun stop(): Boolean = try {
    requestNativeOutputStop()
  } catch (error: UnsatisfiedLinkError) {
    // The Rust library is loaded with the activity; without it there is nothing to stop.
    false
  }
}

/**
 * Process-wide keep state shared by MainActivity and DeviceOutputService.
 *
 * The page reports what it wants (`update`); MainActivity alone decides at onPause whether
 * output is kept (`keptUntil`), and the page reads that one decision. Fails closed: any missing
 * piece means no keep.
 */
internal object BackgroundKeep {
  const val CAPABILITY = 1
  /** Android offers 5 or 10 minutes; anything outside this range never arms. */
  const val MIN_KEEP_MS = 60_000L
  const val MAX_KEEP_MS = 10 * 60_000L

  @Volatile var armed = false
    private set
  @Volatile var keepMs = 0L
    private set
  @Volatile var outputActive = false
  /** Wall-clock end of the current background keep; 0 unless onPause decided to keep. */
  @Volatile var keptUntil = 0L
  /** Between MainActivity.onResume and onPause: the only time the service may be started. */
  @Volatile var activityForeground = false
  /** Runs a script in the page; set by MainActivity while its WebView exists. Main thread. */
  var pageEvents: ((String) -> Unit)? = null

  fun update(enabled: Boolean, keepMs: Long, outputActive: Boolean) {
    val valid = enabled && keepMs in MIN_KEEP_MS..MAX_KEEP_MS
    this.keepMs = if (valid) keepMs else 0L
    this.armed = valid
    this.outputActive = outputActive
  }

  fun wantsService(): Boolean = armed && outputActive

  /** Whether onPause may keep: armed, output active, notifications on, service running. */
  fun mayKeep(notificationsAllowed: Boolean): Boolean =
    wantsService() && notificationsAllowed && DeviceOutputService.current?.running == true

  /** Main thread. Tells the page the native layer stopped output, and why. */
  fun dispatchOutputStopped(reason: String) {
    val at = System.currentTimeMillis()
    pageEvents?.invoke(
      "window.dispatchEvent(new CustomEvent('0xnullai:native-output-stopped'," +
        "{detail:{reason:'$reason',at:$at}}))",
    )
  }
}

/**
 * `connectedDevice` foreground service that lets DG-Lab output keep running for the keep
 * duration the user chose, and nothing longer.
 *
 * It runs only while keep is armed and output is active, and is started from the foreground.
 * Its low-importance 「设备输出」 notification reads 「设备输出中」 on screen and
 * 「后台保持中 · 剩余 mm:ss」 in the background, with a 急停 action. The deadline is its own:
 * a main-thread tick against elapsed real time, under a partial wake lock that lasts only as
 * long as the keep, so neither the deadline nor plugin-blec's write watchdog sleeps through it.
 * 急停, the deadline, removing the task and any unplanned destroy stop output natively without
 * the WebView, then tell the page.
 */
class DeviceOutputService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private var deadlineElapsed = 0L
  /** Set once startForeground succeeded. */
  var running = false
    private set
  /** Output was already stopped (or must not be stopped) when this service ends. */
  private var settled = false

  private val tick = object : Runnable {
    override fun run() {
      val left = deadlineElapsed - SystemClock.elapsedRealtime()
      if (left <= 0L) {
        stopOutput("timeout")
        return
      }
      notifyStatus(backgroundText(left))
      handler.postDelayed(this, minOf(1_000L, left))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_EMERGENCY_STOP) {
      stopOutput("emergency")
      return START_NOT_STICKY
    }
    if (!running) {
      try {
        val notification = buildNotification(FOREGROUND_TEXT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          startForeground(
            NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
          )
        } else {
          startForeground(NOTIFICATION_ID, notification)
        }
        running = true
        current = this
      } catch (error: Exception) {
        // Background start refused, connectedDevice prerequisites missing, notification
        // blocked: no service means no keep, and onPause stops as before.
        Log.w(TAG, "Device output service not started: ${error.javaClass.simpleName}")
        settled = true
        stopSelf()
        return START_NOT_STICKY
      }
      // The start raced a pause or a disarm that found no service to stop yet. Only a running
      // background keep may continue without the activity in the foreground.
      if (
        !BackgroundKeep.wantsService() ||
        (!BackgroundKeep.activityForeground && BackgroundKeep.keptUntil == 0L)
      ) {
        settled = true
        retire()
        stopSelf()
      }
    }
    // A service restarted by the system has no page and no keep to honour.
    return START_NOT_STICKY
  }

  /**
   * Main thread, from onPause: count down to `untilWall` and stop natively at the end. False
   * when the deadline cannot be guaranteed (no wake lock); the caller then stops as before.
   */
  fun enterBackground(untilWall: Long): Boolean {
    val left = untilWall - System.currentTimeMillis()
    if (left <= 0L || !acquireWakeLock(left + WAKE_LOCK_MARGIN_MS)) return false
    deadlineElapsed = SystemClock.elapsedRealtime() + left
    handler.removeCallbacks(tick)
    tick.run()
    return true
  }

  /** Main thread, from onResume: the page is back and owns output again. */
  fun enterForeground() {
    handler.removeCallbacks(tick)
    deadlineElapsed = 0L
    releaseWakeLock()
    if (running) notifyStatus(FOREGROUND_TEXT)
  }

  /** Stop every device natively, tell the page, end the service. */
  private fun stopOutput(reason: String) {
    handler.removeCallbacks(tick)
    if (!NativeOutputSafety.stop()) Log.d(TAG, "Native output stop is unavailable")
    BackgroundKeep.keptUntil = 0L
    BackgroundKeep.outputActive = false
    settled = true
    retire()
    BackgroundKeep.dispatchOutputStopped(reason)
    stopSelf()
  }

  /**
   * No longer a service onPause may keep with. Done at once, not in onDestroy, which Android
   * runs later: a pause in between must not find a dying service and skip its stop.
   */
  private fun retire() {
    handler.removeCallbacks(tick)
    releaseWakeLock()
    running = false
    if (current === this) current = null
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    stopOutput("task-removed")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    if (!settled) {
      // Not a planned stop from the page: fail closed.
      NativeOutputSafety.stop()
      BackgroundKeep.keptUntil = 0L
      BackgroundKeep.outputActive = false
      BackgroundKeep.dispatchOutputStopped("service-destroyed")
    }
    retire()
    super.onDestroy()
  }

  /** Bounded by the keep itself, so a missed release can never hold the CPU longer. */
  private fun acquireWakeLock(timeoutMs: Long): Boolean {
    releaseWakeLock()
    val manager = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return try {
      wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
        setReferenceCounted(false)
        acquire(timeoutMs)
      }
      true
    } catch (error: Exception) {
      Log.w(TAG, "Device output wake lock unavailable: ${error.javaClass.simpleName}")
      false
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun notifyStatus(text: String) {
    try {
      NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, buildNotification(text))
    } catch (error: SecurityException) {
      // Permission revoked while running: the service keeps its foreground notification.
      Log.w(TAG, "Device output notification not updated")
    }
  }

  private fun buildNotification(text: String) =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setContentTitle(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(
        PendingIntent.getActivity(
          this,
          0,
          Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        ),
      )
      .addAction(
        0,
        "急停",
        PendingIntent.getService(
          this,
          1,
          Intent(this, DeviceOutputService::class.java).setAction(ACTION_EMERGENCY_STOP),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        ),
      )
      .build()

  companion object {
    const val CHANNEL_ID = "device-output"
    private const val TAG = "0xNuller"
    private const val NOTIFICATION_ID = 4201
    private const val ACTION_EMERGENCY_STOP = "ai.nullai.dgagent.action.EMERGENCY_STOP"
    private const val FOREGROUND_TEXT = "设备输出中"
    private const val WAKE_LOCK_TAG = "0xNuller:device-output-keep"
    private const val WAKE_LOCK_MARGIN_MS = 15_000L

    /** The running service, main thread only. */
    @Volatile var current: DeviceOutputService? = null
      private set

    fun ensureChannel(context: Context) {
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "设备输出", NotificationManager.IMPORTANCE_LOW).apply {
          description = "设备输出与后台保持的剩余时间"
          setShowBadge(false)
        },
      )
    }

    /** Foreground only: Android refuses a foreground service started from the background. */
    fun start(context: Context) {
      try {
        context.startForegroundService(Intent(context, DeviceOutputService::class.java))
      } catch (error: Exception) {
        Log.w(TAG, "Device output service not started: ${error.javaClass.simpleName}")
      }
    }

    /** A stop the page or activity planned; output was handled by the caller. */
    fun stopOrderly(context: Context) {
      val service = current ?: return
      service.settled = true
      service.retire()
      context.stopService(Intent(context, DeviceOutputService::class.java))
    }

    fun backgroundText(leftMs: Long): String {
      val seconds = (leftMs + 999L) / 1_000L
      return String.format(Locale.ROOT, "后台保持中 · 剩余 %02d:%02d", seconds / 60L, seconds % 60L)
    }
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
