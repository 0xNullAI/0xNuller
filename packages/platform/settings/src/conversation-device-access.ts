/** Per-account, per-conversation local device consent. Missing or unreadable records deny. */
export type DeviceConversationKind = 'ai' | 'dm' | 'group' | 'group-ai';
const PREFIX = '0xnullai.device-conversation-access.v1:';
const listeners = new Set<() => void>();
function key(
  accountId: string,
  kind: DeviceConversationKind,
  conversationId: string,
): string | null {
  if (
    !/^[A-Za-z0-9._:-]{1,160}$/.test(accountId) ||
    !['ai', 'dm', 'group', 'group-ai'].includes(kind) ||
    !conversationId ||
    conversationId.length > 256
  )
    return null;
  return `${PREFIX}${encodeURIComponent(accountId)}:${kind}:${encodeURIComponent(conversationId)}`;
}
export function deviceConversationAccess(
  accountId: string | null,
  kind: DeviceConversationKind,
  conversationId: string,
): boolean {
  if (!accountId) return false;
  const id = key(accountId, kind, conversationId);
  if (!id) return false;
  try {
    return localStorage.getItem(id) === 'allow';
  } catch {
    return false;
  }
}
/** A failed persist never grants access even for the current page. */
export function setDeviceConversationAccess(
  accountId: string | null,
  kind: DeviceConversationKind,
  conversationId: string,
  enabled: boolean,
): boolean {
  if (!accountId) return false;
  const id = key(accountId, kind, conversationId);
  if (!id) return false;
  try {
    if (enabled) localStorage.setItem(id, 'allow');
    else localStorage.removeItem(id);
    const effective = deviceConversationAccess(accountId, kind, conversationId);
    if (effective !== enabled) return false;
    for (const listener of listeners) listener();
    return true;
  } catch {
    return false;
  }
}
export function subscribeDeviceConversationAccess(listener: () => void): () => void {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key?.startsWith(PREFIX)) listener();
  };
  try {
    window.addEventListener('storage', storage);
  } catch {
    /* Node readers do not expose window. */
  }
  return () => {
    listeners.delete(listener);
    try {
      window.removeEventListener('storage', storage);
    } catch {
      /* no window */
    }
  };
}

/**
 * Whether one group AI may control this account's device in one group. It is separate from
 * the group's own consent for people: allowing members never allows their AIs, and allowing
 * one AI never allows another.
 */
export function groupAiDeviceAccess(
  accountId: string | null,
  groupId: string,
  agentId: string,
): boolean {
  return deviceConversationAccess(accountId, 'group-ai', `${groupId}/${agentId}`);
}

export function setGroupAiDeviceAccess(
  accountId: string | null,
  groupId: string,
  agentId: string,
  enabled: boolean,
): boolean {
  return setDeviceConversationAccess(accountId, 'group-ai', `${groupId}/${agentId}`, enabled);
}
