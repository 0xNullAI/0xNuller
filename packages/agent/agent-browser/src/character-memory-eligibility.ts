import { savedPromptKind, type SavedScene } from '@0xnullai/scenes';
import { getBuiltinPromptPresetById } from '@dg-agent/runtime';

/** Only character entities and established built-ins have private relationship memory. */
export function supportsCharacterMemory(
  presetId: string,
  savedPresets: readonly SavedScene[],
): boolean {
  const saved = savedPresets.find((preset) => preset.id === presetId);
  if (saved) return savedPromptKind(saved) === 'character';
  return Boolean(getBuiltinPromptPresetById(presetId));
}
