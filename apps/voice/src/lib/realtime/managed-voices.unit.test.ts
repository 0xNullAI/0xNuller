import { expect, it } from 'vitest';
import {
  DEFAULT_MANAGED_VOICE,
  MANAGED_VOICES,
  managedVoiceFor,
  normalizeManagedVoice,
} from './managed-voices';

it('uses a character voice only when the managed service offers it', () => {
  expect(managedVoiceFor('zh_male_m191_uranus_bigtts')).toBe('zh_male_m191_uranus_bigtts');
  expect(managedVoiceFor(' zh_female_xiaohe_uranus_bigtts ')).toBe(
    'zh_female_xiaohe_uranus_bigtts',
  );
  expect(managedVoiceFor('')).toBeNull();
  expect(managedVoiceFor('alloy')).toBeNull();
});

it('maps voices saved for the previous realtime provider instead of dropping them', () => {
  expect(managedVoiceFor('ara')).toBe('zh_female_xiaohe_uranus_bigtts');
  expect(normalizeManagedVoice('rex')).toBe('zh_male_taocheng_uranus_bigtts');
  expect(MANAGED_VOICES.map((voice) => voice.id)).toContain(normalizeManagedVoice('eve'));
});

it('falls back to the default voice for unknown stored values', () => {
  expect(normalizeManagedVoice('tongtong')).toBe(DEFAULT_MANAGED_VOICE);
  expect(normalizeManagedVoice(undefined)).toBe(DEFAULT_MANAGED_VOICE);
});
