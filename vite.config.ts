import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Cesium is integrated the way the official CesiumGS/cesium-vite-example does it:
// its static assets are copied verbatim and CESIUM_BASE_URL points at them.
// (vite-plugin-cesium is stale — see docs/research/2026-08-12-stack.md.)
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      // v4 preserves the full source path under dest; stripBase drops the
      // leading node_modules/cesium/Build/Cesium so output is dist/cesium/Workers etc.
      targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets'].map((dir) => ({
        src: `node_modules/cesium/Build/Cesium/${dir}`,
        dest: 'cesium',
        rename: { stripBase: 4 },
      })),
    }),
  ],
  define: {
    // Dev serves Cesium's static assets straight from node_modules (the copy
    // plugin only materializes them for the production build output).
    CESIUM_BASE_URL: JSON.stringify(
      command === 'serve' ? '/node_modules/cesium/Build/Cesium' : '/cesium'
    ),
  },
  optimizeDeps: {
    // Cesium is only reached via dynamic import; without this, the dev server
    // discovers it on first 3D entry and full-page reloads mid-session.
    include: ['cesium'],
  },
  build: {
    // The Cesium chunk is ~1.7 MB gzipped but only loads when the user enters 3D.
    chunkSizeWarningLimit: 2600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/cesium')) return 'vendor-cesium';
          if (id.includes('node_modules/maplibre-gl')) return 'vendor-maplibre';
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) {
            return 'vendor-echarts';
          }
        },
      },
    },
  },
}));
