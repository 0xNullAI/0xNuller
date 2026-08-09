/// <reference types="node" />

import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  resolve: {
    alias: {
      '@agent': path.resolve(here, '../../apps/agent/src'),
      '@voice': path.resolve(here, '../../apps/voice/src'),
      '@chat': path.resolve(here, '../../apps/chat/src'),
    },
  },
  test: {
    // The only jsdom project that lacked this. Its tests cover
    // lifecycle-safety — the stop-when-backgrounded path.
    setupFiles: [path.resolve(here, '../../test/setup/jsdom-gaps.ts')],
    name: 'android',
    // jsdom rather than node: the lifecycle safety net hooks events on
    // document / window.
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
