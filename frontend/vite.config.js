import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Keep host + proxy targets on 127.0.0.1 so opening http://127.0.0.1:3000 does not
// hit localhost/IPv6 mismatches (common macOS proxy ECONNREFUSED warnings).
const DEV_HOST = process.env.VITE_DEV_HOST || '127.0.0.1'
const CP_PORT = Number(process.env.VITE_CP_PORT || 8000)
const LIVE_PORT = Number(process.env.VITE_LIVE_PORT || 8080)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: DEV_HOST,
    port: 3000,
    strictPort: true,
    proxy: {
      '/api/live': {
        target: `http://${DEV_HOST}:${LIVE_PORT}`,
        changeOrigin: true,
      },
      '/ws/live': {
        target: `ws://${DEV_HOST}:${LIVE_PORT}`,
        ws: true,
      },
      '/api': {
        target: `http://${DEV_HOST}:${CP_PORT}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://${DEV_HOST}:${CP_PORT}`,
        ws: true,
      },
    },
  },
})
