import { describe, expect, it, vi } from 'vitest';
import type { LlmClient, ModelContextStrategy, RuntimeEvent } from '@dg-agent/core';
import { createEmptyDeviceState, getBridgeOriginMetadata } from '@dg-agent/core';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import { AgentRuntime } from './agent-runtime.js';
import { ToolRegistry } from './tool-registry.js';
import {
  AbortableLlm,
  ContextProbeLlm,
  CountingDeviceToolLlm,
  DenyingPermission,
  FailingLlm,
  InspectingTwoStepLlm,
  TestDevice,
  TestLlm,
  TestPermission,
  TestSessionStore,
  TwoStepLlm,
  VisionProbeLlm,
  createScriptedMessages,
} from './runtime.test-support.js';

describe('AgentRuntime sessions, context, and lifecycle', () => {
  it('applies the existing upper permission service before resolving an added runtime tool', async () => {
    const invoke = vi.fn(() => ({ type: 'inline' as const, output: '{"ok":true}' }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'device_vibrate',
      definition: {
        name: 'device_vibrate',
        description: 'generic vibration',
        parameters: { type: 'object', properties: {} },
      },
      toExecutionPlan: invoke,
    });
    const llm: LlmClient = {
      async runTurn() {
        return {
          assistantMessage: 'runtime call',
          toolCalls: [{ id: 'runtime-1', name: 'device_vibrate', args: {} }],
        };
      },
    };
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new DenyingPermission(),
      toolRegistry,
      permissionRequiredToolNames: new Set(['device_vibrate']),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'generic-permission',
      text: 'vibrate',
      context: {
        sessionId: 'generic-permission',
        sourceType: 'web',
        traceId: 'generic-permission',
      },
    });

    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps a visual frame ephemeral, disables tools, and redacts recursive model logs', async () => {
    const llm = new VisionProbeLlm();
    const store = new TestSessionStore();
    const events: RuntimeEvent[] = [];
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new TestPermission(),
      sessionStore: store,
      waveformLibrary: createBasicWaveformLibrary(),
    });
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'vision',
      text: '画面里有什么？',
      image: {
        mediaType: 'image/jpeg',
        data: 'camera-secret-base64',
        width: 640,
        height: 480,
        byteLength: 16,
      },
      context: { sessionId: 'vision', sourceType: 'web', traceId: 'vision-1' },
    });

    expect(llm.inputs).toHaveLength(1);
    expect(llm.inputs[0]?.tools).toEqual([]);
    expect(llm.inputs[0]?.image?.data).toBe('camera-secret-base64');
    const snapshot = await runtime.getSessionSnapshot('vision');
    expect(JSON.stringify(snapshot)).not.toContain('camera-secret-base64');
    expect(snapshot.messages.map((message) => message.content)).toEqual([
      '画面里有什么？',
      '我看到了画面。',
    ]);
    const complete = events.find((event) => event.type === 'llm-turn-complete');
    expect(JSON.stringify(complete)).not.toContain('camera-secret-base64');
    expect(JSON.stringify(complete)).toContain('[REDACTED_IMAGE]');
  });

  it('rejects an image with unknown capability before creating a session or calling the model', async () => {
    const llm = new ContextProbeLlm();
    const store = new TestSessionStore();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new TestPermission(),
      sessionStore: store,
    });

    await expect(
      runtime.sendUserMessage({
        sessionId: 'unsupported-vision',
        text: 'look',
        image: {
          mediaType: 'image/webp',
          data: 'secret',
          width: 1,
          height: 1,
          byteLength: 6,
        },
        context: { sessionId: 'unsupported-vision', sourceType: 'web', traceId: 'vision-2' },
      }),
    ).rejects.toThrow(/未明确支持图片输入/);
    expect(llm.conversations).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('runs tool iterations until a final assistant answer is produced', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new TwoStepLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '启动A',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-loop',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.messages.at(-1)?.content).toContain('启动完毕');
    expect(session.deviceState.strengthA).toBe(10);
    expect(session.messages.some((message) => message.role === 'system')).toBe(false);
  });

  it('does not duplicate intermediate assistant narration in the next iteration context', async () => {
    const llm = new InspectingTwoStepLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '启动A',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-loop-no-dup',
      },
    });

    const nextIterationConversation = llm.conversations[1] ?? [];
    const narrations = nextIterationConversation.filter(
      (item) =>
        item.kind === 'message' && item.role === 'assistant' && item.content === '准备启动 A',
    );

    expect(narrations).toHaveLength(1);
  });

  it('supports configurable model context strategies', async () => {
    const seededMessages = createScriptedMessages([
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['user', 'u2'],
      ['assistant', 'a2'],
      ['user', 'u3'],
      ['assistant', 'a3'],
      ['user', 'u4'],
      ['assistant', 'a4'],
      ['user', 'u5'],
      ['assistant', 'a5'],
      ['user', 'u6'],
      ['assistant', 'a6'],
    ]);

    const cases: Array<{ strategy: ModelContextStrategy; expected: string[] }> = [
      {
        strategy: 'last-user-turn',
        expected: ['user:u6', 'assistant:a6', 'user:u7'],
      },
      {
        strategy: 'last-five-user-turns',
        expected: [
          'user:u3',
          'assistant:a3',
          'user:u4',
          'assistant:a4',
          'user:u5',
          'assistant:a5',
          'user:u6',
          'assistant:a6',
          'user:u7',
        ],
      },
      {
        strategy: 'full-history',
        expected: [
          'user:u1',
          'assistant:a1',
          'user:u2',
          'assistant:a2',
          'user:u3',
          'assistant:a3',
          'user:u4',
          'assistant:a4',
          'user:u5',
          'assistant:a5',
          'user:u6',
          'assistant:a6',
          'user:u7',
        ],
      },
    ];

    for (const testCase of cases) {
      const llm = new ContextProbeLlm();
      const now = Date.now();
      const sessionStore = new TestSessionStore(
        new Map([
          [
            `context-${testCase.strategy}`,
            {
              id: `context-${testCase.strategy}`,
              createdAt: now,
              updatedAt: now,
              messages: seededMessages.map((message) => ({ ...message })),
              deviceState: createEmptyDeviceState(),
            },
          ],
        ]),
      );

      const runtime = new AgentRuntime({
        device: new TestDevice(),
        llm,
        permission: new TestPermission(),
        waveformLibrary: createBasicWaveformLibrary(),
        sessionStore,
        modelContextStrategy: testCase.strategy,
      });

      await runtime.sendUserMessage({
        sessionId: `context-${testCase.strategy}`,
        text: 'u7',
        context: {
          sessionId: `context-${testCase.strategy}`,
          sourceType: 'cli',
          traceId: `trace-${testCase.strategy}`,
        },
      });

      expect(llm.conversations[0]).toEqual(testCase.expected);
    }
  });

  it('persists bridge origin metadata for bridge-sourced sessions', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'bridge-active-session',
      text: 'hello from group',
      context: {
        sessionId: 'bridge-active-session',
        sourceType: 'qq',
        sourceUserId: 'group:123456',
        sourceUserName: 'Test Group',
        traceId: 'trace-bridge-origin',
      },
    });

    const session = await runtime.getSessionSnapshot('bridge-active-session');
    expect(getBridgeOriginMetadata(session.metadata)).toEqual({
      platform: 'qq',
      userId: 'group:123456',
      userName: 'Test Group',
    });
  });

  it('checks an injected module lease gate at the final device boundary', async () => {
    const device = new TestDevice();
    const executed: DeviceCommand[] = [];
    const originalExecute = device.execute.bind(device);
    device.execute = async (command) => {
      executed.push(command);
      return originalExecute(command);
    };
    const runtime = new AgentRuntime({
      device,
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      deviceExecutionGate: () => false,
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'lease-gate',
      text: '启动',
      context: { sessionId: 'lease-gate', sourceType: 'cli', traceId: 'lease-gate' },
    });

    expect(executed).toEqual([]);
    expect((await device.getState()).strengthA).toBe(0);
  });

  it('clamps cold start strength before executing device command', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '启动A强度50',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-1',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.deviceState.strengthA).toBe(10);
  });

  it('invalidates a permission continuation before stopping devices', async () => {
    let resolvePermission: ((decision: { type: 'approve-once' }) => void) | undefined;
    let markRequested: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    const permission: PermissionService = {
      request: async () => {
        markRequested?.();
        return new Promise((resolve) => {
          resolvePermission = resolve;
        });
      },
    };
    const device = new TestDevice();
    const executed: DeviceCommand[] = [];
    const originalExecute = device.execute.bind(device);
    device.execute = async (command) => {
      executed.push(command);
      return originalExecute(command);
    };
    const runtime = new AgentRuntime({
      device,
      llm: new TestLlm(),
      permission,
      waveformLibrary: createBasicWaveformLibrary(),
    });

    const reply = runtime.sendUserMessage({
      sessionId: 'permission-stop',
      text: '启动',
      context: { sessionId: 'permission-stop', sourceType: 'cli', traceId: 'permission-stop' },
    });
    await requested;
    await runtime.emergencyStop('permission-stop');
    resolvePermission?.({ type: 'approve-once' });

    await expect(reply).rejects.toThrow('已停止当前回复');
    expect(executed).toEqual([]);
    expect((await device.getState()).strengthA).toBe(0);
  });

  it('invalidates a late provider result even when the provider ignores AbortSignal', async () => {
    let resolveTurn: ((result: Awaited<ReturnType<LlmClient['runTurn']>>) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const llm: LlmClient = {
      runTurn: async () => {
        markStarted?.();
        return new Promise((resolve) => {
          resolveTurn = resolve;
        });
      },
    };
    const device = new TestDevice();
    const executed: DeviceCommand[] = [];
    const originalExecute = device.execute.bind(device);
    device.execute = async (command) => {
      executed.push(command);
      return originalExecute(command);
    };
    const runtime = new AgentRuntime({
      device,
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });
    const reply = runtime.sendUserMessage({
      sessionId: 'late-llm-stop',
      text: '启动',
      context: { sessionId: 'late-llm-stop', sourceType: 'cli', traceId: 'late-llm-stop' },
    });
    await started;
    // Device output is runtime-global: a panic from another visible session
    // must invalidate this session's late provider continuation too.
    await runtime.emergencyStop('panic-button-session');
    resolveTurn?.({
      assistantMessage: '启动',
      toolCalls: [
        {
          id: 'late-tool',
          name: 'shock_start',
          args: { channel: 'A', strength: 10, waveformId: 'pulse_mid', loop: true },
        },
      ],
    });

    await expect(reply).rejects.toThrow('已停止当前回复');
    expect(executed).toEqual([]);
  });

  it('aborts an in-flight assistant reply and records the abort note', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new AbortableLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => {
      events.push(event);
    });

    const sendPromise = runtime.sendUserMessage({
      sessionId: 'test',
      text: 'stop this later',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-abort',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.abortCurrentReply('test');

    await expect(sendPromise).rejects.toThrow('已停止当前回复');

    const session = await runtime.getSessionSnapshot('test');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1]?.content).toContain('已手动中止');
    expect(events.some((event) => event.type === 'assistant-message-aborted')).toBe(true);
  });

  it('does not recreate a deleted session when an in-flight reply is aborted during deletion', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new AbortableLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    const sendPromise = runtime.sendUserMessage({
      sessionId: 'deleted-while-busy',
      text: 'delete me later',
      context: {
        sessionId: 'deleted-while-busy',
        sourceType: 'cli',
        traceId: 'trace-delete-while-busy',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.deleteSession('deleted-while-busy');
    await expect(sendPromise).rejects.toThrow('已停止当前回复');

    const sessions = await runtime.listSessions();
    expect(sessions.some((session) => session.id === 'deleted-while-busy')).toBe(false);
    expect(await runtime.getSessionTrace('deleted-while-busy')).toEqual([]);
  });

  it('persists and clears a user-assigned session title', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.getSessionSnapshot('rename-me');
    await runtime.renameSession('rename-me', '  常用控制  ');
    expect((await runtime.getSessionSnapshot('rename-me')).metadata?.sessionTitle).toBe('常用控制');

    await runtime.renameSession('rename-me', null);
    expect((await runtime.getSessionSnapshot('rename-me')).metadata?.sessionTitle).toBeUndefined();
  });

  it('keeps a rename made while a reply is in flight', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new AbortableLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    const reply = runtime.sendUserMessage({
      sessionId: 'rename-while-busy',
      text: 'hello',
      context: {
        sessionId: 'rename-while-busy',
        sourceType: 'cli',
        traceId: 'trace-rename-while-busy',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.renameSession('rename-while-busy', '回复中的标题');
    await runtime.abortCurrentReply('rename-while-busy');
    await expect(reply).rejects.toThrow('已停止当前回复');

    expect((await runtime.getSessionSnapshot('rename-while-busy')).metadata?.sessionTitle).toBe(
      '回复中的标题',
    );
  });

  it('persists a friendly assistant error message when the provider fails', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new FailingLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: 'hello',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-error',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1]?.role).toBe('assistant');
    expect(session.messages[1]?.content).toContain('API Key');
  });

  it('refreshes persisted session device state from the real device on snapshot load', async () => {
    const now = Date.now();
    const sessionStore = new TestSessionStore(
      new Map([
        [
          'test',
          {
            id: 'test',
            createdAt: now,
            updatedAt: now,
            messages: [],
            deviceState: {
              ...createEmptyDeviceState(),
              connected: true,
              deviceName: 'Old Device',
            },
          },
        ],
      ]),
    );

    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false, deviceName: undefined }),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      sessionStore,
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.deviceState.connected).toBe(false);
    expect(session.deviceState.deviceName).toBeUndefined();
  });

  it('stops the turn immediately when a device tool is requested while disconnected', async () => {
    const llm = new CountingDeviceToolLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '启动 A 通道',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-disconnected-stop',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(llm.count).toBe(1);
    expect(session.messages.at(-1)?.content).toBe(
      '设备未连接，请先点击输入框旁的蓝牙图标连接郊狼。',
    );
  });
});
