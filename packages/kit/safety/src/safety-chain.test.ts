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
 * 安全链的端到端。
 *
 * 真机验证不了的部分，这里尽可能补上：从策略引擎一路走到**传输层边界**——除了最后
 * 那段无线电，每一段都跑真的实现（真 PolicyEngine、真 DeviceCommandQueue、真租约），
 * 只有 `DeviceClient` 是假的。
 *
 * 换句话说，这些测试能证明「用户设了上限 30，AI 要求 100，最终落到传输层的是 30」，
 * 但证明不了「传输层真的把那个包发出去了」。后者只有真机能证。
 *
 * 每个模块单独的测试都只覆盖自己那一段，而这条链的失效恰恰发生在段与段之间。
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
      // 模拟设备侧状态推进，好让后续命令的相对计算有依据
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

/** 用户设的上限走到策略引擎，再走到队列——这就是模块里那条真实路径的形状。 */
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
    // 关键：落到传输层的是钳制**之后**的值。这条链断在任何一段，用户设的 30 都会
    // 失效，而失效的表现是电流直接到 100。
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
    // 卡住第一条，让第二条留在队列里
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

    // 反复放行到没有新的 gate——串行队列里第二条要等第一条跑完才进 execute。
    for (let i = 0; i < 10; i++) {
      while (gates.length) gates.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }

    // 排在队列里、还没开始执行的那条必须被丢弃。
    expect(landed.commands.filter((c) => c.type === 'adjustStrength')).toHaveLength(1);

    // **最终强度必须是 0。** 这才是用户关心的事，停了几次不重要。
    //
    // 已经在 execute() 里的那条撤不回来——generation 检查发生在 execute 之前，而急停
    // 是并发跑的，它的写入会落在急停之后。所以队列在这种情况下会补停一次，
    // stops 因此是 2 而不是 1。写死 stops===1 会把这个修复判成回归。
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

    // 模块在**每一条**指令前检查租约——远程指令不经过 UI，只禁用按钮没用。
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

    // 后台模块的设备也在人身上。只停当前模块等于让用户以为全停了。
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
    // 失败必须被报出来而不是吞掉——用户需要知道有一台没停下。
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
          // 一个模块可以同时持有四种设备。它的 stop 必须把每一种都归零——
          // 只停郊狼的话，负鼠还在振动，而用户已经按过停止了。
          stopped.push('coyote', 'opossum', 'paw-prints', 'civet-edging');
        },
        devices: () => [
          { id: 'c', kind: 'coyote', name: '郊狼', connected: true },
          { id: 'o', kind: 'opossum', name: '负鼠', connected: true },
          { id: 'p', kind: 'paw-prints', name: '爪印', connected: true },
          { id: 'v', kind: 'civet-edging', name: '灵狐', connected: true },
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
    // 两台设备的 id 都是 'c'——设备栏用 `sessionId:deviceId` 做 key，只用 deviceId
    // 会让 React 把两台设备当成同一个，第二台根本不显示。
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.sessionId).sort()).toEqual(['agent', 'chat']);
    expect(groups.flatMap((g) => g.devices.map((d) => d.name)).sort()).toEqual([
      '我的郊狼',
      '搭档的郊狼',
    ]);
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

    // 一个模块状态读取出错不该让设备栏整个消失——那会连带藏掉旁边的停止按钮。
    const groups = allConnectedDevices();
    expect(groups.map((g) => g.sessionId)).toEqual(['chat']);
  });
});
