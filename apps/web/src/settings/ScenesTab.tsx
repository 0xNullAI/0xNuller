import { savedPromptKind, type SavedScene } from '@0xnullai/scenes';
import { SceneLibrary } from '@0xnullai/scenes/library';
import { openSceneChat } from '@0xnullai/scenes/start-chat';
import { openCharacterChat } from '../open-character-chat';

/** The shared account library; legacy built-in prompts are not offered here. */
export function ScenesTab({ onOpenAgent }: { onOpenAgent?: () => void }) {
  // Characters reopen their own chat; scenes open a chat in the place with no character.
  const startChat = (preset: SavedScene) => {
    const open =
      savedPromptKind(preset) === 'character'
        ? openCharacterChat(preset.id)
        : openSceneChat(preset.id);
    void open.then((opened) => {
      if (opened) onOpenAgent?.();
    });
  };
  return <SceneLibrary onStartChat={onOpenAgent ? startChat : undefined} />;
}
