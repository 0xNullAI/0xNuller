/* global window */
// Simulated Coyote V3 over Web Bluetooth, for visual checks only. Paste into the page console
// (or javascript_tool) before pressing "connect device". It follows the V3 protocol:
// B0 writes carry seq/mode/strength; the device answers with B1 [seq, strengthA, strengthB].
(() => {
  const short = (u) => u.slice(4, 8).toLowerCase();
  const log = (window.__fakeCoyote = {
    writes: [],
    strengthA: 0,
    strengthB: 0,
    limitA: 0,
    limitB: 0,
  });
  const listeners = new Set();
  const notifyChar = {
    uuid: '0000150b-0000-1000-8000-00805f9b34fb',
    value: null,
    startNotifications: async () => notifyChar,
    stopNotifications: async () => notifyChar,
    addEventListener: (type, fn) => type === 'characteristicvaluechanged' && listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
  const notify = (bytes) => {
    notifyChar.value = new DataView(new Uint8Array(bytes).buffer);
    for (const fn of listeners) fn({ target: notifyChar });
  };
  const apply = (mode, current, value) =>
    mode === 1 ? current + value : mode === 2 ? current - value : mode === 3 ? value : current;
  const write = async (data) => {
    const b = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset ?? 0) : data);
    if (b[0] === 0xbf) {
      log.limitA = b[1];
      log.limitB = b[2];
    }
    if (b[0] === 0xb0) {
      const seq = b[1] >> 4;
      const mode = b[1] & 0x0f;
      const nextA = Math.max(0, Math.min(log.limitA || 200, apply(mode >> 2, log.strengthA, b[2])));
      const nextB = Math.max(0, Math.min(log.limitB || 200, apply(mode & 3, log.strengthB, b[3])));
      if (mode !== 0) {
        log.strengthA = nextA;
        log.strengthB = nextB;
        log.writes.push({ at: Date.now(), seq, mode, a: nextA, b: nextB });
        if (log.writes.length > 200) log.writes.shift();
        setTimeout(() => notify([0xb1, seq, log.strengthA, log.strengthB]), 20);
      }
    }
  };
  const writeChar = {
    uuid: '0000150a-0000-1000-8000-00805f9b34fb',
    writeValue: write,
    writeValueWithResponse: write,
    writeValueWithoutResponse: write,
  };
  const batteryChar = { readValue: async () => new DataView(new Uint8Array([83]).buffer) };
  const services = {
    '180c': {
      getCharacteristic: async (u) => (short(u) === '150a' ? writeChar : notifyChar),
    },
    '180f': { getCharacteristic: async () => batteryChar },
  };
  const deviceListeners = new Set();
  const device = {
    id: 'fake-coyote-v3',
    name: '47L121000',
    addEventListener: (type, fn) => type === 'gattserverdisconnected' && deviceListeners.add(fn),
    removeEventListener: (_type, fn) => deviceListeners.delete(fn),
    gatt: {
      connected: false,
      device: null,
      connect: async () => {
        device.gatt.connected = true;
        return device.gatt;
      },
      disconnect: () => {
        device.gatt.connected = false;
        for (const fn of deviceListeners) fn({ target: device });
      },
      getPrimaryService: async (u) => {
        const service = services[short(u)];
        if (!service) throw new Error(`No services matching UUID ${u}`);
        return service;
      },
      requestMTU: async () => 144,
    },
  };
  device.gatt.device = device;
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: {
      getAvailability: async () => true,
      requestDevice: async () => device,
      getDevices: async () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  return 'fake Coyote V3 ready';
})();
