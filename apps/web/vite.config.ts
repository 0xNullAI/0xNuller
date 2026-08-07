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
 */
export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@agent': path.resolve(__dirname, '../agent/src'),
      '@voice': path.resolve(__dirname, '../voice/src'),
    },
  },
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' },
  server: { port: 5170 },
});
