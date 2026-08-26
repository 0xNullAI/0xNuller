import { describe, expect, it, vi } from 'vitest';
import type { LlmClient, LlmImageInput, ToolCall } from '@dg-agent/core';
import type { DeviceId, FeatureId } from '@0xnullai/device-runtime';
import {
  VideoAiDeviceRouter,
  type VideoAiAllowedTarget,
  type VideoAiDeviceAction,
} from './video-ai-device-router.js';

const FRAME: LlmImageInput = {
  mediaType: 'image/jpeg',
  data: 'frame',
  width: 1,
  height: 1,
  byteLength: 5,
};
const coyote = (id: string, capA = 30): VideoAiAllowedTarget => ({
  id: `coyote/${id}`,
  kind: 'coyote',
  targetId: id,
  label: id,
  modality: 'electrostimulation',
  battery: null,
  active: false,
  capA,
  capB: 40,
});
const embedded: VideoAiAllowedTarget = {
  id: 'embedded/device/motor',
  kind: 'embedded',
  deviceId: 'device' as DeviceId,
  featureId: 'motor' as FeatureId,
  label: 'motor',
  modality: 'vibration',
  battery: null,
  active: false,
  capA: 0.3,
  capB: 0.3,
};

function call(id: string, targetId: string, action = 'start', value = 5): ToolCall {
  return {
    id,
    name: 'video_device_control',
    args: { targetId, action, channel: 'A', value, durationMs: 100 },
  };
}

function harness(
  turns: ToolCall[][],
  targets: VideoAiAllowedTarget[] = [coyote('a'), coyote('b'), embedded],
  rejectAction?: (action: VideoAiDeviceAction) => boolean,
) {
  let live = [...targets];
  let lease = true;
  let now = 1_000;
  const invoked: VideoAiDeviceAction[] = [];
  const stopAll = vi.fn(async () => undefined);
  const llm: LlmClient = {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async () => ({ assistantMessage: 'ok', toolCalls: turns.shift() ?? [] })),
  };
  const router = new VideoAiDeviceRouter({
    getLlm: () => llm,
    getTargets: () => live,
    hasLease: () => lease,
    invoke: async (action) => {
      if (rejectAction?.(action)) throw new Error('stop failed');
      invoked.push(action);
    },
    stopAll,
    now: () => now,
  });
  return {
    router,
    llm,
    invoked,
    stopAll,
    targets,
    setLive: (next: VideoAiAllowedTarget[]) => (live = next),
    setLease: (next: boolean) => (lease = next),
    setNow: (next: number) => (now = next),
  };
}

async function authorize(h: ReturnType<typeof harness>, durationMs = 60_000) {
  return h.router.authorize({
    targets: h.targets,
    allowEnhanced: true,
    allowBurst: true,
    durationMs,
    cadenceMs: 5_000,
    captureIntervalMs: 1_000,
  });
}

describe('VideoAiDeviceRouter', () => {
  it('includes the selected scene and built-in continuous-observation contract', async () => {
    const h = harness([[]]);
    h.router.updateInputs(h.llm, h.targets, {
      name: '雾境测试',
      prompt: '根据最新画面推进原创幻想场景。',
    });
    await authorize(h);
    await h.router.observe(FRAME);

    const input = vi.mocked(h.llm.runTurn).mock.calls[0]?.[0];
    expect(input?.instructions).toContain('当前选定场景「雾境测试」');
    expect(input?.instructions).toContain('根据最新画面推进原创幻想场景');
    expect(input?.instructions).toContain('不等待用户逐轮下令');
    expect(input?.instructions).toContain('工具请求不代表成功');
  });

  it('lets the model choose an exact target on every call and stops the old route before switching', async () => {
    const h = harness([[call('a', 'coyote/a')], [call('b', 'coyote/b')]]);
    await authorize(h);
    await h.router.observe(FRAME);
    await h.router.observe(FRAME);
    expect(h.invoked.map(({ id, target }) => [id, target.id])).toEqual([
      ['a', 'coyote/a'],
      ['b-switch-stop', 'coyote/a'],
      ['b', 'coyote/b'],
    ]);
  });

  it('rejects targets outside the authorization snapshot and enforces modality caps', async () => {
    const h = harness([
      [call('bad-id', 'coyote/not-allowed')],
      [call('too-strong', embedded.id, 'start', 0.31)],
    ]);
    await authorize(h);
    await expect(h.router.observe(FRAME)).rejects.toThrow('未授权 targetId');
    await expect(h.router.observe(FRAME)).rejects.toThrow('超过授权上限');
    expect(h.invoked).toHaveLength(0);
  });

  it('revokes and globally stops when a target identity disappears', async () => {
    const h = harness([[]]);
    await authorize(h);
    h.setLive([h.targets[0]!]);
    await expect(h.router.observe(FRAME)).rejects.toThrow('身份已变化或断开');
    expect(h.router.getGrant()?.revoked).toBe(true);
    expect(h.stopAll).toHaveBeenCalledOnce();
  });

  it('fails closed on route-switch stop failure and never starts the new target', async () => {
    const h = harness([[call('a', 'coyote/a')], [call('b', 'coyote/b')]], undefined, (action) =>
      action.id.endsWith('switch-stop'),
    );
    await authorize(h);
    await h.router.observe(FRAME);
    await expect(h.router.observe(FRAME)).rejects.toThrow('stop failed');
    expect(h.invoked.some(({ id }) => id === 'b')).toBe(false);
    expect(h.router.getGrant()?.revoked).toBe(true);
    expect(h.stopAll).toHaveBeenCalledOnce();
  });

  it('stops on lease loss and grant expiry, and a stop for another target preserves the active route', async () => {
    const h = harness([
      [call('a', 'coyote/a')],
      [call('stop-b', 'coyote/b', 'stop', 0)],
      [call('start-b', 'coyote/b')],
    ]);
    await authorize(h, 1_000);
    await h.router.observe(FRAME);
    await h.router.observe(FRAME);
    await h.router.observe(FRAME);
    expect(h.invoked.map(({ id }) => id)).toEqual([
      'a',
      'stop-b',
      'start-b-switch-stop',
      'start-b',
    ]);

    const lease = harness([[]]);
    await authorize(lease);
    lease.setLease(false);
    await expect(lease.router.observe(FRAME)).rejects.toThrow('没有设备控制权');
    expect(lease.stopAll).toHaveBeenCalledOnce();

    const expired = harness([[]]);
    await authorize(expired, 1_000);
    expired.setNow(2_001);
    await expect(expired.router.observe(FRAME)).rejects.toThrow('授权不存在或已过期');
    expect(expired.stopAll).toHaveBeenCalledOnce();
  });
});
