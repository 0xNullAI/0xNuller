import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceClient, DeviceCommand, DeviceState } from '@dg-kit/core';
import { PolicyEngine } from './policy-engine.js';
import { createDefaultPolicyRules } from './default-policies.js';
import { DeviceCommandQueue } from './device-command-queue.js';
import {
  allConnectedDevices,
  grantDeviceLease,
  hasDeviceLease,
  registerSafetySession,
  stopAllSafetySessions,
} from './safety-bus.js';

/**
 * End-to-end tests for the safety chain.
 *
 * They cover as much as possible of what real hardware can't be used to
 * verify here: from the policy engine all the way to the *transport
 * boundary* — every segment runs the real implementation (real PolicyEngine,
 * real DeviceCommandQueue, real lease) except the radio itself; only
 * `DeviceClient` is fake.
 *
 * In other words, these tests can prove "user capped at 30, AI asked for
 * 100, what reached the transport was 30" — but not "the transport actually
 * sent that packet". Only a real device proves the latter.
 *
 * Each module's own tests cover only their own segment, and this chain
 * fails precisely at the seams between segments.
 */

interface Landed {
  commands: DeviceCommand[];
  stops: number;
}

function fakeDevice(): { client: DeviceClient; landed: Landed; state: DeviceState } {
  const state = {
    connected: true,
    strengthA: 0,
    strengthB: 0,
    limitA: 200,
    limitB: 200,
    waveActiveA: false,
    waveActiveB: false,
  } as DeviceState;
  const landed: Landed = { commands: [], stops: 0 };

  const client: DeviceClient = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getState: async () => state,
    execute: async (command) => {
      landed.commands.push(command);
      // Simulate device-side state advancing so later commands have a
      // baseline for relative math
      if (command.type === 'adjustStrength') {
        if (command.channel === 'A') state.strengthA += command.delta;
        else state.strengthB += command.delta;
      }
      return { state, notes: [] };
    },
    emergencyStop: async () => {
      landed.stops += 1;
      state.strengthA = 0;
      state.strengthB = 0;
    },
    onStateChanged: () => () => undefined,
  };
  return { client, landed, state };
}

/** User cap → policy engine → queue: the same shape as the real path inside a module. */
function makeChain(userCaps: { maxStrengthA: number; maxAdjustStep?: number }) {
  const { client, landed, state } = fakeDevice();
  const engine = new PolicyEngine(createDefaultPolicyRules(userCaps));
  const queue = new DeviceCommandQueue(client);

  async function send(command: DeviceCommand, source = 'peer') {
    const decision = engine.evaluate({
      context: { sourceType: 'remote', sourceUserId: source } as never,
      command,
      deviceState: state,
    });
    if (decision.type === 'deny') return { blocked: true as const, reason: decision.reason };
    const final = decision.type === 'clamp' ? decision.command : command;
    await queue.enqueue(final);
    return { blocked: false as const };
  }

  return { send, queue, landed, state };
}

const cleanups: (() => void)[] = [];
beforeEach(async () => {
  while (cleanups.length) cleanups.pop()!();
  await grantDeviceLease(null);
});

