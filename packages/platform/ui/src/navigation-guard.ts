export type NavigationGuard = (destination: URL, source: URL) => string | null;
const guards = new Set<NavigationGuard>();
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}
/** Navigation only. Never call this from stop, logout or permission-revocation paths. */
export function allowGuardedNavigation(
  destination: string | URL,
  source: string | URL = window.location.href,
): boolean {
  const target = new URL(destination, window.location.href);
  const messages = [
    ...new Set(
      [...guards]
        .map((guard) => guard(target, new URL(source, window.location.href)))
        .filter((message): message is string => Boolean(message)),
    ),
  ];
  return messages.length === 0 || window.confirm(messages.join('\n\n'));
}

const INDEX = '__0xnullaiNavigationIndex';
function indexOf(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[INDEX];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
function stamp(state: unknown, index: number): Record<string, unknown> {
  return { ...(state && typeof state === 'object' ? state : {}), [INDEX]: index };
}
/**
 * Mark same-document entries, including feature-owned query navigation. Capture traversal before
 * feature popstate subscribers; denied traversal returns to the original entry without destroying
 * forward history. Installation belongs to the single Web shell, never individual features.
 */
export function installHistoryNavigationGuard(target: Window = window): () => void {
  const history = target.history;
  const push = history.pushState;
  const replace = history.replaceState;
  let currentIndex = indexOf(history.state) ?? 0;
  let acceptedUrl = target.location.href;
  let acceptedState: unknown = history.state;
  let restoring: number | null = null;
  replace.call(history, stamp(history.state, currentIndex), '', acceptedUrl);
  const wrappedPush: History['pushState'] = function (state, unused, url) {
    const next = currentIndex + 1;
    push.call(history, stamp(state, next), unused, url);
    currentIndex = next;
    acceptedUrl = target.location.href;
    acceptedState = history.state;
  };
  const wrappedReplace: History['replaceState'] = function (state, unused, url) {
    replace.call(history, stamp(state, currentIndex), unused, url);
    acceptedUrl = target.location.href;
    acceptedState = history.state;
  };
  history.pushState = wrappedPush;
  history.replaceState = wrappedReplace;
  const onPop = (event: PopStateEvent) => {
    const destinationIndex = indexOf(event.state);
    if (restoring !== null && destinationIndex === restoring) {
      restoring = null;
      event.stopImmediatePropagation();
      return;
    }
    if (!allowGuardedNavigation(target.location.href, acceptedUrl)) {
      event.stopImmediatePropagation();
      if (destinationIndex !== null && destinationIndex !== currentIndex) {
        restoring = currentIndex;
        history.go(currentIndex - destinationIndex);
      } else {
        // Entries predating this shell lack direction information: preserve current visible route.
        replace.call(history, stamp(acceptedState, currentIndex), '', acceptedUrl);
      }
      return;
    }
    currentIndex = destinationIndex ?? currentIndex + 1;
    if (destinationIndex === null)
      replace.call(history, stamp(event.state, currentIndex), '', target.location.href);
    acceptedUrl = target.location.href;
    acceptedState = history.state;
  };
  target.addEventListener('popstate', onPop, true);
  return () => {
    target.removeEventListener('popstate', onPop, true);
    if (history.pushState === wrappedPush) history.pushState = push;
    if (history.replaceState === wrappedReplace) history.replaceState = replace;
  };
}
