import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@voice': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    setupFiles: [path.resolve(import.meta.dirname, '../../test/setup/jsdom-gaps.ts')],
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'worker/**/*.{test,spec}.ts'],
  },
});
