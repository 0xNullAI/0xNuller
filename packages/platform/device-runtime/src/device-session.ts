/**
 * The module-side view of the shared DG-Lab devices.
 *
 * Control, Playground and Chat used to each build a `DeviceSession` that owned its own protocol
 * adapters, BLE clients and command queues, so one Coyote could end up with two adapters writing
 * the same characteristic. The physical side now lives only in `DgLabConnectionRegistry`. What
 * stays here is what a module needs on top of it: its software caps, the absolute-to-delta
 * translation for sliders, waveform and reading bookkeeping, and the sensor-to-Opossum link.
 * Every write goes through the module's registry handle, so the lease fence, the holder-side
 * re-clamp and the device's one queue apply to it.
 */

import {
  V2_DEVICE_NAME_PREFIX,
  type CivetPressureReading,
  type OpossumButtonEvent,
  type OpossumState,
  type PawPrintsReading,
} from '@dg-kit/protocol';
import { DEFAULT_DEVICE_LINK_RULE } from '@dg-kit/core';
import type {
  DeviceCommand,
  DeviceKind,
  DeviceLinkRule,
  DeviceState,
  OpossumCommand,
  OpossumVibrationPatternName,
  SensorState,
  WaveFrame as KitWaveFrame,
} from '@dg-kit/core';
import type { DgLabModuleHandle } from './dglab/dglab-connection-registry.js';
import type { DgLabDeviceSnapshot } from './dglab/physical-device.js';
import type {
  CoyoteSummary,
  DeviceVersion,
  OpossumSummary,
  SensorKind,
  SensorSummary,
} from './attached-device-state.js';

export type {
  CoyoteSummary,
  DeviceVersion,
  OpossumSummary,
  SensorKind,
  SensorSummary,
} from './attached-device-state.js';

export interface DeviceInfo {
  version: DeviceVersion;
  name: string;
  /** Null while the device has not reported a level. */
  battery: number | null;
}

export type WaveFrame = KitWaveFrame;

type Channel = 'A' | 'B';
type CoyoteSnapshot = Extract<DgLabDeviceSnapshot, { kind: 'coyote' }>;
type OpossumSnapshot = Extract<DgLabDeviceSnapshot, { kind: 'opossum' }>;
type SensorSnapshot = Extract<DgLabDeviceSnapshot, { kind: SensorKind }>;

const DEFAULT_LIMIT = 50;
const LINK_PULSE_MS = 500;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ignore(): undefined {
  return undefined;
}

function isSensorKind(kind: DeviceKind): kind is SensorKind {
  return kind === 'paw-prints' || kind === 'civet-edging';
}

function isCoyote(device: DgLabDeviceSnapshot): device is CoyoteSnapshot {
  return device.kind === 'coyote';
}

function isOpossum(device: DgLabDeviceSnapshot): device is OpossumSnapshot {
  return device.kind === 'opossum';
}

function isSensor(device: DgLabDeviceSnapshot): device is SensorSnapshot {
  return isSensorKind(device.kind);
}

/**
 * One Coyote host as this module sees it: a registry device id plus the module's own caps and
 * pending slider targets. It holds no adapter, client or queue.
 */
export class DGLabDevice {
  readonly id: string;
  private readonly handle: DgLabModuleHandle;
  private limitA: number;
  private limitB: number;
  /** Latest requested absolute strength per channel, not yet sent. */
  private readonly pending: Record<Channel, number | null> = { A: null, B: null };
  private readonly flushing: Record<Channel, boolean> = { A: false, B: false };
  /** The latest stop this view issued. A target set after it is computed once it has landed. */
  private settled: Promise<unknown> = Promise.resolve();

  constructor(handle: DgLabModuleHandle, id: string, limits: { A: number; B: number }) {
    this.handle = handle;
    this.id = id;
    this.limitA = clamp(Math.round(limits.A), 0, 200);
    this.limitB = clamp(Math.round(limits.B), 0, 200);
  }

  /**
   * Set the absolute strength of a channel.
   *
   * The device only takes relative `adjustStrength`, so the target is turned into a delta. The
   * delta is computed one write at a time against the state the previous write left behind:
   * computing it at call time let two quick slider moves both start from the same stale reading
   * and overshoot the target. Intermediate targets are coalesced; the last one wins.
   */
  setStrength(channel: Channel, value: number): void {
    const state = this.state();
    if (!state?.connected) return;
    this.pending[channel] = clamp(Math.round(value), 0, this.effectiveLimit(channel, state));
    if (!this.flushing[channel]) void this.flush(channel);
  }

