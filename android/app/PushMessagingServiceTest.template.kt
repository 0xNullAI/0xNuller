package ai.nullai.dgagent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test

class PushMessagingServiceTest {
  @Test fun notificationIdentityIsStableAndScopedToAccountAndConversation() {
    val key = PushSupport.notificationEventKey("account-a", "dm", "friend-a", "event-1")
    assertEquals(key, PushSupport.notificationEventKey("account-a", "dm", "friend-a", "event-1"))
    assertNotEquals(key, PushSupport.notificationEventKey("account-b", "dm", "friend-a", "event-1"))
    assertNotEquals(key, PushSupport.notificationEventKey("account-a", "group", "friend-a", "event-1"))
    assertNotEquals(key, PushSupport.notificationEventKey("account-a", "dm", "friend-b", "event-1"))
    assertNotEquals(key, PushSupport.notificationEventKey("account-a", "dm", "friend-a", "event-2"))
    assertFalse(key.contains("friend-a"))
  }

  @Test fun lengthPrefixSeparatesAmbiguousIdentifiers() {
    assertNotEquals(
      PushSupport.notificationEventKey("a:b", "dm", "c", "event"),
      PushSupport.notificationEventKey("a", "dm", "b:c", "event"),
    )
  }
}
