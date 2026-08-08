/// <reference types="node" />

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const r = (p: string) => path.resolve(here, p);

const buildId = process.env.VERCEL_GIT_COMMIT_SHA ?? `tauri-${Date.now()}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  resolve: {
    // React 必须全仓只有一份实例。Market 曾经声明 react@18 而其余是 19，npm 无法提升，
    // 结果是它的 chunk 拿到第二个 React 实例、useState 读到 null dispatcher 直接崩。
    dedupe: ['react', 'react-dom'],
    alias: {
      // 模块内部别名。合并前各模块都用 `@`，塞进同一个构建会互相撞车，
      // 所以改成各自的前缀，这里必须与 apps/web/vite.config.ts 保持一致。
      '@agent': r('../../apps/agent/src'),
      '@voice': r('../../apps/voice/src'),
      '@chat': r('../../apps/chat/src'),
      '@dg-agent/web-app': r('../../apps/agent/src'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
  },
});