  setWave(channel: Channel, frames: WaveFrame[], waveformId: string, loop = true): void {
    if (frames.length === 0) {
      this.write({ type: 'stop', channel });
      return;
    }
    this.write({
      type: 'changeWave',
      channel,
      waveform: {
        id: waveformId,
        name: waveformId,
        frames: frames.map((frame) => [frame[0], frame[1]] as WaveFrame),
      },
      loop,
    });
  }

  stopWave(channel: Channel): void {
    this.write({ type: 'stop', channel });
  }

  /** Zero both channels. A priority interrupt in the registry: queued writes are skipped. */
  stopAll(): void {
    const stop = this.handle.emergencyStop(this.id);
    this.cancelPending(stop);
    void stop.catch(ignore);
  }

  /**
   * Forget unsent slider targets. Used on stop, revoke and when the device goes away. `stop`
   * is the stop just issued: a target set right after it (a game replacing its last pulse) is
   * computed against the zeroed state, not the reading from before the stop landed.
   */
  cancelPending(stop?: Promise<unknown>): void {
    this.pending.A = null;
    this.pending.B = null;
    if (stop) this.settled = stop.catch(ignore);
  }

  /** Software cap only; never written to the device. Lowering it stops live output. */
  setLimit(channel: Channel, value: number): void {
    const next = clamp(Math.round(value), 0, 200);
    const previous = channel === 'A' ? this.limitA : this.limitB;
    if (channel === 'A') this.limitA = next;
    else this.limitB = next;
    // Work already queued was clamped under the old cap; the emergency path voids it.
    if (next < previous && this.state()?.connected) this.stopAll();
  }

  getState(): {
    connected: boolean;
    strengthA: number;
    strengthB: number;
    battery: number;
    waveActiveA: boolean;
    waveActiveB: boolean;
    waveIdA: string | null;
    waveIdB: string | null;
    limitA: number;
    limitB: number;
  } {
    const s = this.state();
    return {
      connected: s?.connected ?? false,
      strengthA: s?.strengthA ?? 0,
      strengthB: s?.strengthB ?? 0,
      battery: s?.battery ?? 0,
      waveActiveA: s?.waveActiveA ?? false,
      waveActiveB: s?.waveActiveB ?? false,
      waveIdA: s?.currentWaveA ?? null,
      waveIdB: s?.currentWaveB ?? null,
      limitA: s ? this.effectiveLimit('A', s) : this.limitA,
      limitB: s ? this.effectiveLimit('B', s) : this.limitB,
    };
  }

  getSummary(): CoyoteSummary {
    const snapshot = this.snapshot();
    const s = this.getState();
    const name = snapshot?.name ?? '';
    return {
      id: this.id,
      name: name || '郊狼',
      version: name.startsWith(V2_DEVICE_NAME_PREFIX) ? 'v2' : 'v3',
      connected: s.connected,
      battery: s.connected ? s.battery : null,
      strengthA: s.strengthA,
      strengthB: s.strengthB,
      limitA: s.limitA,
      limitB: s.limitB,
      waveActiveA: s.waveActiveA,
      waveActiveB: s.waveActiveB,
      waveIdA: s.waveIdA,
      waveIdB: s.waveIdB,
    };
  }

  private async flush(channel: Channel): Promise<void> {
    this.flushing[channel] = true;
    try {
      while (this.pending[channel] !== null) {
        await this.settled;
        // A stop while waiting cleared the target; one set after the stop is a new intent.
        const target = this.pending[channel];
        if (target === null) break;
        this.pending[channel] = null;
        const state = this.state();
        if (!state?.connected) break;
        // Re-clamp at send time: the cap may have been lowered while this target waited.
        const capped = Math.min(target, this.effectiveLimit(channel, state));
        const delta = capped - (channel === 'A' ? state.strengthA : state.strengthB);
        if (delta === 0) continue;
        try {
          await this.handle.execute(this.id, { type: 'adjustStrength', channel, delta });
        } catch {
          // Rejected (lease, limit, link): nothing reached the device, and a later target
          // computed from this one would be wrong too.
          this.pending[channel] = null;
          break;
        }
      }
    } finally {
      this.flushing[channel] = false;
    }
  }

