import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Serve Nepal's scanned survey sheets from wherever they already live.
 *
 * The sheets are ~4.2 GB of scanned government maps. Copying them into public/
 * would put them in every build and every backup; committing them is out of the
 * question. So the dev server streams them from their original folder, named by
 * GHATTA_TOPO_DIR, and nothing is duplicated or bundled.
 *
 * Development only, deliberately. A production build has no route here, so the
 * overlay simply does not exist in `npm run build` output — which is the right
 * default for imagery that cannot be redistributed.
 *
 * Only basenames from the requested directory are served, and only image
 * extensions: a path from the browser must not be able to walk out of the
 * folder and read the rest of the disk.
 */
function topoSheets(dir: string | undefined): Plugin {
  return {
    name: 'ghatta-topo-sheets',
    apply: 'serve',
    configureServer(server) {
      if (!dir || !existsSync(dir)) return;
      server.middlewares.use('/topo', (req, res, next) => {
        const raw = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
        // basename() strips any traversal; the extension test bounds it further.
        const name = basename(raw);
        if (!name || !/\.(jpe?g|png)$/i.test(name)) return next();
        const file = join(dir, name);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', /\.png$/i.test(name) ? 'image/png' : 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        createReadStream(file).pipe(res);
      });
      server.config.logger.info(`  ➜  topo sheets served from ${dir}`);
    },
  };
}

// The `mode` form so .env.local is read here too: Vite exposes only
// VITE_-prefixed vars to the client and puts nothing into process.env for the
// config itself, so GHATTA_TOPO_DIR has to be loaded explicitly.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss(), topoSheets(env.GHATTA_TOPO_DIR)],
    // Relative asset URLs, so the identical build works served from a web root
    // and loaded by the desktop shell's app:// scheme.
    base: './',
    build: {
      rollupOptions: {
        // The app plus the validation page — predicted vs built, shipped beside it.
        input: { main: 'index.html', validation: 'validation.html' },
        // MapLibre is the only heavy dependency and it never changes between
        // deploys — its own chunk stays cached across releases.
        output: {
          manualChunks: (id) =>
            id.includes('node_modules/maplibre-gl') ? 'vendor-maplibre' : undefined,
        },
      },
    },
  };
});
