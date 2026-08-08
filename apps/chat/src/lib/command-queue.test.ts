import { describe, expect, it, vi } from 'vitest';
import type { DeviceClient, DeviceCommand, DeviceState } from '@dg-kit/core';
import { DGLabDevice } from './bluetooth';

/**
 * Chat 的设备写入必须经过 `DeviceCommandQueue`。
 *
 * 合并前它是全仓唯一绕开队列直写 `client.execute()` 的地方，而队列的急停插队是靠
 * generation 计数作废在途命令实现的——绕开队列就等于绕开了这个机制。表现是：按下
 * 急停、设备停住，然后排在路上的下一条强度指令照样执行，设备又动起来。
 *
 * 这些测试守的正是那条时序，不是「有没有调用队列」这种形式检查。
 */

function makeState(over: Partial<DeviceState> = {}): DeviceState {
  return {
    connected: true,
    strengthA: 0,
    strengthB: 0,
    limitA: 200,
    limitB: 200,
    waveActiveA: false,
    waveActiveB: false,
    ...over,
  } as DeviceState;
}

/** 可控放行的假设备：execute 挂起直到测试放行，好制造「在途命令」。 */
function makeGatedClient() {
  const executed: DeviceCommand[] = [];
  const gates: (() => void)[] = [];
  let stopped = 0;

  const client: DeviceClient = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    getState: async () => makeState(),
    execute: async (command) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      executed.push(command);
      return { state: makeState(), notes: [] };
    },
    emergencyStop: async () => {
      stopped += 1;
    },
    onStateChanged: () => () => undefined,
  };

  return {
    client,
    executed,
    /**
     * 反复放行直到不再有新的 gate 冒出来。
     *
     * 只放行「当下已存在的 gate」是不够的：队列是串行的，第二条命令要等第一条跑完
     * 才会进入 execute 并压入自己的 gate。一次性放行会让第二条永远卡住，于是无论
     * generation 作废机制在不在，断言都成立——测试绿得毫无意义。
     */
    drain: async () => {
      for (let i = 0; i < 20; i++) {
        while (gates.length) gates.shift()!();
        await new Promise((r) => setTimeout(r, 0));
        if (gates.length === 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (gates.length === 0) return;
        }
      }
    },
    get stopped() {
      return stopped;
    },
  };
}

describe('Chat 的设备命令队列', () => {
  it('急停会作废已经排在路上的指令', async () => {
    const gated = makeGatedClient();
    const device = new DGLabDevice(() => gated.client);

    // 排两条：第一条立刻开始执行并卡在 gate 上，第二条在队列里等。
    device.setStrength('A', 10);
    device.setStrength('A', 20);
    await Promise.resolve();

    device.stopAll();
    await Promise.resolve();

    await gated.drain();

    expect(gated.stopped).toBe(1);
    // 关键断言：急停之后，队列里那条还没跑的强度指令必须被丢弃。
    // 它要是执行了，用户看到的就是「停住了又自己动起来」。
    expect(gated.executed.filter((c) => c.type === 'adjustStrength')).toHaveLength(1);
  });

  it('急停不排队等待，立即执行', async () => {
    const gated = makeGatedClient();
    const device = new DGLabDevice(() => gated.client);

    device.setStrength('A', 10); // 卡住不放行
    await Promise.resolve();
    device.stopAll();
    await new Promise((r) => setTimeout(r, 0));

    // 前面那条还卡着，但急停已经落地——它不能等前面的命令跑完。
    expect(gated.stopped).toBe(1);
    expect(gated.executed).toHaveLength(0);
  });

  it('调整上限不写设备，只改软件侧', () => {
    const gated = makeGatedClient();
    const device = new DGLabDevice(() => gated.client);
    const protocol = (
      device as unknown as { protocol: { setLimits: (a: number, b: number) => void } }
    ).protocol;
    const setLimits = vi.spyOn(protocol, 'setLimits');

    device.setLimit('A', 30);

    // 往设备写 BF 包会改变持久的设备侧状态：同一台郊狼被 Chat 连过之后上限就是 50、
    // 被别处连过之后是别的值——谁最后连谁说了算，用户在别处调高的上限被静默压回。
    expect(setLimits).not.toHaveBeenCalled();
    expect(device.getState().limitA).toBe(30);
  });

  it('强度取「设备上报上限」与「本地上限」的较小者', async () => {
    const gated = makeGatedClient();
    const device = new DGLabDevice(() => gated.client);
    device.setLimit('A', 30);
    device.setStrength('A', 100);

    // enqueue 到 execute 之间隔着微任务，必须先让它跑到 gate 上再放行，
    // 否则 releaseAll 时 gate 还没被压进去，什么都不会发生。
    await gated.drain();

    const cmd = gated.executed.find((c) => c.type === 'adjustStrength');
    // 不再写硬件，软件这一侧是唯一由用户控制的闸门。
    expect(cmd).toMatchObject({ type: 'adjustStrength', delta: 30 });
  });
});
