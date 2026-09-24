import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendTarget = 'http://127.0.0.1:3001'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': { target: backendTarget },
      '/ws': { target: backendTarget, ws: true },
      '/files': { target: backendTarget },
      '/captured': { target: backendTarget },
      '/statics': { target: backendTarget },
      '/animated': { target: backendTarget }
    }
  }
})