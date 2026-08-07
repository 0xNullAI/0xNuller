import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@agent': path.resolve(__dirname, '../agent/src'),
      '@voice': path.resolve(__dirname, '../voice/src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(__dirname, '../../test/setup/jsdom-gaps.ts')],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
