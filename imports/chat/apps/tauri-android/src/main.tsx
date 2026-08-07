import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@chat/App';
// styles.css @import's @chat/index.css (which carries `@import 'tailwindcss'`)
// alongside the @source scan paths — importing index.css here too would split
// it into a separate Tailwind root with no @source, breaking utility extraction.
import './styles.css';
import { TauriBlecDeviceClient } from '@dg-kit/transport-tauri-blec';
import { showDevicePicker } from './components/show-device-picker';
import { requestDeviceTauri } from './request-device-tauri';
import { wrapWithLifecycleSafety } from './lifecycle-safety';
import { installAndroidShellBehaviours, withBlePermissionHelp } from './android-shell';

// Wire up Android-only behaviours (status bar tint, keyboard scroll,
// hardware back button) before React renders.
installAndroidShellBehaviours();

// Fade out the splash placed in index.html once React commits its first frame.
queueMicrotask(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('dgch-splash');
    if (splash) {
      splash.classList.add('dgch-splash-loaded');
      setTimeout(() => splash.remove(), 250);
    }
  });
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App
      deviceClientFactory={(protocol) => {
        const inner = wrapWithLifecycleSafety(
          new TauriBlecDeviceClient({
            protocol,
            selectDevice: showDevicePicker,
            namePrefixes: ['47L121', 'D-LAB'],
            scanDurationMs: 8000,
          }),
        );
        return {
          ...inner,
          connect: () => withBlePermissionHelp(() => inner.connect()),
        };
      }}
      // requestDgLabDeviceTauri()'s own permission check (before any scan
      // runs) is what throws "未授予蓝牙权限" now — wrap it here so a denied
      // prompt still surfaces the friendly modal, mirroring the
      // deviceClientFactory wrapping above.
      requestDeviceTauri={() => withBlePermissionHelp(() => requestDeviceTauri())}
    />
  </React.StrictMode>,
);
