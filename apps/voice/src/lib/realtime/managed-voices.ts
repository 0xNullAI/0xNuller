/**
 * Voices offered by 猫愿语音. The catalog is shared with managed read-aloud, because both
 * speak through the same provider; the Worker validates the id again before using it.
 * Ids saved for the previous providers map to catalog voices when read.
 */
export {
  DEFAULT_MANAGED_VOICE,
  MANAGED_VOICES,
  managedVoiceFor,
  managedVoiceLabel,
  normalizeManagedVoice,
} from '@0xnullai/ai-pricing';
