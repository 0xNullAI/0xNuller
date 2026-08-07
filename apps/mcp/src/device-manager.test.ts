import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CIVET_DEVICE_NAME_PREFIX,
  OPOSSUM_DEVICE_NAME_PREFIX,
  V2_DEVICE_NAME_PREFIX,
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_DEVICE_NAME_PREFIX,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_SENSOR_NAME_PREFIX,
  V3_WRITE_CHAR,
  CoyoteProtocolAdapter,
  CivetPressureSensorAdapter,
  OpossumVibrateAdapter,
  PawPrintsSensorAdapter,
} from '@dg-kit/protocol';

// --- Fake `@stoprocent/noble` -----------------------------------------------
//
// DeviceManager talks to noble through the default export (an EventEmitter
// singleton) plus Peripheral/Service/Characteristic objects it gets back
// from scanning/connecting. We fake the whole transport here so the real
// `@dg-kit/protocol` adapters (unmocked) drive these fakes exactly the way
// they'd drive a real BLE stack -- this is what exercises the
// classifyName/detectDeviceKind fix end-to-end (a paw-prints-prefixed name
// must produce a PawPrintsSensorAdapter, not the Coyote adapter).

class FakeCharacteristic extends EventEmitter {
  readonly uuid: string;
  nextReadValue: Buffer = Buffer.from([0]);
  readonly writes: Buffer[] = [];

  constructor(uuid: string) {
    super();
    this.uuid = uuid;
  }

  async writeAsync(data: Buffer): Promise<void> {
    this.writes.push(Buffer.from(data));
  }

  async readAsync(): Promise<Buffer> {
    return this.nextReadValue;
  }

  async subscribeAsync(): Promise<void> {}
  async unsubscribeAsync(): Promise<void> {}
}

interface FakeService {
  uuid: string;
  characteristics: FakeCharacteristic[];
}

function createV3FamilyServices(): { services: FakeService[]; writeChar: FakeCharacteristic; notifyChar: FakeCharacteristic } {
  const writeChar = new FakeCharacteristic(V3_WRITE_CHAR);
  const notifyChar = new FakeCharacteristic(V3_NOTIFY_CHAR);
  const batteryChar = new FakeCharacteristic(V3_BATTERY_CHAR);
  batteryChar.nextReadValue = Buffer.from([88]);

  const services: FakeService[] = [
    { uuid: V3_PRIMARY_SERVICE, characteristics: [writeChar, notifyChar] },
    { uuid: V3_BATTERY_SERVICE, characteristics: [batteryChar] },
  ];

  return { services, writeChar, notifyChar };
}

class FakePeripheral extends EventEmitter {
  readonly id: string;
  readonly address: string;
  readonly advertisement: { localName: string };
  readonly rssi = -42;
  state: 'disconnected' | 'connected' = 'disconnected';
  private readonly servicesToReturn: FakeService[];

  constructor(address: string, name: string, services: FakeService[]) {
    super();
    this.id = address;
    this.address = address;
    this.advertisement = { localName: name };
    this.servicesToReturn = services;
  }

  async connectAsync(): Promise<void> {
    this.state = 'connected';
  }

  async disconnectAsync(): Promise<void> {
    this.state = 'disconnected';
    this.emit('disconnect', 'test-teardown');
  }

  async discoverAllServicesAndCharacteristicsAsync(): Promise<{ services: FakeService[] }> {
    return { services: this.servicesToReturn };
  }
}

class FakeNoble extends EventEmitter {
  state = 'poweredOn';
  peripheralsToDiscover: FakePeripheral[] = [];

  async startScanningAsync(): Promise<void> {
    for (const p of this.peripheralsToDiscover) {
      this.emit('discover', p);
    }
  }

  async stopScanningAsync(): Promise<void> {}
}

// Plain module-level instance (not `vi.hoisted`): `vi.mock` factories run
// lazily on first import of the mocked module, so by the time this factory
// actually executes (triggered by the dynamic `import('./device-manager.js')`
// below), `fakeNoble` is already initialized. `vi.hoisted` would instead run
// its callback eagerly at the hoisted position -- before `EventEmitter`'s own
// import binding is live -- which throws a TDZ error.
const fakeNoble = new FakeNoble();

vi.mock('@stoprocent/noble', () => ({ default: fakeNoble }));

const { DeviceManager } = await import('./device-manager.js');

function makeCoyoteV3Peripheral(address: string) {
  const { services } = createV3FamilyServices();
  return new FakePeripheral(address, `${V3_DEVICE_NAME_PREFIX}000`, services);
}

function makePawPrintsPeripheral(address: string) {
  const { services } = createV3FamilyServices();
  // V3_SENSOR_NAME_PREFIX is the paw-prints prefix -- see constants.ts. This
  // is the exact prefix the old (buggy) classifyName() folded into 'v3'.
  return new FakePeripheral(address, `${V3_SENSOR_NAME_PREFIX}000`, services);
}

