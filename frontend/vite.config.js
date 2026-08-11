import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  base: './',
  build: {
    outDir: 'dist',
    // Ship sourcemaps so DevTools can show real component/file names and
    // line numbers when debugging inside Element's iframe, instead of the
    // minified bundle. This doesn't disable minification (the shipped JS is
    // unchanged) — it just adds a .map file DevTools uses to unminify what
    // you see in Sources. Safe for this app: no backend, nothing secret in
    // the source that isn't already visible in the bundle itself.
    sourcemap: true
  }
})
