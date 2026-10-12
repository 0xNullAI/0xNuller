import { expect, it } from 'vitest';
import { createEmptyDeviceState } from '@dg-agent/core';
import { createBuildBrowserInstructions } from './build-browser-instructions.js';

it('keeps the conversation character when global selection changes and does not borrow another character after deletion', () => {
  const build = createBuildBrowserInstructions({
    promptPresetId: 'new',
    savedPromptPresets: [
      { id: 'old', name: '旧角色', kind: 'character', prompt: '原本的角色人格' },
      { id: 'new', name: '新角色', kind: 'character', prompt: '另一个角色人格' },
    ],
    maxStrengthA: 10,
    maxStrengthB: 10,
  });
  const input = {
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      deviceState: createEmptyDeviceState(),
      metadata: { promptPresetId: 'old' },
    },
    context: { sessionId: 's', sourceType: 'web' as const, traceId: 't' },
    isFirstIteration: true,
    turnToolCalls: [],
  };
  expect(build(input)).toContain('原本的角色人格');
  expect(build(input)).not.toContain('另一个角色人格');
  input.session.metadata.promptPresetId = 'deleted';
  expect(build(input)).not.toContain('另一个角色人格');
});

it('keeps a bound character while changing or clearing an optional environment scene', () => {
  const build = createBuildBrowserInstructions({
    promptPresetId: 'other',
    savedPromptPresets: [
      { id: 'character', name: '角色', kind: 'character', prompt: '固定的人物性格' },
      { id: 'other', name: '其他角色', kind: 'character', prompt: '错误的人物性格' },
      { id: 'forest', name: '森林', kind: 'scene', prompt: '森林环境规则' },
      { id: 'city', name: '城市', kind: 'scene', prompt: '城市环境规则' },
    ],
    maxStrengthA: 10,
    maxStrengthB: 10,
  });
  const input = {
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      deviceState: createEmptyDeviceState(),
      metadata: { promptPresetId: 'character', relationshipId: 'private', sceneId: 'forest' },
    },
    context: { sessionId: 's', sourceType: 'web' as const, traceId: 't' },
    isFirstIteration: true,
    turnToolCalls: [],
  };
  expect(build(input)).toContain('固定的人物性格');
  expect(build(input)).toContain('森林环境规则');
  expect(build(input)).not.toContain('错误的人物性格');
  input.session.metadata.sceneId = 'city';
  expect(build(input)).toContain('城市环境规则');
  expect(build(input)).not.toContain('森林环境规则');
  input.session.metadata.sceneId = '';
  expect(build(input)).not.toContain('森林环境规则');
  expect(build(input)).not.toContain('城市环境规则');
  expect(build(input)).toContain('固定的人物性格');
});

it('reads a legacy prompt-only scene without treating it as a character', () => {
  const build = createBuildBrowserInstructions({
    promptPresetId: 'character',
    savedPromptPresets: [
      { id: 'legacy-scene', name: '旧场景', prompt: '旧场景环境规则' },
      { id: 'character', name: '角色', kind: 'character', prompt: '其他人物性格' },
    ],
    maxStrengthA: 10,
    maxStrengthB: 10,
  });
  const instructions = build({
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      deviceState: createEmptyDeviceState(),
      metadata: { promptPresetId: 'legacy-scene' },
    },
    context: { sessionId: 's', sourceType: 'web', traceId: 't' },
    isFirstIteration: true,
    turnToolCalls: [],
  });
  expect(instructions).toContain('旧场景环境规则');
  expect(instructions).not.toContain('其他人物性格');
});

it('does not silently apply a newly selected global scene to an existing unbound chat', () => {
  const build = createBuildBrowserInstructions({
    promptPresetId: 'forest',
    savedPromptPresets: [{ id: 'forest', name: '森林', kind: 'scene', prompt: '森林环境规则' }],
    maxStrengthA: 10,
    maxStrengthB: 10,
  });
  const instructions = build({
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', content: '继续', createdAt: 1 }],
      deviceState: createEmptyDeviceState(),
    },
    context: { sessionId: 's', sourceType: 'web', traceId: 't' },
    isFirstIteration: true,
    turnToolCalls: [],
  });
  expect(instructions).not.toContain('森林环境规则');
});
