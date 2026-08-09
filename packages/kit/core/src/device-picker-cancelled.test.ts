import { describe, expect, it } from 'vitest';
import { DEVICE_PICKER_CANCELLED_MESSAGE, isDevicePickerCancelled } from './index.js';

/**
 * Backing out of the device picker is a normal action, but both transports
 * report it by throwing, so every module has to recognise it.
 *
 * They did not. Voice matched /cancelled|user gesture/i, which never matches
 * the Tauri transport's Chinese message, and Chat had no check at all — so on
 * Android, where that transport is the only one, closing the picker raised a
 * red error banner the user could not tell apart from a real failure.
 */

describe('设备选择器取消判定', () => {
  it('认得 Web Bluetooth 的取消', () => {
    expect(
      isDevicePickerCancelled(new Error('User cancelled the requestDevice() chooser')),
    ).toBe(true);
  });

  it('认得安卓 Tauri 传输层抛的取消——之前 Voice 与 Chat 都漏了这条', () => {
    expect(isDevicePickerCancelled(new Error(DEVICE_PICKER_CANCELLED_MESSAGE))).toBe(true);
  });

  it('剥掉 DOMException 之类的前缀', () => {
    expect(
      isDevicePickerCancelled('NotFoundError: User cancelled the requestDevice() chooser'),
    ).toBe(true);
    expect(isDevicePickerCancelled(`Error: ${DEVICE_PICKER_CANCELLED_MESSAGE}`)).toBe(true);
  });

  it('真正的失败不能被当成取消吞掉', () => {
    for (const message of [
      'GATT operation failed',
      '蓝牙未开启',
      'Bluetooth adapter not available',
      '连接超时',
    ]) {
      expect(isDevicePickerCancelled(new Error(message)), message).toBe(false);
    }
  });

  it('null / undefined 不算取消', () => {
    expect(isDevicePickerCancelled(null)).toBe(false);
    expect(isDevicePickerCancelled(undefined)).toBe(false);
  });
});
