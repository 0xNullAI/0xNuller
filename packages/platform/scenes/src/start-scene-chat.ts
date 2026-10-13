import {
  currentAuthUserId,
  ensureCharacterRelationship,
  listPrivateConversationSummaries,
  requestNewAgentInboxConversation,
  selectAgentInboxConversation,
} from '@0xnullai/auth';
import { loadScenes, savedPromptKind, updateScenes } from './index.js';

/**
 * Start a chat in a library scene with no character: the AI narrates the place and plays its
 * cast. Works for private scenes and ones imported from 发现 alike. A scene is a story one may
 * play again, so every start is a new play-through; earlier ones stay in the message list. The
 * scene is selected and a new conversation requested (Agent treats a new chat whose selection
 * is a scene as scene-only). A scene has no relationship or memory, so nothing here creates
 * one. Returns false when the scene is gone or the account changed.
 */
export async function openSceneChat(sceneId: string): Promise<boolean> {
  const account = currentAuthUserId();
  if (!account) return false;
  const scene = loadScenes().scenes.find((entry) => entry.id === sceneId);
  if (!scene || savedPromptKind(scene) !== 'scene') return false;
  if (updateScenes((library) => ({ ...library, selectedId: sceneId })).selectedId !== sceneId)
    return false;
  if (currentAuthUserId() !== account) return false;
  requestNewAgentInboxConversation();
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
