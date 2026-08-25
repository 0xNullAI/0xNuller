/**
 * DGLabDevice — the product-wide DG-Lab BLE controller, backed by @dg-kit.
 *
 * Wraps `@dg-kit/transport-webbluetooth`'s `WebBluetoothDeviceClient` plus
 * `@dg-kit/protocol`'s `CoyoteProtocolAdapter`. The public API is preserved
 * so `use-device.ts` and `commands.ts` don't need to change.
 */

import {
  CoyoteProtocolAdapter,
  V2_DEVICE_NAME_PREFIX,
  PawPrintsSensorAdapter,
  CivetPressureSensorAdapter,
  OpossumVibrateAdapter,
  createEmptyOpossumState,
  runWithGattReadyRetry,
  type WebBluetoothProtocolAdapter,
  type BluetoothDeviceLike,
  type BluetoothRemoteGATTServerLike,
  type PawPrintsReading,
  type CivetPressureReading,
  type RequestedDevice,
  type OpossumState,
  type OpossumButtonEvent,
} from '@dg-kit/protocol';
import { WebBluetoothDeviceClient, requestDgLabDevice } from '@dg-kit/transport-webbluetooth';
import { DeviceCommandQueue } from '@dg-kit/safety';
import type {
  DeviceClient,
  DeviceState as KitDeviceState,
  WaveFrame as KitWaveFrame,
  SensorState,
  DeviceKind,
  OpossumVibrationPatternName,
  DeviceLinkRule,
} from '@dg-kit/core';
import { DEFAULT_DEVICE_LINK_RULE } from '@dg-kit/core';
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

/**
 * Optional override hook for non-browser runtimes (Tauri Android shell).
 * The default behaviour creates a `WebBluetoothDeviceClient`. The Tauri
 * shell passes a factory that creates a `TauriBlecDeviceClient` instead.
 */
export type DeviceClientFactory = (protocol: WebBluetoothProtocolAdapter) => DeviceClient;

/**
 * A picked, already-GATT-connected DG-Lab device plus its identified kind.
 * Declared in `@dg-kit/protocol` (both pickers return it); re-exported so
 * product surfaces share one transport-injection contract.
 */
export type { RequestedDevice };

/**
 * Override hook for `DeviceSession.connectDevice()`'s device-picking step.
 * Defaults to `requestDgLabDevice()` (a single Web Bluetooth chooser scoped
 * to all 4 kinds, auto-detected). The Tauri Android shell passes
 * `requestDgLabDeviceTauri()` instead — same one shared scan+picker across
 * all 4 kinds, auto-detected via `detectDeviceKind()`, just over plugin-blec
 * instead of `navigator.bluetooth.requestDevice()`.
 */
export type RequestDeviceFn = () => Promise<RequestedDevice>;

export interface DeviceInfo {
  version: DeviceVersion;
  name: string;
  battery: number;
}

export type WaveFrame = KitWaveFrame;

const DEFAULT_LIMIT = 50;

/** Current waveform definition kept locally so we can re-trigger plays. */
interface ChannelLocalState {
  waveformId: string | null;
  frames: WaveFrame[] | null;
  loop: boolean;
}

/**
 * One Coyote host's state, flattened for the UI and the device bar.
 *
 * Carries `id` because a session may now hold several Coyotes at once: every
 * row the user sees, and every targeted command, is addressed by this.
 */
export class DGLabDevice {
  private readonly protocol = new CoyoteProtocolAdapter();
  private readonly client: DeviceClient;
  /**
   * Every write has to go through this.
   *
   * Before the merge this class was the only place in the repo that bypassed
   * the queue and wrote to `client.execute()` directly. The consequence:
   * `SerialCommandQueue`'s emergency-stop jump-the-queue (which voids in-flight
   * commands via a generation counter) had no effect on it whatsoever — after
   * an emergency stop, old commands already on their way still landed on the
   * device. Now that device ownership has been hoisted up, one and the same
   * device would have both "writes that go through the queue" and "writes that
   * don't" — the most dangerous combination there is.
   */
  private readonly queue: DeviceCommandQueue;
  private onStateChange: (() => void) | null = null;

  private version: DeviceVersion = 'v3';
  private deviceName = '';
  private channelA: ChannelLocalState = { waveformId: null, frames: null, loop: true };
  private channelB: ChannelLocalState = { waveformId: null, frames: null, loop: true };

  // Tracked independently of the live protocol's own state so the 50 default
  // safety cap holds from construction — not just after a Coyote actually
  // connects. `@dg-kit/core`'s createEmptyDeviceState() defaults limitA/limitB
  // to 200 (the raw protocol range), which used to leak straight through
  // getState() into the UI/Opossum-clamping code whenever this DGLabDevice's
  // Coyote was never connected (an Opossum-only session, say) — silently
  // bypassing the documented 50 cap for anyone who only pairs the new device
  // kinds. See DeviceSession's shared-limit doc comment.
  private limitA = DEFAULT_LIMIT;
  private limitB = DEFAULT_LIMIT;

  /**
   * Identity of the attached host, once known.
   *
   * `BluetoothDevice.id` on web, the BLE address on Android — both stable
   * across a drop-and-reconnect, which is what lets `DeviceSession` put a
   * reconnecting device back into the slot it came from instead of growing a
   * second, duplicate row for it.
   */
  private deviceId: string | null = null;

  /**
   * Stable identity for this host: its device id once connected, otherwise
   * the slot's construction-time fallback.
   *
   * Never empty and never colliding with another slot's, because it keys the
   * device bar's rows and every targeted command. A row that collides is a
   * row React drops — and a device the user can no longer see is attached.
   */
  get id(): string {
    return this.deviceId ?? this.fallbackId;
  }

