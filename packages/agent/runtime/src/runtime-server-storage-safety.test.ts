import { describe, expect, it, vi } from 'vitest';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import type { SessionSnapshot, SessionStore } from '@dg-agent/core';
import { AgentRuntime } from './agent-runtime.js';
import { TestDevice, TestLlm, TestPermission } from './runtime.test-support.js';
import { TestPawPrintsClient } from './runtime-multi-device.test-support.js';

describe('server history outages do not block stopping devices', () => {
  it('unsubscribes the sensor engine before awaiting unavailable history', async () => {
    const sessions = new Map<string, SessionSnapshot>();
    let offline = false;
    const store: SessionStore = {
      get: async (id) => {
        if (offline) throw new Error('offline');
        return sessions.get(id) ?? null;
      },
      save: async (s) => {
        sessions.set(s.id, s);
      },
      list: async () => [...sessions.values()],
      delete: async (id) => {
        sessions.delete(id);
      },
    };
    const device = new TestDevice();
    const pawPrints = new TestPawPrintsClient();
    const runtime = new AgentRuntime({
      device,
      pawPrints,
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      sessionStore: store,
    });
    await runtime.setSensorTriggersEnabled('s', true);
    // The engine owns sensor subscriptions; its teardown must happen before the rejected read.
    const internals = runtime as unknown as { sensorTriggerEngine: { dispose(): void } | null };
    const dispose = vi.spyOn(internals.sensorTriggerEngine!, 'dispose');
    offline = true;
    await expect(runtime.setSensorTriggersEnabled('s', false)).rejects.toThrow('offline');
    expect(dispose).toHaveBeenCalledOnce();
    expect(internals.sensorTriggerEngine).toBeNull();
    const stop = vi.spyOn(device, 'emergencyStop');
    await runtime.emergencyStop('s');
    expect(stop).toHaveBeenCalled();
    runtime.dispose();
  });
});
