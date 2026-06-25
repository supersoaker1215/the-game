// Vite configuration for Card Lane Battle.
//
// Migration plan (not yet applied — the static-server workflow still
// works via `npm run dev:static`). This config bundles the existing
// script load order into a single hashed output when you run
// `npm run build`, which writes to `dist/`.
//
// Zero changes to the existing loose-script pattern are required to
// get started:
//   1. `npm install`
//   2. `npm run dev`   — live-reload dev server (replaces `python3 -m http.server`)
//   3. `npm run build` — prod bundle at dist/
//
// Source files are already split enough (cards / tricks / abilities /
// game / ai / ui) that a further split into ES modules is a separate
// incremental pass. For now this config just consolidates + minifies.

import { defineConfig } from 'vite';

export default defineConfig({
  // Serve / build from the repo root so index.html can stay where it is.
  root: '.',
  base: './',
  publicDir: 'audio', // audio files served as-is
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    // Keep source maps so Sentry / devtools can trace through minified code.
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'index.html'
      }
    }
  },
  server: {
    port: parseInt(process.env.PORT || '8080'),
    host: true,       // bind to 0.0.0.0 for phone/tablet testing on LAN
    strictPort: false
  },
  preview: {
    port: parseInt(process.env.PORT || '8080')
  }
});
