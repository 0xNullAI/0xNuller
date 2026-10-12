import './polyfills';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Shell } from '@0xnullai/web/Shell';
import { NativeBridgeProvider, type NativeBridge } from '@0xnullai/native';
import { createUnifiedShellDgLabRegistry } from '@0xnullai/web/dglab-device-registry';
import { installShellErrorReporting } from '@0xnullai/web/client-error-reporting';
import { prewarmDgLabDeviceScan } from '@dg-kit/transport-tauri-blec';
import { OtaConfirm } from './components/OtaConfirm';
import { UpdateBanner } from './components/UpdateBanner';
import { otaUpdater } from './services/ota';
import { attachAndroidDgLabLifecycle } from './lifecycle-safety';
import { createTauriDgLabTransport } from './tauri-dglab-transport';
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
 * **This file's shell is hot-updatable, its native layer is not.** UI bundles
 * reach installed apps through `services/ota.ts`; a mistake that stops the UI
 * from rendering is rolled back after a few starts, but anything needing new
 * Rust/Kotlin/plugin code still waits for the next APK. Every module reaches DG-Lab devices only through the one
 * registry below (`NativeBridge.dglab`); there is no per-module device seam.
 */

installAndroidShellBehaviours();
// Same reporter as the web shell; sends no cookies or Bearer token.
installShellErrorReporting('android');
// If Bluetooth permission was granted on an earlier run, begin collecting
// named DG-Lab advertisements behind the splash screen. Missing permission is
// deliberately not requested here; the user's first connect action owns that
// system prompt and its explanatory UI.
void prewarmDgLabDeviceScan().catch(() => undefined);

// The one DG-Lab connection owner for the whole APK. Every off-screen signal stops all of its
// Coyote and Opossum output, on top of the per-client lifecycle wrapper each Coyote keeps
// (`wrapWithLifecycleSafety` inside the transport).
const dglab = createUnifiedShellDgLabRegistry({
  transport: createTauriDgLabTransport({
    connectHelp: withConnectPermissionHelp,
    permissionHelp: withBlePermissionHelp,
  }),
  attachNativeLifecycle: attachAndroidDgLabLifecycle,
});

const bridge = {
  dglab,
  app: {
    status: async () => {
      const status = await otaUpdater.nativeStatus();
      return { installedVersion: status.embeddedVersion, hotUpdate: status.active !== null };
    },
    resetUi: () => otaUpdater.reset(),
  },
  // Non-device Agent flags only: no speech, bridge or version.json on the native shell.
  agent: {
    servicesOverrides: {
      disableSpeech: true,
      disableBridge: true,
      disableUpdateChecker: true,
    },
  },
} satisfies NativeBridge;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SplashDismiss />
    <UpdateBanner dglab={dglab} />
    <NativeBridgeProvider bridge={bridge}>
      <Shell />
    </NativeBridgeProvider>
    <OtaConfirm buildId={__BUILD_ID__} />
  </React.StrictMode>,
);
