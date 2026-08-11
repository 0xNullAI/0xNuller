import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend builds to ./dist, served by wrangler's [assets].
// In dev, /api is proxied to a local `wrangler dev` (8787 by default).
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
