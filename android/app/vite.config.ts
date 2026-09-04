/// <reference types="node" />

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildId } from '../../scripts/vite-version.ts';
import { unwrapCascadeLayers } from './android-css-compat.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const r = (p: string) => path.resolve(here, p);

// No update checker in the APK (no hot update), so no version.json — but the
// shell still stamps its own build id, and 'tauri' is what marks it as one.
const buildId = resolveBuildId('tauri');

const androidCssCompatibility: Plugin = {
  name: 'android-css-compatibility',
  apply: 'build',
  async generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type !== 'asset' || !output.fileName.endsWith('.css')) continue;
      const css =
        typeof output.source === 'string'
          ? output.source
          : new TextDecoder().decode(output.source ?? new Uint8Array());
      output.source = await unwrapCascadeLayers(css);
    }
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), androidCssCompatibility],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  resolve: {
    // There must be exactly one React instance across the whole repo. Market once
    // declared react@18 while everything else was 19, npm could not hoist it, and
    // the result was that its chunk got a second React instance and useState read
    // a null dispatcher and crashed outright.
    dedupe: ['react', 'react-dom'],
    alias: {
      // Module-internal aliases. Before the merge every module used `@`, which
      // collides once they are packed into a single build, so each got its own
      // prefix; these must stay consistent with apps/web/vite.config.ts.
      '@agent': r('../../apps/agent/src'),
      '@voice': r('../../apps/voice/src'),
      '@chat': r('../../apps/chat/src'),
      '@control': r('../../apps/control/src'),
      '@dg-agent/web-app': r('../../apps/agent/src'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
  },
  build: {
    // Android OS support is separate from the updatable WebView runtime.
    // Tailwind 4 requires a modern engine; older WebViews receive an upgrade screen.
    target: ['chrome111', 'safari16.4'],
    sourcemap: true,
    outDir: mode === 'desktop' ? 'dist-desktop' : 'dist',
  },
}));
