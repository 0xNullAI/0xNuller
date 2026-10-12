import { describe, expect, it, vi } from 'vitest';
import { createEmptyDeviceState, type DeviceState } from '@dg-agent/core';
import { ToolRegistry } from '@dg-agent/runtime';
import { CoyoteTargetToolRegistry, createCoyoteTargetRouter } from './coyote-target-routing.js';
import type { BluetoothDeviceLike } from '@dg-kit/protocol';

class Child {
  state: DeviceState = createEmptyDeviceState();
  execute = vi.fn(async () => ({ state: this.state }));
  listeners = new Set<(state: DeviceState) => void>();
  async connect() {}
  async connectDevice(device: BluetoothDeviceLike) {
    this.state = { ...createEmptyDeviceState(), connected: true, deviceName: device.name };
    for (const listener of this.listeners) listener(this.state);
  }
  async disconnect() {
    this.state = createEmptyDeviceState();
    for (const listener of this.listeners) listener(this.state);
  }
  async getState() {
    return this.state;
  }
  async emergencyStop() {}
  onStateChanged(listener: (state: DeviceState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function bluetooth(id: string): BluetoothDeviceLike {
  return Object.assign(new EventTarget(), { id, name: '相同名称' });
}

describe('Coyote exact target composition', () => {
  it('requires the current targetId enum on every Coyote model tool', async () => {
    const legacy = new ToolRegistry();
    for (const name of [
      'shock_start',
      'shock_stop',
      'shock_adjust',
      'shock_change_wave',
      'shock_burst',
    ]) {
      legacy.register({
        name,
        definition: {
          name,
          description: name,
          parameters: { type: 'object', properties: {} },
        },
        toExecutionPlan: (_args: Record<string, unknown>) => ({
          type: 'device',
          command: { type: 'stop' },
        }),
      });
    }
    const registry = new CoyoteTargetToolRegistry(legacy, {
      listTargets: async () => [
        { targetId: 'opaque/a', state: { ...createEmptyDeviceState(), connected: true } },
        { targetId: 'opaque/b', state: { ...createEmptyDeviceState(), connected: true } },
      ],
    });
    const definitions = await registry.listDefinitions();
    expect(definitions).toHaveLength(5);
    for (const definition of definitions) {
      const schema = definition.parameters as {
        properties: { targetId: { enum: string[] } };
        required: string[];
      };
      expect(schema.properties.targetId.enum).toEqual(['opaque/a', 'opaque/b']);
      expect(schema.required).toContain('targetId');
      expect(schema).toMatchObject({ additionalProperties: false });
    }
  });

  it('rotates a single device identity after disconnect and rejects the stale target', async () => {
    const child = new Child();
    await child.connectDevice(bluetooth('transport-a'));
    const router = createCoyoteTargetRouter(child, 'opaque/first-connection');
    expect((await router.listTargets())[0]?.targetId).toBe('opaque/first-connection');

    await child.disconnect();
    await child.connectDevice(bluetooth('transport-a'));
    const replacement = (await router.listTargets())[0]!.targetId;

    expect(replacement).not.toBe('opaque/first-connection');
    await expect(
      router.executeTarget('opaque/first-connection', { type: 'stop' }),
    ).resolves.toBeNull();
    expect(child.execute).not.toHaveBeenCalled();
  });
});
