/**
 * The shared registry's one Tauri chooser (see `tauri-dglab-transport.ts`) — the Tauri
 * counterpart to `@dg-kit/transport-webbluetooth`'s `requestDgLabDevice()`.
 *
 * `@dg-kit/transport-tauri-blec`'s `requestDgLabDeviceTauri()` runs ONE
 * plugin-blec scan across all 4 DG-Lab device kinds' name prefixes, shows
 * ONE `showDevicePicker()` modal, and auto-detects which kind was picked via
 * `detectDeviceKind()` — same one-button, one-chooser experience as the web
 * build. The registry routes the result the same way regardless of which one produced it.
 */
import {
  requestDgLabDeviceTauri,
  type RequestedDgLabDeviceTauri,
} from '@dg-kit/transport-tauri-blec';
import { showDevicePicker } from './components/show-device-picker';

export function requestDeviceTauri(): Promise<RequestedDgLabDeviceTauri> {
  return requestDgLabDeviceTauri({ selectDevice: showDevicePicker, scanDurationMs: 8000 });
}
