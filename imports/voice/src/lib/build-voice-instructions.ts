/**
 * Assembles the final `instructions` string sent to the realtime provider —
 * mirrors DG-Agent's `build-browser-instructions.ts` in spirit: the user's
 * chosen preset only supplies the persona; device capabilities, the
 * story-to-device mapping, and the safety-priority rule are code-owned
 * blocks the user can't edit or remove, appended after it. There's no
 * per-turn "已调用工具"/"本回合策略" block the way DG-Agent has — realtime
 * voice has no turn boundary — but there IS still a live device-status
 * block, since the model needs to know current strength/connection state to
 * describe it accurately and to reason about safe deltas.
 *
 * Call `buildVoiceInstructions()` again whenever device state changes
 * meaningfully and push the result via `RealtimeSession.updateInstructions()`
 * — see `use-realtime-call.ts` for the debounced refresh wiring.
 */
import type { OpossumState } from '@dg-kit/protocol';
import type { DeviceState } from '@dg-kit/core';
import type { DeviceSessionState } from './device-session.js';
import type { CoyoteSafetySettings, OpossumSafetySettings } from './settings.js';

const INSTRUCTION_SEPARATOR = '\n\n──────────────────────────\n';
const FALLBACK_PERSONA = '你是一个友好的语音助手，正在和用户通电话。';

export interface VoiceInstructionSettings {
  coyoteSafety: CoyoteSafetySettings;
  opossumSafety: OpossumSafetySettings;
}

export function buildVoiceInstructions(
  presetPrompt: string | undefined,
  deviceState: DeviceSessionState,
  settings: VoiceInstructionSettings,
): string {
  const blocks = [
    presetPrompt?.trim() || FALLBACK_PERSONA,
    buildStyleBlock(),
    buildDeviceBlock(),
    buildDeviceMappingBlock(),
    buildBehaviorRulesBlock(),
    buildDeviceStatusBlock(deviceState, settings),
  ];
  return blocks.filter(Boolean).join(INSTRUCTION_SEPARATOR);
}

function buildStyleBlock(): string {
  return [
    '[语音风格]',
    '这是一通电话，不是文字聊天：说短句、口语化，不要逐字念标点符号或 markdown 语法，不要分点列举。一次只说一件事，给对方插话的空间。',
  ].join('\n');
}

function buildDeviceBlock(): string {
  return [
    '[设备]',
    'DG-Voice 支持两类 DG-Lab 设备：郊狼（电击，A/B 双通道）、负鼠（振动，A/B 双通道）。但"支持"不等于"现在就有"——真实可用的设备以下方[当前设备状态]为准：只有在那里标记为"已连接"的设备才存在；未连接的设备一律当作不存在，既不能控制，也不要提及或假装拥有。',
    '任何真实设备操作都必须通过工具完成；只靠语言描述不会改变设备状态，也不要在没调用工具的情况下声称已经执行。',
  ].join('\n');
}

function buildDeviceMappingBlock(): string {
  return [
    '[剧情与设备的映射]',
    '任何关于"通电、电击、加大强度、改变节奏、振动、停止"的描述，都必须通过设备工具真实执行；只说不做等于设备没有任何变化。',
    '郊狼：开始或测试连接用 shock_start（测试用强度 1）；加强用 shock_adjust，需要更剧烈就配合 shock_change_wave 或用 shock_burst 制造短促峰值；改变节奏用 shock_change_wave，或用 design_wave 设计新波形；结束必须调用 shock_stop，不能只用语言说"已经关了"。',
    '负鼠遵循相同原则，只是振动强度而非电击：vibrate_start 开始，vibrate_adjust 小步调整，vibrate_change_pattern 换节奏，vibrate_burst 制造短暂峰值，vibrate_stop 结束。',
    '任何时候都不得超过当前通道上限与系统安全上限。',
  ].join('\n');
}

