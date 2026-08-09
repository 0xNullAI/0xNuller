import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'market',
    environment: 'node',
    include: ['src/worker/**/*.{test,spec}.ts'],
  },
});
