package ai.nullai.dgagent

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONArray

/** Data-only FCM notifications never carry chat text or device commands. */
class PushMessagingService : FirebaseMessagingService() {
  override fun onRegistered(installationId: String) {
    PushSupport.onRegistered(this, installationId)
  }

  override fun onUnregistered(installationId: String) {
    PushSupport.onUnregistered(this, installationId)
  }

  override fun onMessageReceived(message: RemoteMessage) {
    PushSupport.showMessage(this, message.data)
  }

  override fun onDeletedMessages() {
    // The web shell refreshes its server inbox when it is next opened. No
    // network or device operation is allowed from this background callback.
    Log.w("0xNullerPush", "FCM dropped pending messages; inbox refresh required")
  }
}

object PushSupport {
  private const val PREFS = "android_push"
  private const val ACCOUNT = "account_id"
  private const val INSTALLATION = "installation_id"
  private const val INSTALLATION_KEY = "installation_key"
  private const val PREVIOUS_INSTALLATION = "previous_installation_id"
  private const val RECENT_EVENTS = "recent_event_ids"
  private const val RECENT_EVENTS_LIMIT = 128
  private const val AI_CHANNEL = "ai_messages"
  private const val DM_CHANNEL = "direct_messages"
  private const val GROUP_CHANNEL = "group_messages"
  const val ROUTE_EXTRA = "ai.nullai.dgagent.PUSH_ROUTE"
  private const val ACCOUNT_EXTRA = "ai.nullai.dgagent.PUSH_ACCOUNT"
  @Volatile private var unregistering = false

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun configured(context: Context): Boolean =
    FirebaseApp.getApps(context).isNotEmpty() &&
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) ==
        ConnectionResult.SUCCESS

  fun hasPermission(context: Context): Boolean =
    (Build.VERSION.SDK_INT < 33 ||
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED) &&
      (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
        .areNotificationsEnabled()

  fun ensureChannels(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    listOf(
      NotificationChannel(AI_CHANNEL, "AI 消息", NotificationManager.IMPORTANCE_DEFAULT),
      NotificationChannel(DM_CHANNEL, "私聊消息", NotificationManager.IMPORTANCE_DEFAULT),
      NotificationChannel(GROUP_CHANNEL, "群聊消息", NotificationManager.IMPORTANCE_DEFAULT),
    ).forEach(manager::createNotificationChannel)
  }

  fun setAccount(context: Context, accountId: String) {
    val current = prefs(context).getString(ACCOUNT, null).orEmpty()
    val edit = prefs(context).edit().putString(ACCOUNT, accountId)
    if (current != accountId) {
      cancelRecentNotifications(context)
      edit.remove(RECENT_EVENTS)
    }
    edit.apply()
  }

  fun installationId(context: Context): String =
    prefs(context).getString(INSTALLATION, null).orEmpty()

  /** Stable only for this app installation; never derived from an account or FID. */
  fun installationKey(context: Context): String {
    val saved = prefs(context).getString(INSTALLATION_KEY, null).orEmpty()
    if (saved.matches(Regex("[A-Za-z0-9_-]{16,128}"))) return saved
    val generated = UUID.randomUUID().toString().replace("-", "")
    return if (prefs(context).edit().putString(INSTALLATION_KEY, generated).commit()) generated else ""
  }

  fun previousInstallationId(context: Context): String =
    prefs(context).getString(PREVIOUS_INSTALLATION, null).orEmpty()

  fun register(context: Context) {
    if (!configured(context) || !hasPermission(context)) return
    if (prefs(context).getString(ACCOUNT, null).isNullOrEmpty()) return
    if (unregistering) return
    ensureChannels(context)
    FirebaseMessaging.getInstance().register().addOnFailureListener {
      Log.w("0xNullerPush", "FCM registration failed")
    }
  }

  fun unregister(context: Context) {
    // Local suppression is synchronous. A stale server registration cannot
    // display a notification after logout while FCM unregister is in flight.
    cancelRecentNotifications(context)
    // Keep the preceding FID until a later authenticated server retry can
    // revoke it, even if a rotation and logout happened while offline.
    prefs(context).edit().remove(ACCOUNT).remove(INSTALLATION).remove(RECENT_EVENTS).apply()
    if (configured(context)) {
      synchronized(this) {
        if (unregistering) return
        unregistering = true
      }
      FirebaseMessaging.getInstance().unregister().addOnCompleteListener { result ->
        unregistering = false
        if (!result.isSuccessful) {
          Log.w("0xNullerPush", "FCM unregister failed; local display remains disabled")
        }
        // Account B may have signed in while account A's unregister was in
        // flight. Register B only after that operation has settled.
        if (!prefs(context).getString(ACCOUNT, null).isNullOrEmpty()) register(context)
      }
    }
  }

  fun onRegistered(context: Context, installationId: String) {
    if (unregistering) return
    if (!installationId.matches(Regex("[A-Za-z0-9_-]{16,256}"))) return
    if (prefs(context).getString(ACCOUNT, null).isNullOrEmpty()) return
    if (installationId == installationId(context)) return
    val oldId = installationId(context)
    val edit = prefs(context).edit().putString(INSTALLATION, installationId)
    if (oldId.isNotEmpty() && previousInstallationId(context).isEmpty())
      edit.putString(PREVIOUS_INSTALLATION, oldId)
    edit.apply()
  }

  fun onUnregistered(context: Context, installationId: String) {
    if (prefs(context).getString(ACCOUNT, null).isNullOrEmpty() &&
      installationId == installationId(context)) {
      prefs(context).edit().remove(INSTALLATION).apply()
    }
  }

  fun route(kind: String?, targetId: String?): String? {
    val pattern = if (kind == "group") Regex("[A-Za-z0-9_-]{1,128}")
      else Regex("[A-Za-z0-9._:-]{1,128}")
    if (targetId.isNullOrEmpty() || !targetId.matches(pattern)) return null
    val id = Uri.encode(targetId)
    return when (kind) {
      "ai" -> "/agent?conversation=$id"
      "dm" -> "/chat?dm=$id"
      "group" -> "/chat?room=$id"
      else -> null
    }
  }

  fun safeRoute(value: String?): String? {
    if (value.isNullOrEmpty() || value.length > 420 || !value.startsWith("/") ||
      value.startsWith("//")) return null
    val uri = Uri.parse(value)
    if (uri.fragment != null || uri.queryParameterNames.size != 1) return null
    return when (uri.path) {
      "/agent" -> route("ai", uri.getQueryParameter("conversation"))
      "/chat" ->
        route("dm", uri.getQueryParameter("dm")) ?: route("group", uri.getQueryParameter("room"))
      else -> null
    }
  }

  fun routeFromIntent(context: Context, intent: Intent?): String? {
    val account = prefs(context).getString(ACCOUNT, null)
    if (account.isNullOrEmpty() || intent?.getStringExtra(ACCOUNT_EXTRA) != account) return null
    return safeRoute(intent.getStringExtra(ROUTE_EXTRA))
  }

  fun showMessage(context: Context, data: Map<String, String>) {
    if (!configured(context) || !hasPermission(context)) return
    val account = prefs(context).getString(ACCOUNT, null)
    if (account.isNullOrEmpty() || data["accountId"] != account) return
    val kind = data["kind"] ?: return
    val route = route(kind, data["targetId"]) ?: return
    val eventId = data["eventId"] ?: return
    if (!eventId.matches(Regex("[A-Za-z0-9._:-]{1,128}"))) return
    val eventKey = notificationEventKey(account, kind, data["targetId"] ?: return, eventId)
    val channel = when (kind) {
      "ai" -> AI_CHANNEL
      "dm" -> DM_CHANNEL
      "group" -> GROUP_CHANNEL
      else -> return
    }
    val title = when (kind) {
      "ai" -> "AI 新消息"
      "dm" -> "私聊新消息"
      else -> "群聊新消息"
    }
    if (!recordNewEvent(context, eventKey)) return
    ensureChannels(context)
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
      this.data = Uri.parse("nuller-push://open/${Uri.encode(account)}/${Uri.encode(kind)}/${Uri.encode(data["targetId"])}")
      putExtra(ROUTE_EXTRA, route)
      putExtra(ACCOUNT_EXTRA, account)
    }
    val pending = PendingIntent.getActivity(
      context,
      "$account:$route".hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = Notification.Builder(context, channel)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setContentTitle(title)
      .setContentText("有新消息")
      .setContentIntent(pending)
      .setAutoCancel(true)
      .build()
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(eventKey, 0, notification)
  }

  /** Mirrors the server's (account, kind, target, event) delivery identity. */
  internal fun notificationEventKey(account: String, kind: String, targetId: String, eventId: String): String {
    // Store only a digest of the tuple: recent metadata must not disclose chat targets.
    val identity = listOf(account, kind, targetId, eventId).joinToString("") { "${it.length}:$it" }
    val bytes = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
    return "v2:" + bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun cancelRecentNotifications(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    try {
      val saved = JSONArray(prefs(context).getString(RECENT_EVENTS, "[]"))
      for (index in 0 until saved.length()) {
        saved.optString(index).takeIf { it.isNotEmpty() }?.let { key ->
          if (key.startsWith("v2:")) manager.cancel(key, 0)
          else manager.cancel(key.hashCode()) // notifications shown by earlier APKs
        }
      }
    } catch (_: Exception) {
      // Tap-time account validation still rejects an older notification.
    }
  }

  private fun recordNewEvent(context: Context, eventKey: String): Boolean = synchronized(this) {
    val recent = mutableListOf<String>()
    try {
      val saved = JSONArray(prefs(context).getString(RECENT_EVENTS, "[]"))
      for (index in 0 until saved.length()) {
        saved.optString(index).takeIf { it.isNotEmpty() }?.let(recent::add)
      }
    } catch (_: Exception) {
      // Corrupt local metadata never exposes a previous account's content.
    }
    if (eventKey in recent) return false
    recent.add(eventKey)
    val bounded = recent.takeLast(RECENT_EVENTS_LIMIT)
    // Synchronous commit keeps redelivery after process death from alerting
    // twice. This stores identifiers only, never message body or target.
    prefs(context).edit().putString(RECENT_EVENTS, JSONArray(bounded).toString()).commit()
  }
}
