import { describe, expect, it, vi } from 'vitest';
import type { LlmClient, LlmImageInput, ToolCall } from '@dg-agent/core';
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
const opossum: VideoAiAllowedTarget = {
  id: 'opossum/motor',
  kind: 'opossum',
  targetId: 'motor',
  label: 'motor',
  modality: 'vibration',
  battery: null,
  active: false,
  capA: 30,
  capB: 30,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function call(id: string, targetId: string, action = 'start', value = 5): ToolCall {
  return {
    id,
    name: 'video_device_control',
    args: { targetId, action, channel: 'A', value, durationMs: 100 },
  };
}

function harness(
  turns: ToolCall[][],
  targets: VideoAiAllowedTarget[] = [coyote('a'), coyote('b'), opossum],
  rejectAction?: (action: VideoAiDeviceAction) => boolean,
  resultForAction?: (action: VideoAiDeviceAction) => unknown,
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
      return (
        resultForAction?.(action) ??
        JSON.stringify({
          ok: true,
          ...(action.target.kind === 'coyote' ? { targetId: action.target.targetId } : {}),
          command: {
            type: {
              start: action.target.kind === 'coyote' ? 'start' : 'vibrateStart',
              adjust: action.target.kind === 'coyote' ? 'adjustStrength' : 'vibrateAdjust',
              stop: action.target.kind === 'coyote' ? 'stop' : 'vibrateStop',
              burst: action.target.kind === 'coyote' ? 'burst' : 'vibrateBurst',
            }[action.action],
          },
        })
      );
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
  it('binds an observation to the authorized server conversation and provider instance', async () => {
    const h = harness([[]]);
    h.router.updateInputs(h.llm, h.targets);
    await h.router.authorize({
      conversationId: 'server-conversation',
      targets: h.targets,
      allowEnhanced: false,
      allowBurst: false,
      durationMs: 60_000,
      cadenceMs: 5_000,
      captureIntervalMs: 1_000,
    });
    const replacement = { ...h.llm, runTurn: vi.fn() } as LlmClient;
    h.router.updateInputs(replacement, h.targets);
    await h.router.observe(FRAME);
    expect(vi.mocked(h.llm.runTurn)).toHaveBeenCalledOnce();
    expect(replacement.runTurn).not.toHaveBeenCalled();
    expect(vi.mocked(h.llm.runTurn).mock.calls[0]?.[0]).toMatchObject({
      session: { id: 'server-conversation' },
      context: { sessionId: 'server-conversation' },
    });
  });

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

  it('keeps the authorized card prompt while shared Market selection changes', async () => {
    const h = harness([[], [], []]);
    h.router.updateInputs(h.llm, h.targets, {
      name: '朋友',
      prompt: '朋友的人设与本次私人记忆',
    });
    await authorize(h);

    h.router.updateInputs(h.llm, h.targets, {
      name: '雨夜',
      prompt: '另一张公开场景卡',
    });
    await h.router.observe(FRAME);
    await h.router.observe(FRAME);
    const activeInstructions = vi
      .mocked(h.llm.runTurn)
      .mock.calls.map(([input]) => input.instructions);
    expect(activeInstructions).toHaveLength(2);
    for (const instructions of activeInstructions) {
      expect(instructions).toContain('朋友的人设与本次私人记忆');
      expect(instructions).not.toContain('另一张公开场景卡');
    }

    await h.router.stop();
    await authorize(h);
    await h.router.observe(FRAME);
    expect(vi.mocked(h.llm.runTurn).mock.calls[2]?.[0].instructions).toContain('另一张公开场景卡');
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
      [call('too-strong', opossum.id, 'start', 31)],
    ]);
    await authorize(h);
    await expect(h.router.observe(FRAME)).rejects.toThrow('未授权 targetId');
    expect(h.router.getGrant()?.revoked).toBe(true);
    await authorize(h);
    await expect(h.router.observe(FRAME)).rejects.toThrow('超过授权上限');
    expect(h.router.getGrant()?.revoked).toBe(true);
    expect(h.invoked).toHaveLength(0);
    expect(h.stopAll).toHaveBeenCalledTimes(2);
  });

  it('stops an earlier successful output when a later call in the same frame is invalid', async () => {
    const h = harness([[call('first', 'coyote/a'), call('invalid', 'coyote/not-allowed')]]);
    await authorize(h);
    await expect(h.router.observe(FRAME)).rejects.toThrow('未授权 targetId');
    expect(h.invoked.map(({ id }) => id)).toEqual(['first']);
    expect(h.router.getGrant()?.revoked).toBe(true);
    expect(h.stopAll).toHaveBeenCalledOnce();
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

  it('rechecks the absolute grant deadline after model inference and before execution', async () => {
    const turn = deferred<{ assistantMessage: string; toolCalls: ToolCall[] }>();
    const h = harness([]);
    vi.mocked(h.llm.runTurn).mockImplementationOnce(() => turn.promise);
    await authorize(h, 1_000);

    const observing = h.router.observe(FRAME);
    h.setNow(2_001);
    turn.resolve({ assistantMessage: 'started', toolCalls: [call('late', 'coyote/a')] });

    await expect(observing).rejects.toThrow('已过期');
    expect(h.invoked).toHaveLength(0);
    expect(h.stopAll).toHaveBeenCalledOnce();
  });

  it('treats a structured tool denial as a failed observation', async () => {
    const h = harness([[call('denied', 'coyote/a')]], undefined, undefined, () =>
      JSON.stringify({ error: 'permission denied', _meta: { kind: 'tool-denied' } }),
    );
    await authorize(h);

    await expect(h.router.observe(FRAME)).rejects.toThrow('permission denied');
  });

  it('never presents a model claim as device execution without a tool call', async () => {
    const h = harness([[]]);
    vi.mocked(h.llm.runTurn).mockResolvedValueOnce({
      assistantMessage: '已经启动设备。',
      toolCalls: [],
    });
    await authorize(h);
    const text = await h.router.observe(FRAME);
    expect(text).toContain('没有可核实的工具执行结果');
    expect(h.invoked).toHaveLength(0);
  });

  it('uses a deterministic caption after verified execution instead of provider prose', async () => {
    const h = harness([[call('a', 'coyote/a')]]);
    vi.mocked(h.llm.runTurn).mockResolvedValueOnce({
      assistantMessage: '我已把设备调到最高强度。',
      toolCalls: [call('a', 'coyote/a')],
    });
    await authorize(h);
    const text = await h.router.observe(FRAME);
    expect(text).toContain('已执行 1 项授权设备动作');
    expect(text).not.toContain('最高强度');
  });

  it('rejects unknown tool names before executing any device call', async () => {
    const h = harness([]);
    vi.mocked(h.llm.runTurn).mockResolvedValueOnce({
      assistantMessage: 'ok',
      toolCalls: [call('a', 'coyote/a'), { id: 'bad', name: 'file_read', args: {} }],
    });
    await authorize(h);
    await expect(h.router.observe(FRAME)).rejects.toThrow('未授权的工具');
    expect(h.invoked).toHaveLength(0);
  });

  it('does not count an unconfirmed device result as successful', async () => {
    const h = harness([[call('a', 'coyote/a')]], undefined, undefined, () => '{}');
    await authorize(h);
    await expect(h.router.observe(FRAME)).rejects.toThrow('结果未确认');
    expect(h.invoked).toHaveLength(1);
    expect(h.router.getGrant()?.revoked).toBe(true);
    expect(h.stopAll).toHaveBeenCalledOnce();
  });

  it('accepts an Opossum receipt without a Coyote target ID', async () => {
    const opossum = {
      ...coyote('ignored'),
      id: 'opossum/one',
      kind: 'opossum' as const,
      targetId: 'one',
      modality: 'vibration' as const,
    };
    const h = harness([[call('a', opossum.id)]], [opossum]);
    await authorize(h);
    await expect(h.router.observe(FRAME)).resolves.toContain('已执行 1 项');
  });

  it('rejects a receipt from a different Coyote target', async () => {
    const h = harness([[call('a', 'coyote/a')]], undefined, undefined, () =>
      JSON.stringify({ ok: true, targetId: 'other', command: { type: 'start' } }),
    );
    await authorize(h);
    await expect(h.router.observe(FRAME)).rejects.toThrow('结果未确认');
    expect(h.stopAll).toHaveBeenCalledOnce();
  });

  it('waits for a pending stop before issuing a replacement authorization', async () => {
    const stopping = deferred<undefined>();
    const h = harness([]);
    h.stopAll.mockImplementationOnce(() => stopping.promise);
    await authorize(h);

    const stop = h.router.stop();
    let authorized = false;
    const next = authorize(h).then(() => {
      authorized = true;
    });
    await Promise.resolve();
    expect(authorized).toBe(false);

    stopping.resolve(undefined);
    await stop;
    await next;
    expect(authorized).toBe(true);
  });
});
