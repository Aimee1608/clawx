import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Vite build output lands in the parent's `dist/web-assets/` so the Node
// runtime can serve it from a single known path (see ../src/web.ts).
// During dev, Vite's own server runs at :5173 and proxies /api to the
// running clawx backend at :8123 (override via CLAWX_API_TARGET).
const apiTarget = process.env.CLAWX_API_TARGET ?? 'http://127.0.0.1:8123'

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'dist', 'web-assets'),
    emptyOutDir: true,
    // Asset paths must be relative so the bundle works when served
    // under any base URL the embedded HTTP server decides on.
    assetsDir: 'assets',
  },
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
    },
  },
})
