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

  it('resolves vibrate_start with a pattern into the same plan', async () => {
    const registry = createDefaultToolRegistry({});
    const plan = await registry.resolve({
      id: '1',
      name: 'vibrate_start',
      args: { channel: 'A', intensity: 15, pattern: 'pulse' },
    });
    expect(plan).toEqual({
      type: 'opossum',
      command: { type: 'vibrateStart', channel: 'A', intensity: 15, pattern: 'pulse' },
    });
  });

  it('rejects vibrate_start with an unrecognized pattern name', async () => {
    const registry = createDefaultToolRegistry({});
    await expect(
      registry.resolve({
        id: '1',
        name: 'vibrate_start',
        args: { channel: 'A', intensity: 15, pattern: 'sparkle' },
      }),
    ).rejects.toThrow();
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
      registry.resolve({
        id: '1',
        name: 'set_indicator_color',
        args: { deviceKind: 'coyote', color: 1 },
      }),
    ).rejects.toThrow();
  });

  it('lists the four new tools among the definitions', async () => {
    const registry = createDefaultToolRegistry({});
    const definitions = await registry.listDefinitions();
    const names = definitions.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'vibrate_start',
        'vibrate_stop',
        'vibrate_adjust',
        'set_indicator_color',
      ]),
    );
  });

  it('resolves vibrate_change_pattern to an opossum vibrateSetPattern plan', async () => {
    const registry = createDefaultToolRegistry({});
    const plan = await registry.resolve({
      id: '1',
      name: 'vibrate_change_pattern',
      args: { channel: 'A', pattern: 'heartbeat' },
    });
    expect(plan).toEqual({
      type: 'opossum',
      command: { type: 'vibrateSetPattern', channel: 'A', pattern: 'heartbeat' },
    });
  });

  it('rejects vibrate_change_pattern with an unrecognized pattern name', async () => {
    const registry = createDefaultToolRegistry({});
    await expect(
      registry.resolve({
        id: '1',
        name: 'vibrate_change_pattern',
        args: { channel: 'A', pattern: 'sparkle' },
      }),
    ).rejects.toThrow();
  });

  it('resolves vibrate_burst to an opossum vibrateBurst plan, accepting the legacy duration_ms arg name', async () => {
    const registry = createDefaultToolRegistry({});
    const plan = await registry.resolve({
      id: '1',
      name: 'vibrate_burst',
      args: { channel: 'B', intensity: 80, durationMs: 1500 },
    });
    expect(plan).toEqual({
      type: 'opossum',
      command: { type: 'vibrateBurst', channel: 'B', intensity: 80, durationMs: 1500 },
    });

    const legacy = await registry.resolve({
      id: '2',
      name: 'vibrate_burst',
      args: { channel: 'A', intensity: 50, duration_ms: 800 },
    });
    expect(legacy).toEqual({
      type: 'opossum',
      command: { type: 'vibrateBurst', channel: 'A', intensity: 50, durationMs: 800 },
    });
  });

  it('lists the vibrate pattern/burst tools among the definitions', async () => {
    const registry = createDefaultToolRegistry({});
    const names = (await registry.listDefinitions()).map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['vibrate_change_pattern', 'vibrate_burst']));
  });
});

describe('shock_* tool renames', () => {
  it('advertises only the shock_* names, never the pre-1.9.0 ones', async () => {
    const registry = createDefaultToolRegistry({});
    const names = (await registry.listDefinitions()).map((d) => d.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'shock_start',
        'shock_stop',
        'shock_adjust',
        'shock_change_wave',
        'shock_burst',
      ]),
    );
    for (const legacy of ['start', 'stop', 'adjust_strength', 'change_wave', 'burst']) {
      expect(names).not.toContain(legacy);
    }
  });

  it('resolves shock_adjust to a device adjustStrength plan', async () => {
    const registry = createDefaultToolRegistry({});
    const plan = await registry.resolve({
      id: '1',
      name: 'shock_adjust',
      args: { channel: 'A', delta: 5 },
    });
    expect(plan).toEqual({
      type: 'device',
      command: { type: 'adjustStrength', channel: 'A', delta: 5 },
    });
  });

  it('still resolves the pre-rename alias names to the same plans', async () => {
    const registry = createDefaultToolRegistry({});
    const plan = await registry.resolve({
      id: '1',
      name: 'adjust_strength',
      args: { channel: 'A', delta: 5 },
    });
    expect(plan).toEqual({
      type: 'device',
      command: { type: 'adjustStrength', channel: 'A', delta: 5 },
    });
    expect(registry.getDisplayName('adjust_strength')).toBe('调节电击强度');
    expect(registry.getDisplayName('shock_adjust')).toBe('调节电击强度');
  });
});
