import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState, SESSION_TITLE_METADATA_KEY } from '@dg-agent/core';
import {
  isBluetoothChooserCancelledError,
  formatUiErrorMessage,
  getSessionTitle,
} from '../utils/ui-formatters.js';

describe('isBluetoothChooserCancelledError', () => {
  it('recognizes the Web Bluetooth chooser cancellation message', () => {
    expect(
      isBluetoothChooserCancelledError(new Error('User cancelled the requestDevice() chooser.')),
    ).toBe(true);
  });

  it('recognizes the Tauri Android kind/device picker cancellation message', () => {
    // Thrown by connect-any-device-tauri.ts (kind picker) and by
    // @dg-kit/transport-tauri-blec's TauriBlecDeviceClient/connectTauriAuxDevice
    // (device picker) when the user backs out — both should read as a
    // cancellation, not a real error, same as the Web Bluetooth case.
    expect(isBluetoothChooserCancelledError(new Error('用户取消了设备选择'))).toBe(true);
  });

  it('does not treat unrelated errors as cancellation', () => {
    expect(isBluetoothChooserCancelledError(new Error('GATT 服务发现超时，请重新连接'))).toBe(
      false,
    );
  });
});

describe('formatUiErrorMessage', () => {
  it('shows a friendly cancellation message for the Tauri picker cancellation', () => {
    expect(formatUiErrorMessage(new Error('用户取消了设备选择'))).toBe('你已取消设备选择');
  });
});

describe('getSessionTitle', () => {
  it('prefers a user-assigned title over the first message', () => {
    expect(
      getSessionTitle({
        id: 'session-1',
        createdAt: 1,
        updatedAt: 1,
        deviceState: createEmptyDeviceState(),
        metadata: { [SESSION_TITLE_METADATA_KEY]: '  我的设备计划  ' },
        messages: [{ id: 'm1', role: 'user', content: '旧的自动标题', createdAt: 1 }],
      }),
    ).toBe('我的设备计划');
  });
});
