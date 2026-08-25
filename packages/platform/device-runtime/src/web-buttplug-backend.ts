import {
  DEVICE_RUNTIME_SCHEMA_VERSION,
  MAX_DEVICES,
  MAX_FEATURES_PER_DEVICE,
  MAX_TOTAL_FEATURES,
  type BackendCapability,
  type BackendDevice,
  type DeviceBackend,
  type DeviceBackendSession,
} from './contracts.js';

export type EmbeddedButtplugUnsupportedCode =
  'browser-environment-required' | 'secure-context-required' | 'web-bluetooth-required';

export class EmbeddedButtplugUnsupportedError extends Error {
  override readonly name = 'EmbeddedButtplugUnsupportedError';
  readonly code: EmbeddedButtplugUnsupportedCode;

  constructor(code: EmbeddedButtplugUnsupportedCode) {
    super(code);
    this.code = code;
  }
}

export interface EmbeddedButtplugBrowserEnvironment {
  readonly browser: boolean;
  readonly secureContext: boolean;
  readonly webBluetooth: boolean;
}

interface InstalledFeatureMetadata {
  FeatureIndex: number;
  Output?: Record<string, { Value?: unknown }>;
  Input?: Record<string, { Value?: unknown; Command?: unknown }>;
}

interface EmbeddedButtplugFeature {
  /** Present in the exact pinned buttplug 4.0.2 implementation. */
  readonly _feature?: unknown;
  hasOutput(type: unknown): boolean;
  hasInput(type: unknown): boolean;
  runOutput(command: unknown): Promise<void>;
  runInput(inputType: unknown, inputCommand: unknown): Promise<unknown>;
}

interface EmbeddedButtplugDevice {
  readonly index: number;
  readonly features: Map<number, EmbeddedButtplugFeature>;
  stop(): Promise<void>;
}

interface EmbeddedButtplugClient {
  readonly connected: boolean;
  readonly isScanning: boolean;
  readonly devices: Map<number, EmbeddedButtplugDevice>;
  connect(connector: unknown): Promise<void>;
  startScanning(): Promise<void>;
  stopAllDevices(): Promise<void>;
  on(event: string, listener: (value?: unknown) => void): unknown;
  off(event: string, listener: (value?: unknown) => void): unknown;
}

interface EmbeddedButtplugConnector {
  disconnect(): Promise<void>;
}

interface EmbeddedButtplugApi {
  readonly client: EmbeddedButtplugClient;
  readonly connector: EmbeddedButtplugConnector;
  readonly outputVibrate: unknown;
  readonly inputBattery: unknown;
  readonly inputRssi: unknown;
  readonly inputRead: unknown;
  vibrateSteps(steps: number): unknown;
}

/** @internal Test seam; production always uses the pinned embedded WASM connector. */
export interface WebEmbeddedButtplugBackendOptions {
  environment?: () => EmbeddedButtplugBrowserEnvironment;
  loadApi?: () => Promise<EmbeddedButtplugApi>;
}

interface VibrateRoute {
  kind: 'vibrate';
  nativeDeviceId: string;
  nativeFeatureId: string;
  feature: EmbeddedButtplugFeature;
  stepCount: number;
}

interface InputRoute {
  kind: 'battery' | 'rssi';
  nativeDeviceId: string;
  nativeFeatureId: string;
  feature: EmbeddedButtplugFeature;
  inputType: unknown;
  inputRange: readonly [number, number] | null;
}

type CapabilityRoute = VibrateRoute | InputRoute;

interface MappedCapability {
  capability: BackendCapability;
  route: CapabilityRoute;
}

function browserEnvironment(): EmbeddedButtplugBrowserEnvironment {
  const browser = typeof window !== 'undefined' && typeof navigator !== 'undefined';
  return {
    browser,
    secureContext: browser && globalThis.isSecureContext === true,
    webBluetooth: browser && 'bluetooth' in navigator,
  };
}

function assertSupported(environment: EmbeddedButtplugBrowserEnvironment): void {
  if (!environment.browser)
    throw new EmbeddedButtplugUnsupportedError('browser-environment-required');
  if (!environment.secureContext)
    throw new EmbeddedButtplugUnsupportedError('secure-context-required');
  if (!environment.webBluetooth)
    throw new EmbeddedButtplugUnsupportedError('web-bluetooth-required');
}

async function loadPinnedButtplugApi(): Promise<EmbeddedButtplugApi> {
  const [buttplug, wasm] = await Promise.all([import('buttplug'), import('buttplug-wasm')]);
  const connector = new wasm.ButtplugWasmClientConnector();
  const client = new buttplug.ButtplugClient('0xNuller embedded devices');
  return {
    client: client as unknown as EmbeddedButtplugClient,
    connector,
    outputVibrate: buttplug.OutputType.Vibrate,
    inputBattery: buttplug.InputType.Battery,
    inputRssi: buttplug.InputType.RSSI,
    inputRead: buttplug.InputCommandType.Read,
    vibrateSteps: (steps) => buttplug.DeviceOutput.Vibrate.steps(steps),
  };
}

