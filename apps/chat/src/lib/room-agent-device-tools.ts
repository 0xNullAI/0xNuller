import type { LlmTool, LlmToolCall } from './llm-client.js';
import type { CmdAction, DeviceCommand } from './protocol.js';

/** One exact physical Coyote exposed to the room AI for the current live snapshot. */
export interface AgentDeviceTarget {
  targetId: string;
  peerId: string;
  deviceId: string;
  name: string;
}

type SendCommandAs = (
  roleId: string,
  target: string,
  action: CmdAction,
  params?: Omit<DeviceCommand, 'action'>,
) => void;

function identityPart(value: string): string {
  return encodeURIComponent(value);
}

export function roomAgentDeviceTargetId(peerId: string, deviceId: string): string {
  return `chat-coyote/${identityPart(peerId)}/${identityPart(deviceId)}`;
}

export function buildRoomAgentDeviceTools(targets: readonly AgentDeviceTarget[]): LlmTool[] {
  if (targets.length === 0) return [];
  const targetEnum = targets.map(({ targetId }) => targetId);
  const targetDesc = targets.map(({ targetId, name }) => `${targetId}=${name}`).join('，');
  return [
    {
      type: 'function',
      function: {
        name: 'adjust_strength',
        description: `调整一个精确物理设备某通道的强度（带符号增量，正=增强/负=减弱，设备端会重新校验授权、连接、租约与安全上限）。目标：${targetDesc}`,
        parameters: {
          type: 'object',
          properties: {
            targetId: { type: 'string', enum: targetEnum, description: '当前快照中的目标 ID' },
            channel: { type: 'string', enum: ['A', 'B'], description: '通道' },
            delta: { type: 'number', description: '强度增量，建议绝对值不超过 20' },
          },
          required: ['targetId', 'channel', 'delta'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'stop',
        description: `停止一个精确物理设备的全部输出。目标：${targetDesc}`,
        parameters: {
          type: 'object',
          properties: {
            targetId: { type: 'string', enum: targetEnum, description: '当前快照中的目标 ID' },
          },
          required: ['targetId'],
          additionalProperties: false,
        },
      },
    },
  ];
}

/**
 * Resolve again against the latest live target list immediately before sending.
 * Display names and device kinds are never identities, and an unknown ID never
 * falls back to a primary device or fans out.
 */
export function applyRoomAgentDeviceTool(
  roleId: string,
  call: LlmToolCall,
  liveTargets: readonly AgentDeviceTarget[],
  sendCommandAs: SendCommandAs,
): string {
  const expectedFields =
    call.name === 'adjust_strength' ? ['targetId', 'channel', 'delta'] : ['targetId'];
  if (!hasExactFields(call.arguments, expectedFields))
    return '错误：设备工具参数不完整或包含未知字段';
  const targetId = String(call.arguments.targetId ?? '');
  const target = liveTargets.find((candidate) => candidate.targetId === targetId);
  if (!target) return `错误：目标 ${targetId} 已断开、未授权或身份已失效`;

  if (call.name === 'adjust_strength') {
    if (call.arguments.channel !== 'A' && call.arguments.channel !== 'B') {
      return '错误：设备通道无效';
    }
    const requestedDelta = Number(call.arguments.delta);
    if (!Number.isFinite(requestedDelta)) return '错误：设备强度增量无效';
    const channel = call.arguments.channel;
    const delta = Math.max(-50, Math.min(50, requestedDelta));
    sendCommandAs(roleId, target.peerId, 'adjust_strength', {
      kind: 'coyote',
      deviceId: target.deviceId,
      c: channel,
      v: delta,
    });
    return `已向 ${targetId} 通道${channel} 发出调整请求 ${delta > 0 ? '+' : ''}${delta}；实际生效值由设备所有者重新校验，不要断言具体数值。`;
  }
  if (call.name === 'stop') {
    sendCommandAs(roleId, target.peerId, 'stop', {
      kind: 'coyote',
      deviceId: target.deviceId,
    });
    return `已向 ${targetId} 发出停止全部输出请求`;
  }
  return `未知工具：${call.name}`;
}

function hasExactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

export interface ConnectedCoyoteIdentity {
  id: string;
  connected: boolean;
}

/** Owner-side final identity/authorization check for every room-AI command. */
export function resolveRoomAiCoyoteTarget<T extends ConnectedCoyoteIdentity>(
  allowAi: boolean,
  command: DeviceCommand,
  coyotes: readonly T[],
): T | null {
  if (!allowAi || command.kind !== 'coyote' || !command.deviceId) return null;
  return coyotes.find(({ id, connected }) => connected && id === command.deviceId) ?? null;
}
