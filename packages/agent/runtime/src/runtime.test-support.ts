import type { DeviceClient, LlmClient, PermissionService, SessionStore } from '@dg-agent/core';
import {
  createMessage,
  createEmptyDeviceState,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
} from '@dg-agent/core';

export class TestDevice implements DeviceClient {
  private state: DeviceState;
  private listeners = new Set<(state: DeviceState) => void>();

  constructor(initialState: Partial<DeviceState> = {}) {
    this.state = { ...createEmptyDeviceState(), connected: true, ...initialState };
  }

  async connect(): Promise<void> {
    this.state = { ...this.state, connected: true };
  }

  async disconnect(): Promise<void> {
    this.state = createEmptyDeviceState();
  }

  async getState(): Promise<DeviceState> {
    return this.state;
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    if (command.type === 'start' && command.channel === 'A') {
      this.state = {
        ...this.state,
        strengthA: command.strength,
        waveActiveA: true,
        currentWaveA: command.waveform.id,
      };
      this.emit();
    }

    if (command.type === 'adjustStrength') {
      const nextStrength =
        command.channel === 'A'
          ? Math.max(0, this.state.strengthA + command.delta)
          : Math.max(0, this.state.strengthB + command.delta);
      this.state =
        command.channel === 'A'
          ? {
              ...this.state,
              strengthA: nextStrength,
            }
          : {
              ...this.state,
              strengthB: nextStrength,
            };
      this.emit();
    }

    if (command.type === 'burst') {
      this.state =
        command.channel === 'A'
          ? {
              ...this.state,
              strengthA: command.strength,
            }
          : {
              ...this.state,
              strengthB: command.strength,
            };
      this.emit();
    }

    return { state: this.state };
  }

  async emergencyStop(): Promise<void> {
    this.state = {
      ...this.state,
      strengthA: 0,
      strengthB: 0,
      waveActiveA: false,
      waveActiveB: false,
      currentWaveA: undefined,
      currentWaveB: undefined,
    };
    this.emit();
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

export class TestLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '准备启动 A',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'shock_start',
          args: {
            channel: 'A',
            strength: 50,
            waveformId: 'pulse_mid',
            loop: true,
          },
        },
      ],
    };
  }
}

export class CountingDeviceToolLlm implements LlmClient {
  count = 0;

  async runTurn() {
    this.count += 1;
    return {
      assistantMessage: '准备启动 A',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'shock_start',
          args: {
            channel: 'A',
            strength: 20,
            waveformId: 'pulse_mid',
            loop: true,
          },
        },
      ],
    };
  }
}

export class TwoStepLlm implements LlmClient {
  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (!hasToolOutput) {
      return {
        assistantMessage: '准备启动 A',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'shock_start',
            args: {
              channel: 'A',
              strength: 30,
              waveformId: 'pulse_mid',
              loop: true,
            },
          },
        ],
      };
    }

    return {
      assistantMessage: 'A 通道已经启动完毕。',
    };
  }
}

export class InspectingTwoStepLlm implements LlmClient {
  readonly conversations: Array<
    ReadonlyArray<NonNullable<Parameters<LlmClient['runTurn']>[0]['conversation']>[number]>
  > = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    this.conversations.push([...(input.conversation ?? [])]);

    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (!hasToolOutput) {
      return {
        assistantMessage: '准备启动 A',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'shock_start',
            args: {
              channel: 'A',
              strength: 30,
              waveformId: 'pulse_mid',
              loop: true,
            },
          },
        ],
      };
    }

    return {
      assistantMessage: 'A 通道已经启动完毕。',
    };
  }
}

export class ContextProbeLlm implements LlmClient {
  readonly conversations: string[][] = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    this.conversations.push(
      (input.conversation ?? []).flatMap((item) =>
        item.kind === 'message' ? [`${item.role}:${item.content}`] : [],
      ),
    );

    return {
      assistantMessage: 'ok',
    };
  }
}

export class RepeatedAdjustLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '连续调整强度',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'shock_adjust',
          args: { channel: 'A', delta: 5 },
        },
        {
          id: 'tool-2',
          name: 'shock_adjust',
          args: { channel: 'A', delta: 5 },
        },
      ],
    };
  }
}

export class LargeAdjustLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '澶у箙璋冩暣寮哄害',
      toolCalls: [
        {
          id: 'tool-large-adjust',
          name: 'shock_adjust',
          args: { channel: 'A', delta: 25 },
        },
      ],
    };
  }
}

export class LargeStartLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '灏濊瘯鍐峰惎鍔ㄩ珮寮哄害',
      toolCalls: [
        {
          id: 'tool-large-start',
          name: 'shock_start',
          args: {
            channel: 'A',
            strength: 30,
            waveformId: 'pulse_mid',
            loop: true,
          },
        },
      ],
    };
  }
}

export class BurstOnlyLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '尝试 burst',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'shock_burst',
          args: { channel: 'A', strength: 40, durationMs: 1000 },
        },
      ],
    };
  }
}