function makeCivetPeripheral(address: string) {
  const { services } = createV3FamilyServices();
  return new FakePeripheral(address, `${CIVET_DEVICE_NAME_PREFIX}000`, services);
}

function makeOpossumPeripheral(address: string) {
  const { services } = createV3FamilyServices();
  return new FakePeripheral(address, `${OPOSSUM_DEVICE_NAME_PREFIX}000`, services);
}

function makeUnknownPeripheral(address: string) {
  const { services } = createV3FamilyServices();
  return new FakePeripheral(address, 'Some Other BLE Gadget', services);
}

beforeEach(() => {
  fakeNoble.peripheralsToDiscover = [];
  fakeNoble.removeAllListeners();
});

describe('DeviceManager.scan()', () => {
  it('classifies every known 47L12x-family prefix via detectDeviceKind, not the old v2/v3-only bucket', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [
      makeCoyoteV3Peripheral('AA:AA:AA:AA:AA:01'),
      makePawPrintsPeripheral('AA:AA:AA:AA:AA:02'),
      makeCivetPeripheral('AA:AA:AA:AA:AA:03'),
      makeOpossumPeripheral('AA:AA:AA:AA:AA:04'),
    ];

    const results = await manager.scan(5);
    const byAddress = new Map(results.map((r) => [r.address, r.deviceKind]));

    expect(byAddress.get('AA:AA:AA:AA:AA:01')).toBe('coyote');
    // Regression test for the classifyName bug: a paw-prints-prefixed name
    // must resolve to 'paw-prints', not be folded into the coyote/v3 bucket.
    expect(byAddress.get('AA:AA:AA:AA:AA:02')).toBe('paw-prints');
    expect(byAddress.get('AA:AA:AA:AA:AA:03')).toBe('civet-edging');
    expect(byAddress.get('AA:AA:AA:AA:AA:04')).toBe('opossum');
  });

  it('classifies the legacy V2 name prefix as coyote', async () => {
    const manager = new DeviceManager();
    const { services } = createV3FamilyServices();
    fakeNoble.peripheralsToDiscover = [
      new FakePeripheral('BB:BB:BB:BB:BB:01', `${V2_DEVICE_NAME_PREFIX}`, services),
    ];

    const results = await manager.scan(5);
    expect(results[0]?.deviceKind).toBe('coyote');
  });

  it('omits devices whose advertised name matches no known DG-Lab prefix', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeUnknownPeripheral('CC:CC:CC:CC:CC:01')];

    const results = await manager.scan(5);
    expect(results).toEqual([]);
  });
});

describe('DeviceManager.connect()', () => {
  it('connects a coyote-prefixed device with a CoyoteProtocolAdapter', async () => {
    const manager = new DeviceManager();
    const peripheral = makeCoyoteV3Peripheral('11:11:11:11:11:11');
    fakeNoble.peripheralsToDiscover = [peripheral];

    const result = await manager.connect('11:11:11:11:11:11');
    expect(result.deviceKind).toBe('coyote');

    const entry = manager.findSingleByKind('coyote');
    expect(entry.adapter).toBeInstanceOf(CoyoteProtocolAdapter);
    expect(entry.adapter.getState().connected).toBe(true);
  });

  it('connects a paw-prints-prefixed device with a PawPrintsSensorAdapter (not the Coyote adapter)', async () => {
    const manager = new DeviceManager();
    const peripheral = makePawPrintsPeripheral('22:22:22:22:22:22');
    fakeNoble.peripheralsToDiscover = [peripheral];

    const result = await manager.connect('22:22:22:22:22:22');
    expect(result.deviceKind).toBe('paw-prints');

    const entry = manager.findSingleByKind('paw-prints');
    expect(entry.adapter).toBeInstanceOf(PawPrintsSensorAdapter);
    expect(entry.adapter.getState().connected).toBe(true);
  });

  it('connects a civet-edging-prefixed device with a CivetPressureSensorAdapter', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeCivetPeripheral('33:33:33:33:33:33')];

    const result = await manager.connect('33:33:33:33:33:33');
    expect(result.deviceKind).toBe('civet-edging');

    const entry = manager.findSingleByKind('civet-edging');
    expect(entry.adapter).toBeInstanceOf(CivetPressureSensorAdapter);
  });

  it('connects an opossum-prefixed device with an OpossumVibrateAdapter', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeOpossumPeripheral('44:44:44:44:44:44')];

    const result = await manager.connect('44:44:44:44:44:44');
    expect(result.deviceKind).toBe('opossum');

    const entry = manager.findSingleByKind('opossum');
    expect(entry.adapter).toBeInstanceOf(OpossumVibrateAdapter);
  });

  it('supports connecting multiple different devices concurrently', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeCoyoteV3Peripheral('55:55:55:55:55:55')];
    await manager.connect('55:55:55:55:55:55');

    fakeNoble.peripheralsToDiscover = [makeOpossumPeripheral('66:66:66:66:66:66')];
    await manager.connect('66:66:66:66:66:66');

    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.deviceKind).sort()).toEqual(['coyote', 'opossum']);
  });

  it('rejects a second connect() call for an address that is already connected', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeCoyoteV3Peripheral('77:77:77:77:77:77')];
    await manager.connect('77:77:77:77:77:77');

    fakeNoble.peripheralsToDiscover = [makeCoyoteV3Peripheral('77:77:77:77:77:77')];
    await expect(manager.connect('77:77:77:77:77:77')).rejects.toThrow(/已连接/);
  });

  it('rejects connecting to a device whose name matches no known prefix', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeUnknownPeripheral('88:88:88:88:88:88')];

    await expect(manager.connect('88:88:88:88:88:88')).rejects.toThrow(/无法识别设备类型/);
  });
});

