import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  test: {
    name: 'playground',
    // jsdom: the game hook drives a window timer and reads key events.
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(here, '../../test/setup/jsdom-gaps.ts')],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
