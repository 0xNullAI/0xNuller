import { initialChatTarget, type InitialChatTarget } from './initial-chat-target';

/** Route changes select a conversation or open its create dialog; Chat owns admission. */
export function subscribeChatRouteChanges(options: {
  accountId: () => string | null;
  isCurrent: (target: InitialChatTarget) => boolean;
  select: (target: InitialChatTarget) => void;
  openCreate?: () => void;
}): () => void {
  const onRouteChange = () => {
    if (!options.accountId() || window.location.pathname !== '/chat') return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('create') === '1' && options.openCreate) {
      url.searchParams.delete('create');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      options.openCreate();
      return;
    }
    const target = initialChatTarget(window.location.search);
    if (target && !options.isCurrent(target)) options.select(target);
  };
  window.addEventListener('popstate', onRouteChange);
  return () => window.removeEventListener('popstate', onRouteChange);
}
