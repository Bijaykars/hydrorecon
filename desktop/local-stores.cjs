/**
 * The local data stores, served to the browser — by the dev server AND by the
 * packaged desktop shell.
 *
 * Every big source this app reads off disk — the GloFAS discharge store,
 * GEDTM30, ESA WorldCover, the DMG geology tiles, the scanned topo sheets and
 * the two private folders — used to be reachable only through
 * `configureServer` in vite.config.ts. So `npm run dev` had all of them and a
 * packaged EXE silently had none: the desktop build lost its local flow, its
 * terrain cross-check, its land cover and its geological sheets, and every
 * consumer quietly took its fallback. Nothing broke loudly, which is why it
 * went unnoticed.
 *
 * This is ONE implementation with two hosts. The request handling, the URL
 * shapes, the window arithmetic, the traversal guards and the headers live
 * here; vite.config.ts and desktop/main.cjs each only adapt `resolve()` to
 * their own response object. A route that works in development and not in the
 * product is the defect this closes, and two copies would reopen it.
 *
 * CommonJS, because Electron's main process is CommonJS and this must load
 * there without an interop step. vite.config.ts reaches it through
 * createRequire for the same reason — see the note there.
 *
 * DELIBERATELY WITHOUT ARITHMETIC THAT CAN MOVE AN ANSWER. The window routes
 * slice bytes and nothing else; every decode, interpolation and unit
 * conversion stays in src/, which the engine signature covers.
 *
 * THE DATA IS NEVER BUNDLED. GEDTM30 is ~0.97 GB and WorldCover ~598 MB; they
 * stay external and are found at runtime, so a missing store is the normal
 * case and must degrade exactly as it does in development.
 */
const { existsSync, openSync, readSync, readFileSync, statSync } = require('node:fs');
const { basename, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const JSON_NAME = /^[\w.-]+\.json$/;
const JSON_TYPE = 'application/json';
const BYTES = 'application/octet-stream';
const DAY = 'public, max-age=86400';

/**
 * Where `sources/` lives.
 *
 * HYDRORECON_DATA_DIR wins, so a user who keeps the gigabyte on another drive
 * says so once. Otherwise the first candidate that actually holds a `sources/`
 * folder — next to the executable for a packaged build, the repo root for
 * `desktop:dev` — and failing that the first candidate, which keeps every
 * path below well-formed even when nothing is installed.
 */
function dataRoot(candidates = [process.cwd()]) {
  const list = [process.env.HYDRORECON_DATA_DIR, ...candidates].filter(Boolean);
  for (const c of list) {
    if (existsSync(join(c, 'sources'))) return c;
  }
  return list[0] ?? process.cwd();
}

/** A window request is a few hundred cells across. Anything larger is a mistake
 *  or an attempt to pull a whole store through one request. */
const MAX_CELLS = 4_000_000;

/** Validate a row/column rectangle against the store it is cut from. */
function windowOk(q, meta) {
  const num = (k) => Number(q.get(k));
  const w = { row0: num('row0'), col0: num('col0'), rows: num('rows'), cols: num('cols') };
  const ok =
    [w.row0, w.col0, w.rows, w.cols].every(Number.isInteger) &&
    w.rows > 0 &&
    w.cols > 0 &&
    w.row0 >= 0 &&
    w.col0 >= 0 &&
    w.row0 + w.rows <= meta.rows &&
    w.col0 + w.cols <= meta.cols &&
    w.rows * w.cols <= MAX_CELLS;
  return ok ? w : null;
}

/**
 * Open a flat raster store, or report why it is not being served.
 *
 * `bytesPerCell` is the only difference between the two: WorldCover carries
 * class codes in uint8, GEDTM30 elevations in uint16. The size test is what
 * catches a half-finished download — serving those bytes would hand the app
 * silent nonsense rather than nothing.
 */
function openRaster(metaFile, binFile, bytesPerCell, label, notes) {
  if (!existsSync(metaFile) || !existsSync(binFile)) return null;
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  } catch {
    notes.push(`  ➜  ${label} meta at ${metaFile} is not readable JSON — not served`);
    return null;
  }
  const size = statSync(binFile).size;
  const expected = meta.rows * meta.cols * bytesPerCell;
  if (size !== expected) {
    notes.push(`  ➜  ${label} store is ${size} bytes, expected ${expected} — not served`);
    return null;
  }
  const fd = openSync(binFile, 'r');
  notes.push(`  ➜  ${label} served from ${binFile} (${meta.cols}x${meta.rows})`);
  return {
    metaText: readFileSync(metaFile, 'utf8'),
    read(w) {
      const rowBytes = w.cols * bytesPerCell;
      const out = Buffer.allocUnsafe(w.rows * rowBytes);
      for (let r = 0; r < w.rows; r++) {
        readSync(fd, out, r * rowBytes, rowBytes, ((w.row0 + r) * meta.cols + w.col0) * bytesPerCell);
      }
      return out;
    },
    window: (q) => windowOk(q, meta),
  };
}

