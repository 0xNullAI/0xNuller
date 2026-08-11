import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  resolve: {
    // The module-internal alias. Every module has its own prefix rather than a
    // shared `@`, which collides once they are packed into one build; this must
    // stay in step with apps/web and android/app.
    alias: { '@control': path.resolve(here, 'src') },
  },
  test: {
    name: 'control',
    // jsdom: the playback state lives in React hooks and the safety summaries
    // are read out of a rendered component tree.
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(here, '../../test/setup/jsdom-gaps.ts')],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
