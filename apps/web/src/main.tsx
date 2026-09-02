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
const PRELOAD_REFRESH_KEY = '0xnuller.module-preload-refresh';
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  const now = Date.now();
  let lastRefresh = 0;
  try {
    lastRefresh = Number(sessionStorage.getItem(PRELOAD_REFRESH_KEY) ?? 0);
  } catch {
    // Storage can be unavailable in privacy-restricted WebViews; one reload is
    // still a better recovery attempt than leaving a permanently rejected lazy chunk.
  }
  if (now - lastRefresh < 60_000) return;
  try {
    sessionStorage.setItem(PRELOAD_REFRESH_KEY, String(now));
  } catch {
    // See above; location.reload remains available without storage.
  }
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NativeBridgeProvider bridge={{ deviceRuntime: embeddedDevices.deviceRuntime }} native={false}>
      <Shell />
    </NativeBridgeProvider>
  </StrictMode>,
);