/** Embedded-only Web Bluetooth backend. It has no endpoint or WebSocket configuration. */
export class WebEmbeddedButtplugBackend implements DeviceBackend {
  private readonly environment: () => EmbeddedButtplugBrowserEnvironment;
  private readonly loadApi: () => Promise<EmbeddedButtplugApi>;

  constructor(options: WebEmbeddedButtplugBackendOptions = {}) {
    this.environment = options.environment ?? browserEnvironment;
    this.loadApi = options.loadApi ?? loadPinnedButtplugApi;
  }

  async openSession(onEvent: (event: unknown) => void): Promise<DeviceBackendSession> {
    assertSupported(this.environment());
    const session = new WebEmbeddedButtplugSession(await this.loadApi(), onEvent);
    await session.connect();
    return session;
  }
}

class WebEmbeddedButtplugSession implements DeviceBackendSession {
  private readonly devices = new Map<string, EmbeddedButtplugDevice>();
  private readonly telemetry = new Map<string, number | null>();
  private routes = new Map<string, CapabilityRoute>();
  private closed = false;
  private terminalEmitted = false;
  private stopAllSucceededSinceWrite = false;
  private closePromise: Promise<void> | null = null;
  private readonly api: EmbeddedButtplugApi;
  private readonly onEvent: (event: unknown) => void;

  private readonly onDeviceAdded = (value?: unknown): void => {
    const device = asDevice(value);
    if (!device || this.closed) return;
    const nativeDeviceId = String(device.index);
    this.devices.set(nativeDeviceId, device);
    this.publishTopology();
    void this.refreshTelemetry(nativeDeviceId);
  };

  private readonly onDeviceRemoved = (value?: unknown): void => {
    const device = asDevice(value);
    if (!device || this.closed) return;
    const nativeDeviceId = String(device.index);
    if (this.devices.get(nativeDeviceId) !== device) return;
    this.devices.delete(nativeDeviceId);
    this.deleteTelemetry(nativeDeviceId);
    this.publishTopology();
  };

