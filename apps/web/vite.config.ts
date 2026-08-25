/// <reference types="node" />

import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { emitVersionJson, resolveBuildId } from '../../scripts/vite-version.ts';
import productPackage from '../../package.json' with { type: 'json' };

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
const buildId = resolveBuildId('local');

/**
 * Optional dev proxy onto locally-running Workers.
 *
 * In production every `/api/*` path is taken over by a Worker on the same
 * origin, so the client sends bare relative paths. `vite dev` serves the shell
 * alone, so those paths resolve to the SPA's index.html and the client parses
 * HTML as JSON — which is why nothing account-shaped (sign-in, profile,
 * contacts, direct messages) can be exercised locally without this.
 *
 * Off unless asked for, because a proxy pointed at a port nothing is listening
 * on fills the console with ECONNREFUSED and makes the default `npm run dev`
 * look broken. To use it:
 *
 *     wrangler dev --config workers/auth/wrangler.jsonc --port 8787
 *     DEV_API_PROXY=http://127.0.0.1:8787 npm run dev -w @0xnullai/web
 *
 * Point it at whichever Worker owns the paths being worked on; the chat Worker
 * serves /ws and /api/lobby, /api/upload, /api/media, /api/dm.
 */
const apiProxyTarget = process.env.DEV_API_PROXY;
const proxy = apiProxyTarget
  ? {
      '/api': { target: apiProxyTarget, changeOrigin: true },
      '/ws': { target: apiProxyTarget, changeOrigin: true, ws: true },
    }
  : undefined;

export default defineConfig({
  root: import.meta.dirname,
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
      '@agent': path.resolve(import.meta.dirname, '../agent/src'),
      '@voice': path.resolve(import.meta.dirname, '../voice/src'),
      '@control': path.resolve(import.meta.dirname, '../control/src'),
    },
  },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [react(), tailwindcss(), emitVersionJson(buildId, productPackage.version)],
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' },
  server: { port: 5170, proxy },
});
