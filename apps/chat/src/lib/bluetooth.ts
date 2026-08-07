/**
 * DGLabDevice — DG-Chat's BLE controller, now backed by @dg-kit.
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
  type OpossumState,
  type OpossumButtonEvent,
} from '@dg-kit/protocol';
import { WebBluetoothDeviceClient, requestDgLabDevice } from '@dg-kit/transport-webbluetooth';
import type {
  DeviceClient,
  DeviceState as KitDeviceState,
  WaveFrame as KitWaveFrame,
  SensorState,
  DeviceKind,
} from '@dg-kit/core';

/**
 * Optional override hook for non-browser runtimes (Tauri Android shell).
 * The default behaviour creates a `WebBluetoothDeviceClient`. The Tauri
 * shell passes a factory that creates a `TauriBlecDeviceClient` instead.
 */
export type DeviceClientFactory = (protocol: WebBluetoothProtocolAdapter) => DeviceClient;

/**
 * A picked, already-GATT-connected DG-Lab device plus its identified kind —
 * the shape both `@dg-kit/transport-webbluetooth`'s `requestDgLabDevice()`
 * (Web Bluetooth) and `@dg-kit/transport-tauri-blec`'s
 * `requestDgLabDeviceTauri()` (Tauri Android) return.
 */
export interface RequestedDevice {
  kind: DeviceKind;
  device: BluetoothDeviceLike;
  server: BluetoothRemoteGATTServerLike;
}

/**
 * Override hook for `DeviceSession.connectDevice()`'s device-picking step.
 * Defaults to `requestDgLabDevice()` (a single Web Bluetooth chooser scoped
 * to all 4 kinds, auto-detected). The Tauri Android shell passes
 * `requestDgLabDeviceTauri()` instead — same one shared scan+picker across
 * all 4 kinds, auto-detected via `detectDeviceKind()`, just over plugin-blec
 * instead of `navigator.bluetooth.requestDevice()`.
 */
export type RequestDeviceFn = () => Promise<RequestedDevice>;

export type DeviceVersion = 'v2' | 'v3';

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

export class DGLabDevice {
  private readonly protocol = new CoyoteProtocolAdapter();
  private readonly client: DeviceClient;
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
   * @param clientFactory optional factory invoked with the protocol adapter
   *   to create the transport-specific `DeviceClient`. Defaults to
   *   `WebBluetoothDeviceClient` for browser. The Tauri Android shell
   *   passes a factory that builds a `TauriBlecDeviceClient`.
   */
  constructor(clientFactory?: DeviceClientFactory) {
    this.client = clientFactory
      ? clientFactory(this.protocol)
      : new WebBluetoothDeviceClient({ protocol: this.protocol });
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
    return this.afterConnect();
  }

  /** Shared post-connect bookkeeping for both `connect()` and `connectViaChosenDevice()`. */
  private async afterConnect(): Promise<DeviceInfo> {
    const state = await this.client.getState();
    this.deviceName = state.deviceName ?? '';
    this.version = this.deviceName.startsWith(V2_DEVICE_NAME_PREFIX) ? 'v2' : 'v3';

    // DG-Chat ships with a per-channel safety cap of 50 (0~200 protocol range).
    await this.protocol.setLimits(DEFAULT_LIMIT, DEFAULT_LIMIT);
    this.limitA = DEFAULT_LIMIT;
    this.limitB = DEFAULT_LIMIT;

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
    const limit = channel === 'A' ? state.limitA : state.limitB;
    const target = clamp(Math.round(value), 0, limit);
    const current = channel === 'A' ? state.strengthA : state.strengthB;
    const delta = target - current;
    if (delta === 0) return;
    void this.client
      .execute({ type: 'adjustStrength', channel, delta })
      .catch(() => undefined);
  }

