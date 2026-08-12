import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset URLs, so the identical build works served from a web root
  // and loaded by the desktop shell's app:// scheme.
  base: './',
  build: {
    rollupOptions: {
      // MapLibre is the only heavy dependency and it never changes between
      // deploys — its own chunk stays cached across releases.
      output: {
        manualChunks: (id) => (id.includes('node_modules/maplibre-gl') ? 'vendor-maplibre' : undefined),
      },
    },
  },
});
