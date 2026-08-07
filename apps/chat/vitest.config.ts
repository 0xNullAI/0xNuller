import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [path.resolve(__dirname, '../../test/setup/localstorage.ts')],
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
