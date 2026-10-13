import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'android',
    environment: 'jsdom',
    // Node 26's built-in localStorage shadows jsdom's; the settings store needs a working one.
    setupFiles: [`${import.meta.dirname}/../../test/setup/jsdom-gaps.ts`],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
