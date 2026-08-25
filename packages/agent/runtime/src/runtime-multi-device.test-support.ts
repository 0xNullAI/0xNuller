import type { LlmClient, OpossumCommand } from '@dg-agent/core';
import type {
  CivetPressureReading,
  OpossumState,
  PawPrintsReading,
  SensorState,
} from '@dg-kit/protocol';
import type {
  CivetEdgingClient,
  OpossumClient,
  OpossumCommandResult,
  PawPrintsClient,
} from './device-clients.js';

export function createOpossumState(overrides: Partial<OpossumState> = {}): OpossumState {
  return { connected: true, battery: 100, intensityA: 0, intensityB: 0, ...overrides };
}

export class TestOpossumClient implements OpossumClient {
  private state: OpossumState;
  ledCalls: number[] = [];

  constructor(initialState: Partial<OpossumState> = {}) {
    this.state = createOpossumState(initialState);
  }

  async connect(): Promise<void> {
    this.state = { ...this.state, connected: true };
  }
  async disconnect(): Promise<void> {
    this.state = createOpossumState({ connected: false });
  }
  async getState(): Promise<OpossumState> {
    return this.state;
  }
  async execute(command: OpossumCommand): Promise<OpossumCommandResult> {
    if (command.type === 'vibrateStart' || command.type === 'vibrateBurst') {
      this.state =
        command.channel === 'A'
          ? { ...this.state, intensityA: command.intensity }
          : { ...this.state, intensityB: command.intensity };
    }
    if (command.type === 'vibrateAdjust') {
      const next =
        command.channel === 'A'
          ? Math.max(0, this.state.intensityA + command.delta)
          : Math.max(0, this.state.intensityB + command.delta);
      this.state =
        command.channel === 'A'
          ? { ...this.state, intensityA: next }
          : { ...this.state, intensityB: next };
    }
    if (command.type === 'vibrateStop') {
      this.state = command.channel
        ? command.channel === 'A'
          ? { ...this.state, intensityA: 0 }
          : { ...this.state, intensityB: 0 }
        : { ...this.state, intensityA: 0, intensityB: 0 };
    }
    return { state: this.state };
  }
  async emergencyStop(): Promise<void> {
    this.state = { ...this.state, intensityA: 0, intensityB: 0 };
  }
  async setIndicatorColor(color: number): Promise<void> {
    this.ledCalls.push(color);
  }
  onStateChanged(): () => void {
    return () => {};
  }
}

export class TestPawPrintsClient implements PawPrintsClient {
  private state: SensorState;
  ledCalls: number[] = [];
  private readingListeners = new Set<(reading: PawPrintsReading) => void>();

  constructor(initialState: Partial<SensorState> = {}) {
    this.state = { connected: true, battery: 100, ...initialState };
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState(): Promise<SensorState> {
    return this.state;
  }
  subscribe(listener: (reading: PawPrintsReading) => void): () => void {
    this.readingListeners.add(listener);
    return () => {
      this.readingListeners.delete(listener);
    };
  }
  onStateChanged(): () => void {
    return () => {};
  }
  async setIndicatorColor(color: number): Promise<void> {
    this.ledCalls.push(color);
  }
  /** Test hook: simulate a raw sensor reading reaching the SensorTriggerEngine. */
  pushReading(reading: PawPrintsReading): void {
    for (const listener of this.readingListeners) listener(reading);
  }
}

export class TestCivetEdgingClient implements CivetEdgingClient {
  private state: SensorState;
  private readingListeners = new Set<(reading: CivetPressureReading) => void>();

  constructor(initialState: Partial<SensorState> = {}) {
    this.state = { connected: true, battery: 100, ...initialState };
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState(): Promise<SensorState> {
    return this.state;
  }
  subscribe(listener: (reading: CivetPressureReading) => void): () => void {
    this.readingListeners.add(listener);
    return () => {
      this.readingListeners.delete(listener);
    };
  }
  onStateChanged(): () => void {
    return () => {};
  }
  /** Test hook: simulate a raw pressure reading reaching subscribers. */
  pushReading(reading: CivetPressureReading): void {
    for (const listener of this.readingListeners) listener(reading);
  }
  // Deliberately no setIndicatorColor override here in some tests to check
  // the "client exists but doesn't support LED" branch; individual test
  // classes add it where needed.
}

export class OpossumVibrateStartLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '启动负鼠振动',
      toolCalls: [
        {
          id: 'tool-vibrate-1',
          name: 'vibrate_start',
          args: { channel: 'A', intensity: 30 },
        },
      ],
    };
  }
}

export class OpossumVibrateAdjustLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '调整负鼠振动',
      toolCalls: [
        {
          id: 'tool-vibrate-adjust-1',
          name: 'vibrate_adjust',
          args: { channel: 'A', delta: 25 },
        },
      ],
    };
  }
}

export class RepeatedVibrateAdjustLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '连续调整负鼠振动',
      toolCalls: [
        {
          id: 'tool-vibrate-adjust-1',
          name: 'vibrate_adjust',
          args: { channel: 'A', delta: 5 },
        },
        {
          id: 'tool-vibrate-adjust-2',
          name: 'vibrate_adjust',
          args: { channel: 'A', delta: 5 },
        },
      ],
    };
  }
}

export class SetIndicatorColorLlm implements LlmClient {
  constructor(private readonly deviceKind: string) {}
  async runTurn() {
    return {
      assistantMessage: '设置指示灯',
      toolCalls: [
        {
          id: 'tool-indicator-1',
          name: 'set_indicator_color',
          args: { deviceKind: this.deviceKind, color: 3 },
        },
      ],
    };
  }
}

export class SensorToolLlm implements LlmClient {
  readonly toolCountsBySource: Array<{ sourceType: string; toolCount: number }> = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    this.toolCountsBySource.push({
      sourceType: input.context.sourceType,
      toolCount: input.tools.length,
    });

    if (input.context.sourceType === 'sensor') {
      const hasToolOutput = input.conversation?.some(
        (item) => item.kind === 'function_call_output',
      );
      if (!hasToolOutput) {
        return {
          assistantMessage: '感觉到了，稍微加强一点。',
          toolCalls: [
            {
              id: 'tool-sensor-vibrate',
              name: 'vibrate_start',
              args: { channel: 'A', intensity: 5 },
            },
          ],
        };
      }
      return { assistantMessage: '已经响应了传感器事件。' };
    }

    return { assistantMessage: '好的。' };
  }
}
