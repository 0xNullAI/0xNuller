import {
  currentAuthUserId,
  ensureCharacterRelationship,
  listPrivateConversationSummaries,
  requestNewAgentInboxConversation,
  selectAgentInboxConversation,
} from '@0xnullai/auth';
import { updateScenes } from '@0xnullai/scenes';

/**
 * Open the chat with an imported character, like opening a contact: its latest
 * conversation if there is one, otherwise a new one with that character. The
 * private relationship is ensured first so the chat starts bound to it.
 */
export async function openCharacterChat(characterId: string): Promise<boolean> {
  const account = currentAuthUserId();
  if (!account) return false;
  // A relationship the user deleted is not recreated here; the chat still opens.
  await ensureCharacterRelationship(characterId).catch(() => undefined);
  if (currentAuthUserId() !== account) return false;
  updateScenes((library) => ({ ...library, selectedId: characterId }));
  const existing = await listPrivateConversationSummaries({ limit: 50 })
    .then((page) => page.items.find((entry) => entry.metadata.promptPresetId === characterId))
    .catch(() => undefined);
  if (currentAuthUserId() !== account) return false;
  if (existing) selectAgentInboxConversation(existing.id);
  else requestNewAgentInboxConversation();
  return true;
}
