import type { DeviceKind } from '@dg-kit/core';

/**
 * Minimal BLE characteristic shape needed by the protocol adapters.
 *
 * Both Web Bluetooth's `BluetoothRemoteGATTCharacteristic` and a Noble
 * `Characteristic` shim must satisfy this interface for the protocol code to
 * drive them.
 */
export interface BluetoothRequestFilterLike {
  namePrefix?: string;
}

export interface RequestDeviceOptionsLike {
  filters?: BluetoothRequestFilterLike[];
  optionalServices?: string[];
}

export interface BluetoothRemoteGATTCharacteristicLike extends EventTarget {
  value: DataView | null;
  writeValueWithoutResponse?(value: ArrayBufferView | ArrayBuffer): Promise<void>;
  writeValueWithResponse?(value: ArrayBufferView | ArrayBuffer): Promise<void>;
  writeValue?(value: ArrayBufferView | ArrayBuffer): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
}

export interface BluetoothRemoteGATTServiceLike {
  getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristicLike>;
}

export interface BluetoothRemoteGATTServerLike {
  connected: boolean;
  getPrimaryService(service: string): Promise<BluetoothRemoteGATTServiceLike>;
  /**
   * Negotiate a larger ATT MTU. Optional: Web Bluetooth negotiates MTU
   * automatically with no JS-facing control, so browser transports never
   * implement this. Native transports (Tauri, Node) may.
   */
  requestMTU?(mtu: number): Promise<number>;
}

export interface BluetoothRemoteGATTLike {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServerLike>;
  disconnect(): void;
}

export interface BluetoothDeviceLike extends EventTarget {
  id?: string;
  name?: string;
  gatt?: BluetoothRemoteGATTLike;
}

export interface BluetoothLike {
  requestDevice(options: RequestDeviceOptionsLike): Promise<BluetoothDeviceLike>;
}

export interface NavigatorBluetoothLike {
  bluetooth?: BluetoothLike;
}

/**
 * A picked, already-GATT-connected DG-Lab device plus its identified kind.
 *
 * Every cross-kind picker returns this shape — `requestDgLabDevice()` over
 * Web Bluetooth and `requestDgLabDeviceTauri()` over plugin-blec — which is
 * what lets a host swap transports without branching on which one it got.
 * It lives here, next to the `*Like` BLE shapes it is built from, because
 * both transports and both app-side device layers had redeclared it.
 */
export interface RequestedDevice {
  kind: DeviceKind;
  device: BluetoothDeviceLike;
  server: BluetoothRemoteGATTServerLike;
}
