/**
 * Android counterpart of `createWebBluetoothTransport()` (see
 * `src/lib/device-session.ts`). `DeviceSessionTransport` exists precisely so
 * this file is the ONLY Android-specific device code — everything downstream
 * (DeviceSession, ToolExecutor, the whole safety chain, the UI) is shared
 * with the web build unchanged.
 *
 * `requestDgLabDeviceTauri()` was built in @dg-kit to return the exact same
 * `{kind, device, server}` shape as the Web Bluetooth `requestDgLabDevice()`,
 * and every Tauri client exposes the same `connectDevice(device, server)`
 * passthrough as its Web Bluetooth counterpart — so no branching is needed
 * anywhere but here.
 */
import { CoyoteProtocolAdapter } from '@dg-kit/protocol';
import {
  TauriBlecDeviceClient,
  TauriBlecOpossumClient,
  requestDgLabDeviceTauri,
} from '@dg-kit/transport-tauri-blec';
import type { DeviceSessionTransport } from '@voice/lib/device-session';
import { showDevicePicker } from './components/show-device-picker';
import { withBlePermissionHelp } from './android-shell';

const SCAN_DURATION_MS = 8000;

export function createTauriTransport(): DeviceSessionTransport {
  return {
    coyote: new TauriBlecDeviceClient({
      protocol: new CoyoteProtocolAdapter(),
      selectDevice: showDevicePicker,
      scanDurationMs: SCAN_DURATION_MS,
    }),
    opossum: new TauriBlecOpossumClient({
      selectDevice: showDevicePicker,
      scanDurationMs: SCAN_DURATION_MS,
    }),
    // requestDgLabDeviceTauri() checks BLE permission before scanning and
    // throws "未授予蓝牙权限" — wrap it so a denied prompt surfaces the
    // friendly modal instead of an opaque error in the UI's error banner.
    requestDevice: () =>
      withBlePermissionHelp(() =>
        requestDgLabDeviceTauri({ selectDevice: showDevicePicker, scanDurationMs: SCAN_DURATION_MS }),
      ),
  };
}
