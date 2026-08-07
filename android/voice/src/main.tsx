import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '@/App';
import './styles.css';
import { createTauriTransport } from './tauri-transport';
import { attachLifecycleSafety } from './lifecycle-safety';
import { installAndroidShellBehaviours } from './android-shell';

// Android-only behaviours (status bar tint, keyboard scroll, hardware back
// button) before React renders.
installAndroidShellBehaviours();

// Built once here rather than inside the component so the lifecycle guard
// below can hold the same client instances the app is using.
const transport = createTauriTransport();

// Independent of call state — see lifecycle-safety.ts for why this is not
// merged into the shared CallSafetyGuard.
attachLifecycleSafety([transport.coyote, transport.opossum]);

// Fade out the splash placed in index.html once React commits its first frame.
queueMicrotask(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('dgv-splash');
    if (splash) {
      splash.classList.add('dgv-splash-loaded');
      setTimeout(() => splash.remove(), 250);
    }
  });
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App transport={transport} />
  </React.StrictMode>,
);
