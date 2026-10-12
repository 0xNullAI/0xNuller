import {
  currentAuthUserId,
  ensureCharacterRelationship,
  listPrivateConversationSummaries,
  requestNewAgentInboxConversation,
  selectAgentInboxConversation,
} from '@0xnullai/auth';
import { loadScenes, savedPromptKind, updateScenes } from './index.js';

/**
 * Open a chat in a library scene with no character: the AI narrates the place and plays its
 * cast. Works for private scenes and ones imported from 发现 alike. The scene is selected, then
 * its latest scene-only conversation reopens, otherwise a new one starts (Agent treats a new
 * chat whose selection is a scene as scene-only). A scene has no relationship or memory, so
 * nothing here creates one. Returns false when the scene is gone or the account changed.
 */
export async function openSceneChat(sceneId: string): Promise<boolean> {
  const account = currentAuthUserId();
  if (!account) return false;
  const scene = loadScenes().scenes.find((entry) => entry.id === sceneId);
  if (!scene || savedPromptKind(scene) !== 'scene') return false;
  if (updateScenes((library) => ({ ...library, selectedId: sceneId })).selectedId !== sceneId)
    return false;
  // Like a character, a scene reopens its latest scene-only chat instead of piling up new ones.
  const existing = await listPrivateConversationSummaries({ limit: 50 })
    .then((page) =>
      page.items.find(
        (entry) =>
          entry.metadata.sceneId === sceneId &&
          (!entry.metadata.promptPresetId || entry.metadata.promptPresetId === sceneId),
      ),
    )
    .catch(() => undefined);
  if (currentAuthUserId() !== account) return false;
  if (existing) selectAgentInboxConversation(existing.id);
  else requestNewAgentInboxConversation();
  return true;
}

/**
 * Open the chat with a library character, like opening a contact: its latest
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
