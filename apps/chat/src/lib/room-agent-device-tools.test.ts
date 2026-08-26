import { describe, expect, it, vi } from 'vitest';
import type { LlmToolCall } from './llm-client.js';
import {
  applyRoomAgentDeviceTool,
  buildRoomAgentDeviceTools,
  resolveRoomAiCoyoteTarget,
  roomAgentDeviceTargetId,
  type AgentDeviceTarget,
} from './room-agent-device-tools.js';

const targets: AgentDeviceTarget[] = [
  {
    targetId: roomAgentDeviceTargetId('peer-a', 'opaque-1'),
    peerId: 'peer-a',
    deviceId: 'opaque-1',
    name: 'Alice · 同名设备',
  },
  {
    targetId: roomAgentDeviceTargetId('peer-a', 'opaque-2'),
    peerId: 'peer-a',
    deviceId: 'opaque-2',
    name: 'Alice · 同名设备',
  },
];

function call(name: string, targetId: string): LlmToolCall {
  return {
    id: `call-${name}`,
    name,
    arguments: { targetId, channel: 'B', delta: 7 },
  };
}

describe('room agent physical device tools', () => {
  it('keeps same-name physical instances as separate opaque enum targets', () => {
    const tools = buildRoomAgentDeviceTools(targets);
    const adjust = tools.find(({ function: definition }) => definition.name === 'adjust_strength')!;
    const schema = adjust.function.parameters as {
      properties: { targetId: { enum: string[] } };
      required: string[];
      additionalProperties: boolean;
    };

    expect(schema.properties.targetId.enum).toEqual(targets.map(({ targetId }) => targetId));
    expect(new Set(schema.properties.targetId.enum).size).toBe(2);
    expect(schema.required).toContain('targetId');
    expect(schema.additionalProperties).toBe(false);
  });

  it('routes one exact physical identity and never fans out to its same-name sibling', () => {
    const send = vi.fn();
    applyRoomAgentDeviceTool(
      'room-agent',
      call('adjust_strength', targets[1]!.targetId),
      targets,
      send,
    );

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('room-agent', 'peer-a', 'adjust_strength', {
      kind: 'coyote',
      deviceId: 'opaque-2',
      c: 'B',
      v: 7,
    });
  });

  it('revalidates the latest allowlist and does not fall back after disconnect', () => {
    const send = vi.fn();
    const result = applyRoomAgentDeviceTool(
      'room-agent',
      call('adjust_strength', targets[1]!.targetId),
      [targets[0]!],
      send,
    );

    expect(result).toContain('已断开、未授权或身份已失效');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects incomplete or expanded arguments instead of defaulting a target channel', () => {
    const send = vi.fn();
    const malformed = call('adjust_strength', targets[0]!.targetId);
    delete malformed.arguments.channel;
    expect(applyRoomAgentDeviceTool('room-agent', malformed, targets, send)).toContain(
      '参数不完整',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('owner-side resolution requires consent, exact kind/id and a live connection', () => {
    const coyotes = [
      { id: 'opaque-1', connected: true },
      { id: 'opaque-2', connected: false },
    ];
    const command = {
      action: 'adjust_strength',
      kind: 'coyote',
      deviceId: 'opaque-1',
      c: 'A',
      v: 5,
    } as const;

    expect(resolveRoomAiCoyoteTarget(true, command, coyotes)).toBe(coyotes[0]);
    expect(resolveRoomAiCoyoteTarget(false, command, coyotes)).toBeNull();
    expect(
      resolveRoomAiCoyoteTarget(true, { ...command, deviceId: 'opaque-2' }, coyotes),
    ).toBeNull();
    expect(
      resolveRoomAiCoyoteTarget(true, { ...command, deviceId: 'missing' }, coyotes),
    ).toBeNull();
    expect(resolveRoomAiCoyoteTarget(true, { ...command, kind: undefined }, coyotes)).toBeNull();
  });
});
