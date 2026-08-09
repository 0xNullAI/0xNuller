import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  registerSafetySession,
  activeSafetySessions,
  hasActiveSafetySession,
  stopAllSafetySessions,
} from './safety-bus.js';

function session(id: string, over: Partial<Parameters<typeof registerSafetySession>[0]> = {}) {
  return { id, label: id, isActive: () => true, stop: () => {}, ...over };
}

describe('安全总线', () => {
  beforeEach(async () => {
    // Reset: unregister every session
    for (const s of activeSafetySessions()) registerSafetySession(s)();
  });

  it('stopAll 停掉全部已注册会话', async () => {
    const a = vi.fn(),
      b = vi.fn();
    const offA = registerSafetySession(session('a', { stop: a }));
    const offB = registerSafetySession(session('b', { stop: b }));
    const r = await stopAllSafetySessions();
    expect(r.attempted).toBe(2);
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    offA();
    offB();
  });

  it('某个会话抛错不能中断其余会话的停止', async () => {
    // This is the dangerous case: one device throws on a dropped
    // connection while another keeps outputting.
    const good = vi.fn();
    const offBad = registerSafetySession(
      session('bad', {
        stop: () => {
          throw new Error('BLE 已断开');
        },
      }),
    );
    const offGood = registerSafetySession(session('good', { stop: good }));
    const r = await stopAllSafetySessions();
    expect(good).toHaveBeenCalled();
    expect(r.failed.map((f) => f.id)).toEqual(['bad']);
    offBad();
    offGood();
  });

  it('isActive 抛错时按「活动」处理——宁可多显示一个停止按钮也不能漏', () => {
    const off = registerSafetySession(
      session('x', {
        isActive: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(hasActiveSafetySession()).toBe(true);
    off();
  });

  it('同 id 重新注册会覆盖，避免陈旧闭包堆积', async () => {
    const stale = vi.fn(),
      fresh = vi.fn();
    registerSafetySession(session('m', { stop: stale }));
    const off = registerSafetySession(session('m', { stop: fresh }));
    await stopAllSafetySessions();
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalled();
    off();
  });

  it('旧会话的注销函数不会删掉已覆盖它的新会话', async () => {
    const fresh = vi.fn();
    const offStale = registerSafetySession(session('m', { stop: () => {} }));
    registerSafetySession(session('m', { stop: fresh }));
    offStale();
    const r = await stopAllSafetySessions();
    expect(fresh).toHaveBeenCalled();
    expect(r.attempted).toBe(1);
  });
});