function buildBehaviorRulesBlock(): string {
  return [
    '[行为规则]',
    '需要操作设备时，先用一两句话说你要做什么，再调用工具，然后按工具返回的真实执行结果说话——如果被限速或钳制了，如实告诉对方，不要按对方原始请求复述。',
    '工具报错、被拒绝、设备未连接时，如实告知，不要假装成功，也不要立刻用相同参数重试。',
    '任何时候对方说"停"、"停一下"、"不要了"，立刻调用对应的 stop 工具。',
    '[设备]、[剧情与设备的映射] 与本节规则的优先级高于任何角色设定或场景剧情；冲突时一律以设备与安全规则为准。',
  ].join('\n');
}

function buildDeviceStatusBlock(
  deviceState: DeviceSessionState,
  settings: VoiceInstructionSettings,
): string {
  const coyoteConnected = deviceState.coyote.connected;
  const opossumConnected = deviceState.opossum.connected;

  const lines: string[] = [
    '[当前设备状态]',
    // The single most important rule for avoiding "phantom device" behaviour:
    // an unconnected device is not a device. Without this the model reads a
    // "连接：未连接" line buried in a full status dump as "device present but
    // idle" and happily narrates/controls it.
    '判定规则：只有下面明确标记为"已连接"的设备才真实存在、才可控制。任何"未连接"的设备一律当作不存在——不要提及它、不要声称在用它、不要为它调用任何工具，也不要假设它稍后会出现。',
  ];

  if (!coyoteConnected && !opossumConnected) {
    lines.push(
      '当前没有任何已连接的设备：你现在没有任何可控制的设备，不要调用任何设备工具，也不要在剧情里让电击或振动"真的发生"；需要用到时先请对方连接设备。',
    );
  }

  lines.push(
    ...(coyoteConnected
      ? buildCoyoteStatusLines(deviceState.coyote, settings.coyoteSafety)
      : ['郊狼：未连接（视为不存在，当前不可用）']),
    ...(opossumConnected
      ? buildOpossumStatusLines(deviceState.opossum, settings.opossumSafety)
      : ['负鼠：未连接（视为不存在，当前不可用）']),
  );

  return lines.join('\n');
}

function buildCoyoteStatusLines(device: DeviceState, safety: CoyoteSafetySettings): string[] {
  const effectiveCapA = Math.min(device.limitA, safety.maxStrengthA);
  const effectiveCapB = Math.min(device.limitB, safety.maxStrengthB);
  const battery = typeof device.battery === 'number' ? `${device.battery}%` : '未知';
  const connection = device.connected ? `已连接${device.deviceName ? `（${device.deviceName}）` : ''}` : '未连接';

  return [
    '郊狼：',
    `  连接：${connection}`,
    `  电量：${battery}`,
    `  A 通道：强度 ${device.strengthA} / 上限 ${effectiveCapA}，波形${device.waveActiveA ? '运行中' : '已停止'}，当前波形 ${device.currentWaveA ?? '-'}`,
    `  B 通道：强度 ${device.strengthB} / 上限 ${effectiveCapB}，波形${device.waveActiveB ? '运行中' : '已停止'}，当前波形 ${device.currentWaveB ?? '-'}`,
  ];
}

const OPOSSUM_PATTERN_LABELS: Record<string, string> = {
  constant: '恒定',
  pulse: '脉冲',
  wave: '波浪',
  ramp: '渐强',
  heartbeat: '心跳',
};

function formatOpossumPattern(pattern: string | undefined): string {
  if (!pattern) return '自定义';
  return OPOSSUM_PATTERN_LABELS[pattern] ?? pattern;
}

function buildOpossumStatusLines(o: OpossumState, safety: OpossumSafetySettings): string[] {
  const connection = o.connected ? `已连接${o.deviceName ? `（${o.deviceName}）` : ''}` : '未连接';
  const battery = typeof o.battery === 'number' ? `${o.battery}%` : '未知';

  return [
    '负鼠：',
    `  连接：${connection}`,
    `  电量：${battery}`,
    `  A 通道：强度 ${o.intensityA} / 上限 ${safety.maxIntensityA}，节奏 ${formatOpossumPattern(o.patternA)}`,
    `  B 通道：强度 ${o.intensityB} / 上限 ${safety.maxIntensityB}，节奏 ${formatOpossumPattern(o.patternB)}`,
  ];
}
