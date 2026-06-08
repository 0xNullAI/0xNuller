import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// Served at the root of wiki.0xnullai.com (Cloudflare)
export default defineConfig({
  base: '/',
  plugins: [react(), tailwind()],
  assetsInclude: ['**/*.md'],
});
