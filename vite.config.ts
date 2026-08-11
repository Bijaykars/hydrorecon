import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const sitesStaticWorker = () => ({
  name: 'sites-static-worker',
  generateBundle(this: { emitFile: (asset: { type: 'asset'; fileName: string; source: string }) => void }) {
    this.emitFile({
      type: 'asset',
      fileName: 'server/index.js',
      source: `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
`,
    });
  },
});

export default defineConfig({
  plugins: [react(), sitesStaticWorker()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-map': ['maplibre-gl'],
          'vendor-react': ['react', 'react-dom'],
        },
      },
    },
  },
});
