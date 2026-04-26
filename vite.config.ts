import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// GitHub Pages serves at /DG-Wiki/ subpath
export default defineConfig({
  base: '/DG-Wiki/',
  plugins: [react(), tailwind()],
  assetsInclude: ['**/*.md'],
});
