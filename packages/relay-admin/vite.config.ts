import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Dev: `bun run dev` proxies /api to a local relay on :8080. Add ?mock=1 (or VITE_MOCK=1) to run
// against the in-browser mock API instead.
export default defineConfig({
  base: '/admin/',
  plugins: [tailwindcss()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 700 },
  server: {
    proxy: {
      '/api/admin/stats': { target: 'ws://127.0.0.1:8080', ws: true },
      '/api': 'http://127.0.0.1:8080',
    },
  },
})
