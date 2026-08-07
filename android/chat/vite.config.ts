import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite config for the Tauri Android shell.
 *
 * Re-uses DG-Chat's full React app (../../src) and only overrides the entry
 * point (apps/tauri-android/src/main.tsx) so we can inject the Tauri BLE
 * transport into `<App deviceClientFactory={...} />`.
 *
 * `clearScreen: false` and the Tauri-recommended fixed dev port keep
 * `cargo tauri android dev` happy.
 */
export default defineConfig({
  // Source root is this directory; index.html lives next to vite.config.ts.
  root: __dirname,
  // Resolve back to the web app source so JSX / CSS modules / hooks just work.
  resolve: {
    alias: {
      '@chat': path.resolve(__dirname, '../../src'),
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
