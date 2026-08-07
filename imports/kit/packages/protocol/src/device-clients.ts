/**
 * Client contracts for the three newer DG-Lab device families (opossum,
 * paw-prints, civet-edging), alongside the existing Coyote `DeviceClient`
 * (`@dg-kit/core`). These live in `protocol` rather than `core` because they
 * reference `OpossumState`/`PawPrintsReading`/`CivetPressureReading`, which
 * are protocol-layer types `core` doesn't (and shouldn't) know about.
 *
 * Runtime-level contracts, not concrete implementations — actual Web
 * Bluetooth/Tauri-backed instances are constructed in the transport
 * packages, which each implement these same shapes independently today.
 * Sharing the contract here is what lets a `PolicyEngine`/tool executor be
 * written once and reused across transports.
 */
import type { OpossumCommand, SensorDeviceClient } from '@dg-kit/core';
import type { CivetPressureReading } from './civet-edging.js';
import type { PawPrintsReading } from './paw-prints.js';
import type { OpossumState } from './opossum.js';

export interface OpossumCommandResult {
  state: OpossumState;
}

export interface OpossumClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getState(): Promise<OpossumState>;
  execute(command: OpossumCommand): Promise<OpossumCommandResult>;
  /** Best-effort: drive both channels to zero. Used by a runtime-wide emergency stop. */
  emergencyStop(): Promise<void>;
  setIndicatorColor(color: number): Promise<void>;
  onStateChanged(listener: (state: OpossumState) => void): () => void;
}

export type PawPrintsClient = SensorDeviceClient<PawPrintsReading>;
export type CivetEdgingClient = SensorDeviceClient<CivetPressureReading>;
