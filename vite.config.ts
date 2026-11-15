import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { watch:{ignored:['**/.ui-review/**']}, proxy: { '/api': 'http://127.0.0.1:43861' } },
})
