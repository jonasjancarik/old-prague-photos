import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    fs: {
      allow: [resolve(__dirname, '..')],
    },
  },
  build: {
    outDir: '../static',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        pomoc: resolve(__dirname, 'pomoc.html'),
        'dup-review': resolve(__dirname, 'dup-review.html'),
        'group-review': resolve(__dirname, 'group-review.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
});
