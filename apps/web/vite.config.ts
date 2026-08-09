/// <reference types="node" />

import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The unified shell. The four modules' source trees still live under
 * apps/<module>/src; this config mounts them by route.
 *
 * A module's **build-time contract** has to move along with it: Agent's update
 * check reads __BUILD_ID__, a constant that used to be defined in its own vite
 * config. Move the source without the define and the bundle keeps an unreplaced
 * identifier that becomes a plain ReferenceError at runtime — neither typecheck
 * nor the build reports it.
 */
const buildId = process.env.VERCEL_GIT_COMMIT_SHA ?? `local-${Date.now()}`;

export default defineConfig({
  root: __dirname,
  resolve: {
    // There must be exactly one React instance across the whole repo. Before the
    // merge apps/market declared react@18 while everything else was 19, npm could not
    // hoist it, so a second copy sat in apps/market/node_modules — Market's chunk got
    // the other React instance and useState read a null dispatcher and crashed
    // outright. The versions are unified now; this is one more backstop so that if
    // someone reintroduces a different version it will not silently split into two
    // instances.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@agent': path.resolve(__dirname, '../agent/src'),
      '@voice': path.resolve(__dirname, '../voice/src'),
    },
  },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'emit-version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId }, null, 2) });
      },
    },
  ],
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' },
  server: { port: 5170 },
});