  private write(command: DeviceCommand): void {
    void this.handle.execute(this.id, command).catch(ignore);
  }

  /** The smaller of the device-reported cap and this module's software cap. */
  private effectiveLimit(channel: Channel, state: DeviceState): number {
    return Math.min(
      channel === 'A' ? state.limitA : state.limitB,
      channel === 'A' ? this.limitA : this.limitB,
    );
  }

  private snapshot(): CoyoteSnapshot | null {
    const device = this.handle.list().find((candidate) => candidate.id === this.id);
    return device && isCoyote(device) ? device : null;
  }

  private state(): DeviceState | null {
    return this.snapshot()?.state ?? null;
  }
}

export interface DeviceSessionSafetyLimits {
  strengthA: number;
  strengthB: number;
  intensityA: number;
  intensityB: number;
}

/** Turn a raw paw-prints notification into a short human-readable summary + optional numeric value. */
function describePawPrintsReading(
  reading: PawPrintsReading,
): { text: string; value: number | null } | null {
  switch (reading.type) {
    case 'trigger':
      return {
        text: `触发事件 #${reading.eventId}（参数 ${reading.parameterValue}）`,
        value: reading.parameterValue,
      };
    case 'triggerCancel':
      return { text: `事件 #${reading.eventId} 已取消`, value: null };
    case 'parameterChange':
      return { text: `参数 #${reading.eventId} 变更为 ${reading.value}`, value: reading.value };
    case 'physical':
      return { text: reading.pressState ? '物理按键：按下' : '物理按键：松开', value: null };
    case 'autoDetectResult':
      return { text: '姿态自检完成', value: null };
    default:
      // `status` is a passive ping, not a user-facing event.
      return null;
  }
}

function describeCivetReading(reading: CivetPressureReading): {
  text: string;
  value: number | null;
} {
  return { text: `压力 ${reading.kPa.toFixed(1)} kPa`, value: reading.kPa };
}

/**
 * One module's view over every DG-Lab device in the registry: any number of Coyotes, plus the
 * first connected sensor and the first connected Opossum (the single-slot surface the UI shows).
 *
 * Topology is read from the registry, never kept here: a device another module connected appears
 * in this view with the same id, and a device disconnected anywhere disappears from it.
 */
export class DeviceSession {
  private readonly handle: DgLabModuleHandle;
  private readonly coyoteViews = new Map<string, DGLabDevice>();
  private readonly listeners = new Set<() => void>();
  private coyoteLimitA = DEFAULT_LIMIT;
  private coyoteLimitB = DEFAULT_LIMIT;
  // Direct callers historically supplied the Opossum cap per command, so 200 preserves that API.
  // The product hook always seeds these from the shared settings (default 50).
  private opossumLimitA = 200;
  private opossumLimitB = 200;

  private sensorId: string | null = null;
  private sensorLastEvent: string | null = null;
  private sensorLastValue: number | null = null;
  private sensorLastEventAt: number | null = null;
  private unsubscribeSensorReading: () => void = ignore;

  private opossumId: string | null = null;
  private opossumWaveIdA: string | null = null;
  private opossumWaveIdB: string | null = null;
  private opossumLastButtons: string | null = null;
  private opossumLastButtonsAt: number | null = null;
  private unsubscribeOpossumButtons: () => void = ignore;

  private deviceLinkRule: DeviceLinkRule = { ...DEFAULT_DEVICE_LINK_RULE };
  private deviceLinkActive = false;
  private deviceLinkLastFiredAt = Number.NEGATIVE_INFINITY;
  private deviceLinkPulseTimer: ReturnType<typeof setTimeout> | null = null;
  /** The devices the running link pulse came from and drives; it stops when either goes away. */
  private deviceLinkSourceId: string | null = null;
  private deviceLinkTargetId: string | null = null;

  constructor(handle: DgLabModuleHandle, safetyLimits?: DeviceSessionSafetyLimits) {
    this.handle = handle;
    if (safetyLimits) {
      this.coyoteLimitA = clamp(Math.round(safetyLimits.strengthA), 0, 200);
      this.coyoteLimitB = clamp(Math.round(safetyLimits.strengthB), 0, 200);
      this.opossumLimitA = clamp(Math.round(safetyLimits.intensityA), 0, 200);
      this.opossumLimitB = clamp(Math.round(safetyLimits.intensityB), 0, 200);
    }
  }

