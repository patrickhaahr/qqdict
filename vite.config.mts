import { defineConfig } from 'vite';
import path from 'node:path';
import { buildIdentity } from './scripts/build-channel.mjs';

const { channel, productName } = buildIdentity();

export default defineConfig({
  base: './',
  define: { 'process.env.QQDICT_CHANNEL': JSON.stringify(channel) },
  plugins: [{
    name: 'app-product-name',
    transformIndexHtml: (html) => html.replaceAll('qqdict', productName),
  }],
  build: {
    outDir: 'dist/renderer', emptyOutDir: true,
    rollupOptions: { input: {
      setup: path.resolve('index.html'),
      popover: path.resolve('popover.html'),
      overlay: path.resolve('overlay.html'),
    } },
  },
});
