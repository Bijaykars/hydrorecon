import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { engineSignature } from './pipeline/engine-signature.mjs';

/**
 * The local data stores, reachable at the same URLs in development and in the
 * packaged desktop shell.
 *
 * WHAT IS SERVED, AND WHY NONE OF IT IS BUNDLED:
 *
 *   /topo       Nepal's scanned survey sheets, ~4.2 GB, from the folder named
 *               by HYDRORECON_TOPO_DIR. Copying them into public/ would put
 *               them in every build and every backup, and they cannot be
 *               redistributed.
 *   /glofas     Daily discharge from the local GloFAS store. Open-Meteo is a
 *               free, donation-funded layer over the same reanalysis, and this
 *               app was spending its quota on every click; one exhausted
 *               afternoon cost a twelve-hour pause. It is a SOURCE, not a
 *               stand-in — the numbers are the ones Open-Meteo would return.
 *   /gedtm      Windows out of the 30 m bare-earth DTM, ~0.97 GB.
 *   /worldcover Windows out of ESA WorldCover, 598 MB. uint8: class codes.
 *   /geology    The DMG province geological tiles. Free downloads, but DMG
 *               sells the printed sheets, so the derived tiles stay local.
 *   /local      local/units.json carries its own "PRIVATE LAYER — local use
 *   /dhm        only" note; dhm/*.json are DHM records supplied privately.
 *               Both used to live in public/, which meant a deployment
 *               published them. .gitignore kept them out of the REPOSITORY and
 *               nothing kept them out of the BUILD, the more exposed of the two.
 *
 * Every consumer already treats a miss as the ordinary answer — src/api.ts
 * falls back to the network and simply does not offer GEDTM30,
 * src/landcover.ts reads "no land-cover screen", src/geology-overlay.ts "no
 * coverage", loadLocalGis() and dhmSeries() return null. So a store that is
 * not installed costs a fallback, never an error.
 *
 * `apply: 'serve'`, so a plain `vite build` for the web still has no route to
 * any of it. The desktop shell is the other host: desktop/main.cjs answers the
 * identical paths out of desktop/local-stores.cjs, which is where the URL
 * shapes, the window arithmetic, the traversal guards and the headers actually
 * live. A route that worked in development and not in the product is the whole
 * reason that module exists, and a second copy here would reopen it.
 *
 * createRequire rather than an import, because that module is CommonJS for
 * Electron's sake and loads a dynamic ESM import of its own. Vite bundles this
 * config with esbuild, which would rewrite both; requiring it at runtime from
 * the real file hands the job to Node instead.
 */
const { createLocalStores } = createRequire(import.meta.url)('./desktop/local-stores.cjs') as {
  createLocalStores: (opts: { root?: string; topoDir?: string }) => Promise<{
    notes: string[];
    resolve: (url: string) => null | {
      contentType: string;
      cacheControl?: string;
      file?: string;
      body?: string | Buffer;
    };
  }>;
};

function localStores(topoDir: string | undefined): Plugin {
  return {
    name: 'hydrorecon-local-stores',
    apply: 'serve',
    async configureServer(server) {
      const stores = await createLocalStores({ root: process.cwd(), topoDir });
      for (const note of stores.notes) server.config.logger.info(note);
      server.middlewares.use((req, res, next) => {
        const hit = stores.resolve(req.url ?? '');
        if (!hit) return next();
        res.setHeader('Content-Type', hit.contentType);
        if (hit.cacheControl) res.setHeader('Cache-Control', hit.cacheControl);
        // Streamed where it is a file on disk — a survey sheet is megabytes.
        if (hit.file) return void createReadStream(hit.file).pipe(res);
        res.end(hit.body);
      });
    },
  };
}


// The `mode` form so .env.local is read here too: Vite exposes only
// VITE_-prefixed vars to the client and puts nothing into process.env for the
// config itself, so HYDRORECON_TOPO_DIR has to be loaded explicitly.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      react(),
      tailwindcss(),
      // GHATTA_TOPO_DIR is still read: the app was renamed, and an .env.local
      // that already works should not stop working because of it.
      localStores(env.HYDRORECON_TOPO_DIR || env.GHATTA_TOPO_DIR),
    ],
    /**
     * The engine fingerprint, computed from the calculation modules on disk.
     *
     * The validation page ships a committed JSON of results and claims those
     * results cannot drift from the app. Nothing enforced it: the file sat four
     * days behind flowchoice.ts and modified-hydest.ts and still said so. With
     * the same signature stamped into the data and compiled into the page, the
     * page can compare them and admit when it is stale.
     */
    define: { __ENGINE_SIGNATURE__: JSON.stringify(engineSignature()) },
    /**
     * Let a tunnel reach the dev server.
     *
     * Every local store this app needs — GloFAS, GEDTM30, WorldCover, the topo
     * sheets — is served by `apply: 'serve'` middleware above, so a production
     * build has no route to any of them. Showing the working app to someone on
     * another machine therefore means tunnelling THE DEV SERVER, not deploying a
     * build, and Vite rejects a request whose Host header it does not recognise
     * with a bare "Blocked request" that reads like the tunnel is broken.
     *
     * Scoped to the two quick-tunnel domains rather than `true`: this opens a
     * private tool to whoever holds the URL, and a wildcard would also accept
     * any hostname that happens to resolve to this machine.
     */
    server: { allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io'] },
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

