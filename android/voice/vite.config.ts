import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite config for the Tauri Android shell.
 *
 * Re-uses DG-Voice's full React app (../../src) and only overrides the entry
 * point (apps/tauri-android/src/main.tsx) so the Tauri BLE transport can be
 * injected via `<App transport={...} />`. The `@` alias intentionally points
 * at the SAME `../../src` the web build uses — there is no forked copy of the
 * UI here, only a different entry file.
 *
 * `clearScreen: false` and the Tauri-recommended fixed dev port keep
 * `cargo tauri android dev` happy.
 */
export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
    },
  },
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 1421,
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
});