  private readonly onDisconnected = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.detachListeners();
    this.devices.clear();
    this.routes.clear();
    this.emitTerminal('embedded-connector-disconnected');
  };

  constructor(api: EmbeddedButtplugApi, onEvent: (event: unknown) => void) {
    this.api = api;
    this.onEvent = onEvent;
  }

  async connect(): Promise<void> {
    this.api.client.on('deviceadded', this.onDeviceAdded);
    this.api.client.on('deviceremoved', this.onDeviceRemoved);
    this.api.client.on('disconnect', this.onDisconnected);
    try {
      await this.api.client.connect(this.api.connector);
      for (const device of this.api.client.devices.values()) this.onDeviceAdded(device);
      if (this.devices.size === 0) this.publishTopology();
    } catch (error) {
      this.closed = true;
      this.detachListeners();
      try {
        await this.api.connector.disconnect();
      } catch {
        // Preserve the connection failure while still attempting connector cleanup.
      }
      throw error;
    }
  }

  async scan(): Promise<void> {
    this.requireOpen();
    if (!this.api.client.isScanning) await this.api.client.startScanning();
  }

  async disconnect(nativeDeviceId: string): Promise<void> {
    this.requireOpen();
    const device = this.devices.get(nativeDeviceId);
    if (!device) throw new Error('unknown-device');
    await device.stop();
    await this.terminate(true, 'device-disconnect-closes-embedded-session');
  }

  async writeVibrate(
    nativeDeviceId: string,
    nativeFeatureId: string,
    normalizedIntensity: number,
  ): Promise<void> {
    this.requireOpen();
    if (
      !Number.isFinite(normalizedIntensity) ||
      normalizedIntensity < 0 ||
      normalizedIntensity > 1
    ) {
      throw new Error('invalid-vibration-intensity');
    }
    const route = this.vibrateRoute(nativeDeviceId, nativeFeatureId);
    const steps = Math.floor(normalizedIntensity * route.stepCount);
    await route.feature.runOutput(this.api.vibrateSteps(steps));
    this.stopAllSucceededSinceWrite = false;
  }

  async stopFeature(nativeDeviceId: string, nativeFeatureId: string): Promise<void> {
    this.requireOpen();
    const route = this.vibrateRoute(nativeDeviceId, nativeFeatureId);
    await route.feature.runOutput(this.api.vibrateSteps(0));
  }

  async stopAll(): Promise<void> {
    this.requireOpen();
    await this.api.client.stopAllDevices();
    this.stopAllSucceededSinceWrite = true;
  }

  close(): Promise<void> {
    return this.terminate(false, 'runtime-closed');
  }

  private terminate(reportTerminal: boolean, reason: string): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closing = this.terminateInternal(reportTerminal, reason);
    this.closePromise = closing;
    return closing;
  }

  private async terminateInternal(reportTerminal: boolean, reason: string): Promise<void> {
    if (this.closed) return;
    let firstError: unknown;
    if (!this.stopAllSucceededSinceWrite) {
      try {
        await this.api.client.stopAllDevices();
        this.stopAllSucceededSinceWrite = true;
      } catch (error) {
        firstError = error;
      }
    }

    this.detachListeners();
    try {
      await this.api.connector.disconnect();
    } catch (error) {
      firstError ??= error;
    } finally {
      this.closed = true;
      this.devices.clear();
      this.routes.clear();
      if (reportTerminal) this.emitTerminal(reason);
    }
    if (firstError) throw firstError;
  }

  private publishTopology(): void {
    if (this.closed) return;
    const devices: BackendDevice[] = [];
    const nextRoutes = new Map<string, CapabilityRoute>();
    let remainingFeatures = MAX_TOTAL_FEATURES;

    for (const [nativeDeviceId, device] of this.devices) {
      if (devices.length >= MAX_DEVICES || remainingFeatures === 0) break;
      const capabilities: BackendCapability[] = [];
      for (const [featureIndex, feature] of device.features) {
        if (capabilities.length >= MAX_FEATURES_PER_DEVICE || remainingFeatures === 0) break;
        for (const mapped of this.mapFeature(nativeDeviceId, featureIndex, feature)) {
          if (capabilities.length >= MAX_FEATURES_PER_DEVICE || remainingFeatures === 0) break;
          capabilities.push(mapped.capability);
          nextRoutes.set(routeKey(nativeDeviceId, mapped.capability.nativeFeatureId), mapped.route);
          remainingFeatures -= 1;
        }
      }
      devices.push({ nativeDeviceId, name: 'Embedded device', capabilities });
    }

    this.routes = nextRoutes;
    this.onEvent({
      version: DEVICE_RUNTIME_SCHEMA_VERSION,
      type: 'topology',
      devices,
    });
  }

  private mapFeature(
    nativeDeviceId: string,
    featureIndex: number,
    feature: EmbeddedButtplugFeature,
  ): MappedCapability[] {
    if (!Number.isSafeInteger(featureIndex) || featureIndex < 0) return [];
    const metadata = featureMetadata(feature);
    if (!metadata || metadata.FeatureIndex !== featureIndex) return [];
    const mapped: MappedCapability[] = [];

    if (safeHasOutput(feature, this.api.outputVibrate)) {
      const stepCount = outputStepCount(metadata, this.api.outputVibrate);
      if (stepCount !== null) {
        const nativeFeatureId = `feature/${featureIndex}/vibrate`;
        mapped.push({
          capability: { kind: 'vibrate', nativeFeatureId, stepCount },
          route: {
            kind: 'vibrate',
            nativeDeviceId,
            nativeFeatureId,
            feature,
            stepCount,
          },
        });
      }
    }

    for (const [kind, inputType] of [
      ['battery', this.api.inputBattery],
      ['rssi', this.api.inputRssi],
    ] as const) {
      if (
        !safeHasInput(feature, inputType) ||
        !supportsRead(metadata, inputType, this.api.inputRead)
      ) {
        continue;
      }
      const nativeFeatureId = `feature/${featureIndex}/${kind}`;
      const route: InputRoute = {
        kind,
        nativeDeviceId,
        nativeFeatureId,
        feature,
        inputType,
        inputRange: inputRange(metadata, inputType),
      };
      mapped.push({
        capability: {
          kind,
          nativeFeatureId,
          value: this.telemetry.get(routeKey(nativeDeviceId, nativeFeatureId)) ?? null,
        },
        route,
      });
    }
    return mapped;
  }

  private async refreshTelemetry(nativeDeviceId: string): Promise<void> {
    const routes = [...this.routes.values()].filter(
      (route): route is InputRoute =>
        route.nativeDeviceId === nativeDeviceId && route.kind !== 'vibrate',
    );
    await Promise.all(
      routes.map(async (route) => {
        let value: number | null;
        try {
          const reading = await route.feature.runInput(route.inputType, this.api.inputRead);
          value = normalizeInputReading(reading, route);
        } catch {
          return;
        }
        const key = routeKey(route.nativeDeviceId, route.nativeFeatureId);
        const current = this.routes.get(key);
        if (
          this.closed ||
          !current ||
          current.kind !== route.kind ||
          current.feature !== route.feature ||
          this.telemetry.get(key) === value
        ) {
          return;
        }
        this.telemetry.set(key, value);
        this.publishTopology();
      }),
    );
  }

  private vibrateRoute(nativeDeviceId: string, nativeFeatureId: string): VibrateRoute {
    const route = this.routes.get(routeKey(nativeDeviceId, nativeFeatureId));
    if (!route || route.kind !== 'vibrate') throw new Error('unknown-vibration-feature');
    return route;
  }

  private deleteTelemetry(nativeDeviceId: string): void {
    const prefix = `${nativeDeviceId}\u0000`;
    for (const key of this.telemetry.keys()) {
      if (key.startsWith(prefix)) this.telemetry.delete(key);
    }
  }

  private requireOpen(): void {
    if (this.closed || !this.api.client.connected) throw new Error('embedded-session-unavailable');
  }

  private detachListeners(): void {
    this.api.client.off('deviceadded', this.onDeviceAdded);
    this.api.client.off('deviceremoved', this.onDeviceRemoved);
    this.api.client.off('disconnect', this.onDisconnected);
  }

  private emitTerminal(reason: string): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.onEvent({
      version: DEVICE_RUNTIME_SCHEMA_VERSION,
      type: 'session-ended',
      reason,
    });
  }
}

