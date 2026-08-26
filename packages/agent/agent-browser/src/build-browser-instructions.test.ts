import { describe, expect, it } from 'vitest';
import {
  createEmptyDeviceState,
  createEmptySensorState,
  withSensorLastReading,
  type ActionContext,
  type SessionSnapshot,
} from '@dg-agent/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import {
  createBuildBrowserInstructions,
  type BrowserInstructionsInput,
} from './build-browser-instructions.js';

const context: ActionContext = {
  sessionId: 's1',
  sourceType: 'web',
  traceId: 't1',
};

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    deviceState: createEmptyDeviceState(),
    ...overrides,
  };
}

function baseInput(overrides: Partial<BrowserInstructionsInput> = {}): BrowserInstructionsInput {
  return {
    session: session(),
    context,
    isFirstIteration: true,
    turnToolCalls: [],
    ...overrides,
  };
}

const settings = {
  promptPresetId: 'gentle',
  savedPromptPresets: [],
  maxStrengthA: 50,
  maxStrengthB: 50,
  maxOpossumIntensityA: 40,
  maxOpossumIntensityB: 40,
};

describe('createBuildBrowserInstructions', () => {
  it('omits every device capability, mapping, and status block when nothing is connected', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        opossumState: createEmptyOpossumState(),
        pawPrintsState: createEmptySensorState(),
        civetEdgingState: createEmptySensorState(),
      }),
    );

    expect(instructions).not.toContain('[设备]');
    expect(instructions).not.toContain('[剧情与设备的映射]');
    expect(instructions).not.toContain('[当前设备状态]');
    expect(instructions).not.toContain('郊狼');
    expect(instructions).not.toContain('负鼠');
    expect(instructions).not.toContain('爪印');
    expect(instructions).not.toContain('灵猫');
    expect(instructions).not.toContain('shock_start');
  });

  it('Coyote-only: mentions only the connected Coyote', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        session: session({
          deviceState: { ...createEmptyDeviceState(), connected: true },
        }),
      }),
    );

    expect(instructions).toContain('郊狼（Coyote）');
    expect(instructions).toContain('shock_start');
    expect(instructions).not.toContain('负鼠');
    expect(instructions).not.toContain('爪印');
    expect(instructions).not.toContain('灵猫');
  });

  it('lists same-name Coyote instances separately by opaque targetId and independent state', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        coyoteTargets: [
          {
            targetId: 'opaque/one',
            state: {
              ...createEmptyDeviceState(),
              connected: true,
              deviceName: '相同名称',
              strengthA: 7,
            },
          },
          {
            targetId: 'opaque/two',
            state: {
              ...createEmptyDeviceState(),
              connected: true,
              deviceName: '相同名称',
              strengthA: 19,
            },
          },
        ],
      }),
    );

    expect(instructions).toContain('targetId="opaque/one"');
    expect(instructions).toContain('targetId="opaque/two"');
    expect(instructions).toContain('强度 7 / 上限 50');
    expect(instructions).toContain('强度 19 / 上限 50');
    expect(instructions).toContain('同名设备也是独立实例');
  });

  it('Coyote + Opossum: mentions Opossum mapping and status, still no sensors', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        session: session({
          deviceState: { ...createEmptyDeviceState(), connected: true },
        }),
        opossumState: {
          ...createEmptyOpossumState(),
          connected: true,
          intensityA: 12,
          intensityB: 0,
        },
      }),
    );

    expect(instructions).toContain('负鼠（Opossum）');
    expect(instructions).toContain('vibrate_start');
    expect(instructions).toContain('vibrate_adjust');
    expect(instructions).toContain('vibrate_stop');
    // Status block reports the configured user cap, not a hardcoded number.
    expect(instructions).toContain('强度 12 / 上限 40');
    // No pattern in the fixture state — reported as 自定义 rather than guessed.
    expect(instructions).toContain('节奏 自定义');
    expect(instructions).not.toContain('爪印');
    expect(instructions).not.toContain('灵猫');
  });

  it('mentions connected device kinds and omits a configured-but-disconnected sensor', () => {
    const build = createBuildBrowserInstructions(settings);
    const metadata = withSensorLastReading(undefined, 'paw-prints', {
      summary: '按钮触发（事件1）',
      firedAt: Date.parse('2026-07-19T00:00:00Z'),
    });

    const instructions = build(
      baseInput({
        session: session({
          metadata,
          deviceState: { ...createEmptyDeviceState(), connected: true },
        }),
        opossumState: { ...createEmptyOpossumState(), connected: true },
        pawPrintsState: { ...createEmptySensorState(), connected: true, deviceName: '47L120001' },
        civetEdgingState: { ...createEmptySensorState(), connected: false },
      }),
    );

    expect(instructions).toContain('负鼠（Opossum）');
    expect(instructions).toContain('爪印（按键 / 姿态传感器）');
    expect(instructions).not.toContain('灵猫（压力传感器）');
    expect(instructions).toContain('按钮触发（事件1）');
    expect(instructions).toContain('内部提醒');
    expect(instructions).not.toContain('灵猫：');
    expect(instructions).not.toContain('未连接');
  });

  it('removes a previously connected auxiliary device from the next instruction build', () => {
    const build = createBuildBrowserInstructions(settings);
    const connected = build(
      baseInput({
        opossumState: { ...createEmptyOpossumState(), connected: true },
      }),
    );
    const disconnected = build(
      baseInput({
        opossumState: { ...createEmptyOpossumState(), connected: false },
      }),
    );

    expect(connected).toContain('负鼠（Opossum）');
    expect(connected).toContain('vibrate_start');
    expect(disconnected).not.toContain('负鼠');
    expect(disconnected).not.toContain('vibrate_start');
    expect(disconnected).not.toContain('[当前设备状态]');
  });

  it('a sensor with no recorded reading yet reports 暂无', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        pawPrintsState: { ...createEmptySensorState(), connected: true },
      }),
    );

    expect(instructions).toContain('最近读数：暂无');
    expect(instructions).toContain('连接的传感器（爪印）');
    expect(instructions).not.toContain('灵猫');
    expect(instructions).not.toContain('郊狼');
    expect(instructions).not.toContain('负鼠');
    expect(instructions).toContain('不要声称执行了任何输出动作');
  });

  it('shows the named opossum pattern per channel with a Chinese label', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        opossumState: {
          ...createEmptyOpossumState(),
          connected: true,
          intensityA: 30,
          patternA: 'heartbeat',
          patternB: 'constant',
        },
      }),
    );

    expect(instructions).toContain('强度 30 / 上限 40，节奏 心跳');
    expect(instructions).toContain('节奏 恒定');
  });

  it('includes a 近段汇总 line under 最近读数 when a rolling summary is provided', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        pawPrintsState: { ...createEmptySensorState(), connected: true },
        civetEdgingState: { ...createEmptySensorState(), connected: true },
        pawPrintsSummary: '60s 内触发 3 次，最近事件5',
        civetSummary: '当前 12.0kPa，30s 内 10.0~14.0kPa，趋势上升',
      }),
    );

    expect(instructions).toContain('近段汇总：60s 内触发 3 次，最近事件5');
    expect(instructions).toContain('近段汇总：当前 12.0kPa，30s 内 10.0~14.0kPa，趋势上升');
  });

  it('omits the 近段汇总 line entirely when no summary is provided yet', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        pawPrintsState: { ...createEmptySensorState(), connected: true },
      }),
    );

    expect(instructions).not.toContain('近段汇总');
  });
});