  /**
   * @param clientFactory optional factory invoked with the protocol adapter
   *   to create the transport-specific `DeviceClient`. Defaults to
   *   `WebBluetoothDeviceClient` for browser. The Tauri Android shell
   *   passes a factory that builds a `TauriBlecDeviceClient`.
   * @param fallbackId identity used until the transport reports a real device
   *   id (and if it never does — some `DeviceClientFactory` implementations
   *   do not expose one).
   */
  // Not a constructor parameter property: `erasableSyntaxOnly` is on in this
  // app, and those fail the build with TS1294 (typecheck alone does not catch
  // it).
  private readonly fallbackId: string;

  constructor(clientFactory?: DeviceClientFactory, fallbackId = 'coyote') {
    this.fallbackId = fallbackId;
    this.client = clientFactory
      ? clientFactory(this.protocol)
      : new WebBluetoothDeviceClient({ protocol: this.protocol });
    this.queue = new DeviceCommandQueue(this.client);
    this.protocol.subscribe(() => {
      this.onStateChange?.();
    });
  }

  /** Scan + connect; auto-detect V2/V3 by name prefix; default per-channel limit 50. */
  async connect(): Promise<DeviceInfo> {
    await this.client.connect();
    return this.afterConnect();
  }

  /**
   * Attach to a Coyote host that was already picked through the shared,
   * all-4-kinds device picker (see `DeviceSession`'s class doc) instead of
   * running this device's own `client.connect()` chooser prompt.
   * `gatt.connect()` (Web) / plugin-blec `connect()` (Tauri) must already
   * have been called by the caller.
   *
   * Only works when the configured `DeviceClient` exposes a `connectDevice`
   * method — true for both `WebBluetoothDeviceClient` (`@dg-kit/transport-
   * webbluetooth` 1.5.0+) and `TauriBlecDeviceClient` (`@dg-kit/transport-
   * tauri-blec` 1.7.0+). Kept as a runtime guard rather than a static type
   * requirement so a future/custom `DeviceClientFactory` without it still
   * fails with a clear error instead of a silent no-op.
   */
  async connectViaChosenDevice(
    device: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<DeviceInfo> {
    if (!hasConnectDevice(this.client)) {
      throw new Error('当前环境暂不支持免二次选择器直接连接 Coyote 主机');
    }
    await this.client.connectDevice(device, server);
    return this.afterConnect(device.id ?? null);
  }

  /** Shared post-connect bookkeeping for both `connect()` and `connectViaChosenDevice()`. */
  private async afterConnect(pickedId: string | null = null): Promise<DeviceInfo> {
    // Prefer the id of the device actually handed to us; fall back to asking
    // the transport (the `connect()` path runs the chooser inside the client,
    // so this side never sees the device object).
    this.deviceId = pickedId ?? clientDeviceId(this.client);
    const state = await this.client.getState();
    this.deviceName = state.deviceName ?? '';
    this.version = this.deviceName.startsWith(V2_DEVICE_NAME_PREFIX) ? 'v2' : 'v3';

    // A V3 host can retain its last output across a BLE drop. Treat every
    // successful attach (including a manual reconnect) as a new safety
    // boundary: invalidate commands left from the old link and zero the host
    // before the user starts controlling it again.
    this.stopAll();

    // The hardware cap is no longer written to the device. The setLimits(50,50)
    // that used to be here was the only place in the repo that rewrote
    // device-side state (V3's BF packet is persistent device state), so the same
    // Coyote ended up with a hardware cap of 50 after Chat had connected to it
    // and 200 after Agent had — whoever connected last wins, and a cap the user
    // raised elsewhere got silently pushed back down here. The cap is now a pure
    // software clamp: the smaller of "what the device reports" and "what the
    // user set".

    return {
      version: this.version,
      name: this.deviceName,
      battery: state.battery ?? 0,
    };
  }

  disconnect(): void {
    this.channelA = { waveformId: null, frames: null, loop: true };
    this.channelB = { waveformId: null, frames: null, loop: true };
    void this.client.disconnect();
  }

  /**
   * Set the absolute strength of a channel.
   *
   * NOTE: @dg-kit's `execute()` only exposes relative `adjustStrength`. For
   * the slider UX we want absolute. We translate target → delta off the
   * latest acked state. During rapid drags the V3 ack-gating means
   * intermediate values may be coalesced, but the final position always
   * wins (the slider settles at the user's release point).
   */
  setStrength(channel: 'A' | 'B', value: number): void {
    const state = this.protocol.getState();
    // Take the smaller of the two: the cap the device itself reports (possibly a
    // hardware value left behind by somewhere else) and the local software cap.
    // We no longer write the hardware, so the software side is the only gate the
    // user controls — it must never be skipped.
    const limit = Math.min(
      channel === 'A' ? state.limitA : state.limitB,
      channel === 'A' ? this.limitA : this.limitB,
    );
    const target = clamp(Math.round(value), 0, limit);
    const current = channel === 'A' ? state.strengthA : state.strengthB;
    const delta = target - current;
    if (delta === 0) return;
    void this.queue.enqueue({ type: 'adjustStrength', channel, delta }).catch(() => undefined);
  }

  setWave(channel: 'A' | 'B', frames: WaveFrame[], waveformId: string, loop = true): void {
    const local = channel === 'A' ? this.channelA : this.channelB;
    if (frames.length === 0) {
      local.waveformId = null;
      local.frames = null;
      local.loop = loop;
      void this.queue.enqueue({ type: 'stop', channel }).catch(() => undefined);
      return;
    }

    local.waveformId = waveformId;
    local.frames = frames.map((f) => [f[0], f[1]] as WaveFrame);
    local.loop = loop;

    void this.queue
      .enqueue({
        type: 'changeWave',
        channel,
        waveform: {
          id: waveformId,
          name: waveformId,
          frames: local.frames,
        },
        loop,
      })
      .catch(() => undefined);
  }

  stopWave(channel: 'A' | 'B'): void {
    const local = channel === 'A' ? this.channelA : this.channelB;
    local.waveformId = null;
    local.frames = null;
    void this.queue.enqueue({ type: 'stop', channel }).catch(() => undefined);
  }

  /** Emergency stop: zero both channels, stop every waveform. */
  stopAll(): void {
    this.channelA = { waveformId: null, frames: null, loop: true };
    this.channelB = { waveformId: null, frames: null, loop: true };
    // Go through the queue rather than calling client.emergencyStop() directly:
    // the queue's jump-the-queue bumps the generation, which voids the old
    // commands already on their way along with it. Calling the client directly
    // only stops the present moment; the next strength command waiting in the
    // queue still runs right after — the device starts moving again after an
    // emergency stop.
    void this.queue.enqueue({ type: 'emergencyStop' }).catch(() => undefined);
  }

  /** Update a channel's strength cap. Software side only — never written to the device. */
  setLimit(channel: 'A' | 'B', value: number): void {
    const next = clamp(Math.round(value), 0, 200);
    const previous = channel === 'A' ? this.limitA : this.limitB;
    this.limitA = channel === 'A' ? next : this.limitA;
    this.limitB = channel === 'B' ? next : this.limitB;
    // Lowering a cap must affect commands that were already queued under the
    // old cap. The emergency path invalidates them before they can land after
    // the settings change and raise output again.
    if (next < previous && this.getState().connected) this.stopAll();
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
    actualStrA: number;
    actualStrB: number;
    limitA: number;
    limitB: number;
  } {
    const s: KitDeviceState = this.protocol.getState();
    return {
      connected: s.connected,
      strengthA: s.strengthA,
      strengthB: s.strengthB,
      battery: s.battery ?? 0,
      waveActiveA: s.waveActiveA,
      waveActiveB: s.waveActiveB,
      waveIdA: s.currentWaveA ?? null,
      waveIdB: s.currentWaveB ?? null,
      // @dg-kit doesn't track ack-state separately; expose the current
      // strength as both the user-set and device-actual values.
      actualStrA: s.strengthA,
      actualStrB: s.strengthB,
      // Read from our own tracked fields, not the live protocol's raw
      // state — see the class-field comment on limitA/limitB above.
      limitA: this.limitA,
      limitB: this.limitB,
    };
  }

  /** This host's row for the UI and the shell's device bar. */
  getSummary(): CoyoteSummary {
    const s = this.getState();
    return {
      id: this.id,
      name: this.deviceName || '郊狼',
      version: this.version,
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

  setOnStateChange(cb: () => void): void {
    this.onStateChange = cb;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Reads the transport's device identity when it exposes one — true for both
 * `WebBluetoothDeviceClient` and `TauriBlecDeviceClient`. Duck-typed rather
 * than added to `@dg-kit/core`'s `DeviceClient`, so a custom
 * `DeviceClientFactory` without it keeps working (it just falls back to the
 * slot id).
 */
function clientDeviceId(client: DeviceClient): string | null {
  const id = (client as { deviceId?: unknown }).deviceId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Duck-types a `DeviceClient` for a `connectDevice(device, server)` method —
 * true for both `WebBluetoothDeviceClient` (`@dg-kit/transport-webbluetooth`
 * 1.5.0+) and `TauriBlecDeviceClient` (`@dg-kit/transport-tauri-blec`
 * 1.7.0+); false only for a custom `DeviceClientFactory` that doesn't
 * implement it.
 */
function hasConnectDevice(client: DeviceClient): client is DeviceClient & {
  connectDevice(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void>;
} {
  return typeof (client as { connectDevice?: unknown }).connectDevice === 'function';
}

// ---------------------------------------------------------------------------
// Multi-device session (Coyote + optional sensor + optional Opossum)
// ---------------------------------------------------------------------------

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
    case 'status':
      // Passive status ping, not a user-facing event.
      return null;
    default:
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
 * DeviceSession — manages a member's full BLE device set: any number of Coyote
 * hosts plus at most one sensor (paw-prints OR civet-edging — never both at
 * once) plus at most one Opossum vibration controller.
 *
 * Multiple Coyotes are held as one `DGLabDevice` *per device* rather than one
 * `DGLabDevice` juggling several: each carries its own protocol adapter, its
 * own `DeviceCommandQueue` and its own software caps, so two hosts can never
 * end up sharing one clamp state or one emergency-stop generation counter.
 * The transports were already built this way (both clients are scoped to one
 * device), so this is the shape the layer below already had.
 *
 * Still deliberately simplified: no two sensors at once even of different
 * kinds. Connecting a new sensor replaces whichever sensor was previously
 * connected.
 *
 * All four device kinds share ONE entry point — `connectDevice()` — built on
 * an injectable `RequestDeviceFn` that opens a single chooser scoped to
 * every known DG-Lab device kind, connects its GATT server, and identifies
 * which kind was picked via `detectDeviceKind()`. Defaults to `@dg-kit/
 * transport-webbluetooth`'s `requestDgLabDevice()` (Web Bluetooth); the
 * Tauri Android shell supplies `@dg-kit/transport-tauri-blec`'s
 * `requestDgLabDeviceTauri()` instead (plugin-blec scan + the host device
 * picker) — same one-shared-chooser experience on both platforms. A Coyote
 * pick is routed to `this.coyote.connectViaChosenDevice(device, server)`
 * (backed by the configured `DeviceClient`'s `connectDevice()` — both
 * `WebBluetoothDeviceClient` and `TauriBlecDeviceClient` implement it); a
 * sensor/Opossum pick goes straight to that device's own protocol adapter
 * via `attachSensor()`/`attachOpossum()`, which only need a `(device,
 * server)` pair and so work identically regardless of which transport
 * produced them.
 */
export class DeviceSession {
  /**
   * Every attached Coyote host, in attach order. Slot 0 is permanent: it is
   * created up front and never removed, so `coyote` below always has
   * something to return and the many existing `session.coyote.x()` call sites
   * keep working with no null check.
   */
  private readonly coyotes: DGLabDevice[] = [];
  private nextSlotSeq = 0;
  private readonly clientFactory: DeviceClientFactory | undefined;

  /**
   * The primary Coyote — the first *connected* one, or slot 0 when none is.
   *
   * This is what the whole single-device surface (`connected`, `strengthA`,
   * `setStrength`, ...) still points at, so nothing that predates multi-device
   * had to change. Resolved dynamically rather than pinned to slot 0: after
   * the first host is disconnected while a second is still running, a fixed
   * slot 0 would report "not connected" and the UI would claim nothing is
   * attached while a device is live on someone's body.
   */
  get coyote(): DGLabDevice {
    return this.coyotes.find((c) => c.getState().connected) ?? this.coyotes[0]!;
  }

  /** Every attached Coyote's row, primary first. */
  getCoyoteSummaries(): CoyoteSummary[] {
    const primaryId = this.coyote.id;
    return this.coyotes
      .filter((c) => c.getState().connected)
      .sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId))
      .map((c) => c.getSummary());
  }

  /**
   * Resolve a command's target host. An omitted id means the primary — that
   * is what every caller written before multi-device meant, and what old
   * Android clients (no hot update, so they stay on the wire for a long time)
   * still mean when they send a `DeviceCommand` with no `deviceId`.
   */
  coyoteById(deviceId?: string): DGLabDevice | null {
    if (!deviceId) return this.coyote;
    return this.coyotes.find((c) => c.id === deviceId) ?? null;
  }

  private sensorAdapter: PawPrintsSensorAdapter | CivetPressureSensorAdapter | null = null;
  private sensorKind: SensorKind | null = null;
  private sensorDevice: BluetoothDeviceLike | null = null;
  private sensorState: SensorState = { connected: false };
  private sensorLastEvent: string | null = null;
  private sensorLastValue: number | null = null;
  private sensorLastEventAt: number | null = null;
  private unsubscribeSensorReading: (() => void) | null = null;
  private unsubscribeSensorState: (() => void) | null = null;

  private opossumAdapter: OpossumVibrateAdapter | null = null;
  private opossumDevice: BluetoothDeviceLike | null = null;
  private opossumState: OpossumState = createEmptyOpossumState();
  private opossumLastButtons: string | null = null;
  private opossumLastButtonsAt: number | null = null;
  private opossumWaveIdA: string | null = null;
  private opossumWaveIdB: string | null = null;
  private unsubscribeOpossumButtons: (() => void) | null = null;
  private unsubscribeOpossumState: (() => void) | null = null;
  private deviceLinkRule: DeviceLinkRule = { ...DEFAULT_DEVICE_LINK_RULE };
  private deviceLinkActive = false;
  private deviceLinkLastFiredAt = Number.NEGATIVE_INFINITY;
  private deviceLinkPulseTimer: ReturnType<typeof setTimeout> | null = null;

  private onStateChange: (() => void) | null = null;
  private readonly requestDevice: RequestDeviceFn;
  private connectingDevice = false;

  constructor(
    clientFactory?: DeviceClientFactory,
    requestDevice?: RequestDeviceFn,
    safetyLimits?: DeviceSessionSafetyLimits,
  ) {
    this.requestDevice = requestDevice ?? requestDgLabDevice;
    this.clientFactory = clientFactory;
    if (safetyLimits) {
      this.coyoteLimitA = clamp(Math.round(safetyLimits.strengthA), 0, 200);
      this.coyoteLimitB = clamp(Math.round(safetyLimits.strengthB), 0, 200);
      this.opossumLimitA = clamp(Math.round(safetyLimits.intensityA), 0, 200);
      this.opossumLimitB = clamp(Math.round(safetyLimits.intensityB), 0, 200);
    }
    this.addCoyoteSlot();
  }

  /**
   * The caps every Coyote slot runs under, mirrored from the shared
   * device-safety settings by the host hook.
   *
   * Held here as well as on each `DGLabDevice` so a host attached *after* the
   * user lowered the cap still starts out clamped: without this it would come
   * up on `DGLabDevice`'s built-in 50 default, i.e. a safety control that
   * silently does not apply to the second device. Each host still enforces
   * its own copy — this only seeds them, it is not a shared clamp state.
   */
  private coyoteLimitA = DEFAULT_LIMIT;
  private coyoteLimitB = DEFAULT_LIMIT;
  // Direct DeviceSession callers historically supplied the cap per command,
  // so 200 preserves that API. Product hooks always seed these from shared
  // settings (default 50) in the constructor before a device can attach.
  private opossumLimitA = 200;
  private opossumLimitB = 200;

  /** Apply a channel cap to every attached host, and to every host attached later. */
  setCoyoteLimit(channel: 'A' | 'B', value: number): void {
    if (channel === 'A') this.coyoteLimitA = value;
    else this.coyoteLimitB = value;
    for (const coyote of this.coyotes) coyote.setLimit(channel, value);
    this.emit();
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
    if (!this.deviceLinkRule.enabled) {
      const wasActive = this.deviceLinkActive || this.deviceLinkPulseTimer != null;
      this.deviceLinkActive = false;
      this.clearDeviceLinkPulseTimer();
      if (wasActive) this.opossumStop();
    }
    this.emit();
  }

  /** Apply Opossum caps now as well as to future commands. */
  setOpossumLimits(limitA: number, limitB: number): void {
    const nextA = clamp(Math.round(limitA), 0, 200);
    const nextB = clamp(Math.round(limitB), 0, 200);
    const lowered = nextA < this.opossumLimitA || nextB < this.opossumLimitB;
    this.opossumLimitA = nextA;
    this.opossumLimitB = nextB;
    // Opossum writes are asynchronous and bursts carry delayed restores. Its
    // emergency stop also cancels those restores, so a live cap decrease
    // deliberately zeroes both channels instead of racing a second set write.
    if (lowered && this.opossumState.connected) this.opossumStop();
  }

  /** Add an empty Coyote slot, wired to this session's change notifications. */
  private addCoyoteSlot(): DGLabDevice {
    // The fallback id only shows up when the transport reports no device id;
    // it still has to be unique per slot, or two such hosts would collide on
    // the device bar and one row would silently vanish.
    const slot = new DGLabDevice(this.clientFactory, `coyote-${this.nextSlotSeq++}`);
    slot.setLimit('A', this.coyoteLimitA);
    slot.setLimit('B', this.coyoteLimitB);
    slot.setOnStateChange(() => this.emit());
    this.coyotes.push(slot);
    return slot;
  }

  /** Drop a slot. Slot 0 is permanent — see the `coyotes` field doc. */
  private removeCoyoteSlot(slot: DGLabDevice): void {
    const index = this.coyotes.indexOf(slot);
    if (index <= 0) return;
    this.coyotes.splice(index, 1);
  }

  setOnStateChange(cb: () => void): void {
    this.onStateChange = cb;
  }

  private emit(): void {
    this.onStateChange?.();
  }

  /** Existing single-Coyote connect flow — behavior unchanged. */
  async connectCoyote(): Promise<DeviceInfo> {
    return this.coyote.connect();
  }

  /**
   * Disconnect Coyote hosts — sensor and Opossum, if connected, stay up.
   * Distinct from `disconnectAll()`: the per-device rows in
   * `DeviceSafetyButton` now let a user manage each connection
   * independently, so the Coyote row's own "断开" must not silently also
   * drop the other two (that surprise was the point of the fix — see the
   * PR review that caught it).
   *
   * `deviceId` targets one host. Omitting it disconnects *every* Coyote,
   * which is what the single, un-targeted "断开" button in Chat's device
   * panel means: it is rendered from an aggregate row, so leaving a second
   * host silently attached after pressing it would make the UI disagree with
   * what is on the user's body.
   */
  disconnectCoyote(deviceId?: string): void {
    const targets = deviceId ? this.coyotes.filter((c) => c.id === deviceId) : [...this.coyotes];
    for (const target of targets) {
      target.disconnect();
      this.removeCoyoteSlot(target);
    }
    this.emit();
  }

  /**
   * Unified "connect device" entry point — opens ONE chooser scoped to
   * every known DG-Lab device kind (via the injected `requestDevice`, see
   * class doc), which also identifies which kind was picked and connects
   * its GATT server, then routes it to the right slot: Coyote goes to
   * `this.coyote.connectViaChosenDevice()`, sensors/Opossum go to
   * `attachSensor()`/`attachOpossum()`. Call it again to add another
   * device — each call opens a fresh chooser.
   */
  async connectDevice(): Promise<{ kind: DeviceKind; name: string; coyoteInfo?: DeviceInfo }> {
    // Control exposes the same action in its empty-state button and in the
    // shared device popover. A quick tap on both must not open two pickers or
    // race two attachments into the same disconnected slot.
    if (this.connectingDevice) throw new Error('正在连接中，请稍候');
    this.connectingDevice = true;
    try {
      return await this.connectDeviceOnce();
    } finally {
      this.connectingDevice = false;
    }
  }

  private async connectDeviceOnce(): Promise<{
    kind: DeviceKind;
    name: string;
    coyoteInfo?: DeviceInfo;
  }> {
    const { kind, device, server } = await this.requestDevice();

    // The picker has already connected GATT. Rejecting a device already held
    // by this session must happen outside the generic failure cleanup below,
    // or that cleanup disconnects the healthy connection the UI already owns.
    // Replacing an auxiliary slot with the exact same device has the same
    // problem: disconnecting the old adapter tears the new one down too.
    const pickedId = device.id ?? null;
    const duplicateCoyote =
      kind === 'coyote' &&
      pickedId !== null &&
      this.coyotes.some((c) => c.id === pickedId && c.getState().connected);
    const duplicateSensor =
      (kind === 'paw-prints' || kind === 'civet-edging') &&
      pickedId !== null &&
      this.sensorDevice?.id === pickedId &&
      this.sensorState.connected;
    const duplicateOpossum =
      kind === 'opossum' &&
      pickedId !== null &&
      this.opossumDevice?.id === pickedId &&
      this.opossumState.connected;
    if (duplicateCoyote || duplicateSensor || duplicateOpossum) {
      throw new Error('设备已连接');
    }

    let coyoteInfo: DeviceInfo | undefined;
    try {
      if (kind === 'coyote') {
        coyoteInfo = await this.attachCoyote(device, server);
      } else if (kind === 'paw-prints' || kind === 'civet-edging') {
        await this.attachSensor(kind, device, server);
      } else {
        await this.attachOpossum(device, server);
      }
    } catch (error) {
      if (device.gatt?.connected) device.gatt.disconnect();
      throw error;
    }

    return { kind, name: device.name ?? '', coyoteInfo };
  }

  /**
   * Route a picked Coyote host into a slot.
   *
   * Slot choice, in order: the slot that already holds this exact device id
   * (a reconnect — it keeps its identity, so the device bar row and any
   * pending targeted commands stay pointed at the same host rather than
   * growing a duplicate), then any disconnected slot, then a fresh one.
   */
  private async attachCoyote(
    device: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<DeviceInfo> {
    const pickedId = device.id ?? null;
    const sameDevice = pickedId ? this.coyotes.find((c) => c.id === pickedId) : undefined;
    const reusable = sameDevice ?? this.coyotes.find((c) => !c.getState().connected);
    const slot = reusable ?? this.addCoyoteSlot();

    try {
      return await slot.connectViaChosenDevice(device, server);
    } catch (error) {
      // A slot opened just for this attempt must not linger: it would show up
      // as a dead row and as one more thing the stop button walks over.
      if (!reusable) this.removeCoyoteSlot(slot);
      throw error;
    }
  }

  private async attachSensor(
    kind: SensorKind,
    device: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<void> {
    const adapter: PawPrintsSensorAdapter | CivetPressureSensorAdapter =
      kind === 'paw-prints' ? new PawPrintsSensorAdapter() : new CivetPressureSensorAdapter();
    // Connect the new sensor BEFORE tearing down whatever was there before
    // (v1: one sensor at a time) — if onConnected() throws (a flaky/wrong
    // device picked mid-swap), the previous, working sensor must still be
    // intact rather than already disconnected with nothing to fall back to.
    // Wrapped in a retry: these sensors share Coyote's exact GATT skeleton,
    // so they hit the same "gatt.connect() resolves before service
    // discovery" Web Bluetooth race on a first-time pairing.
    await runWithGattReadyRetry(() => adapter.onConnected({ device, server }), {});
    this.attachConnectedSensor(kind, adapter, device);
  }

  /**
   * Shared bookkeeping once a sensor adapter's `onConnected()` has already
   * resolved — factored out of `attachSensor()` (the only caller) so the
   * "replace whatever was there before" swap logic reads on its own.
   */
  private attachConnectedSensor(
    kind: SensorKind,
    adapter: PawPrintsSensorAdapter | CivetPressureSensorAdapter,
    device: BluetoothDeviceLike,
  ): void {
    // Replace whatever was there before only now that the new sensor is
    // confirmed connected (v1: one sensor at a time) — same ordering
    // guarantee as the inline version this was factored out of.
    this.disconnectSensor();

    this.sensorKind = kind;
    this.sensorAdapter = adapter;
    this.sensorDevice = device;
    this.sensorState = adapter.getState();
    device.addEventListener('gattserverdisconnected', this.handleSensorGattDisconnected);

    this.unsubscribeSensorState = adapter.onStateChanged((state) => {
      this.sensorState = state;
      this.emit();
    });
    this.unsubscribeSensorReading = adapter.subscribe(
      (reading: PawPrintsReading | CivetPressureReading) => {
        const described =
          kind === 'paw-prints'
            ? describePawPrintsReading(reading as PawPrintsReading)
            : describeCivetReading(reading as CivetPressureReading);
        if (!described) return;
        this.sensorLastEvent = described.text;
        this.sensorLastValue = described.value;
        this.sensorLastEventAt = Date.now();
        this.emit();
        this.handleLinkedSensorReading(reading);
      },
    );

    this.emit();
  }

  private readonly handleSensorGattDisconnected = (): void => {
    this.disconnectSensor();
  };

  disconnectSensor(): void {
    if (this.sensorDevice) {
      this.sensorDevice.removeEventListener(
        'gattserverdisconnected',
        this.handleSensorGattDisconnected,
      );
      const gatt = this.sensorDevice.gatt;
      if (gatt?.connected) gatt.disconnect();
    }
    this.unsubscribeSensorReading?.();
    this.unsubscribeSensorReading = null;
    this.unsubscribeSensorState?.();
    this.unsubscribeSensorState = null;
    void this.sensorAdapter?.onDisconnected();
    this.sensorAdapter = null;
    this.sensorKind = null;
    this.sensorDevice = null;
    this.sensorState = { connected: false };
    this.sensorLastEvent = null;
    this.sensorLastValue = null;
    this.sensorLastEventAt = null;
    this.emit();
  }

  private async attachOpossum(
    device: BluetoothDeviceLike,
    server: BluetoothRemoteGATTServerLike,
  ): Promise<void> {
    const adapter = new OpossumVibrateAdapter();
    // Same ordering fix as attachSensor(): connect first, tear down the old
    // Opossum only once the new one has actually succeeded. Same GATT-ready
    // retry as attachSensor() too — see that call site's comment.
    await runWithGattReadyRetry(() => adapter.onConnected({ device, server }), {});
    this.attachConnectedOpossum(adapter, device);
  }

  /**
   * Shared bookkeeping once an Opossum adapter's `onConnected()` has already
   * resolved — factored out of `attachOpossum()` (the only caller), mirroring
   * `attachConnectedSensor()`.
   */
  private attachConnectedOpossum(
    adapter: OpossumVibrateAdapter,
    device: BluetoothDeviceLike,
  ): void {
    this.disconnectOpossum();

    this.opossumAdapter = adapter;
    this.opossumDevice = device;
    this.opossumState = adapter.getState();
    device.addEventListener('gattserverdisconnected', this.handleOpossumGattDisconnected);

    this.unsubscribeOpossumState = adapter.onStateChanged((state) => {
      this.opossumState = state;
      this.emit();
    });
    this.unsubscribeOpossumButtons = adapter.subscribeButtons((event: OpossumButtonEvent) => {
      this.opossumLastButtons = event.pressed.size > 0 ? [...event.pressed].join('+') : null;
      this.opossumLastButtonsAt = Date.now();
      this.emit();
      this.handleLinkedOpossumButton(event);
    });

    this.emit();
  }

  private readonly handleOpossumGattDisconnected = (): void => {
    this.disconnectOpossum();
  };

  private handleLinkedSensorReading(reading: PawPrintsReading | CivetPressureReading): void {
    const rule = this.deviceLinkRule;
    if (!rule.enabled || !this.opossumAdapter || rule.source === 'opossum-button') return;
    const now = Date.now();
    if (rule.source === 'paw-button') {
      if (now - this.deviceLinkLastFiredAt < rule.cooldownMs) return;
      if (reading.type === 'trigger') this.fireDeviceLink();
      return;
    }
    if (reading.type !== 'pressure') return;
    if (!this.deviceLinkActive && reading.kPa >= rule.thresholdKPa) {
      if (now - this.deviceLinkLastFiredAt < rule.cooldownMs) return;
      this.deviceLinkActive = true;
      this.fireDeviceLink();
    } else if (this.deviceLinkActive && reading.kPa <= rule.releaseKPa) {
      this.deviceLinkActive = false;
      this.opossumStop();
    }
  }

  private handleLinkedOpossumButton(event: OpossumButtonEvent): void {
    const rule = this.deviceLinkRule;
    if (rule.enabled && rule.source === 'opossum-button' && event.pressed.size > 0) {
      this.fireDeviceLink();
    }
  }

  private fireDeviceLink(): void {
    if (!this.opossumAdapter) return;
    const rule = this.deviceLinkRule;
    this.deviceLinkLastFiredAt = Date.now();
    const channels: ('A' | 'B')[] = rule.channel === 'both' ? ['A', 'B'] : [rule.channel];
    for (const channel of channels) {
      this.opossumAdapter.setVibrationPattern(channel, rule.pattern);
      this.setOpossumIntensity(
        channel,
        rule.intensity,
        channel === 'A' ? this.opossumLimitA : this.opossumLimitB,
      );
    }
    if (rule.source !== 'civet-pressure') {
      this.clearDeviceLinkPulseTimer();
      this.deviceLinkPulseTimer = setTimeout(() => {
        this.deviceLinkPulseTimer = null;
        this.opossumStop();
      }, 500);
    }
  }

  private clearDeviceLinkPulseTimer(): void {
    if (this.deviceLinkPulseTimer == null) return;
    clearTimeout(this.deviceLinkPulseTimer);
    this.deviceLinkPulseTimer = null;
  }

  disconnectOpossum(): void {
    this.clearDeviceLinkPulseTimer();
    if (this.opossumDevice) {
      this.opossumDevice.removeEventListener(
        'gattserverdisconnected',
        this.handleOpossumGattDisconnected,
      );
      const gatt = this.opossumDevice.gatt;
      if (gatt?.connected) gatt.disconnect();
    }
    this.unsubscribeOpossumButtons?.();
    this.unsubscribeOpossumButtons = null;
    this.unsubscribeOpossumState?.();
    this.unsubscribeOpossumState = null;
    void this.opossumAdapter?.onDisconnected();
    this.opossumAdapter = null;
    this.opossumDevice = null;
    this.opossumState = createEmptyOpossumState();
    this.opossumWaveIdA = null;
    this.opossumWaveIdB = null;
    this.opossumLastButtons = null;
    this.opossumLastButtonsAt = null;
    this.emit();
  }

  // Bumped by every intensity-changing call (setOpossumIntensity/opossumStop),
  // per channel. opossumBurst's delayed restore checks this before applying
  // — see its comment below.
  private opossumIntensityGeneration: Record<'A' | 'B', number> = { A: 0, B: 0 };

  /** Absolute set, clamped to [0, limit] — mirrors `DGLabDevice.setStrength`. */
  setOpossumIntensity(channel: 'A' | 'B', value: number, limit: number): void {
    if (!this.opossumAdapter) return;
    this.opossumIntensityGeneration[channel] += 1;
    const configuredLimit = channel === 'A' ? this.opossumLimitA : this.opossumLimitB;
    const target = clamp(Math.round(value), 0, Math.min(limit, configuredLimit));
    void this.opossumAdapter
      .setIntensity(channel === 'A' ? target : 'unchanged', channel === 'B' ? target : 'unchanged')
      .catch(() => undefined);
  }

  /**
   * Apply the shared waveform library to an Opossum channel. Opossum has no
   * frequency axis, so each 25 ms Coyote frame becomes one amplitude sample;
   * the intensity control remains the independent safety-capped ceiling.
   */
  setOpossumWaveform(channel: 'A' | 'B', frames: WaveFrame[], waveformId: string): void {
    if (!this.opossumAdapter || frames.length === 0) return;
    const envelope = frames.map((frame) => clamp(Math.round(frame[1]), 0, 100));
    this.opossumAdapter.setVibrationPattern(channel, envelope);
    if (channel === 'A') this.opossumWaveIdA = waveformId;
    else this.opossumWaveIdB = waveformId;
    this.emit();
  }

  setOpossumPattern(channel: 'A' | 'B', pattern: OpossumVibrationPatternName): void {
    this.opossumAdapter?.setVibrationPattern(channel, pattern);
    this.emit();
  }

  /** Fire-and-restore burst convenience, mirroring Coyote's `burst` command. */
  opossumBurst(channel: 'A' | 'B', strength: number, durationMs: number, limit: number): void {
    if (!this.opossumAdapter) return;
    const previous = channel === 'A' ? this.opossumState.intensityA : this.opossumState.intensityB;
    this.setOpossumIntensity(channel, strength, limit);
    // setOpossumIntensity() above already bumped the generation for this
    // burst's own "jump to strength" write — capture it *after* that call so
    // the restore below only fires if nothing else touched this channel in
    // the meantime (a stop, another burst, a manual adjustment).
    const generation = this.opossumIntensityGeneration[channel];
    setTimeout(
      () => {
        if (this.opossumIntensityGeneration[channel] !== generation) return;
        this.setOpossumIntensity(channel, Math.min(previous, limit), limit);
      },
      Math.max(100, durationMs),
    );
  }

  /** Stop one or both Opossum channels immediately (no restore). */
  opossumStop(channel?: 'A' | 'B'): void {
    if (!this.opossumAdapter) return;
    if (!channel) {
      this.opossumIntensityGeneration.A += 1;
      this.opossumIntensityGeneration.B += 1;
      void this.opossumAdapter.emergencyStop();
      return;
    }
    this.opossumIntensityGeneration[channel] += 1;
    void this.opossumAdapter
      .setIntensity(channel === 'A' ? 0 : 'unchanged', channel === 'B' ? 0 : 'unchanged')
      .catch(() => undefined);
  }

  /**
   * LED color for the sensor or Opossum slot, whichever is connected.
   * `color` is the device family's discrete 0-7 indicator enum (0=熄灭,
   * 1=黄, 2=红, 3=紫, 4=蓝, 5=青, 6=绿, 7=白) — not an RGB/continuous byte.
   * @dg-kit/protocol clamps to this range too; clamping here as well keeps
   * this call site self-documenting and avoids depending on that as the
   * only guard.
   */
  setLedColor(target: 'sensor' | 'opossum', color: number): void {
    const byte = clamp(Math.round(color), 0, 7);
    if (target === 'sensor') {
      if (this.sensorAdapter instanceof PawPrintsSensorAdapter) {
        void this.sensorAdapter.setLedSolid(byte).catch(() => undefined);
      } else if (this.sensorAdapter instanceof CivetPressureSensorAdapter) {
        // civet-edging's setIndicatorColor() re-sends the 0x50 packet with
        // the current streaming state preserved, unlike
        // startPressureReporting()/stopPressureReporting() which would
        // force streaming on/off as a side effect of a purely cosmetic
        // color change.
        void this.sensorAdapter.setIndicatorColor(byte).catch(() => undefined);
      }
    } else if (this.opossumAdapter) {
      void this.opossumAdapter.setLed(byte, true).catch(() => undefined);
    }
  }

  /**
   * Emergency stop across every connected device (every Coyote + Opossum).
   * Sensors have no output to zero.
   *
   * Walks the whole `coyotes` list, not `this.coyote`: this is the function
   * the shell's global stop button reaches through the safety bus, and a stop
   * that zeroes only the primary would leave every other attached host
   * running at its last commanded strength with the user believing they had
   * already stopped everything. Each host's `stopAll()` goes through its own
   * queue's jump-the-queue path, so commands already in flight for that host
   * are voided too.
   */
  stopAllOutputs(): void {
    for (const coyote of this.coyotes) coyote.stopAll();
    this.opossumStop();
  }

  /** Tear down the whole session — used when disconnecting or leaving the room. */
  disconnectAll(): void {
    for (const coyote of this.coyotes) coyote.disconnect();
    // Keep slot 0 (permanent, see the field doc); drop the extras so a
    // re-used session does not start out with dead rows.
    this.coyotes.splice(1);
    this.disconnectSensor();
    this.disconnectOpossum();
  }

  getSensorSummary(): SensorSummary | null {
    if (!this.sensorKind) return null;
    return {
      kind: this.sensorKind,
      connected: this.sensorState.connected,
      deviceName: this.sensorState.deviceName ?? '',
      battery: this.sensorState.battery ?? null,
      lastEvent: this.sensorLastEvent,
      lastValue: this.sensorLastValue,
      lastEventAt: this.sensorLastEventAt,
    };
  }

  getOpossumSummary(): OpossumSummary | null {
    if (!this.opossumAdapter) return null;
    return {
      connected: this.opossumState.connected,
      deviceName: this.opossumState.deviceName ?? '',
      battery: this.opossumState.battery ?? null,
      intensityA: this.opossumState.intensityA,
      intensityB: this.opossumState.intensityB,
      limitA: this.opossumLimitA,
      limitB: this.opossumLimitB,
      waveIdA: this.opossumWaveIdA,
      waveIdB: this.opossumWaveIdB,
      lastButtons: this.opossumLastButtons,
      lastButtonsAt: this.opossumLastButtonsAt,
      patternA: this.opossumState.patternA,
      patternB: this.opossumState.patternB,
    };
  }
}
