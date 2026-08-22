import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './shell.css';
import { Shell } from './Shell';
import { runLegacyBrowserMigration } from './browser-data-migration';

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

async function bootstrap(): Promise<void> {
  await runLegacyBrowserMigration();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
}

void bootstrap();