function routeKey(nativeDeviceId: string, nativeFeatureId: string): string {
  return `${nativeDeviceId}\u0000${nativeFeatureId}`;
}

function asDevice(value: unknown): EmbeddedButtplugDevice | null {
  if (value === null || typeof value !== 'object') return null;
  const device = value as Partial<EmbeddedButtplugDevice>;
  if (
    !Number.isSafeInteger(device.index) ||
    (device.index as number) < 0 ||
    !(device.features instanceof Map) ||
    typeof device.stop !== 'function'
  ) {
    return null;
  }
  return device as EmbeddedButtplugDevice;
}

function featureMetadata(feature: EmbeddedButtplugFeature): InstalledFeatureMetadata | null {
  const value = feature._feature;
  if (value === null || typeof value !== 'object') return null;
  const metadata = value as Partial<InstalledFeatureMetadata>;
  return Number.isSafeInteger(metadata.FeatureIndex) && (metadata.FeatureIndex as number) >= 0
    ? (metadata as InstalledFeatureMetadata)
    : null;
}

function safeHasOutput(feature: EmbeddedButtplugFeature, type: unknown): boolean {
  try {
    return feature.hasOutput(type);
  } catch {
    return false;
  }
}

function safeHasInput(feature: EmbeddedButtplugFeature, type: unknown): boolean {
  try {
    return feature.hasInput(type);
  } catch {
    return false;
  }
}

function outputStepCount(metadata: InstalledFeatureMetadata, type: unknown): number | null {
  const value = metadata.Output?.[String(type)]?.Value;
  if (!Array.isArray(value) || value.length < 2) return null;
  const [minimum, maximum] = value;
  if (
    minimum !== 0 ||
    !Number.isSafeInteger(maximum) ||
    (maximum as number) < 1 ||
    (maximum as number) > 10_000
  ) {
    return null;
  }
  return maximum as number;
}

function supportsRead(
  metadata: InstalledFeatureMetadata,
  type: unknown,
  readCommand: unknown,
): boolean {
  const commands = metadata.Input?.[String(type)]?.Command;
  return Array.isArray(commands) && commands.includes(readCommand);
}

function inputRange(
  metadata: InstalledFeatureMetadata,
  type: unknown,
): readonly [number, number] | null {
  const value = metadata.Input?.[String(type)]?.Value;
  if (!Array.isArray(value) || value.length < 2) return null;
  const [minimum, maximum] = value;
  if (
    typeof minimum !== 'number' ||
    !Number.isFinite(minimum) ||
    typeof maximum !== 'number' ||
    !Number.isFinite(maximum) ||
    maximum <= minimum
  ) {
    return null;
  }
  return [minimum, maximum];
}

function normalizeInputReading(reading: unknown, route: InputRoute): number | null {
  if (reading === null || typeof reading !== 'object') return null;
  const readingRecord = reading as { Reading?: unknown };
  if (readingRecord.Reading === null || typeof readingRecord.Reading !== 'object') return null;
  const entry = (readingRecord.Reading as Record<string, unknown>)[String(route.inputType)];
  if (entry === null || typeof entry !== 'object') return null;
  const value = (entry as { Value?: unknown }).Value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;

  if (route.kind === 'battery') {
    if (!route.inputRange) return null;
    const [minimum, maximum] = route.inputRange;
    if (value < minimum || value > maximum) return null;
    return (value - minimum) / (maximum - minimum);
  }

  return Number.isSafeInteger(value) && value >= -127 && value <= 20 ? value : null;
}
