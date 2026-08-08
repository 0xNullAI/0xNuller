import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'auth', environment: 'node', include: ['src/**/*.test.ts'] },
});
