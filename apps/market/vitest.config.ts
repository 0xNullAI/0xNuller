import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'market',
    environment: 'node',
    include: [
      'src/shared/**/*.{test,spec}.ts',
      'src/worker/**/*.{test,spec}.ts',
      'src/web/**/*.{test,spec}.{ts,tsx}',
    ],
  },
});