describe('安全链端到端（策略 → 队列 → 传输层边界）', () => {
  it('超过用户上限的指令被钳制后才落到传输层', async () => {
    const chain = makeChain({ maxStrengthA: 30, maxAdjustStep: 100 });

    await chain.send({ type: 'adjustStrength', channel: 'A', delta: 100 });

    const landed = chain.landed.commands.find((c) => c.type === 'adjustStrength');
    // The point: what reaches the transport is the *post-clamp* value. If
    // this chain breaks at any segment, the user's 30 stops mattering — and
    // the symptom is current going straight to 100.
    expect(landed).toBeDefined();
    expect(chain.state.strengthA).toBeLessThanOrEqual(30);
  });

  it('单次调节步长上限同样在到达传输层之前生效', async () => {
    const chain = makeChain({ maxStrengthA: 200, maxAdjustStep: 5 });
    await chain.send({ type: 'adjustStrength', channel: 'A', delta: 80 });
    expect(chain.state.strengthA).toBeLessThanOrEqual(5);
  });

  it('急停会作废已经排在队列里、还没到传输层的指令', async () => {
    const { client, landed, state } = fakeDevice();
    // Stall the first command so the second stays queued
    const gates: (() => void)[] = [];
    const original = client.execute;
    client.execute = async (c) => {
      await new Promise<void>((r) => gates.push(r));
      return original(c);
    };
    const queue = new DeviceCommandQueue(client);

    void queue.enqueue({ type: 'adjustStrength', channel: 'A', delta: 10 });
    void queue.enqueue({ type: 'adjustStrength', channel: 'A', delta: 20 });
    await Promise.resolve();
    void queue.enqueue({ type: 'emergencyStop' });

    // Keep releasing gates until none appear — in a serial queue the second
    // command only enters execute after the first finishes.
    for (let i = 0; i < 10; i++) {
      while (gates.length) gates.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }

    // The command still queued and not yet executing must be dropped.
    expect(landed.commands.filter((c) => c.type === 'adjustStrength')).toHaveLength(1);

    // Final strength MUST be 0. That is what the user cares about; how many
    // stops it took does not matter.
    //
    // The command already inside execute() cannot be recalled — the
    // generation check runs before execute while the stop runs concurrently,
    // so its write lands after the stop. The queue therefore issues a
    // follow-up stop, making stops 2 rather than 1. Hard-coding stops===1
    // would flag that fix as a regression.
    expect(landed.stops).toBeGreaterThanOrEqual(1);
    expect(state.strengthA).toBe(0);
  });

  it('失去控制权后，模块不再向传输层发指令', async () => {
    const chain = makeChain({ maxStrengthA: 50 });
    let allowed = true;
    const stop = vi.fn();

    cleanups.push(
      registerSafetySession({
        id: 'chat',
        label: 'chat',
        isActive: () => true,
        stop,
        onRevoke: () => {
          allowed = false;
          stop();
        },
      }),
    );
    await grantDeviceLease('chat');

    // The module checks the lease before *every* command — remote commands
    // never pass through the UI, so disabling buttons is not enough.
    const guardedSend = async (c: DeviceCommand) => {
      if (!allowed || !hasDeviceLease('chat')) return;
      await chain.send(c);
    };

    await guardedSend({ type: 'adjustStrength', channel: 'A', delta: 10 });
    const before = chain.landed.commands.length;
    expect(before).toBeGreaterThan(0);

    await grantDeviceLease('agent');

    await guardedSend({ type: 'adjustStrength', channel: 'A', delta: 10 });
    expect(chain.landed.commands).toHaveLength(before);
    expect(stop).toHaveBeenCalled();
  });

  it('全局停止停的是每一个已注册模块，与谁持有租约无关', async () => {
    const a = vi.fn();
    const b = vi.fn();
    cleanups.push(
      registerSafetySession({ id: 'agent', label: 'agent', isActive: () => true, stop: a }),
    );
    cleanups.push(
      registerSafetySession({ id: 'chat', label: 'chat', isActive: () => true, stop: b }),
    );
    await grantDeviceLease('agent');

    const result = await stopAllSafetySessions();

    // Background modules' devices are on the user's body too. Stopping only
    // the current module makes the user believe everything stopped.
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(result.attempted).toBe(2);
    expect(result.failed).toHaveLength(0);
  });

  it('一个模块停止失败不影响其余模块，并被如实报告', async () => {
    const good = vi.fn();
    cleanups.push(
      registerSafetySession({
        id: 'agent',
        label: 'agent',
        isActive: () => true,
        stop: () => {
          throw new Error('BLE 已断开');
        },
      }),
    );
    cleanups.push(
      registerSafetySession({ id: 'chat', label: 'chat', isActive: () => true, stop: good }),
    );

    const result = await stopAllSafetySessions();

    expect(good).toHaveBeenCalled();
    // Failures must be reported, not swallowed — the user needs to know one
    // device did not stop.
    expect(result.failed.map((f) => f.id)).toEqual(['agent']);
  });
});

