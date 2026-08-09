import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': resolve(import.meta.dirname, 'src/cloudflare-workers-test.ts'),
    },
  },
  test: { name: 'auth', environment: 'node', include: ['src/**/*.test.ts'] },
});
