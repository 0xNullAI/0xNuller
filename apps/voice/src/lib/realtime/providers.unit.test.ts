import { expect, it } from 'vitest';
import { relationshipVoiceFor } from './providers';

it('uses a character voice only when the active provider offers it', () => {
  expect(relationshipVoiceFor('xai', 'ara')).toBe('ara');
  expect(relationshipVoiceFor('xai', '')).toBeNull();
  expect(relationshipVoiceFor('managed', 'eve')).toBe('eve');
  expect(relationshipVoiceFor('managed', 'not-a-managed-voice')).toBeNull();
});