  get moduleId(): string {
    return this.handle.moduleId;
  }

  /**
   * Follow the registry and this module's lease. Returns the matching stop; safe to call again
   * after it (React StrictMode mounts effects twice). Never disconnects anything.
   */
  start(): () => void {
    const offTopology = this.handle.subscribe(() => this.onTopology());
    const offRevoked = this.handle.onRevoked(() => this.onRevoked());
    this.onTopology();
    return () => {
      offTopology();
      offRevoked();
      this.unsubscribeSensorReading();
      this.unsubscribeSensorReading = ignore;
      this.unsubscribeOpossumButtons();
      this.unsubscribeOpossumButtons = ignore;
      this.sensorId = null;
      this.opossumId = null;
      this.clearDeviceLink();
      for (const view of this.coyoteViews.values()) view.cancelPending();
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The primary Coyote: the first connected one, or null. */
  get coyote(): DGLabDevice | null {
    return this.connectedCoyotes()[0] ?? null;
  }

  /** Every connected Coyote's row, primary first. */
  getCoyoteSummaries(): CoyoteSummary[] {
    return this.connectedCoyotes().map((view) => view.getSummary());
  }

  /** An omitted id means the primary, which is what callers written before multi-device meant. */
  coyoteById(deviceId?: string): DGLabDevice | null {
    if (!deviceId) return this.coyote;
    return this.connectedCoyotes().find((view) => view.id === deviceId) ?? null;
  }

  /** The caps every Coyote view runs under, now and for hosts that appear later. */
  setCoyoteLimit(channel: Channel, value: number): void {
    if (channel === 'A') this.coyoteLimitA = value;
    else this.coyoteLimitB = value;
    for (const view of this.coyoteViews.values()) view.setLimit(channel, value);
    this.emit();
  }

  /** Apply Opossum caps now as well as to future commands. Lowering one stops the Opossum. */
  setOpossumLimits(limitA: number, limitB: number): void {
    const nextA = clamp(Math.round(limitA), 0, 200);
    const nextB = clamp(Math.round(limitB), 0, 200);
    const lowered = nextA < this.opossumLimitA || nextB < this.opossumLimitB;
    this.opossumLimitA = nextA;
    this.opossumLimitB = nextB;
    if (lowered && this.opossum()) this.opossumStop();
  }

  getDeviceLinkRule(): DeviceLinkRule {
    return { ...this.deviceLinkRule };
  }

  setDeviceLinkRule(rule: DeviceLinkRule): void {
    this.deviceLinkRule = {
      ...rule,
      intensity: clamp(Math.round(rule.intensity), 0, 200),
      thresholdKPa: Math.max(0, rule.thresholdKPa),
      releaseKPa: Math.max(0, Math.min(rule.releaseKPa, rule.thresholdKPa)),
      cooldownMs: Math.max(250, Math.round(rule.cooldownMs)),
    };
    if (!this.deviceLinkRule.enabled) this.stopDeviceLink();
    this.emit();
  }

  /** The one shared picker. Picking a device another module already attached reuses it. */
  async connectDevice(): Promise<{ kind: DeviceKind; name: string }> {
    const picked = await this.handle.connect();
    return { kind: picked.kind, name: picked.name };
  }

  /** Disconnect one Coyote, or every Coyote when `deviceId` is omitted. Stops first. */
  async disconnectCoyote(deviceId?: string): Promise<void> {
    const targets = this.handle
      .list()
      .filter((device) => isCoyote(device) && (!deviceId || device.id === deviceId));
    for (const target of targets) this.coyoteViews.get(target.id)?.cancelPending();
    await settleAll(targets.map((target) => this.handle.disconnect(target.id)));
  }

  /** Disconnect every sensor. */
  async disconnectSensor(): Promise<void> {
    const targets = this.handle.list().filter(isSensor);
    await settleAll(targets.map((target) => this.handle.disconnect(target.id)));
  }

  /** Disconnect every Opossum. The registry stops each one before dropping its link. */
  async disconnectOpossum(): Promise<void> {
    this.clearDeviceLink();
    const targets = this.handle.list().filter(isOpossum);
    await settleAll(targets.map((target) => this.handle.disconnect(target.id)));
  }

  /** Disconnect every DG-Lab device in the app. */
  async disconnectAll(): Promise<void> {
    this.clearDeviceLink();
    for (const view of this.coyoteViews.values()) view.cancelPending();
    await settleAll(this.handle.list().map((device) => this.handle.disconnect(device.id)));
  }

  /** Absolute set, clamped to [0, min(limit, configured cap)]. */
  setOpossumIntensity(channel: Channel, value: number, limit: number): void {
    const opossum = this.opossum();
    if (!opossum) return;
    const intensity = clamp(Math.round(value), 0, Math.min(limit, this.opossumLimit(channel)));
    this.writeOpossum(opossum.id, { type: 'vibrateStart', channel, intensity });
  }

  /**
   * Apply a shared vibration waveform. Each 25 ms frame becomes one amplitude sample; the
   * intensity stays the independent, capped ceiling.
   */
  setOpossumWaveform(channel: Channel, frames: WaveFrame[], waveformId: string): void {
    const opossum = this.opossum();
    if (!opossum || frames.length === 0) return;
    const envelope = frames.map((frame) => clamp(Math.round(frame[1]), 0, 100));
    // `OpossumCommand` names only the presets, but both Opossum clients hand `vibrateSetPattern`
    // to the kit adapter's `setVibrationPattern`, which also takes a raw envelope. Going through
    // the command keeps the write on the registry's fenced queue.
    this.writeOpossum(opossum.id, {
      type: 'vibrateSetPattern',
      channel,
      pattern: envelope as unknown as OpossumVibrationPatternName,
    });
    if (channel === 'A') this.opossumWaveIdA = waveformId;
    else this.opossumWaveIdB = waveformId;
    this.emit();
  }

  setOpossumPattern(channel: Channel, pattern: OpossumVibrationPatternName): void {
    const opossum = this.opossum();
    if (!opossum) return;
    this.writeOpossum(opossum.id, { type: 'vibrateSetPattern', channel, pattern });
    this.emit();
  }

  /** Raise briefly, then restore. The kit adapter never restores above an intervening stop. */
  opossumBurst(channel: Channel, strength: number, durationMs: number, limit: number): void {
    const opossum = this.opossum();
    if (!opossum) return;
    const intensity = clamp(Math.round(strength), 0, Math.min(limit, this.opossumLimit(channel)));
    this.writeOpossum(opossum.id, { type: 'vibrateBurst', channel, intensity, durationMs });
  }

  /** Stop one Opossum channel, or the whole Opossum (also cancels a pending burst restore). */
  opossumStop(channel?: Channel): void {
    const opossum = this.opossum();
    if (!opossum) return;
    if (!channel) {
      void this.handle.emergencyStop(opossum.id).catch(ignore);
      return;
    }
    this.writeOpossum(opossum.id, { type: 'vibrateStop', channel });
  }

  /** LED color for the sensor or the Opossum (discrete 0-7 indicator enum). */
  setLedColor(target: 'sensor' | 'opossum', color: number): void {
    const id = target === 'sensor' ? this.sensorId : this.opossumId;
    if (!id) return;
    void this.handle.setIndicatorColor(id, clamp(Math.round(color), 0, 7)).catch(ignore);
  }

  /**
   * Emergency stop for every Coyote and Opossum in the app, whichever module attached it.
   * Never lease-gated: stop stays reachable after the module lost control.
   */
  stopAllOutputs(): void {
    const stop = this.handle.emergencyStop();
    for (const view of this.coyoteViews.values()) view.cancelPending(stop);
    this.clearDeviceLink();
    void stop.catch(ignore);
  }

  getSensorSummary(): SensorSummary | null {
    const sensor = this.sensor();
    if (!sensor) return null;
    const state: SensorState = sensor.state;
    return {
      kind: sensor.kind,
      connected: state.connected,
      deviceName: state.deviceName ?? sensor.name,
      battery: state.battery ?? null,
      lastEvent: this.sensorLastEvent,
      lastValue: this.sensorLastValue,
      lastEventAt: this.sensorLastEventAt,
    };
  }

  getOpossumSummary(): OpossumSummary | null {
    const opossum = this.opossum();
    if (!opossum) return null;
    const state: OpossumState = opossum.state;
    return {
      connected: state.connected,
      deviceName: state.deviceName ?? opossum.name,
      battery: state.battery ?? null,
      intensityA: state.intensityA,
      intensityB: state.intensityB,
      limitA: this.opossumLimit('A'),
      limitB: this.opossumLimit('B'),
      waveIdA: this.opossumWaveIdA,
      waveIdB: this.opossumWaveIdB,
      lastButtons: this.opossumLastButtons,
      lastButtonsAt: this.opossumLastButtonsAt,
      patternA: state.patternA,
      patternB: state.patternB,
    };
  }

  private onTopology(): void {
    const devices = this.handle.list();
    this.syncCoyoteViews(devices);

    const sensor = devices.find(
      (device): device is SensorSnapshot => isSensor(device) && device.connected,
    );
    if ((sensor?.id ?? null) !== this.sensorId) this.followSensor(sensor ?? null);

    const opossum = devices.find(
      (device): device is OpossumSnapshot => isOpossum(device) && device.connected,
    );
    if ((opossum?.id ?? null) !== this.opossumId) this.followOpossum(opossum ?? null);

    this.checkDeviceLinkEndpoints();
    this.emit();
  }

  private onRevoked(): void {
    // The registry has already stopped every output. Drop what this module still holds so its
    // next event cannot pick up from a pre-revoke target.
    for (const view of this.coyoteViews.values()) view.cancelPending();
    this.clearDeviceLink();
    this.emit();
  }

  private syncCoyoteViews(devices: DgLabDeviceSnapshot[]): void {
    const present = new Set(devices.filter(isCoyote).map((device) => device.id));
    for (const [id, view] of this.coyoteViews) {
      if (present.has(id)) continue;
      view.cancelPending();
      this.coyoteViews.delete(id);
    }
    for (const id of present) {
      if (this.coyoteViews.has(id)) continue;
      this.coyoteViews.set(
        id,
        new DGLabDevice(this.handle, id, { A: this.coyoteLimitA, B: this.coyoteLimitB }),
      );
    }
  }

  private followSensor(sensor: SensorSnapshot | null): void {
    this.unsubscribeSensorReading();
    this.unsubscribeSensorReading = ignore;
    this.sensorId = sensor?.id ?? null;
    this.sensorLastEvent = null;
    this.sensorLastValue = null;
    this.sensorLastEventAt = null;
    if (!sensor) return;
    const { id, kind } = sensor;
    this.unsubscribeSensorReading = this.handle.readings(id, (reading) => {
      const described =
        kind === 'paw-prints'
          ? describePawPrintsReading(reading as PawPrintsReading)
          : describeCivetReading(reading as CivetPressureReading);
      if (!described) return;
      this.sensorLastEvent = described.text;
      this.sensorLastValue = described.value;
      this.sensorLastEventAt = Date.now();
      this.emit();
      this.handleLinkedSensorReading(id, reading as PawPrintsReading | CivetPressureReading);
    });
  }

  private followOpossum(opossum: OpossumSnapshot | null): void {
    this.unsubscribeOpossumButtons();
    this.unsubscribeOpossumButtons = ignore;
    this.opossumId = opossum?.id ?? null;
    this.opossumWaveIdA = null;
    this.opossumWaveIdB = null;
    this.opossumLastButtons = null;
    this.opossumLastButtonsAt = null;
    if (!opossum) return;
    const { id } = opossum;
    this.unsubscribeOpossumButtons = this.handle.readings(id, (reading) => {
      const event = reading as OpossumButtonEvent;
      if (!(event.pressed instanceof Set)) return;
      this.opossumLastButtons = event.pressed.size > 0 ? [...event.pressed].join('+') : null;
      this.opossumLastButtonsAt = Date.now();
      this.emit();
      this.handleLinkedOpossumButton(id, event);
    });
  }

  private handleLinkedSensorReading(
    sensorId: string,
    reading: PawPrintsReading | CivetPressureReading,
  ): void {
    const rule = this.deviceLinkRule;
    if (!rule.enabled || !this.opossumId || rule.source === 'opossum-button') return;
    const now = Date.now();
    if (rule.source === 'paw-button') {
      if (now - this.deviceLinkLastFiredAt < rule.cooldownMs) return;
      if (reading.type === 'trigger') this.fireDeviceLink(sensorId);
      return;
    }
    if (reading.type !== 'pressure') return;
    if (!this.deviceLinkActive && reading.kPa >= rule.thresholdKPa) {
      if (now - this.deviceLinkLastFiredAt < rule.cooldownMs) return;
      this.deviceLinkActive = true;
      this.fireDeviceLink(sensorId);
    } else if (this.deviceLinkActive && reading.kPa <= rule.releaseKPa) {
      this.stopDeviceLink();
    }
  }

  private handleLinkedOpossumButton(opossumId: string, event: OpossumButtonEvent): void {
    const rule = this.deviceLinkRule;
    if (rule.enabled && rule.source === 'opossum-button' && event.pressed.size > 0) {
      this.fireDeviceLink(opossumId);
    }
  }

  private fireDeviceLink(sourceId: string): void {
    const targetId = this.opossumId;
    if (!targetId) return;
    const rule = this.deviceLinkRule;
    this.deviceLinkLastFiredAt = Date.now();
    this.deviceLinkSourceId = sourceId;
    this.deviceLinkTargetId = targetId;
    const channels: Channel[] = rule.channel === 'both' ? ['A', 'B'] : [rule.channel];
    for (const channel of channels) {
      this.writeOpossum(targetId, {
        type: 'vibrateStart',
        channel,
        intensity: clamp(rule.intensity, 0, this.opossumLimit(channel)),
        pattern: rule.pattern,
      });
    }
    if (rule.source !== 'civet-pressure') {
      this.clearDeviceLinkPulseTimer();
      // stopDeviceLink() clears this timer itself; it must still read as engaged here.
      this.deviceLinkPulseTimer = setTimeout(() => this.stopDeviceLink(), LINK_PULSE_MS);
    }
  }

  /**
   * A held link output must end when its source stops reporting or its target is replaced: a
   * pressure link waits for a release reading, and a sensor that went away never sends one.
   */
  private checkDeviceLinkEndpoints(): void {
    if (!this.deviceLinkEngaged()) return;
    const sourcePresent =
      this.deviceLinkSourceId !== null &&
      (this.deviceLinkSourceId === this.sensorId || this.deviceLinkSourceId === this.opossumId);
    const targetPresent = this.deviceLinkTargetId === this.opossumId;
    if (!sourcePresent || !targetPresent) this.stopDeviceLink();
  }

  private deviceLinkEngaged(): boolean {
    return this.deviceLinkActive || this.deviceLinkPulseTimer !== null;
  }

  /** End the link output: stop the Opossum it drove, if that Opossum is still here. */
  private stopDeviceLink(): void {
    const targetId = this.deviceLinkTargetId;
    const engaged = this.deviceLinkEngaged();
    this.clearDeviceLink();
    if (engaged && targetId && this.handle.list().some((device) => device.id === targetId)) {
      void this.handle.emergencyStop(targetId).catch(ignore);
    }
  }

  private clearDeviceLink(): void {
    this.deviceLinkActive = false;
    this.deviceLinkSourceId = null;
    this.deviceLinkTargetId = null;
    this.clearDeviceLinkPulseTimer();
  }

  private clearDeviceLinkPulseTimer(): void {
    if (this.deviceLinkPulseTimer === null) return;
    clearTimeout(this.deviceLinkPulseTimer);
    this.deviceLinkPulseTimer = null;
  }

  private writeOpossum(id: string, command: OpossumCommand): void {
    void this.handle.executeOpossum(id, command).catch(ignore);
  }

  /** The module cap, lowered by the holder's cap for the attached Opossum (its own limit). */
  private opossumLimit(channel: Channel): number {
    const module = channel === 'A' ? this.opossumLimitA : this.opossumLimitB;
    const holder = this.opossum()?.limits;
    if (!holder) return module;
    return Math.min(module, channel === 'A' ? holder.a : holder.b);
  }

  private connectedCoyotes(): DGLabDevice[] {
    return this.handle
      .list()
      .filter((device): device is CoyoteSnapshot => isCoyote(device) && device.connected)
      .map((device) => this.coyoteViews.get(device.id))
      .filter((view): view is DGLabDevice => view !== undefined);
  }

  private sensor(): SensorSnapshot | null {
    if (!this.sensorId) return null;
    const device = this.handle.list().find((candidate) => candidate.id === this.sensorId);
    return device && isSensor(device) ? device : null;
  }

  private opossum(): OpossumSnapshot | null {
    if (!this.opossumId) return null;
    const device = this.handle.list().find((candidate) => candidate.id === this.opossumId);
    return device && isOpossum(device) && device.connected ? device : null;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** Attempt every action; report the first failure only after all of them ran. */
async function settleAll(actions: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(actions);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}
