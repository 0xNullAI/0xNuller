import { describe, expect, it } from 'vitest';
import { shouldShowDeviceBarConnect } from './device-bar-connect';

describe('shouldShowDeviceBarConnect', () => {
  it.each([
    { narrow: false, conversationDetail: false },
    { narrow: true, conversationDetail: true },
  ])(
    'keeps a connect entry in an AI chat, the only way the Agent runtime can get a device (%o)',
    (layout) => {
      expect(shouldShowDeviceBarConnect({ ...layout, leaseModuleId: 'agent' })).toBe(true);
    },
  );

  it('never offers connect without a lease holder or on 设备, which has its own entry', () => {
    for (const narrow of [false, true]) {
      expect(
        shouldShowDeviceBarConnect({ narrow, conversationDetail: false, leaseModuleId: null }),
      ).toBe(false);
      expect(
        shouldShowDeviceBarConnect({ narrow, conversationDetail: false, leaseModuleId: 'control' }),
      ).toBe(false);
    }
  });

  it('keeps other modules phone-only and out of a human chat page', () => {
    expect(
      shouldShowDeviceBarConnect({
        narrow: false,
        conversationDetail: false,
        leaseModuleId: 'chat',
      }),
    ).toBe(false);
    expect(
      shouldShowDeviceBarConnect({ narrow: true, conversationDetail: true, leaseModuleId: 'chat' }),
    ).toBe(false);
    expect(
      shouldShowDeviceBarConnect({
        narrow: true,
        conversationDetail: false,
        leaseModuleId: 'market',
      }),
    ).toBe(true);
  });
});
