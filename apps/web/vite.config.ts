/// <reference types="node" />

import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 统一外壳。四个模块的源码树仍在 apps/<模块>/src 下，这里按路由挂载它们。
 *
 * 模块的**构建期契约**也要一并搬来：Agent 的更新检查读 __BUILD_ID__，那是它原来
 * vite 配置里 define 的常量；只搬源码不搬 define，产物里会留下未替换的标识符，
 * 运行时直接 ReferenceError——类型检查与构建都不会报。
 */
const buildId = process.env.VERCEL_GIT_COMMIT_SHA ?? `local-${Date.now()}`;

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@agent': path.resolve(__dirname, '../agent/src'),
      '@voice': path.resolve(__dirname, '../voice/src'),
    },
  },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'emit-version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId }, null, 2) });
      },
    },
  ],
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' },
  server: { port: 5170 },
});