describe('DeviceManager.disconnect()', () => {
  it('disconnects a single device by address, leaving others connected', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeCoyoteV3Peripheral('99:99:99:99:99:91')];
    await manager.connect('99:99:99:99:99:91');
    fakeNoble.peripheralsToDiscover = [makeOpossumPeripheral('99:99:99:99:99:92')];
    await manager.connect('99:99:99:99:99:92');

    await manager.disconnect('99:99:99:99:99:91');

    const list = manager.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.deviceKind).toBe('opossum');
  });

  it('disconnects every device when no address is given', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeCoyoteV3Peripheral('AB:AB:AB:AB:AB:01')];
    await manager.connect('AB:AB:AB:AB:AB:01');
    fakeNoble.peripheralsToDiscover = [makeOpossumPeripheral('AB:AB:AB:AB:AB:02')];
    await manager.connect('AB:AB:AB:AB:AB:02');

    await manager.disconnect();

    expect(manager.list()).toEqual([]);
  });

  it('throws a clear error disconnecting an address that is not connected', async () => {
    const manager = new DeviceManager();
    await expect(manager.disconnect('00:00:00:00:00:00')).rejects.toThrow(/未连接/);
  });
});

describe('DeviceManager.findSingleByKind()', () => {
  it('throws a clear Chinese error when zero devices of that kind are connected', () => {
    const manager = new DeviceManager();
    expect(() => manager.findSingleByKind('opossum')).toThrow('没有已连接的负鼠设备');
  });

  it('throws a clear error when more than one device of the same kind is connected', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeOpossumPeripheral('C1:C1:C1:C1:C1:01')];
    await manager.connect('C1:C1:C1:C1:C1:01');
    fakeNoble.peripheralsToDiscover = [makeOpossumPeripheral('C1:C1:C1:C1:C1:02')];
    await manager.connect('C1:C1:C1:C1:C1:02');

    expect(() => manager.findSingleByKind('opossum')).toThrow(/台已连接的负鼠设备/);
  });
});

describe('DeviceManager sensor reading cache', () => {
  it('caches the latest paw-prints reading pushed via notifications and exposes it via getSensorSnapshots()', async () => {
    const manager = new DeviceManager();
    const { services, notifyChar } = createV3FamilyServices();
    const peripheral = new FakePeripheral('D1:D1:D1:D1:D1:01', `${V3_SENSOR_NAME_PREFIX}000`, services);
    fakeNoble.peripheralsToDiscover = [peripheral];

    await manager.connect('D1:D1:D1:D1:D1:01');

    // NOTIFY_TRIGGER = 0x5a, byteLength >= 4: [opcode, ?, eventId, parameterValue]
    notifyChar.emit('data', Buffer.from([0x5a, 0x00, 0x07, 0x2a]));

    const snapshots = manager.getSensorSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.deviceKind).toBe('paw-prints');
    expect(snapshots[0]?.latestReading).toEqual({ type: 'trigger', eventId: 7, parameterValue: 42 });
  });

  it('returns an empty array for a device with no readings yet', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeCivetPeripheral('D2:D2:D2:D2:D2:01')];
    await manager.connect('D2:D2:D2:D2:D2:01');

    const snapshots = manager.getSensorSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.latestReading).toBeNull();
  });

  it('excludes coyote/opossum devices from getSensorSnapshots()', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeCoyoteV3Peripheral('D3:D3:D3:D3:D3:01')];
    await manager.connect('D3:D3:D3:D3:D3:01');

    expect(manager.getSensorSnapshots()).toEqual([]);
  });
});

describe('DeviceManager.emergencyStopAll()', () => {
  it('resolves without throwing when no devices are connected', async () => {
    const manager = new DeviceManager();
    await expect(manager.emergencyStopAll()).resolves.toBeUndefined();
  });

  it('zeroes an opossum device intensity', async () => {
    const manager = new DeviceManager();
    fakeNoble.peripheralsToDiscover = [makeOpossumPeripheral('E1:E1:E1:E1:E1:01')];
    await manager.connect('E1:E1:E1:E1:E1:01');
    const entry = manager.findSingleByKind('opossum');
    await entry.adapter.setIntensity(120, 80);

    await manager.emergencyStopAll();

    const state = entry.adapter.getState();
    expect(state.intensityA).toBe(0);
    expect(state.intensityB).toBe(0);
  });
});
