import type { DeviceLeaseSnapshot } from '@dg-kit/safety';

declare const backendSessionIdBrand: unique symbol;
declare const deviceIdBrand: unique symbol;
declare const featureIdBrand: unique symbol;

/** Opaque identifiers are valid only for the backend session that issued them. */
export type BackendSessionId = string & { readonly [backendSessionIdBrand]: true };
export type DeviceId = string & { readonly [deviceIdBrand]: true };
export type FeatureId = string & { readonly [featureIdBrand]: true };

export const DEVICE_RUNTIME_SCHEMA_VERSION = 1 as const;
export const MAX_DEVICES = 8;
export const MAX_FEATURES_PER_DEVICE = 8;
export const MAX_TOTAL_FEATURES = 32;
export const MAX_OUTPUT_LEASE_MS = 5_000;

export interface VibrateCapability {
  kind: 'vibrate';
  featureId: FeatureId;
  /** Number of equal native steps across normalized intensity 0..1. */
  stepCount: number;
  /** Sticky until the device disappears or a new backend session starts. */
  faulted: boolean;
}

export interface BatteryCapability {
  kind: 'battery';
  featureId: FeatureId;
  /** Normalized 0..1, or null when the backend has no current reading. */
  value: number | null;
}

export interface RssiCapability {
  kind: 'rssi';
  featureId: FeatureId;
  /** dBm, or null when the backend has no current reading. */
  value: number | null;
}

export type DeviceCapability = VibrateCapability | BatteryCapability | RssiCapability;

export interface RuntimeDevice {
  deviceId: DeviceId;
  name: string;
  capabilities: readonly DeviceCapability[];
}

export interface DeviceSnapshot {
  version: typeof DEVICE_RUNTIME_SCHEMA_VERSION;
  sessionId: BackendSessionId;
  sequence: number;
  topologyGeneration: number;
  safetyGeneration: number;
  devices: readonly RuntimeDevice[];
}

export interface RuntimeFence {
  sessionId: BackendSessionId;
  topologyGeneration: number;
  safetyGeneration: number;
  moduleId: string;
  leaseEpoch: number;
}

interface CommandBase {
  version: typeof DEVICE_RUNTIME_SCHEMA_VERSION;
  interactionId: string;
}

interface FencedCommandBase extends CommandBase, RuntimeFence {}

export interface ScanCommand extends FencedCommandBase {
  type: 'scan';
}

export interface DisconnectCommand extends FencedCommandBase {
  type: 'disconnect';
  deviceId: DeviceId;
}

export interface VibrateCommand extends FencedCommandBase {
  type: 'vibrate';
  deviceId: DeviceId;
  featureId: FeatureId;
  /** Requested normalized intensity. Native quantization always rounds down. */
  intensity: number;
  /** Hard watchdog duration; output is stopped after this interval. */
  outputLeaseMs: number;
}

export interface StopFeatureCommand extends CommandBase {
  type: 'stop';
  deviceId: DeviceId;
  featureId: FeatureId;
}

export interface EmergencyStopCommand extends CommandBase {
  type: 'emergency-stop';
}

export type RuntimeCommand =
  ScanCommand | DisconnectCommand | VibrateCommand | StopFeatureCommand | EmergencyStopCommand;

export type AckStatus = 'applied' | 'stopped' | 'rejected' | 'faulted';

export interface CommandAck {
  version: typeof DEVICE_RUNTIME_SCHEMA_VERSION;
  type: 'ack';
  interactionId: string;
  status: AckStatus;
  code: string;
  /** A transport write is not proof of physical hardware state. */
  hardwareState: 'unknown';
  sessionId: BackendSessionId;
  topologyGeneration: number;
  safetyGeneration: number;
  appliedIntensity?: number;
}

export type RuntimeEvent =
  | {
      version: typeof DEVICE_RUNTIME_SCHEMA_VERSION;
      type: 'snapshot';
      snapshot: DeviceSnapshot;
    }
  | CommandAck
  | {
      version: typeof DEVICE_RUNTIME_SCHEMA_VERSION;
      type: 'fault';
      sessionId: BackendSessionId;
      deviceId: DeviceId;
      featureId: FeatureId;
      code: 'stop-failed';
      hardwareState: 'unknown';
    };

export interface BackendVibrateCapability {
  kind: 'vibrate';
  nativeFeatureId: string;
  stepCount: number;
}

export interface BackendBatteryCapability {
  kind: 'battery';
  nativeFeatureId: string;
  value: number | null;
}

export interface BackendRssiCapability {
  kind: 'rssi';
  nativeFeatureId: string;
  value: number | null;
}

export type BackendCapability =
  BackendVibrateCapability | BackendBatteryCapability | BackendRssiCapability;

export interface BackendDevice {
  nativeDeviceId: string;
  name: string;
  capabilities: readonly BackendCapability[];
}

/** Full topology replacement or terminal backend-session loss. */
export type BackendEvent =
  | {
      version: typeof DEVICE_RUNTIME_SCHEMA_VERSION;
      type: 'topology';
      devices: readonly BackendDevice[];
    }
  | {
      version: typeof DEVICE_RUNTIME_SCHEMA_VERSION;
      type: 'session-ended';
      reason: string;
    };

export interface DeviceBackendSession {
  scan(): Promise<void>;
  disconnect(nativeDeviceId: string): Promise<void>;
  writeVibrate(
    nativeDeviceId: string,
    nativeFeatureId: string,
    normalizedIntensity: number,
  ): Promise<void>;
  stopFeature(nativeDeviceId: string, nativeFeatureId: string): Promise<void>;
  stopAll(): Promise<void>;
  close(): Promise<void>;
}

export interface DeviceBackend {
  openSession(onEvent: (event: unknown) => void): Promise<DeviceBackendSession>;
}

export interface DevicePermissionRequest {
  moduleId: string;
  interactionId: string;
  action: 'scan' | 'disconnect' | 'vibrate';
  deviceId?: DeviceId;
  featureId?: FeatureId;
  intensity?: number;
  outputLeaseMs?: number;
}

export interface DevicePermissionPolicy {
  authorize(request: DevicePermissionRequest): Promise<'allow' | 'deny'>;
}

export interface DeviceSafetyPolicy {
  /** Maximum normalized intensity. */
  intensityCap: number;
  /** Maximum increase from the last accepted write. Decreases are unrestricted. */
  maxIncrease: number;
  /** Maximum first increase from zero. */
  coldStartCap: number;
  /** Maximum watchdog duration accepted from a caller. */
  maxOutputLeaseMs: number;
}

export interface DeviceRuntimeExecutorOptions {
  permissionPolicy: DevicePermissionPolicy;
  safetyPolicy: () => DeviceSafetyPolicy;
  leaseSnapshot: () => DeviceLeaseSnapshot;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}
