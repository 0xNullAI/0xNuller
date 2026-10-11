import { expect, it } from 'vitest';
import { DEFAULT_MANAGED_VOICE, managedVoiceFor, normalizeManagedVoice } from './managed-voices';

it('uses a character voice only when the managed service offers it', () => {
  expect(managedVoiceFor('eve')).toBe('eve');
  expect(managedVoiceFor(' ara ')).toBe('ara');
  expect(managedVoiceFor('')).toBeNull();
  expect(managedVoiceFor('alloy')).toBeNull();
});

it('falls back to the default voice for unknown stored values', () => {
  expect(normalizeManagedVoice('rex')).toBe('rex');
  expect(normalizeManagedVoice('tongtong')).toBe(DEFAULT_MANAGED_VOICE);
  expect(normalizeManagedVoice(undefined)).toBe(DEFAULT_MANAGED_VOICE);
});
