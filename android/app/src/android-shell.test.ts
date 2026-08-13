import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  syncVisualViewport,
  withBlePermissionHelp,
  withConnectPermissionHelp,
  type BlePlatform,
} from './android-shell';

function blePlatform(overrides: Partial<BlePlatform> = {}): BlePlatform {
  return {
    getAdapterState: async () => 'On',
    getSdkInt: () => 31,
    isLocationEnabled: () => true,
    isPermissionPermanentlyDenied: () => false,
    hasBleScanPermission: () => true,
    requestBleScanPermission: vi.fn(),
    openAppSettings: vi.fn(),
    openBluetoothSettings: vi.fn(),
    openLocationSettings: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  document.documentElement.removeAttribute('data-keyboard-open');
  document.documentElement.style.removeProperty('--android-viewport-height');
  document.documentElement.style.removeProperty('--android-keyboard-inset');
  document.getElementById('dgaa-ble-guidance')?.remove();
  vi.restoreAllMocks();
});

describe('Android shell integration', () => {
  it('keeps native system-bar inset handling in the generated activity template', () => {
    const activity = readFileSync(
      resolve(process.cwd(), 'android/app/MainActivity.template.kt'),
      'utf8',
    );
    expect(activity).toContain('WindowInsetsCompat.Type.systemBars()');
    expect(activity).toContain('WindowInsetsCompat.Type.displayCutout()');
    expect(activity).toContain(
      '.setInsets(handledTypes or WindowInsetsCompat.Type.ime(), Insets.NONE)',
    );
    expect(activity).toContain('maxOf(insets.bottom, imeInsets.bottom)');
    expect(activity).toContain('WindowInsetsCompat.Type.ime()');
    expect(activity).toContain('ViewCompat.requestApplyInsets(webView)');
    expect(activity).toContain('webView.addJavascriptInterface(AndroidSystemBridge()');
    expect(activity).toContain('Settings.ACTION_APPLICATION_DETAILS_SETTINGS');
    expect(activity).toContain('Settings.ACTION_BLUETOOTH_SETTINGS');
    expect(activity).toContain('Settings.ACTION_LOCATION_SOURCE_SETTINGS');
    expect(activity).toContain('fun hasBleScanPermission()');
    expect(activity).toContain('fun requestBleScanPermission()');
  });

  it('requests the native Android BLE permission before scanning', async () => {
    const connect = vi.fn(async () => undefined);
    const requestBleScanPermission = vi.fn();
    let granted = false;
    requestBleScanPermission.mockImplementation(() => {
      granted = true;
    });

    await withBlePermissionHelp(
      connect,
      blePlatform({
        getSdkInt: () => 30,
        hasBleScanPermission: () => granted,
        requestBleScanPermission,
      }),
    );

    expect(requestBleScanPermission).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('keeps prototype device methods while decorating connect', async () => {
    class Client {
      connect = vi.fn(async () => undefined);
      disconnect(): string {
        return 'disconnected';
      }
    }
    const client = new Client();
    const rawConnect = client.connect;
    const wrapped = withConnectPermissionHelp(client);
    await wrapped.connect();
    expect(wrapped).toBe(client);
    expect(wrapped.disconnect()).toBe('disconnected');
    expect(rawConnect).toHaveBeenCalledOnce();
  });

  it('stops before scanning when Bluetooth is off and opens Bluetooth settings', async () => {
    const connect = vi.fn(async () => undefined);
    const openBluetoothSettings = vi.fn();
    const result = withBlePermissionHelp(
      connect,
      blePlatform({ getAdapterState: async () => 'Off', openBluetoothSettings }),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(document.querySelector('#dgaa-ble-guidance')).not.toBeNull();
    });
    const action = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '打开蓝牙设置',
    );
    action?.click();

    expect((await result) as Error).toMatchObject({ message: '蓝牙已关闭，请开启蓝牙后重试' });
    expect(connect).not.toHaveBeenCalled();
    expect(openBluetoothSettings).toHaveBeenCalledOnce();
  });

  it('explains the Android 11 location permission instead of a generic failure', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const denied = new Error('未授予蓝牙权限');

    await expect(
      withBlePermissionHelp(
        async () => Promise.reject(denied),
        blePlatform({ getSdkInt: () => 30 }),
      ),
    ).rejects.toBe(denied);

    expect(alert).toHaveBeenCalledWith(expect.stringContaining('Android 11 及以下'));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('位置信息权限'));
  });

  it('offers app settings after Nearby devices permission is permanently denied', async () => {
    const openAppSettings = vi.fn();
    const denied = new Error('permission denied');
    const result = withBlePermissionHelp(
      async () => Promise.reject(denied),
      blePlatform({
        getSdkInt: () => 31,
        isPermissionPermanentlyDenied: () => true,
        openAppSettings,
      }),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('“附近的设备”权限');
    });
    const action = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '打开应用设置',
    );
    action?.click();

    expect(await result).toBe(denied);
    expect(openAppSettings).toHaveBeenCalledOnce();
  });

  it('distinguishes disabled location services on Android 11', async () => {
    const connect = vi.fn(async () => undefined);
    const result = withBlePermissionHelp(
      connect,
      blePlatform({ getSdkInt: () => 30, isLocationEnabled: () => false }),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('定位服务已关闭');
    });
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '取消',
    );
    cancel?.click();

    expect((await result) as Error).toMatchObject({ message: '定位服务已关闭，无法扫描蓝牙设备' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('tracks the visual viewport height and keyboard inset', () => {
    const viewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    viewport.height = 420;
    viewport.offsetTop = 0;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    const stop = syncVisualViewport(viewport as VisualViewport);
    expect(document.documentElement.style.getPropertyValue('--android-viewport-height')).toBe(
      '420px',
    );
    expect(document.documentElement.style.getPropertyValue('--android-keyboard-inset')).toBe(
      '380px',
    );
    expect(document.documentElement.hasAttribute('data-keyboard-open')).toBe(true);
    stop();
  });
});
