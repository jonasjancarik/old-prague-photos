import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __MAP_APP_SCRIPT_VERSION__: JSON.stringify(createHash('sha256')
      .update(readFileSync(resolve(__dirname, '../static/app.js')))
      .digest('hex').slice(0, 12)),
  },
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
