import { expect, it, vi } from 'vitest';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import { AgentRuntime } from './agent-runtime.js';
import { TestDevice, TestPermission } from './runtime.test-support.js';
import type { SourceType } from '@dg-agent/core';
import { createEmptyDeviceState } from '@dg-agent/core';
import { InMemorySessionStore } from './in-memory-session-store.js';

function runtime() {
  return new AgentRuntime({
    device: new TestDevice({ connected: false }),
    llm: { runTurn: async () => ({ assistantMessage: '你好' }) },
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
  });
}
it('uses a bounded runtime read for an established personal character', async () => {
  const sessions = new InMemorySessionStore();
  await sessions.save({
    id: 's',
    createdAt: 1,
    updatedAt: 1,
    metadata: { promptPresetId: 'character' },
    messages: [],
    deviceState: createEmptyDeviceState(),
  });
  const getRuntimeWindow = vi.fn((id: string) => sessions.get(id));
  const client = new AgentRuntime({
    device: new TestDevice({ connected: false }),
    llm: { runTurn: async () => ({ assistantMessage: '你好' }) },
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
    sessionStore: Object.assign(sessions, { getRuntimeWindow }),
  });
  await client.sendUserMessage({
    sessionId: 's',
    text: '继续',
    characterId: 'character',
    context: { sessionId: 's', sourceType: 'web', traceId: 'turn' },
  });
  expect(getRuntimeWindow).toHaveBeenCalledWith('s');
  expect((await sessions.get('s'))?.messages.map((message) => message.content)).toEqual([
    '继续',
    '你好',
  ]);
  client.dispose();
});
it('persists the first personal character and refuses later global selection or relationship changes', async () => {
  const client = runtime();
  const context = { sessionId: 's', sourceType: 'web' as const, traceId: 't' };
  await client.sendUserMessage({ sessionId: 's', text: '你好', context, characterId: 'old' });
  expect((await client.getSessionSnapshot('s')).metadata?.promptPresetId).toBe('old');
  await client.sendUserMessage({
    sessionId: 's',
    text: '继续',
    context,
    characterId: 'new',
    relationshipId: 'wrong',
  });
  expect((await client.getSessionSnapshot('s')).metadata).toMatchObject({ promptPresetId: 'old' });
  expect((await client.getSessionSnapshot('s')).metadata?.relationshipId).toBeUndefined();
  await client.sendUserMessage({
    sessionId: 's',
    text: '继续',
    context,
    characterId: 'old',
    relationshipId: 'right',
  });
  await client.sendUserMessage({
    sessionId: 's',
    text: '继续',
    context,
    characterId: 'old',
    relationshipId: 'replacement',
  });
  expect((await client.getSessionSnapshot('s')).metadata?.relationshipId).toBe('right');
  client.dispose();
});
it('does not establish personal bindings for bridge or channel messages', async () => {
  const client = runtime();
  for (const sourceType of ['qq', 'telegram', 'web'] as SourceType[]) {
    const sessionId = sourceType;
    await client.sendUserMessage({
      sessionId,
      text: '你好',
      characterId: 'private',
      relationshipId: 'private',
      context: { sessionId, sourceType, sourceChannelId: 'room', traceId: 't' },
    });
    expect((await client.getSessionSnapshot(sessionId)).metadata?.promptPresetId).toBeUndefined();
    expect((await client.getSessionSnapshot(sessionId)).metadata?.relationshipId).toBeUndefined();
  }
  client.dispose();
});

it('changes only the optional scene on an existing personal character conversation', async () => {
  const client = runtime();
  const context = { sessionId: 's', sourceType: 'web' as const, traceId: 't' };
  await client.sendUserMessage({
    sessionId: 's',
    text: '你好',
    context,
    characterId: 'character',
    relationshipId: 'relation',
  });
  const originalMessages = (await client.getSessionSnapshot('s')).messages;
  await client.setSessionScene('s', 'market-forest');
  expect((await client.getSessionSnapshot('s')).metadata).toMatchObject({
    promptPresetId: 'character',
    relationshipId: 'relation',
    sceneId: 'market-forest',
  });
  await client.setSessionScene('s', 'market-city');
  expect((await client.getSessionSnapshot('s')).metadata?.sceneId).toBe('market-city');
  await client.setSessionScene('s', null);
  expect((await client.getSessionSnapshot('s')).metadata).toMatchObject({
    promptPresetId: 'character',
    relationshipId: 'relation',
    sceneId: '',
  });
  expect((await client.getSessionSnapshot('s')).messages).toEqual(originalMessages);
  client.dispose();
});

it('links a server run to the persisted user message by request ID', async () => {
  const client = new AgentRuntime({
    device: new TestDevice({ connected: false }),
    llm: { runTurn: async () => ({ assistantMessage: '收到' }) },
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
    taskRunReporter: {
      begin: async () => undefined,
      beforeToolCall: async () => undefined,
      recordReceipt: async () => undefined,
      finish: async () => undefined,
    },
  });
  const requestId = 'web-request-1234';
  await client.sendUserMessage({
    sessionId: 's',
    runId: 'run-server-1234',
    text: '测试',
    context: { sessionId: 's', sourceType: 'web', traceId: requestId },
  });
  const session = await client.getSessionSnapshot('s');
  expect(session.messages.find((message) => message.role === 'user')?.id).toBe(requestId);
  client.dispose();
});

it('rejects scene changes to non-personal conversations and malformed IDs', async () => {
  const client = runtime();
  await expect(client.setSessionScene('s', 'invalid scene')).rejects.toThrow('场景编号无效');
  await client.importSessions([
    {
      id: 'group',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      deviceState: { ...(await client.getSessionSnapshot('s')).deviceState },
      metadata: { conversationType: 'group' },
    },
  ]);
  await expect(client.setSessionScene('group', 'market-forest')).rejects.toThrow('只有私人聊天');
  client.dispose();
});
