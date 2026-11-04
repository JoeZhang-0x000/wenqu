import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: resolve(here, '../dist/web'),
    emptyOutDir: true,
    // pdf.js relies on top-level await and recent language features.
    target: 'esnext',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/pdfjs': 'http://127.0.0.1:4317',
    },
  },
});
