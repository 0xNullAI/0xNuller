import { describe, expect, it } from 'vitest';
import { createDefaultToolRegistry } from './registry.js';

describe('opossum + LED tools', () => {
  it('resolves vibrate_start to an opossum vibrateStart plan', async () => {
    const registry = createDefaultToolRegistry({});
    const plan = await registry.resolve({
      id: '1',
      name: 'vibrate_start',
      args: { channel: 'A', intensity: 15 },
    });
    expect(plan).toEqual({
      type: 'opossum',
      command: { type: 'vibrateStart', channel: 'A', intensity: 15 },
    });
  });

  it('resolves vibrate_stop with an omitted channel', async () => {
    const registry = createDefaultToolRegistry({});
    const plan = await registry.resolve({ id: '1', name: 'vibrate_stop', args: {} });
    expect(plan).toEqual({ type: 'opossum', command: { type: 'vibrateStop', channel: undefined } });
  });

  it('resolves vibrate_adjust to a signed delta plan', async () => {
    const registry = createDefaultToolRegistry({});
    const plan = await registry.resolve({
      id: '1',
      name: 'vibrate_adjust',
      args: { channel: 'B', delta: -10 },
    });
    expect(plan).toEqual({
      type: 'opossum',
      command: { type: 'vibrateAdjust', channel: 'B', delta: -10 },
    });
  });

  it('rejects a vibrate_adjust delta outside the hard bound', async () => {
    const registry = createDefaultToolRegistry({});
    await expect(
      registry.resolve({ id: '1', name: 'vibrate_adjust', args: { channel: 'A', delta: 500 } }),
    ).rejects.toThrow();
  });

  it('resolves set_indicator_color for an LED-capable device kind', async () => {
    const registry = createDefaultToolRegistry({});
    const plan = await registry.resolve({
      id: '1',
      name: 'set_indicator_color',
      args: { deviceKind: 'opossum', color: 4 },
    });
    expect(plan).toEqual({ type: 'setIndicatorColor', deviceKind: 'opossum', color: 4 });
  });

  it('rejects set_indicator_color for coyote (no indicator)', async () => {
    const registry = createDefaultToolRegistry({});
    await expect(
      registry.resolve({ id: '1', name: 'set_indicator_color', args: { deviceKind: 'coyote', color: 1 } }),
    ).rejects.toThrow();
  });

  it('lists the four new tools among the definitions', async () => {
    const registry = createDefaultToolRegistry({});
    const definitions = await registry.listDefinitions();
    const names = definitions.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining(['vibrate_start', 'vibrate_stop', 'vibrate_adjust', 'set_indicator_color']),
    );
  });
});
