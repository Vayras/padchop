import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths, so the build works from any URL path (e.g. GitHub Pages).
  base: './',
  plugins: [react()],
})
