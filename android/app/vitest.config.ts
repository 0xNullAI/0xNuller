/// <reference types="node" />

import { defineConfig } from 'vitest/config';
import path from 'node:path';

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
    name: 'android',
    // jsdom 而不是 node：生命周期安全网挂的是 document / window 上的事件。
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
