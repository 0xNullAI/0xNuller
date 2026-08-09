/// <reference types="node" />

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { emitVersionJson, resolveBuildId } from '../../scripts/vite-version.js';

const buildId = resolveBuildId('local');

export default defineConfig({
  plugins: [react(), tailwindcss(), emitVersionJson(buildId)],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  resolve: {
    alias: {
      '@agent': path.resolve(__dirname, './src'),
    },
  },
  base: './',
});
