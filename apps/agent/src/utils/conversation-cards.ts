import { savedPromptKind, type SceneLibrary } from '@0xnullai/scenes';
import { BUILTIN_PROMPT_PRESETS } from '@dg-agent/runtime';
import type { SessionSnapshot } from '@dg-agent/core';

/** A character owns the relationship; a scene only changes the environment of that chat. */
export function resolveConversationCards(
  session: SessionSnapshot | null,
  activeSessionId: string | null,
  library: SceneLibrary,
): { characterId: string; sceneId: string; boundPresetId: string } {
  const active = session?.id === activeSessionId ? session : null;
  const boundPresetId =
    typeof active?.metadata?.promptPresetId === 'string' ? active.metadata.promptPresetId : '';
  const boundPreset = library.scenes.find((item) => item.id === boundPresetId);
  const selectedPreset = library.scenes.find((item) => item.id === library.selectedId);
  const characterId = boundPresetId
    ? boundPreset && savedPromptKind(boundPreset) === 'scene'
      ? '' // Older sessions stored a scene in the identity field.
      : boundPresetId
    : (selectedPreset && savedPromptKind(selectedPreset) === 'character') ||
        BUILTIN_PROMPT_PRESETS.some((preset) => preset.id === library.selectedId)
      ? library.selectedId
      : '';
  const sceneId =
    typeof active?.metadata?.sceneId === 'string'
      ? active.metadata.sceneId
      : boundPreset && savedPromptKind(boundPreset) === 'scene'
        ? boundPresetId
        : active?.messages.length === 0 &&
            selectedPreset &&
            savedPromptKind(selectedPreset) === 'scene'
          ? selectedPreset.id
          : '';
  return { characterId, sceneId, boundPresetId };
}

/** Preserve readable legacy scene chats, but do not start a new scene-only conversation. */
export function sceneNeedsCharacter(
  session: SessionSnapshot | null,
  activeSessionId: string | null,
  characterId: string,
  sceneId: string,
): boolean {
  return Boolean(
    sceneId &&
    !characterId &&
    (!session || session.id !== activeSessionId || session.messages.length === 0),
  );
}
