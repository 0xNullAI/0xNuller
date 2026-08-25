/// <reference types="node" />

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'video',
    environment: 'jsdom',
  },
});
