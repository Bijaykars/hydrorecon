import { createReadStream, existsSync, openSync, readSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { engineSignature } from './pipeline/engine-signature.mjs';

/**
 * Serve Nepal's scanned survey sheets from wherever they already live.
 *
 * The sheets are ~4.2 GB of scanned government maps. Copying them into public/
 * would put them in every build and every backup; committing them is out of the
 * question. So the dev server streams them from their original folder, named by
 * HYDRORECON_TOPO_DIR, and nothing is duplicated or bundled.
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
    name: 'hydrorecon-topo-sheets',
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

/**
 * Serve daily discharge from the local GloFAS store, so development never
 * touches the shared service.
 *
 * Open-Meteo is a free, donation-funded layer over GloFAS, and this app was
 * spending its quota on every click during development — one exhausted
 * afternoon cost a twelve-hour pause and stopped the measurement work outright.
 * pipeline/fetch-glofas-nepal.py downloads the same reanalysis from ECMWF for
 * Nepal alone, and pipeline/build-glofas-store.py flattens it for point
 * queries. This hands those bytes to the browser.
 *
 * It is a SOURCE, not a stand-in: the numbers are the ones Open-Meteo would
 * have returned, so a run against this and a run against the network agree.
 *
 * Development only, like the topo sheets above. A production build has no route
 * here, and src/api.ts falls back to the network when the route is missing —
 * which is also what makes this safe to try on every request.
 */
function glofasStore(): Plugin {
  return {
    name: 'hydrorecon-glofas-store',
    apply: 'serve',
    async configureServer(server) {
      let read: ((lat: number, lon: number) => unknown) | null = null;
      try {
        // The store reader is plain JS with no types; this config is the only
        // consumer and the shape is three functions wide.
        const mod = (await import(
          /* @vite-ignore */ './pipeline/glofas-store.mjs' as string
        )) as unknown as {
          hasGlofasStore: () => boolean;
          glofasSeries: (lat: number, lon: number) => unknown;
          glofasCoverage: () => { from: string; to: string } | null;
        };
        if (!mod.hasGlofasStore()) return;
        read = mod.glofasSeries;
        const c = mod.glofasCoverage();
        if (c) server.config.logger.info(`  ➜  flow served locally from GloFAS ${c.from} to ${c.to}`);
      } catch {
        return; // no store built; the app uses the network as before
      }
      server.middlewares.use('/glofas', (req, res, next) => {
        const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const lat = Number(q.get('lat'));
        const lon = Number(q.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return next();
        const series = read!(lat, lon);
        if (!series) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(series));
      });
    },
  };
}

/**
 * Serve the land-cover store.
 *
 * Same shape as the DEM route below it and for the same reason: the app asks
 * for a window a few hundred cells across, samples it locally, and never pays
 * for the 598 MB the store actually is. uint8 rather than uint16 — these are
 * class codes, not measurements.
 *
 * Development only. A production build has no route, and src/landcover.ts
 * treats the missing meta as "no land-cover screen", which is the same answer
 * it gives outside Nepal.
 */
function worldcoverStore(): Plugin {
  const META = 'sources/worldcover/nepal-worldcover.json';
  const BIN = 'sources/worldcover/nepal-worldcover.bin';
  return {
    name: 'hydrorecon-worldcover-store',
    apply: 'serve',
    configureServer(server) {
      if (!existsSync(META) || !existsSync(BIN)) return;
      const meta = JSON.parse(readFileSync(META, 'utf8')) as { rows: number; cols: number };
      const expected = meta.rows * meta.cols;
      if (statSync(BIN).size !== expected) {
        server.config.logger.warn(
          `  ➜  land-cover store is ${statSync(BIN).size} bytes, expected ${expected} — not served`
        );
        return;
      }
      const fd = openSync(BIN, 'r');

      server.middlewares.use('/worldcover/meta', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(readFileSync(META, 'utf8'));
      });

      server.middlewares.use('/worldcover/window', (req, res, next) => {
        const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const num = (k: string) => Number(q.get(k));
        const row0 = num('row0');
        const col0 = num('col0');
        const rows = num('rows');
        const cols = num('cols');
        const ok =
          [row0, col0, rows, cols].every(Number.isInteger) &&
          rows > 0 &&
          cols > 0 &&
          row0 >= 0 &&
          col0 >= 0 &&
          row0 + rows <= meta.rows &&
          col0 + cols <= meta.cols &&
          // A scheme corridor is a few hundred cells across. Anything larger is
          // a mistake or an attempt to pull the whole store through one request.
          rows * cols <= 4_000_000;
        if (!ok) return next();

        const out = Buffer.allocUnsafe(rows * cols);
        for (let r = 0; r < rows; r++) {
          readSync(fd, out, r * cols, cols, (row0 + r) * meta.cols + col0);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(out);
      });

      server.config.logger.info(
        `  ➜  ESA WorldCover land cover served from ${BIN} (${meta.cols}x${meta.rows})`
      );
    },
  };
}

/**
 * Serve the DMG geological map tiles.
 *
 * pipeline/build-dmg-geology.py renders Nepal's published province geological
 * maps into tiles under sources/geology. They are free downloads from the
 * publishing department, but DMG sells printed sheets, so the derived tiles
 * stay local like every other third-party raster here.
 *
 * Development only. A production build has no route and src/geology-overlay.ts
 * treats the missing index as "no coverage", which is the same answer it gives
 * for Karnali.
 */
function geologyTiles(): Plugin {
  const DIR = 'sources/geology';
  return {
    name: 'hydrorecon-geology-tiles',
    apply: 'serve',
    configureServer(server) {
      if (!existsSync(`${DIR}/index.json`)) return;
      server.middlewares.use('/geology', (req, res, next) => {
        const raw = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
        // basename() strips traversal; the extension test bounds it further.
        const name = basename(raw);
        if (!name || !/^[\w.-]+\.(png|json)$/.test(name)) return next();
        const file = join(DIR, name);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        createReadStream(file).pipe(res);
      });
      const n = JSON.parse(readFileSync(`${DIR}/index.json`, 'utf8')).tiles?.length ?? 0;
      server.config.logger.info(`  ➜  geology: ${n} DMG map tiles served from ${DIR}`);
    },
  };
}

/**
 * Serve the two private data folders, WITHOUT putting them in the bundle.
 *
 * These used to live in public/, which meant Vite copied them into dist/ and a
 * deployment published them. Both are explicitly non-redistributable:
 *
 *   local/units.json carries its own "PRIVATE LAYER - local use only, not
 *   redistributable" note, from a source that grants non-commercial use only;
 *
 *   dhm/*.json are DHM's daily discharge records, supplied privately. The
 *   derived index in src/data/dhm-records.json is what travels.
 *
 * .gitignore kept them out of the REPOSITORY and nothing kept them out of the
 * BUILD, which is the more exposed of the two. Serving them from outside
 * public/ the way the topo sheets and the GloFAS store already are is the fix:
 * identical URLs in development, absent from dist entirely.
 *
 * Both consumers already treat a miss as the normal answer — loadLocalGis()
 * returns null on !ok, dhmSeries() returns null — so a production build simply
 * does without the private layers and the gauge transfer rather than breaking.
 */
function privateLayers(): Plugin {
  const FOLDERS: Record<string, string> = {
    '/local': 'sources/local',
    '/dhm': 'sources/dhm',
  };
  return {
    name: 'hydrorecon-private-layers',
    apply: 'serve',
    configureServer(server) {
      for (const [route, dir] of Object.entries(FOLDERS)) {
        if (!existsSync(dir)) continue;
        server.middlewares.use(route, (req, res, next) => {
          const raw = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
          // basename() strips traversal; the extension test bounds it further.
          const name = basename(raw);
          if (!name || !/^[\w.-]+\.json$/.test(name)) return next();
          const file = join(dir, name);
          if (!existsSync(file) || !statSync(file).isFile()) return next();
          res.setHeader('Content-Type', 'application/json');
          res.end(readFileSync(file));
        });
        server.config.logger.info(`  ➜  ${route} served from ${dir} (not bundled)`);
      }
    },
  };
}

/**
 * Serve windows out of the local GEDTM30 extract.
 *
 * GEDTM30 is a 30 m global bare-earth DTM. Every other terrain source this app
 * uses is a SURFACE model reading the top of the canopy, which in a forested
 * Nepali valley is metres of bias that does not cancel out of a head
 * difference. pipeline/build-gedtm-nepal.py cuts Nepal out of the 432 GB global
 * COG once; this hands slices of it to the browser.
 *
 * DELIBERATELY WITHOUT ARITHMETIC. This route slices bytes and nothing else: it
 * takes a row/column rectangle and returns those uint16s untouched. Every
 * decode, interpolation and unit conversion happens in src/api.ts, which the
 * engine signature covers. A number that can move the answer must not live in
 * a config file that no A/B test fingerprints.
 *
 * Development only, like the topo sheets and the GloFAS store above. A
 * production build has no route here and src/api.ts simply does not offer the
 * source, which is the right default for a gigabyte that is not in the bundle.
 */
function gedtmStore(): Plugin {
  const META = 'sources/gedtm/nepal-gedtm.json';
  const BIN = 'sources/gedtm/nepal-gedtm.bin';
  return {
    name: 'hydrorecon-gedtm-store',
    apply: 'serve',
    configureServer(server) {
      if (!existsSync(META) || !existsSync(BIN)) return;
      const meta = JSON.parse(readFileSync(META, 'utf8')) as { rows: number; cols: number };
      const fd = openSync(BIN, 'r');
      const expected = meta.rows * meta.cols * 2;
      if (statSync(BIN).size !== expected) {
        server.config.logger.warn(
          `  ➜  GEDTM30 store is ${statSync(BIN).size} bytes, expected ${expected} — not served`
        );
        return;
      }

      server.middlewares.use('/gedtm/meta', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(readFileSync(META, 'utf8'));
      });

      server.middlewares.use('/gedtm/window', (req, res, next) => {
        const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const num = (k: string) => Number(q.get(k));
        const row0 = num('row0');
        const col0 = num('col0');
        const rows = num('rows');
        const cols = num('cols');
        const ok =
          [row0, col0, rows, cols].every(Number.isInteger) &&
          rows > 0 &&
          cols > 0 &&
          row0 >= 0 &&
          col0 >= 0 &&
          row0 + rows <= meta.rows &&
          col0 + cols <= meta.cols &&
          // A window this app asks for is a few hundred cells across. Anything
          // larger is a mistake or an attempt to pull the whole gigabyte
          // through one request.
          rows * cols <= 4_000_000;
        if (!ok) return next();

        const out = Buffer.allocUnsafe(rows * cols * 2);
        const rowBytes = cols * 2;
        for (let r = 0; r < rows; r++) {
          const at = ((row0 + r) * meta.cols + col0) * 2;
          readSync(fd, out, r * rowBytes, rowBytes, at);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(out);
      });

      server.config.logger.info(
        `  ➜  GEDTM30 bare-earth terrain served from ${BIN} (${meta.cols}x${meta.rows})`
      );
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
      topoSheets(env.HYDRORECON_TOPO_DIR || env.GHATTA_TOPO_DIR),
      glofasStore(),
      gedtmStore(),
      worldcoverStore(),
      privateLayers(),
      geologyTiles(),
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