describe('多设备同时连接', () => {
  it('停止会覆盖每一种设备，不只是郊狼', async () => {
    const stopped: string[] = [];
    cleanups.push(
      registerSafetySession({
        id: 'agent',
        label: 'agent',
        isActive: () => true,
        stop: () => {
          // One module can hold all four device kinds at once. Its stop must
          // zero every one of them — stopping only the Coyote leaves the
          // Opossum vibrating after the user already pressed stop.
          stopped.push('coyote', 'opossum', 'paw-prints', 'civet-edging');
        },
        devices: () => [
          { id: 'c', kind: 'coyote', name: '郊狼', connected: true },
          { id: 'o', kind: 'opossum', name: '负鼠', connected: true },
          { id: 'p', kind: 'paw-prints', name: '爪印', connected: true },
          { id: 'v', kind: 'civet-edging', name: '灵猫', connected: true },
        ],
      }),
    );

    await stopAllSafetySessions();
    expect(stopped).toEqual(['coyote', 'opossum', 'paw-prints', 'civet-edging']);
  });

  it('两个模块各持一台郊狼时，设备清单不混淆来源', async () => {
    cleanups.push(
      registerSafetySession({
        id: 'agent',
        label: 'agent',
        isActive: () => true,
        stop: vi.fn(),
        devices: () => [{ id: 'c', kind: 'coyote', name: '我的郊狼', connected: true }],
      }),
    );
    cleanups.push(
      registerSafetySession({
        id: 'chat',
        label: 'chat',
        isActive: () => true,
        stop: vi.fn(),
        devices: () => [{ id: 'c', kind: 'coyote', name: '搭档的郊狼', connected: true }],
      }),
    );

    const groups = allConnectedDevices();
    // Both devices have id 'c' — the device bar keys rows by
    // `sessionId:deviceId`; keying by deviceId alone makes React treat the
    // two as one and the second never renders.
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.sessionId).sort()).toEqual(['agent', 'chat']);
    expect(groups.flatMap((g) => g.devices.map((d) => d.name)).sort()).toEqual([
      '我的郊狼',
      '搭档的郊狼',
    ]);
  });

  it('同一个模块挂两台郊狼时，两台都要出现在设备清单里', () => {
    cleanups.push(
      registerSafetySession({
        id: 'control',
        label: 'control',
        isActive: () => true,
        stop: vi.fn(),
        // Both entries are the same *kind*. Before device ids were made
        // per-device, every Coyote reported id 'coyote', so the two rows
        // collided on the device bar's `sessionId:deviceId` key and React
        // rendered only one of them — the user lost the only on-screen
        // confirmation that a second device was attached to their body.
        // The cross-module test above never caught this: there the sessionId
        // half of the key differs.
        devices: () => [
          { id: 'aa:bb:cc:dd:ee:01', kind: 'coyote', name: '郊狼一号', connected: true },
          { id: 'aa:bb:cc:dd:ee:02', kind: 'coyote', name: '郊狼二号', connected: true },
        ],
      }),
    );

    const groups = allConnectedDevices();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.devices).toHaveLength(2);
    // The keys the device bar builds must be distinct, or one row vanishes.
    const keys = groups.flatMap((g) => g.devices.map((d) => `${g.sessionId}:${d.id}`));
    expect(new Set(keys).size).toBe(2);
    expect(groups[0]?.devices.map((d) => d.name)).toEqual(['郊狼一号', '郊狼二号']);
  });

  it('同一个模块挂两台郊狼时，停止必须两台都归零', async () => {
    const zeroed: string[] = [];
    cleanups.push(
      registerSafetySession({
        id: 'control',
        label: 'control',
        isActive: () => true,
        // A module holding N Coyotes registers ONE stop on the bus, so that
        // stop is the only thing standing between the user and a device that
        // keeps running. Stopping just the primary would leave device #2
        // outputting after the user pressed the global stop — the worst
        // possible failure of this button.
        stop: () => {
          zeroed.push('aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02');
        },
        devices: () => [
          { id: 'aa:bb:cc:dd:ee:01', kind: 'coyote', name: '郊狼一号', connected: true },
          { id: 'aa:bb:cc:dd:ee:02', kind: 'coyote', name: '郊狼二号', connected: true },
        ],
      }),
    );

    await stopAllSafetySessions();
    expect(zeroed).toEqual(['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02']);
  });

  it('一个模块的设备读取抛错时，其余模块的设备照常列出', () => {
    cleanups.push(
      registerSafetySession({
        id: 'agent',
        label: 'agent',
        isActive: () => true,
        stop: vi.fn(),
        devices: () => {
          throw new Error('状态读取失败');
        },
      }),
    );
    cleanups.push(
      registerSafetySession({
        id: 'chat',
        label: 'chat',
        isActive: () => true,
        stop: vi.fn(),
        devices: () => [{ id: 'c', kind: 'coyote', name: '还在的', connected: true }],
      }),
    );

    // One module's broken state read must not blank the whole device bar —
    // that would also hide the stop button next to it.
    const groups = allConnectedDevices();
    expect(groups.map((g) => g.sessionId)).toEqual(['chat']);
  });
});