  setWave(channel: 'A' | 'B', frames: WaveFrame[], waveformId: string, loop = true): void {
    const local = channel === 'A' ? this.channelA : this.channelB;
    if (frames.length === 0) {
      local.waveformId = null;
      local.frames = null;
      local.loop = loop;
      void this.client.execute({ type: 'stop', channel }).catch(() => undefined);
      return;
    }

    local.waveformId = waveformId;
    local.frames = frames.map((f) => [f[0], f[1]] as WaveFrame);
    local.loop = loop;

    void this.client
      .execute({
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
    void this.client.execute({ type: 'stop', channel }).catch(() => undefined);
  }

  /** Emergency stop: zero both channels, kill all waves. */
  stopAll(): void {
    this.channelA = { waveformId: null, frames: null, loop: true };
    this.channelB = { waveformId: null, frames: null, loop: true };
    void this.client.emergencyStop().catch(() => undefined);
  }

  /** Update one channel's strength soft-limit (the other channel is preserved). */
  setLimit(channel: 'A' | 'B', value: number): void {
    const next = clamp(Math.round(value), 0, 200);
    this.limitA = channel === 'A' ? next : this.limitA;
    this.limitB = channel === 'B' ? next : this.limitB;
    void this.protocol.setLimits(this.limitA, this.limitB).catch(() => undefined);
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

  setOnStateChange(cb: () => void): void {
    this.onStateChange = cb;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Duck-types a `DeviceClient` for a `connectDevice(device, server)` method —
 * true for both `WebBluetoothDeviceClient` (`@dg-kit/transport-webbluetooth`
 * 1.5.0+) and `TauriBlecDeviceClient` (`@dg-kit/transport-tauri-blec`
 * 1.7.0+); false only for a custom `DeviceClientFactory` that doesn't
 * implement it.
 */
function hasConnectDevice(
  client: DeviceClient,
): client is DeviceClient & {
  connectDevice(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void>;
} {
  return typeof (client as { connectDevice?: unknown }).connectDevice === 'function';
}

// ---------------------------------------------------------------------------
// Multi-device session (Coyote + optional sensor + optional Opossum)
// ---------------------------------------------------------------------------

export type SensorKind = Extract<DeviceKind, 'paw-prints' | 'civet-edging'>;

export interface SensorSummary {
  kind: SensorKind;
  connected: boolean;
  deviceName: string;
  battery: number | null;
  /** Human-readable summary of the most recent reading. Informational only. */
  lastEvent: string | null;
  /** Raw numeric value of the last reading, when the reading type has one
   *  (civet-edging pressure in kPa; paw-prints trigger parameterValue). */
  lastValue: number | null;
  lastEventAt: number | null;
}

export interface OpossumSummary {
  connected: boolean;
  deviceName: string;
  battery: number | null;
  intensityA: number;
  intensityB: number;
  /** Names of buttons currently reported pressed, joined with '+', or null. */
  lastButtons: string | null;
  lastButtonsAt: number | null;
}

/** Turn a raw paw-prints notification into a short human-readable summary + optional numeric value. */
function describePawPrintsReading(reading: PawPrintsReading): { text: string; value: number | null } | null {
  switch (reading.type) {
    case 'trigger':
      return { text: `触发事件 #${reading.eventId}（参数 ${reading.parameterValue}）`, value: reading.parameterValue };
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

function describeCivetReading(reading: CivetPressureReading): { text: string; value: number | null } {
  return { text: `压力 ${reading.kPa.toFixed(1)} kPa`, value: reading.kPa };
}

/**
 * DeviceSession — manages a member's full BLE device set: exactly one Coyote
 * plus at most one sensor (paw-prints OR civet-edging — never both at once)
 * plus at most one Opossum vibration controller.
 *
 * v1 scope, deliberately simplified: no multi-Coyote, no two sensors at
 * once even of different kinds. Connecting a new sensor replaces whichever
 * sensor was previously connected. This mirrors the brief's "one of each
 * kind is a reasonable v1 scope."
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
  readonly coyote: DGLabDevice;

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
  private unsubscribeOpossumButtons: (() => void) | null = null;
  private unsubscribeOpossumState: (() => void) | null = null;

  private onStateChange: (() => void) | null = null;
  private readonly requestDevice: RequestDeviceFn;

  constructor(clientFactory?: DeviceClientFactory, requestDevice?: RequestDeviceFn) {
    this.requestDevice = requestDevice ?? requestDgLabDevice;
    this.coyote = new DGLabDevice(clientFactory);
    this.coyote.setOnStateChange(() => this.emit());
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
   * Disconnect only the Coyote host — sensor and Opossum, if connected,
   * stay up. Distinct from `disconnectAll()`: the per-device rows in
   * `DeviceSafetyButton` now let a user manage each connection
   * independently, so the Coyote row's own "断开" must not silently also
   * drop the other two (that surprise was the point of the fix — see the
   * PR review that caught it).
   */
  disconnectCoyote(): void {
    this.coyote.disconnect();
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
    const { kind, device, server } = await this.requestDevice();

    let coyoteInfo: DeviceInfo | undefined;
    try {
      if (kind === 'coyote') {
        coyoteInfo = await this.coyote.connectViaChosenDevice(device, server);
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
    this.unsubscribeSensorReading = adapter.subscribe((reading: PawPrintsReading | CivetPressureReading) => {
      const described =
        kind === 'paw-prints'
          ? describePawPrintsReading(reading as PawPrintsReading)
          : describeCivetReading(reading as CivetPressureReading);
      if (!described) return;
      this.sensorLastEvent = described.text;
      this.sensorLastValue = described.value;
      this.sensorLastEventAt = Date.now();
      this.emit();

      // TODO(cross-device consent): a sensor event like this is exactly the
      // kind of signal a user might eventually want to wire into "my
      // button press nudges someone else's device" — but doing that
      // automatically, without the *receiving* member explicitly opting
      // in, would let one person's sensor silently drive another person's
      // hardware. That needs its own consent/permission UI (mirroring the
      // existing `allowAi` opt-in toggle for AI control) before it can be
      // built safely. Until that exists, sensor events stay strictly
      // informational: surfaced in the room UI via MemberState.sensorLastEvent,
      // never used here to construct/send a DeviceCommand automatically.
    });

    this.emit();
  }

  private readonly handleSensorGattDisconnected = (): void => {
    this.disconnectSensor();
  };

  disconnectSensor(): void {
    if (this.sensorDevice) {
      this.sensorDevice.removeEventListener('gattserverdisconnected', this.handleSensorGattDisconnected);
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

  private async attachOpossum(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void> {
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
  private attachConnectedOpossum(adapter: OpossumVibrateAdapter, device: BluetoothDeviceLike): void {
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
      // TODO(cross-device consent): see the identical note in
      // attachSensor() above — Opossum button presses are informational
      // only, for the same reason (no receiving-side consent UI yet).
    });

    this.emit();
  }

  private readonly handleOpossumGattDisconnected = (): void => {
    this.disconnectOpossum();
  };

  disconnectOpossum(): void {
    if (this.opossumDevice) {
      this.opossumDevice.removeEventListener('gattserverdisconnected', this.handleOpossumGattDisconnected);
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
    const target = clamp(Math.round(value), 0, limit);
    void this.opossumAdapter
      .setIntensity(channel === 'A' ? target : 'unchanged', channel === 'B' ? target : 'unchanged')
      .catch(() => undefined);
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
    setTimeout(() => {
      if (this.opossumIntensityGeneration[channel] !== generation) return;
      this.setOpossumIntensity(channel, Math.min(previous, limit), limit);
    }, Math.max(100, durationMs));
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

  /** Emergency stop across every connected device (Coyote + Opossum). Sensors have no output to zero. */
  stopAllOutputs(): void {
    this.coyote.stopAll();
    this.opossumStop();
  }

  /** Tear down the whole session — used when disconnecting or leaving the room. */
  disconnectAll(): void {
    this.coyote.disconnect();
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
      lastButtons: this.opossumLastButtons,
      lastButtonsAt: this.opossumLastButtonsAt,
    };
  }
}
