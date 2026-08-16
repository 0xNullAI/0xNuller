import { describe, expect, it } from 'vitest';
import {
  V2_BATTERY_CHAR,
  V2_BATTERY_SERVICE,
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
} from './constants.js';

describe('battery GATT UUIDs', () => {
  it('uses the Bluetooth SIG Battery Service exposed by DG-Lab devices', () => {
    expect(V3_BATTERY_SERVICE).toBe('0000180f-0000-1000-8000-00805f9b34fb');
    expect(V3_BATTERY_CHAR).toBe('00002a19-0000-1000-8000-00805f9b34fb');
    expect(V2_BATTERY_SERVICE).toBe('955a180a-0fe2-f5aa-a094-84b8d4f3e8ad');
    expect(V2_BATTERY_CHAR).toBe('955a1500-0fe2-f5aa-a094-84b8d4f3e8ad');
  });
});
