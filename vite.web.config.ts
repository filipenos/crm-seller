import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  plugins: [react()],
  build: { outDir: resolve(__dirname, 'dist-web'), emptyOutDir: true },
  resolve: {
    alias: [
      { find: '@renderer/api', replacement: resolve(__dirname, 'src/web/client/api.ts') },
      { find: '@renderer', replacement: resolve(__dirname, 'src/renderer/src') },
      { find: '@shared', replacement: resolve(__dirname, 'src/shared') }
    ]
  }
})
