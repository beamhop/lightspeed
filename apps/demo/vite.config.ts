import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/lightspeed/demo/',
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173 },
})
