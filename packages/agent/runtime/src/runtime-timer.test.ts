import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState } from '@dg-agent/core';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import { AgentRuntime } from './agent-runtime.js';
import {
  DeniedToolFollowUpLlm,
  DenyingPermission,
  DuplicateAssistantLlm,
  TestDevice,
  TestLlm,
  TestPermission,
  TestSessionStore,
  ThrowingDevice,
  TimerFollowUpLlm,
} from './runtime.test-support.js';

describe('AgentRuntime timer and synthetic follow-up turns', () => {
  it('uses ephemeral timer triggers, keeps them out of history, and disables tools on system turns', async () => {
    const llm = new TimerFollowUpLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    const followUpCompleted = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (event.type !== 'assistant-message-completed') return;
        if (event.message.content !== '我还在等你的反馈。') return;
        unsubscribe();
        resolve();
      });
    });

    await runtime.sendUserMessage({
      sessionId: 'timer-test',
      text: '等我反馈',
      context: {
        sessionId: 'timer-test',
        sourceType: 'cli',
        traceId: 'trace-timer',
      },
    });

    await followUpCompleted;

    const session = await runtime.getSessionSnapshot('timer-test');
    const traceEntries = await runtime.getSessionTrace('timer-test');
    expect(session.messages.map((message) => message.content)).toEqual([
      '等我反馈',
      '我先等你反馈。',
      '我还在等你的反馈。',
    ]);
    expect(session.messages.some((message) => message.content.includes('[Timer due]'))).toBe(false);
    expect(session.messages.some((message) => message.content.includes('[内部提醒]'))).toBe(false);
    expect(traceEntries.some((entry) => entry.kind === 'timer-scheduled')).toBe(true);
    expect(traceEntries.some((entry) => entry.kind === 'timer-fired')).toBe(true);
    expect(
      llm.toolCountsBySource.some(
        (entry) => entry.sourceType === 'system' && entry.toolCount === 0,
      ),
    ).toBe(true);
  });

  it('does not persist the same assistant narration twice across a tool iteration and final reply', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new DuplicateAssistantLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'duplicate-assistant',
      text: '轻一点开始',
      context: {
        sessionId: 'duplicate-assistant',
        sourceType: 'cli',
        traceId: 'trace-duplicate-assistant',
      },
    });

    const session = await runtime.getSessionSnapshot('duplicate-assistant');
    expect(
      session.messages.filter(
        (message) => message.role === 'assistant' && message.content === '先从很轻的强度开始。',
      ),
    ).toHaveLength(1);
  });

  it('uses an ephemeral deny trigger to get a final assistant reply without persisting the trigger text', async () => {
    const llm = new DeniedToolFollowUpLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new DenyingPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'denied-follow-up',
      text: '启动 A',
      context: {
        sessionId: 'denied-follow-up',
        sourceType: 'cli',
        traceId: 'trace-denied-follow-up',
      },
    });

    const session = await runtime.getSessionSnapshot('denied-follow-up');
    const traceEntries = await runtime.getSessionTrace('denied-follow-up');

    expect(session.messages.map((message) => message.content)).toEqual([
      '启动 A',
      '这一步没有执行，因为你刚才拒绝了这次操作。',
    ]);
    expect(session.messages.some((message) => message.content.includes('[内部提醒]'))).toBe(false);
    expect(traceEntries.some((entry) => entry.kind === 'tool-denied')).toBe(true);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.toolCount).toBe(0);
    expect(llm.calls[1]?.syntheticDenySeen).toBe(true);
  });

  it('persists a system notice when tool execution fails after approval', async () => {
    const llm = new DeniedToolFollowUpLlm();
    const runtime = new AgentRuntime({
      device: new ThrowingDevice(),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'failed-follow-up',
      text: '启动 A',
      context: {
        sessionId: 'failed-follow-up',
        sourceType: 'cli',
        traceId: 'trace-failed-follow-up',
      },
    });

    const session = await runtime.getSessionSnapshot('failed-follow-up');
    const traceEntries = await runtime.getSessionTrace('failed-follow-up');

    expect(session.messages.map((message) => message.content)).toEqual([
      '启动 A',
      '这一步没有执行，因为你刚才拒绝了这次操作。',
    ]);
    expect(session.messages.some((message) => message.content.includes('[内部提醒]'))).toBe(false);
    expect(traceEntries.some((entry) => entry.kind === 'tool-failed')).toBe(true);
    expect(llm.calls[1]?.toolCount).toBe(0);
    expect(llm.calls[1]?.syntheticDenySeen).toBe(true);
  });

  it('normalizes legacy timer trigger messages away and collapses assistant duplicates they caused', async () => {
    const now = Date.now();
    const sessionStore = new TestSessionStore(
      new Map([
        [
          'legacy-session',
          {
            id: 'legacy-session',
            createdAt: now,
            updatedAt: now,
            messages: [
              { id: 'u1', role: 'user', content: '继续', createdAt: now },
              { id: 'a1', role: 'assistant', content: '我先等你反馈。', createdAt: now + 1 },
              {
                id: 't1',
                role: 'user',
                content: '[Timer due]\nlabel: 等待反馈\nseconds: 5',
                createdAt: now + 2,
              },
              { id: 'a2', role: 'assistant', content: '我先等你反馈。', createdAt: now + 3 },
            ],
            deviceState: createEmptyDeviceState(),
          },
        ],
      ]),
    );

    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      sessionStore,
    });

    const session = await runtime.getSessionSnapshot('legacy-session');
    expect(
      session.messages.filter(
        (message) => message.role === 'assistant' && message.content === '我先等你反馈。',
      ),
    ).toHaveLength(1);
    expect(session.messages.some((message) => message.content.includes('定时提醒：等待反馈'))).toBe(
      false,
    );
    expect(session.messages.some((message) => message.content.includes('[Timer due]'))).toBe(false);
  });
});