export class LongBurstLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '尝试长时间 burst',
      toolCalls: [
        {
          id: 'tool-long-burst',
          name: 'shock_burst',
          args: { channel: 'A', strength: 40, durationMs: 3000 },
        },
      ],
    };
  }
}

export class ThrowingDevice extends TestDevice {
  override async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    if (command.type === 'start') {
      throw new Error('蓝牙写入失败。');
    }
    return super.execute(command);
  }
}

export class DuplicateAssistantLlm implements LlmClient {
  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (!hasToolOutput) {
      return {
        assistantMessage: '先从很轻的强度开始。',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'shock_start',
            args: {
              channel: 'A',
              strength: 10,
              waveformId: 'pulse_mid',
              loop: true,
            },
          },
        ],
      };
    }

    return {
      assistantMessage: '先从很轻的强度开始。',
    };
  }
}

export class TimerFollowUpLlm implements LlmClient {
  readonly toolCountsBySource: Array<{ sourceType: string; toolCount: number }> = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    this.toolCountsBySource.push({
      sourceType: input.context.sourceType,
      toolCount: input.tools.length,
    });

    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (input.context.sourceType === 'system') {
      return {
        assistantMessage: '我还在等你的反馈。',
      };
    }

    if (!hasToolOutput) {
      return {
        assistantMessage: '我先等你反馈。',
        toolCalls: [
          {
            id: 'tool-timer',
            name: 'timer',
            args: { seconds: 1, label: '等待反馈' },
          },
        ],
      };
    }

    return {
      assistantMessage: '我先等你反馈。',
    };
  }
}

export class DeniedToolFollowUpLlm implements LlmClient {
  readonly calls: Array<{ toolCount: number; message: string; syntheticDenySeen: boolean }> = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    const syntheticDenySeen = Boolean(
      input.conversation?.some(
        (item) =>
          item.kind === 'message' &&
          item.role === 'user' &&
          item.content.includes('[内部提醒] 刚才请求的工具'),
      ),
    );

    this.calls.push({
      toolCount: input.tools.length,
      message: input.message,
      syntheticDenySeen,
    });

    if (syntheticDenySeen || input.tools.length === 0) {
      return {
        assistantMessage: '这一步没有执行，因为你刚才拒绝了这次操作。',
      };
    }

    return {
      assistantMessage: '',
      toolCalls: [
        {
          id: 'tool-denied-1',
          name: 'shock_start',
          args: {
            channel: 'A',
            strength: 10,
            waveformId: 'pulse_mid',
            loop: true,
          },
        },
      ],
    };
  }
}

export class AbortableLlm implements LlmClient {
  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    input.onTextDelta?.('thinking');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1_000);
      input.abortSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });

    return {
      assistantMessage: 'done',
    };
  }
}

export class VisionProbeLlm implements LlmClient {
  readonly capabilities = { imageInput: true };
  inputs: Array<Parameters<LlmClient['runTurn']>[0]> = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    this.inputs.push(input);
    input.onRawRequest?.({ messages: [{ content: [{ type: 'image', data: input.image?.data }] }] });
    return {
      assistantMessage: '我看到了画面。',
      rawResponse: { echoed: `data:${input.image?.mediaType};base64,${input.image?.data}` },
    };
  }
}

export class FailingLlm implements LlmClient {
  async runTurn(): Promise<never> {
    throw new Error('Provider HTTP error 401: unauthorized');
  }
}

export class TestPermission implements PermissionService {
  async request() {
    return { type: 'approve-once' } as const;
  }
}

export class DenyingPermission implements PermissionService {
  async request() {
    return { type: 'deny', reason: '用户拒绝本次操作' } as const;
  }
}

export class CountingPermission implements PermissionService {
  callCount = 0;
  async request() {
    this.callCount += 1;
    return { type: 'approve-once' } as const;
  }
}

export class TestSessionStore implements SessionStore {
  constructor(private readonly sessions = new Map<string, TestSessionStoreEntry>()) {}

  async get(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session ? this.cloneSession(session) : null;
  }

  async save(
    session: Awaited<ReturnType<TestSessionStore['get']>> extends infer T
      ? Exclude<T, null>
      : never,
  ) {
    this.sessions.set(session.id, this.cloneSession(session));
  }

  async list() {
    return Array.from(this.sessions.values()).map((session) => this.cloneSession(session));
  }

  async delete(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  private cloneSession(session: TestSessionStoreEntry): TestSessionStoreEntry {
    return {
      ...session,
      messages: session.messages.map((message) => ({ ...message })),
      deviceState: { ...session.deviceState },
      metadata: session.metadata ? structuredClone(session.metadata) : undefined,
    };
  }
}

export interface TestSessionStoreEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{
    id: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    createdAt: number;
  }>;
  deviceState: DeviceState;
  metadata?: Record<string, unknown>;
}

export function createScriptedMessages(
  entries: Array<['user' | 'assistant', string]>,
  startedAt = Date.now(),
) {
  return entries.map(([role, content], index) => createMessage(role, content, startedAt + index));
}
