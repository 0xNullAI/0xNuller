import { describe, expect, it, vi } from 'vitest';
import type { DeviceClient, DeviceCommand, DeviceState } from '@dg-kit/core';
import { DGLabDevice } from './device-session';

/**
 * Chat's device writes must all go through `DeviceCommandQueue`.
 *
 * Before the merge this was the only place in the repo that bypassed the queue
 * and wrote to `client.execute()` directly, and the queue's emergency-stop
 * jump-the-queue is implemented by voiding in-flight commands via a generation
 * counter — bypassing the queue means bypassing that mechanism. What it looks
 * like in practice: you hit emergency stop, the device stops, and then the next
 * strength command already on its way runs anyway and the device starts moving
 * again.
 *
 * These tests guard exactly that ordering, not a formality like "was the queue
 * called".
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

/**
 * A fake device with controllable release: execute hangs until the test lets it
 * through, so we can manufacture "in-flight commands".
 */
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
     * Release repeatedly until no new gate shows up any more.
     *
     * Releasing only "the gates that exist right now" is not enough: the queue
     * is serial, so the second command only reaches execute and pushes its own
     * gate once the first one has finished. A one-shot release leaves the
     * second command stuck forever, and then the assertions hold whether or not
     * the generation-voiding mechanism is there at all — the test goes green
     * for no reason at all.
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

describe('共享设备会话的命令队列', () => {
  it('急停会作废已经排在路上的指令', async () => {
    const gated = makeGatedClient();
    const device = new DGLabDevice(() => gated.client);

    // Queue two: the first starts executing immediately and blocks on its gate,
    // the second waits in the queue.
    device.setStrength('A', 10);
    device.setStrength('A', 20);
    await Promise.resolve();

    device.stopAll();
    await Promise.resolve();

    await gated.drain();

    // The key assertion: after the emergency stop, the strength command still
    // sitting unrun in the queue must be discarded. If it does run, what the
    // user sees is "it stopped and then started moving on its own again".
    expect(gated.executed.filter((c) => c.type === 'adjustStrength')).toHaveLength(1);

    // How many times it stopped doesn't matter; "it ends up stopped" is what
    // matters. The one already inside execute() can't be recalled (the
    // generation check happens before execute, and the emergency stop runs
    // concurrently), so the queue issues one more stop after it lands — hence
    // ≥1 here rather than ==1.
    expect(gated.stopped).toBeGreaterThanOrEqual(1);
  });

  it('急停不排队等待，立即执行', async () => {
    const gated = makeGatedClient();
    const device = new DGLabDevice(() => gated.client);

    device.setStrength('A', 10); // blocked, never released
    await Promise.resolve();
    device.stopAll();
    await new Promise((r) => setTimeout(r, 0));

    // The earlier command is still blocked, but the emergency stop has already
    // landed — it must not wait for the command ahead of it to finish.
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

    // Writing the BF packet to the device changes persistent device-side state:
    // the same Coyote has a cap of 50 after Chat has connected to it and some
    // other value after something else has — whoever connected last wins, and a
    // cap the user raised elsewhere gets silently pushed back down.
    expect(setLimits).not.toHaveBeenCalled();
    expect(device.getState().limitA).toBe(30);
  });

  it('强度取「设备上报上限」与「本地上限」的较小者', async () => {
    const gated = makeGatedClient();
    const device = new DGLabDevice(() => gated.client);
    device.setLimit('A', 30);
    device.setStrength('A', 100);

    // There are microtasks between enqueue and execute, so it has to reach the
    // gate before we release; otherwise the gate hasn't been pushed yet when
    // releaseAll runs and nothing happens at all.
    await gated.drain();

    const cmd = gated.executed.find((c) => c.type === 'adjustStrength');
    // The hardware is no longer written, so the software side is the only gate
    // the user controls.
    expect(cmd).toMatchObject({ type: 'adjustStrength', delta: 30 });
  });
});
