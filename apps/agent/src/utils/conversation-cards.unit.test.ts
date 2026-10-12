import { expect, it } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import { resolveConversationCards, sceneNeedsCharacter } from './conversation-cards.js';

const library = {
  selectedId: 'new-character',
  hiddenBuiltinIds: [],
  scenes: [
    { id: 'character', name: '原角色', kind: 'character' as const, prompt: '人设' },
    { id: 'new-character', name: '新角色', kind: 'character' as const, prompt: '新人设' },
    { id: 'forest', name: '森林', kind: 'scene' as const, prompt: '环境' },
  ],
};
function session(
  metadata: Record<string, unknown>,
  messages: SessionSnapshot['messages'] = [],
): SessionSnapshot {
  return {
    id: 's',
    createdAt: 1,
    updatedAt: 1,
    messages,
    metadata,
    deviceState: createEmptyDeviceState(),
  };
}

it('keeps the bound character and scene across global selection changes', () => {
  const current = session({
    promptPresetId: 'character',
    relationshipId: 'private',
    sceneId: 'forest',
  });
  expect(resolveConversationCards(current, 's', library)).toEqual({
    characterId: 'character',
    sceneId: 'forest',
    boundPresetId: 'character',
  });
  expect(resolveConversationCards(current, 'other', library).characterId).toBe('new-character');
});

it('treats an old prompt-only scene as an environment, never a character', () => {
  const old = session({ promptPresetId: 'forest' }, [
    { id: 'm', role: 'user', content: 'hello', createdAt: 1 },
  ]);
  expect(resolveConversationCards(old, 's', library)).toEqual({
    characterId: '',
    sceneId: 'forest',
    boundPresetId: 'forest',
  });
  expect(resolveConversationCards(session({ sceneId: '' }), 's', library).sceneId).toBe('');
});

it('requires a character before starting scene-only chat while retaining legacy message history', () => {
  expect(sceneNeedsCharacter(session({ sceneId: 'forest' }), 's', '', 'forest')).toBe(true);
  expect(sceneNeedsCharacter(null, 's', '', 'forest')).toBe(true);
  expect(sceneNeedsCharacter(session({ sceneId: 'forest' }), 's', 'character', 'forest')).toBe(
    false,
  );
  expect(
    sceneNeedsCharacter(
      session({ promptPresetId: 'forest' }, [
        { id: 'm', role: 'user', content: '旧会话', createdAt: 1 },
      ]),
      's',
      '',
      'forest',
    ),
  ).toBe(false);
});
