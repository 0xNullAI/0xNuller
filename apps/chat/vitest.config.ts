import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [path.resolve(import.meta.dirname, '../../test/setup/jsdom-gaps.ts')],
    environment: 'jsdom',
    globals: true,
    // worker/ and shared/ were outside this glob, which is why the room
    // DO, the lobby and media upload had no tests — any that were written
    // would simply never have run.
    include: ['{src,worker,shared}/**/*.{test,spec}.{ts,tsx}'],
  },
});
