import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/renderer', emptyOutDir: true,
    rollupOptions: { input: {
      setup: path.resolve('index.html'),
      popover: path.resolve('popover.html'),
      overlay: path.resolve('overlay.html'),
    } },
  },
});
