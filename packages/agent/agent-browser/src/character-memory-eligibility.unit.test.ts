import { expect, it } from 'vitest';
import { supportsCharacterMemory } from './character-memory-eligibility.js';

it('allows existing built-in personas and structured or explicitly typed characters', () => {
  expect(supportsCharacterMemory('gentle', [])).toBe(true);
  expect(
    supportsCharacterMemory('market-role', [
      { id: 'market-role', name: '角色', prompt: '人设', kind: 'character' },
    ]),
  ).toBe(true);
  expect(
    supportsCharacterMemory('legacy-role', [
      {
        id: 'legacy-role',
        name: '角色',
        prompt: '人设',
        characterCard: {
          schemaVersion: 1,
          description: '',
          personality: '',
          greeting: '',
          exampleDialogue: '',
          tags: [],
          creator: '',
          license: '',
        },
      },
    ]),
  ).toBe(true);
});

it('denies scene rules, old prompt-only custom entries and unknown ids', () => {
  expect(
    supportsCharacterMemory('market-scene', [
      { id: 'market-scene', name: '场景', prompt: '世界规则', kind: 'scene' },
    ]),
  ).toBe(false);
  expect(
    supportsCharacterMemory('legacy-scene', [
      { id: 'legacy-scene', name: '场景', prompt: '世界规则' },
    ]),
  ).toBe(false);
  expect(supportsCharacterMemory('missing', [])).toBe(false);
});
