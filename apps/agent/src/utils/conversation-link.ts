const CONVERSATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A URL identifies an existing server conversation; it never creates one. */
export function linkedAgentConversationId(pathname: string, search: string): string | null {
  if (pathname !== '/agent') return null;
  const ids = new URLSearchParams(search).getAll('conversation');
  const id = ids[0];
  return ids.length === 1 && id && CONVERSATION_ID.test(id) ? id : null;
}

/** Keep the visible link aligned when selecting an Agent session in its page. */
export function replaceAgentConversationLink(sessionId: string): void {
  if (window.location.pathname !== '/agent' || !CONVERSATION_ID.test(sessionId)) return;
  const url = new URL(window.location.href);
  if (url.searchParams.get('conversation') === sessionId) return;
  url.searchParams.set('conversation', sessionId);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/** An account change must not leave the previous account's conversation in the URL. */
export function clearAgentConversationLink(): void {
  if (window.location.pathname !== '/agent') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('conversation')) return;
  url.searchParams.delete('conversation');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
