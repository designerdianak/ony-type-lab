import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  /** GitHub Pages: https://designerdianak.github.io/ony-type-lab/ */
  base: '/ony-type-lab/',
  plugins: [react()],
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
});
