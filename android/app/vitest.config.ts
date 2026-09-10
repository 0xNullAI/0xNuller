import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'android',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
