import { DesktopLifecycle } from './DesktopLifecycle';
import { withDesktopBleHelp, withDesktopConnectHelp } from './desktop-platform';
import './polyfills';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Shell } from '@0xnullai/web/Shell';
import { NativeBridgeProvider, type NativeBridge } from '@0xnullai/native';
import { createUnifiedShellEmbeddedDeviceRuntime } from '@0xnullai/web/embedded-device-runtime';
import {
  createBrowserVideoControl,
  type BrowserVideoControlOptions,
} from '@dg-agent/agent-browser';
import { CoyoteProtocolAdapter } from '@dg-kit/protocol';
import {
  TauriBlecDeviceClient,
  TauriBlecOpossumClient,
  TauriBlecPawPrintsClient,
  TauriBlecCivetEdgingClient,
  prewarmDgLabDeviceScan,
} from '@dg-kit/transport-tauri-blec';
import { showDevicePicker } from './components/show-device-picker';
import { UpdateBanner } from './components/UpdateBanner';
import { connectAnyDgLabDeviceTauri } from './connect-any-device-tauri';
import { requestDeviceTauri } from './request-device-tauri';
import { createTauriTransport } from './tauri-transport';
import { attachAndroidDeviceRuntimeLifecycle, wrapWithLifecycleSafety } from './lifecycle-safety';
import { ButtplugDeviceBackend } from './buttplug-device-backend';
import { SplashDismiss } from './SplashDismiss';
import {
  installAndroidShellBehaviours,
  withBlePermissionHelp,
  withConnectPermissionHelp,
} from './android-shell';
import './styles.css';

/**
 * The unified Android app: one APK, seven modules.
 *
 * Before the merge there were three separately packaged APKs (Agent / Chat /
 * Voice); the user had to install three of them, connect the device once in
 * each, and configure the settings three times. Now Control, Agent, Voice,
 * Chat, Playground and Market are modules inside one shell, sharing the
 * device, the safety settings, the scene library, the waveform library and
 * the account.
 *
 * **Android has no hot updates.** Any mistake made here lives on users' phones
 * for a long time, so the shape of the three native injection seams is kept
 * exactly as it was (see the comments in @0xnullai/native); only the injection
 * point is merged into one.
 */

const desktop = import.meta.env.MODE === 'desktop';
const connectHelp = desktop ? withDesktopConnectHelp : withConnectPermissionHelp;
const permissionHelp = desktop ? withDesktopBleHelp : withBlePermissionHelp;
if (!desktop) installAndroidShellBehaviours();
// If Bluetooth permission was granted on an earlier run, begin collecting
// named DG-Lab advertisements behind the splash screen. Missing permission is
// deliberately not requested here; the user's first connect action owns that
// system prompt and its explanatory UI.
if (!desktop) void prewarmDgLabDeviceScan().catch(() => undefined);

// One provider/controller pair for the whole APK. Constructing it does not invoke the native
// backend; the local default-off setting and a later human scan action gate initialization.
const embeddedDevices = createUnifiedShellEmbeddedDeviceRuntime({
  backendFactory: () => new ButtplugDeviceBackend(),
  attachNativeLifecycle: attachAndroidDeviceRuntimeLifecycle,
});

// Inlined by Vite at build time. Android requests carry no browser Origin, so
// the free proxy relies on this signature to tell "our client" from "anyone".
const freeProxySecret = import.meta.env.VITE_DG_PROXY_SECRET;

/**
 * Wrap `connect()` with the permission help in place, returning the same instance.
 *
 * **Deliberately not `{ ...inner, connect }`**: inner here is a class instance,
 * and methods declared in the class body live on the prototype, not on the
 * instance. Spreading only copies own enumerable properties, so
 * disconnect/getState/execute are all lost, and every call other than connect
 * then throws "is not a function".
 */
const bridge = {
  deviceRuntime: embeddedDevices.deviceRuntime,
  agent: {
    servicesOverrides: {
      disableSpeech: true,
      disableBridge: true,
      disableUpdateChecker: true,
      freeProxySecret,
      createDeviceClient: (
        protocol: ConstructorParameters<typeof TauriBlecDeviceClient>[0]['protocol'],
      ) => {
        const inner = wrapWithLifecycleSafety(
          new TauriBlecDeviceClient({
            protocol,
            selectDevice: showDevicePicker,
            namePrefixes: ['47L121', 'D-LAB'],
            scanDurationMs: 8000,
          }),
        );
        // Give the user an understandable prompt when they deny the Bluetooth
        // permission. The inner client throws 「未授予蓝牙权限」, which without
        // this wrapper is just a small notice and leaves the user with no idea
        // what to do about it.
        return connectHelp(inner);
      },
      createOpossumClient: () =>
        connectHelp(
          new TauriBlecOpossumClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
        ),
      createPawPrintsClient: () =>
        connectHelp(
          new TauriBlecPawPrintsClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
        ),
      createCivetEdgingClient: () =>
        connectHelp(
          new TauriBlecCivetEdgingClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
        ),
    },
    connectDevice: (clients: unknown) =>
      permissionHelp(() => connectAnyDgLabDeviceTauri(clients as never)),
  },
  chat: {
    deviceClientFactory: (
      protocol: ConstructorParameters<typeof TauriBlecDeviceClient>[0]['protocol'],
    ) => {
      const inner = wrapWithLifecycleSafety(
        new TauriBlecDeviceClient({
          protocol,
          selectDevice: showDevicePicker,
          namePrefixes: ['47L121', 'D-LAB'],
          scanDurationMs: 8000,
        }),
      );
      return connectHelp(inner);
    },
    requestDevice: () => permissionHelp(() => requestDeviceTauri()),
  },
  voice: {
    transport: createTauriTransport(),
  },
  video: {
    createControlService: (options: BrowserVideoControlOptions) => {
      // Keep one native Coyote client: the shared Video service assigns an
      // opaque ID per connection and rejects a second target when this
      // transport composition cannot independently prove multiple identities.
      const device = connectHelp(
        wrapWithLifecycleSafety(
          new TauriBlecDeviceClient({
            protocol: new CoyoteProtocolAdapter(),
            selectDevice: showDevicePicker,
            namePrefixes: ['47L121', 'D-LAB'],
            scanDurationMs: 8000,
          }),
        ),
      );
      const opossum = connectHelp(
        new TauriBlecOpossumClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
      );
      return createBrowserVideoControl({
        ...options,
        device,
        opossum,
        connectOutputDevice: (clients) => permissionHelp(() => connectAnyDgLabDeviceTauri(clients)),
      });
    },
  },
} satisfies NativeBridge;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SplashDismiss />
    {desktop ? <DesktopLifecycle /> : <UpdateBanner />}
    <NativeBridgeProvider bridge={bridge}>
      <Shell />
    </NativeBridgeProvider>
  </React.StrictMode>,
);
