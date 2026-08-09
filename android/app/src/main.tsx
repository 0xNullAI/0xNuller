import React from 'react';
import ReactDOM from 'react-dom/client';
import { Shell } from '@0xnullai/web/Shell';
import { NativeBridgeProvider } from '@0xnullai/native';
import {
  TauriBlecDeviceClient,
  TauriBlecOpossumClient,
  TauriBlecPawPrintsClient,
  TauriBlecCivetEdgingClient,
} from '@dg-kit/transport-tauri-blec';
import { showDevicePicker } from './components/show-device-picker';
import { UpdateBanner } from './components/UpdateBanner';
import { connectAnyDgLabDeviceTauri } from './connect-any-device-tauri';
import { requestDeviceTauri } from './request-device-tauri';
import { createTauriTransport } from './tauri-transport';
import { wrapWithLifecycleSafety } from './lifecycle-safety';
import { installAndroidShellBehaviours, withBlePermissionHelp } from './android-shell';
import './styles.css';

/**
 * The unified Android app: one APK, six modules.
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

installAndroidShellBehaviours();

// Fade out the splash screen from index.html once React has committed its first frame.
queueMicrotask(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('nx-splash');
    if (splash) {
      splash.classList.add('nx-splash-loaded');
      setTimeout(() => splash.remove(), 250);
    }
  });
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
function withConnectPermissionHelp<T extends { connect(): Promise<void> }>(inner: T): T {
  const rawConnect = inner.connect.bind(inner);
  inner.connect = () => withBlePermissionHelp(rawConnect);
  return inner;
}

const bridge = {
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
        return { ...inner, connect: () => withBlePermissionHelp(() => inner.connect()) };
      },
      createOpossumClient: () =>
        withConnectPermissionHelp(
          new TauriBlecOpossumClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
        ),
      createPawPrintsClient: () =>
        withConnectPermissionHelp(
          new TauriBlecPawPrintsClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
        ),
      createCivetEdgingClient: () =>
        withConnectPermissionHelp(
          new TauriBlecCivetEdgingClient({ selectDevice: showDevicePicker, scanDurationMs: 8000 }),
        ),
    },
    connectDevice: (clients: unknown) =>
      withBlePermissionHelp(() => connectAnyDgLabDeviceTauri(clients as never)),
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
      return { ...inner, connect: () => withBlePermissionHelp(() => inner.connect()) };
    },
    requestDevice: () => withBlePermissionHelp(() => requestDeviceTauri()),
  },
  voice: {
    transport: createTauriTransport(),
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UpdateBanner />
    <NativeBridgeProvider bridge={bridge}>
      <Shell />
    </NativeBridgeProvider>
  </React.StrictMode>,
);
