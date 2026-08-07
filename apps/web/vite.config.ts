/// <reference types="node" />

import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 统一外壳的构建配置。
 *
 * 四个模块各自的源码树仍在 apps/<模块>/src 下，这里只是把它们按路由挂载起来。
 * 合并前每个模块的内部别名都叫 `@`，单一构建里无法共存——已改成各自专属的
 * `@agent` / `@voice`，chat 与 market 本来就用相对路径。
 *
 * 注意：模块的**构建期契约**也要一起搬过来。Agent 的更新检查读 `__BUILD_ID__`，
 * 那是它原来 vite 配置里 define 的；只搬源码不搬 define，产物里会留下未替换的
 * 标识符，运行时直接 ReferenceError——类型检查不会报，构建也不会报。
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
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      // Agent 的 update-checker 轮询这个文件来判断有没有新版本发布。
      name: 'emit-version-json',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ buildId }, null, 2),
        });
      },
    },
  ],
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' },
  server: { port: 5170 },
});
