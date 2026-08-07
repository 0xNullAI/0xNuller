import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端构建到 ./dist，由 wrangler 的 [assets] 托管。
// dev 时 /api 代理到本地 `wrangler dev`（默认 8787）。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
