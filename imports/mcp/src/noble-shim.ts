/**
 * Noble → CharacteristicLike shim.
 *
 * Wraps an `@stoprocent/noble` Peripheral so it satisfies the
 * `BluetoothRemoteGATTServerLike` / `BluetoothRemoteGATTServiceLike` /
 * `BluetoothRemoteGATTCharacteristicLike` interfaces from `@dg-kit/protocol`,
 * which lets the (browser-shaped) `CoyoteProtocolAdapter` drive a real
 * Bluetooth connection from Node.js.
 */

import type {
  BluetoothRemoteGATTCharacteristicLike,
  BluetoothRemoteGATTServerLike,
  BluetoothRemoteGATTServiceLike,
} from '@dg-kit/protocol';
import type { Peripheral, Service, Characteristic } from '@stoprocent/noble';

function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

function toBuffer(value: ArrayBufferView | ArrayBuffer): Buffer {
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export class NobleGATTServer implements BluetoothRemoteGATTServerLike {
  connected: boolean;

  constructor(
    private readonly peripheral: Peripheral,
    private readonly services: Service[],
  ) {
    this.connected = peripheral.state === 'connected';
  }

  async getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTServiceLike> {
    const target = normalizeUuid(uuid);
    const service = this.services.find((s) => normalizeUuid(s.uuid) === target);
    if (!service) {
      throw new Error(`GATT service not found: ${uuid}`);
    }
    return new NobleGATTService(service);
  }
}

class NobleGATTService implements BluetoothRemoteGATTServiceLike {
  constructor(private readonly service: Service) {}

  async getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristicLike> {
    const target = normalizeUuid(uuid);
    const characteristic = (this.service.characteristics ?? []).find(
      (c) => normalizeUuid(c.uuid) === target,
    );
    if (!characteristic) {
      throw new Error(`GATT characteristic not found: ${uuid}`);
    }
    return new NobleGATTCharacteristic(characteristic);
  }
}

class NobleGATTCharacteristic extends EventTarget implements BluetoothRemoteGATTCharacteristicLike {
  value: DataView | null = null;

  constructor(private readonly char: Characteristic) {
    super();
    this.char.on('data', (data: Buffer) => {
      // Copy into a fresh ArrayBuffer to avoid Node Buffer pooling surprises.
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      this.value = new DataView(ab);
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    });
  }

  async writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    await this.char.writeAsync(toBuffer(value), true);
  }

  async writeValueWithResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    await this.char.writeAsync(toBuffer(value), false);
  }

  async readValue(): Promise<DataView> {
    const buffer = await this.char.readAsync();
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const view = new DataView(ab);
    this.value = view;
    return view;
  }

  async startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike> {
    await this.char.subscribeAsync();
    return this;
  }

  async stopNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike> {
    await this.char.unsubscribeAsync();
    return this;
  }
}
