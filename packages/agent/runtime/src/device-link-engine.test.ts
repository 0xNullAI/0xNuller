import { describe, expect, it } from 'vitest';
import type { DeviceLinkRule } from '@dg-agent/core';
import type { OpossumCommand } from '@dg-kit/core';
import type { CivetPressureReading, OpossumState, PawPrintsReading } from '@dg-kit/protocol';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from './device-clients.js';
import { DeviceLinkEngine } from './device-link-engine.js';

const rule: DeviceLinkRule = {
  enabled: true,
  source: 'civet-pressure',
  channel: 'A',
  intensity: 30,
  pattern: 'pulse',
  thresholdKPa: 2,
  releaseKPa: 1,
  cooldownMs: 1500,
};

class FakeOpossum implements OpossumClient {
  readonly commands: OpossumCommand[] = [];
  private readonly state: OpossumState = {
    connected: true,
    intensityA: 0,
    intensityB: 0,
  };

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState(): Promise<OpossumState> {
    return this.state;
  }
  async execute(command: OpossumCommand): Promise<{ state: OpossumState }> {
    this.commands.push(command);
    return { state: this.state };
  }
  async emergencyStop(): Promise<void> {
    this.commands.push({ type: 'vibrateStop' });
  }
  async setIndicatorColor(): Promise<void> {}
  onStateChanged(): () => void {
    return () => undefined;
  }
}

class FakeCivet implements CivetEdgingClient {
  private readonly listeners = new Set<(reading: CivetPressureReading) => void>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState() {
    return { connected: true, battery: 100 };
  }
  subscribe(listener: (reading: CivetPressureReading) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onStateChanged(): () => void {
    return () => undefined;
  }
  emit(kPa: number): void {
    for (const listener of this.listeners) listener({ type: 'pressure', kPa });
  }
}

class FakePaw implements PawPrintsClient {
  private readonly listeners = new Set<(reading: PawPrintsReading) => void>();
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState() {
    return { connected: true, battery: 100 };
  }
  subscribe(listener: (reading: PawPrintsReading) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onStateChanged(): () => void {
    return () => undefined;
  }
  emit(): void {
    for (const listener of this.listeners)
      listener({ type: 'trigger', eventId: 1, parameterValue: 1 });
  }
}

describe('DeviceLinkEngine', () => {
  it('starts the selected Opossum rhythm at pressure threshold and stops on release', async () => {
    const opossum = new FakeOpossum();
    const civet = new FakeCivet();
    const engine = new DeviceLinkEngine({ rule, opossum, civetEdging: civet });

    civet.emit(2.1);
    await Promise.resolve();
    expect(opossum.commands).toEqual([
      { type: 'vibrateSetPattern', channel: 'A', pattern: 'pulse' },
      { type: 'vibrateStart', channel: 'A', intensity: 30, pattern: 'pulse' },
    ]);

    // Release must not be swallowed by the fire cooldown.
    civet.emit(0.8);
    await Promise.resolve();
    expect(opossum.commands.at(-1)).toEqual({ type: 'vibrateStop' });
    engine.dispose();
  });

  it('supports opt-in Paw trigger linkage and ignores events while disabled', async () => {
    const opossum = new FakeOpossum();
    const paw = new FakePaw();
    const engine = new DeviceLinkEngine({
      rule: { ...rule, source: 'paw-button', channel: 'both' },
      opossum,
      pawPrints: paw,
    });

    paw.emit();
    await Promise.resolve();
    expect(opossum.commands).toHaveLength(4);
    engine.setRule({ ...rule, enabled: false, source: 'paw-button', channel: 'both' });
    paw.emit();
    await Promise.resolve();
    expect(opossum.commands).toHaveLength(5);
    engine.dispose();
  });
});
