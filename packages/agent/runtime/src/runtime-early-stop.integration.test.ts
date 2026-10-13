import { describe, expect, it, vi } from 'vitest';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import type { RuntimeEvent, SessionSnapshot, SessionStore } from '@dg-agent/core';
import { AgentRuntime } from './agent-runtime.js';
import { CountingDeviceToolLlm, TestDevice, TestPermission } from './runtime.test-support.js';

/** A store whose reads or writes can be held open, like a slow server round trip. */
function createGatedStore() {
  const sessions = new Map<string, SessionSnapshot>();
  let releaseRead: (() => void) | null = null;
  let releaseSave: (() => void) | null = null;
  let holdRead = false;
  let holdSave = false;
  const store: SessionStore = {
    get: async (id) => {
      if (holdRead) await new Promise<void>((resolve) => (releaseRead = resolve));
      return sessions.get(id) ?? null;
    },
    save: async (snapshot) => {
      if (holdSave) await new Promise<void>((resolve) => (releaseSave = resolve));
      sessions.set(snapshot.id, snapshot);
    },
    list: async () => [...sessions.values()],
    delete: async (id) => {
      sessions.delete(id);
    },
  };
  return {
    store,
    sessions,
    holdReads: () => (holdRead = true),
    holdSaves: () => (holdSave = true),
    isSaveHeld: () => releaseSave !== null,
    releaseRead: () => {
      holdRead = false;
      releaseRead?.();
    },
    releaseSave: () => {
      holdSave = false;
      releaseSave?.();
    },
  };
}

function createRuntime(store: SessionStore) {
  const device = new TestDevice();
  const llm = new CountingDeviceToolLlm();
  const runtime = new AgentRuntime({
    device,
    llm,
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
    sessionStore: store,
  });
  return { runtime, device, llm };
}

const send = (runtime: AgentRuntime, abortSignal?: AbortSignal) =>
  runtime.sendUserMessage({
    sessionId: 's',
    text: '开始',
    abortSignal,
    context: { sessionId: 's', sourceType: 'web', traceId: 't' },
  });

describe('a stop pressed before the turn registers', () => {
  it('lands while the session is still being read: no model call, no device write', async () => {
    const gated = createGatedStore();
    const { runtime, device, llm } = createRuntime(gated.store);
    const execute = vi.spyOn(device, 'execute');
    gated.holdReads();
    const pending = send(runtime);
    await Promise.resolve();
    expect(runtime.isReplyRunning('s')).toBe(true);

    await runtime.abortCurrentReply('s');
    gated.releaseRead();

    await expect(pending).rejects.toThrow('已停止当前回复');
    expect(llm.count).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(gated.sessions.get('s')?.messages ?? []).toEqual([]);
    expect(runtime.isReplyRunning('s')).toBe(false);
    runtime.dispose();
  });

  it('lands while the user message is being saved: the turn ends aborted without tools', async () => {
    const gated = createGatedStore();
    const { runtime, device, llm } = createRuntime(gated.store);
    const execute = vi.spyOn(device, 'execute');
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    // Let the empty session be created first, then hold the user-message save.
    await runtime.getSessionSnapshot('s');
    gated.holdSaves();
    const pending = send(runtime);
    await vi.waitFor(() => expect(gated.isSaveHeld()).toBe(true));

    await runtime.abortCurrentReply('s');
    gated.releaseSave();

    await expect(pending).rejects.toThrow('已停止当前回复');
    expect(llm.count).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'assistant-message-aborted')).toBe(true);
    runtime.dispose();
  });

  it("honours the caller's signal, even when it was aborted before the call", async () => {
    const gated = createGatedStore();
    const { runtime, llm } = createRuntime(gated.store);
    const controller = new AbortController();
    controller.abort();
    await expect(send(runtime, controller.signal)).rejects.toThrow('已停止当前回复');

    const later = new AbortController();
    gated.holdReads();
    const pending = send(runtime, later.signal);
    await Promise.resolve();
    later.abort();
    gated.releaseRead();
    await expect(pending).rejects.toThrow('已停止当前回复');
    expect(llm.count).toBe(0);
    runtime.dispose();
  });

  it('a stop with no reply starting does not latch onto the next send', async () => {
    const gated = createGatedStore();
    const { runtime, llm } = createRuntime(gated.store);
    await runtime.abortCurrentReply('s');
    await send(runtime);
    expect(llm.count).toBeGreaterThan(0);
    runtime.dispose();
  });
});
