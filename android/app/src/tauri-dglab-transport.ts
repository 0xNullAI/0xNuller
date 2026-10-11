/**
 * The Android/desktop `DgLabTransport` for the shared DG-Lab registry, composed from the same
 * plugin-blec clients and helpers the per-module seams in `bootstrap.tsx` use.
 *
 * Nothing protocol-level lives here. Every Coyote client keeps `wrapWithLifecycleSafety`, every
 * client keeps the platform connect help, and the one shared chooser is `requestDeviceTauri()`
 * behind the platform permission help.
 */
import type {
  DgLabCoyoteClient,
  DgLabOpossumClient,
  DgLabSensorClient,
  DgLabTransport,
} from '@0xnullai/device-runtime';
import {
  TauriBlecCivetEdgingClient,
  TauriBlecDeviceClient,
  TauriBlecOpossumClient,
  TauriBlecPawPrintsClient,
} from '@dg-kit/transport-tauri-blec';
import { showDevicePicker } from './components/show-device-picker';
import { wrapWithLifecycleSafety } from './lifecycle-safety';
import { requestDeviceTauri } from './request-device-tauri';

export interface TauriDgLabTransportOptions {
  /** `withConnectPermissionHelp` on Android, `withDesktopConnectHelp` on desktop. */
  connectHelp: <T extends { connect(): Promise<void> }>(client: T) => T;
  /** `withBlePermissionHelp` on Android, `withDesktopBleHelp` on desktop. */
  permissionHelp: <T>(call: () => Promise<T>) => Promise<T>;
}

const SCAN_DURATION_MS = 8000;
const COYOTE_NAME_PREFIXES = ['47L121', 'D-LAB'];

export function createTauriDgLabTransport({
  connectHelp,
  permissionHelp,
}: TauriDgLabTransportOptions): DgLabTransport {
  return {
    requestDevice: () => permissionHelp(() => requestDeviceTauri()),
    createCoyoteClient: (protocol) => {
      const wrapped = wrapWithLifecycleSafety(
        new TauriBlecDeviceClient({
          protocol,
          selectDevice: showDevicePicker,
          namePrefixes: COYOTE_NAME_PREFIXES,
          scanDurationMs: SCAN_DURATION_MS,
        }),
      );
      // The wrapper forwards `connectDevice` only when the inner client has it. The registry
      // attaches through nothing else, so a missing passthrough must fail here, not at pick time.
      const { connectDevice } = wrapped;
      if (!connectDevice) throw new Error('当前环境不支持连接郊狼设备');
      return connectHelp({ ...wrapped, connectDevice } satisfies DgLabCoyoteClient);
    },
    createOpossumClient: (): DgLabOpossumClient =>
      connectHelp(
        new TauriBlecOpossumClient({
          selectDevice: showDevicePicker,
          scanDurationMs: SCAN_DURATION_MS,
        }),
      ),
    createSensorClient: (kind): DgLabSensorClient => {
      const options = { selectDevice: showDevicePicker, scanDurationMs: SCAN_DURATION_MS };
      return connectHelp(
        kind === 'paw-prints'
          ? (new TauriBlecPawPrintsClient(options) as DgLabSensorClient)
          : (new TauriBlecCivetEdgingClient(options) as DgLabSensorClient),
      );
    },
  };
}
