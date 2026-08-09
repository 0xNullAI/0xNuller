/**
 * "Open a conversation with this account" — the entry point into direct messages.
 *
 * The place a conversation starts is somebody's profile, next to the follow button, and the
 * profile has nothing to do with Chat. So this is a plain function anything can import and
 * call with an account id: it navigates to the module that owns conversations and leaves the
 * request there for it to pick up.
 *
 * It lives in the account package rather than becoming a fifth shell interface beside
 * SidebarSection / ModuleActions / useSafetySession / useNativeBridge, because it is not a
 * shell capability. Its payload is an account id, everyone who needs it already depends on
 * this package for accounts, and @0xnullai/ui's interfaces are about where a module's UI
 * lands in the shell, not about who the user is.
 *
 * Nothing here is persisted. A request to open a conversation is meaningless a session later,
 * and writing it down would mean a stale one firing the next time the app starts.
 *
 * The request is **retained until taken**, which is why this is not a plain event: the module
 * that handles conversations is lazily mounted, so the first time somebody presses 私聊 there
 * is nobody listening yet and the request has to still be there when it finishes loading.
 */

/** Route owned by the module that handles conversations. */
const CONVERSATIONS_PATH = '/chat';

/** A request to open a conversation. The hint is only for rendering a name before the server answers. */
export interface DmRequest {
  accountId: string;
  username?: string;
  displayName?: string;
}

type Listener = (request: DmRequest) => void;

const listeners = new Set<Listener>();
let pending: DmRequest | null = null;

/**
 * Open (or create) a direct message with an account.
 *
 * One call is the whole entry point: it navigates and it delivers the request. Callers do not
 * need to know which module handles conversations, nor how one is addressed — the conversation
 * id is derived server-side from the two account ids and never computed by a client.
 *
 * `hint` is optional and cosmetic: the caller usually already has the name on screen, and
 * passing it avoids a blank header for the moment before the server answers.
 */
export function openDirectMessage(
  accountId: string,
  hint?: { username?: string; displayName?: string },
): void {
  if (!accountId) return;
  const request: DmRequest = {
    accountId,
    username: hint?.username,
    displayName: hint?.displayName,
  };

  // pushState does not notify anyone — popstate only fires for history moves the user makes —
  // so the event is dispatched explicitly. That is the shell's router contract; see
  // apps/web/src/Shell.tsx, which listens for exactly this.
  if (typeof window !== 'undefined' && window.location.pathname !== CONVERSATIONS_PATH) {
    window.history.pushState(null, '', CONVERSATIONS_PATH);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  // Delivered now if anyone is listening, held if not. Holding it *only* when there is no
  // listener is what keeps it from being acted on twice: a subscriber that comes and goes
  // (React re-running an effect) would otherwise replay a request that was already handled.
  if (listeners.size > 0) {
    pending = null;
    for (const listener of [...listeners]) listener(request);
  } else {
    pending = request;
  }
}

/**
 * Listen for requests, and pick up one that arrived before this listener existed.
 *
 * The held request is delivered on a microtask rather than during the call. Subscribing is
 * something a React effect does, and a listener invoked synchronously from inside it would
 * be setting state in the effect body — the cascading-render pattern React tells you not to
 * write. Arriving a microtask later makes it an ordinary external event.
 */
export function subscribeDmRequest(listener: Listener): () => void {
  listeners.add(listener);
  const held = pending;
  if (held) {
    pending = null;
    queueMicrotask(() => listener(held));
  }
  return () => listeners.delete(listener);
}
