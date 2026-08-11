import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@agent': path.resolve(import.meta.dirname, '../agent/src'),
      '@voice': path.resolve(import.meta.dirname, '../voice/src'),
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['../../test/setup/jsdom-gaps.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
