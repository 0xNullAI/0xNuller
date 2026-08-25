import { describe, expect, it } from 'vitest';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import { AgentRuntime } from './agent-runtime.js';
import {
  SensorToolLlm,
  TestOpossumClient,
  TestPawPrintsClient,
} from './runtime-multi-device.test-support.js';
import { TestDevice, TestLlm, TestPermission } from './runtime.test-support.js';

describe('AgentRuntime sensor trigger opt-in gating', () => {
  it('defaults sensor triggers to disabled for a fresh session', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      pawPrints: new TestPawPrintsClient(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    expect(await runtime.isSensorTriggersEnabledForSession('fresh-session')).toBe(false);
  });

  it('persists the opt-in flag on session metadata once enabled', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      pawPrints: new TestPawPrintsClient(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.setSensorTriggersEnabled('opt-in-session', true);
    expect(await runtime.isSensorTriggersEnabledForSession('opt-in-session')).toBe(true);

    await runtime.setSensorTriggersEnabled('opt-in-session', false);
    expect(await runtime.isSensorTriggersEnabledForSession('opt-in-session')).toBe(false);
  });

  it('does not instantiate a trigger engine when no sensor client is registered, even if enabled', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      // No pawPrints / civetEdging registered at all.
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    // Should not throw, and the flag still persists even though nothing
    // is subscribed yet.
    await expect(
      runtime.setSensorTriggersEnabled('no-sensor-session', true),
    ).resolves.toBeUndefined();
    expect(await runtime.isSensorTriggersEnabledForSession('no-sensor-session')).toBe(true);
  });
});
describe('AgentRuntime sensor trigger turns', () => {
  it('a sensor-fired turn keeps tools available and can execute one', async () => {
    const opossum = new TestOpossumClient();
    const pawPrints = new TestPawPrintsClient();
    const llm = new SensorToolLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      opossum,
      pawPrints,
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.setSensorTriggersEnabled('sensor-tools-session', true);

    const responded = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (event.type !== 'assistant-message-completed') return;
        if (event.message.content !== '已经响应了传感器事件。') return;
        unsubscribe();
        resolve();
      });
    });

    pawPrints.pushReading({ type: 'trigger', eventId: 1, parameterValue: 5 });

    await responded;

    expect(
      llm.toolCountsBySource.some((entry) => entry.sourceType === 'sensor' && entry.toolCount > 0),
    ).toBe(true);
    const opossumState = await opossum.getState();
    expect(opossumState.intensityA).toBe(5);
  });

  it('disabling sensor triggers before an event fires means no turn happens at all', async () => {
    const pawPrints = new TestPawPrintsClient();
    const llm = new SensorToolLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      pawPrints,
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.setSensorTriggersEnabled('sensor-disabled-session', true);
    await runtime.setSensorTriggersEnabled('sensor-disabled-session', false);

    pawPrints.pushReading({ type: 'trigger', eventId: 1, parameterValue: 5 });
    // Give any stray microtask/queued work a chance to run before asserting nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(llm.toolCountsBySource).toHaveLength(0);
    const session = await runtime.getSessionSnapshot('sensor-disabled-session');
    expect(session.messages).toHaveLength(0);
  });
});
