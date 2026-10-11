import { expect, it } from 'vitest';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_DOCUMENTED_BATTERY_CHAR,
  V3_DOCUMENTED_BATTERY_SERVICE,
} from './constants.js';
import { findV3FamilyBatteryChar } from './gatt-utils.js';
import type { BluetoothRemoteGATTServerLike } from './types.js';

function server(layout: Record<string, string>): BluetoothRemoteGATTServerLike {
  return {
    getPrimaryService: async (service: string) => {
      if (!(service in layout)) throw new Error(`no ${service}`);
      return {
        getCharacteristic: async (characteristic: string) => {
          if (layout[service] !== characteristic) throw new Error(`no ${characteristic}`);
          return { uuid: characteristic };
        },
      };
    },
  } as unknown as BluetoothRemoteGATTServerLike;
}

it('reads the standard battery service, else the one in the V3 protocol document', async () => {
  expect(
    await findV3FamilyBatteryChar(server({ [V3_BATTERY_SERVICE]: V3_BATTERY_CHAR })),
  ).toMatchObject({ uuid: V3_BATTERY_CHAR });
  expect(
    await findV3FamilyBatteryChar(
      server({ [V3_DOCUMENTED_BATTERY_SERVICE]: V3_DOCUMENTED_BATTERY_CHAR }),
    ),
  ).toMatchObject({ uuid: V3_DOCUMENTED_BATTERY_CHAR });
  expect(await findV3FamilyBatteryChar(server({}))).toBeNull();
});