/**
 * Load the GloFAS reader, if a store has been built.
 *
 * The decode lives in pipeline/glofas-store.mjs and stays there: it is the
 * same reader every harness uses, so the browser and an A/B cannot disagree
 * about what a cell holds. It is ESM and this file is not, so it arrives
 * through a dynamic import — and if that import fails for any reason the route
 * is simply absent and src/api.ts asks Open-Meteo, which is the documented
 * fallback rather than a new failure mode.
 */
async function openGlofas(root, notes) {
  const found = ['pipeline/.cache/glofas-nepal.bin', 'sources/glofas/glofas-nepal.bin']
    .map((p) => join(root, p))
    .find((p) => existsSync(p));
  if (!process.env.HYDRORECON_GLOFAS_STORE && found) {
    process.env.HYDRORECON_GLOFAS_STORE = found;
  }
  try {
    const mod = await import(pathToFileURL(join(__dirname, '..', 'pipeline', 'glofas-store.mjs')).href);
    if (!mod.hasGlofasStore()) return null;
    const c = mod.glofasCoverage();
    if (c) notes.push(`  ➜  flow served locally from GloFAS ${c.from} to ${c.to}`);
    return mod.glofasSeries;
  } catch {
    return null;
  }
}

/**
 * Probe every store once and return a resolver.
 *
 * `resolve(url)` takes a request URL — path and query, exactly as the browser
 * asked for it — and answers with `{ contentType, cacheControl?, file | body }`
 * or null for "not one of mine, or not here". Null is the ordinary answer: the
 * caller falls through to whatever it does with an unknown path, which is what
 * makes a missing store degrade instead of crash.
 */
async function createLocalStores({ root = process.cwd(), topoDir } = {}) {
  const at = (p) => join(root, p);
  const notes = [];

  const topo = topoDir && existsSync(topoDir) ? topoDir : null;
  if (topo) notes.push(`  ➜  topo sheets served from ${topo}`);

  const glofas = await openGlofas(root, notes);

  const gedtm = openRaster(
    at('sources/gedtm/nepal-gedtm.json'),
    at('sources/gedtm/nepal-gedtm.bin'),
    2,
    'GEDTM30 bare-earth terrain',
    notes
  );
  const worldcover = openRaster(
    at('sources/worldcover/nepal-worldcover.json'),
    at('sources/worldcover/nepal-worldcover.bin'),
    1,
    'ESA WorldCover land cover',
    notes
  );

  const geologyDir = existsSync(at('sources/geology/index.json')) ? at('sources/geology') : null;
  if (geologyDir) {
    const n = JSON.parse(readFileSync(join(geologyDir, 'index.json'), 'utf8')).tiles?.length ?? 0;
    notes.push(`  ➜  geology: ${n} DMG map tiles served from ${geologyDir}`);
  }

  // The two private folders. Both are non-redistributable, so they are served
  // from outside public/ and are absent from every build — see the note in
  // vite.config.ts.
  const privateDirs = {};
  for (const [route, dir] of [
    ['/local', at('sources/local')],
    ['/dhm', at('sources/dhm')],
  ]) {
    if (!existsSync(dir)) continue;
    privateDirs[route] = dir;
    notes.push(`  ➜  ${route} served from ${dir} (not bundled)`);
  }

  /** A file inside `dir`, or null. basename() strips any traversal the URL
   *  attempted; the name test bounds it further. */
  const fileIn = (dir, raw, allowed) => {
    const name = basename(decodeURIComponent(raw));
    if (!name || !allowed.test(name)) return null;
    const file = join(dir, name);
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    return file;
  };

  function resolve(url) {
    const [path, search] = String(url ?? '').split('?');
    const q = () => new URLSearchParams(search ?? '');

    if (topo && path.startsWith('/topo/')) {
      const file = fileIn(topo, path.slice('/topo/'.length), /\.(jpe?g|png)$/i);
      if (!file) return null;
      return {
        contentType: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg',
        cacheControl: DAY,
        file,
      };
    }

    if (glofas && path === '/glofas') {
      const p = q();
      const lat = Number(p.get('lat'));
      const lon = Number(p.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const series = glofas(lat, lon);
      if (!series) return null;
      return { contentType: JSON_TYPE, body: JSON.stringify(series) };
    }

    for (const [prefix, store] of [
      ['/gedtm', gedtm],
      ['/worldcover', worldcover],
    ]) {
      if (!store) continue;
      if (path === `${prefix}/meta`) return { contentType: JSON_TYPE, body: store.metaText };
      if (path === `${prefix}/window`) {
        const w = store.window(q());
        if (!w) return null;
        return { contentType: BYTES, cacheControl: DAY, body: store.read(w) };
      }
    }

    if (geologyDir && path.startsWith('/geology/')) {
      const file = fileIn(geologyDir, path.slice('/geology/'.length), /^[\w.-]+\.(png|json)$/);
      if (!file) return null;
      return {
        contentType: file.endsWith('.json') ? JSON_TYPE : 'image/png',
        cacheControl: DAY,
        file,
      };
    }

    for (const [route, dir] of Object.entries(privateDirs)) {
      if (!path.startsWith(`${route}/`)) continue;
      const file = fileIn(dir, path.slice(route.length + 1), JSON_NAME);
      if (!file) return null;
      return { contentType: JSON_TYPE, file };
    }

    return null;
  }

  return { notes, resolve };
}

module.exports = { createLocalStores, dataRoot };