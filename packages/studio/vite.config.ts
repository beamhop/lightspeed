import { defineConfig } from 'vite'

// The Studio server (src/server.ts) serves ./dist and provides /api/*; during `vite dev`
// point /api at a running `bun src/server.ts --no-open` with STUDIO_API.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: { dedupe: ['preact', '@preact/signals'] },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: true },
  server: {
    proxy: { '/api': process.env.STUDIO_API ?? 'http://127.0.0.1:4710' },
  },
})
