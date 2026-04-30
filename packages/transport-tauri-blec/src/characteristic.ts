import type { BluetoothRemoteGATTCharacteristicLike } from '@dg-kit/protocol';
import type { PluginBlecApi } from './plugin-blec.js';

/**
 * Adapts plugin-blec's flat `(uuid, bytes)` API to the
 * `BluetoothRemoteGATTCharacteristicLike` interface that
 * `@dg-kit/protocol`'s adapters consume. The Coyote protocol layer never
 * touches transport-specific types — it sees only this interface.
 */
export class PluginBlecCharacteristic
  extends EventTarget
  implements BluetoothRemoteGATTCharacteristicLike
{
  value: DataView | null = null;
  private notifying = false;

  constructor(
    public readonly uuid: string,
    private readonly api: PluginBlecApi,
    private readonly serviceUuid: string,
  ) {
    super();
  }

  async writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    await this.api.send(
      this.uuid,
      Array.from(toUint8(value)),
      'withoutResponse',
      this.serviceUuid,
    );
  }

  async writeValueWithResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    await this.api.send(this.uuid, Array.from(toUint8(value)), 'withResponse', this.serviceUuid);
  }

  async writeValue(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    await this.writeValueWithResponse(value);
  }

  async readValue(): Promise<DataView> {
    const bytes = await this.api.read(this.uuid, this.serviceUuid);
    const buffer = new Uint8Array(bytes).buffer;
    const view = new DataView(buffer);
    this.value = view;
    return view;
  }

  async startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike> {
    if (this.notifying) return this;
    await this.api.subscribe(this.uuid, (bytes) => {
      const buffer = new Uint8Array(bytes).buffer;
      this.value = new DataView(buffer);
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    });
    this.notifying = true;
    return this;
  }

  async stopNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike> {
    if (!this.notifying) return this;
    await this.api.unsubscribe(this.uuid);
    this.notifying = false;
    return this;
  }
}

function toUint8(value: ArrayBufferView | ArrayBuffer): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
