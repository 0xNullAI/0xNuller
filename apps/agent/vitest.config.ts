/// <reference types="node" />

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@agent': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
  },
});
