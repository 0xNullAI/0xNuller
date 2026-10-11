import { currentAuthUserId, subscribeAuthChanges } from './index';

export interface PrivateConversationSelection {
  accountId: string;
  conversationId: string;
  characterId: string;
  relationshipId?: string;
}
let selected: PrivateConversationSelection | null = null;
const listeners = new Set<() => void>();
let watching = false;
function watchAccount(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  subscribeAuthChanges(() => {
    if (selected && selected.accountId !== currentAuthUserId()) {
      selected = null;
      for (const listener of listeners) listener();
    }
  });
}
/** Page-memory navigation context only. All message and relationship content is loaded from the server. */
export function readPrivateConversationSelection(): PrivateConversationSelection | null {
  watchAccount();
  return selected?.accountId === currentAuthUserId() ? { ...selected } : null;
}
export function selectPrivateConversation(selection: PrivateConversationSelection): void {
  watchAccount();
  if (!selection.accountId || selection.accountId !== currentAuthUserId())
    throw new Error('请先登录当前账户');
  if (JSON.stringify(selected) === JSON.stringify(selection)) return;
  selected = { ...selection };
  for (const listener of listeners) listener();
}
export function subscribePrivateConversationSelection(listener: () => void): () => void {
  watchAccount();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
