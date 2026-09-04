import { recoverPreloadFailure } from './preload-recovery';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WebEmbeddedButtplugBackend } from '@0xnullai/device-runtime';
import { NativeBridgeProvider } from '@0xnullai/native';
import './shell.css';
import { Shell } from './Shell';
import { createUnifiedShellEmbeddedDeviceRuntime } from './embedded-device-runtime';

// One shell-lifetime provider/controller pair. The backend factory remains untouched while the
// local experimental setting is off, so this does not load Buttplug WASM or initialize Bluetooth.
const embeddedDevices = createUnifiedShellEmbeddedDeviceRuntime({
  backendFactory: () => new WebEmbeddedButtplugBackend(),
});

// A tab opened before a deployment can still hold an index chunk that points
// at the previous Agent/Voice/etc. hash. Vite reports that exact case before
// React can recover its cached lazy() rejection. Refresh once and let the new
// index resolve the current module; throttle it so an actual offline/network
// failure never turns into a reload loop.
window.addEventListener('vite:preloadError', (event) => {
  recoverPreloadFailure(event, {
    storage: () => sessionStorage,
    reload: () => window.location.reload(),
    now: Date.now,
  });
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NativeBridgeProvider bridge={{ deviceRuntime: embeddedDevices.deviceRuntime }} native={false}>
      <Shell />
    </NativeBridgeProvider>
  </StrictMode>,
);
