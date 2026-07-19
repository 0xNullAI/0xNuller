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

  /**
   * `address` scopes every plugin-blec call this instance makes to one
   * device. Required (not optional) on purpose: plugin-blec's address-less
   * overloads now throw `AmbiguousDevice` once 2+ devices are connected, and
   * this class is always constructed by a per-device `createGattShim()` that
   * already knows its address — there's no legitimate call site here that
   * should fall back to the ambiguous default.
   */
  constructor(
    public readonly uuid: string,
    private readonly api: PluginBlecApi,
    private readonly serviceUuid: string,
    private readonly address: string,
  ) {
    super();
  }

  async writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    await this.api.send(
      this.uuid,
      Array.from(toUint8(value)),
      'withoutResponse',
      this.serviceUuid,
      this.address,
    );
  }

  async writeValueWithResponse(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    await this.api.send(
      this.uuid,
      Array.from(toUint8(value)),
      'withResponse',
      this.serviceUuid,
      this.address,
    );
  }

  async writeValue(value: ArrayBufferView | ArrayBuffer): Promise<void> {
    await this.writeValueWithResponse(value);
  }

  async readValue(): Promise<DataView> {
    const bytes = await this.api.read(this.uuid, this.serviceUuid, this.address);
    const buffer = new Uint8Array(bytes).buffer;
    const view = new DataView(buffer);
    this.value = view;
    return view;
  }

  async startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike> {
    if (this.notifying) return this;
    await this.api.subscribe(
      this.uuid,
      this.serviceUuid,
      (bytes) => {
        const buffer = new Uint8Array(bytes).buffer;
        this.value = new DataView(buffer);
        this.dispatchEvent(new Event('characteristicvaluechanged'));
      },
      this.address,
    );
    this.notifying = true;
    return this;
  }

  async stopNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike> {
    if (!this.notifying) return this;
    await this.api.unsubscribe(this.uuid, this.serviceUuid, this.address);
    this.notifying = false;
    return this;
  }
}

function toUint8(value: ArrayBufferView | ArrayBuffer): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
