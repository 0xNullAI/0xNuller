import { recoverPreloadFailure } from './preload-recovery';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createWebBluetoothDgLabTransport } from '@0xnullai/device-runtime';
import { NativeBridgeProvider } from '@0xnullai/native';
import './shell.css';
import { Shell } from './Shell';
import { createUnifiedShellDgLabRegistry } from './dglab-device-registry';
import { loadLocale } from '@0xnullai/settings';
import { installShellErrorReporting } from './client-error-reporting';

document.documentElement.lang = loadLocale();
installShellErrorReporting('web');

// The one DG-Lab connection owner for this tab. Constructing it opens no picker and touches no
// Bluetooth API; only a human connect action through a module does.
const dglab = createUnifiedShellDgLabRegistry({ transport: createWebBluetoothDgLabTransport() });

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
    <NativeBridgeProvider bridge={{ dglab }} native={false}>
      <Shell />
    </NativeBridgeProvider>
  </StrictMode>,
);
