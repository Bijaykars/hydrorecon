/**
 * How much of each catchment lies below 5000 m and below 3000 m.
 *
 *   npm run build:hypso
 *
 * WHY THIS EXISTS
 *
 * Nepal's own ungauged-flow method, WECS/DHM 1990 ("HYDEST"), is a regression on
 * catchment area — but not on total area. Its monthly equation is
 *
 *   Q_month = C · A_total^A1 · (A_below5000m + 1)^A2 · MMP^A3
 *
 * and for January through May the precipitation exponent A3 is zero, so those
 * months need nothing but the area of the catchment lying below 5000 m. That is
 * the dry season: the months that set firm power, that Nepal's PPA pays 8.40
 * NPR/kWh for against 4.80 in the wet season, and that decide whether a scheme
 * is financeable. An independent, nationally calibrated estimate of exactly
 * those months is worth a great deal against two uncalibrated global models.
 *
 * A_below5000m is the whole blocker, and it cannot be faked. Substituting total
 * area was tried and fails in the obvious place: on a trans-Himalayan reach at
 * 29.8N it put January at 85% of the annual mean on a monsoon river, because
 * that catchment sits almost entirely ABOVE 5000 m and the term exists precisely
 * to remove it. Classifying by the river bed's own elevation fails the same way,
 * since the bed is below 5000 m where the land draining into it is not.
 *
 * WHAT THIS DOES
 *
 * HydroBASINS level 12 (HydroSHEDS, free for commercial use, cite Lehner & Grill
 * 2013) gives ~160k sub-basin polygons for Asia with NEXT_DOWN topology and a
 * SORT order that runs downstream to upstream — so one reverse sweep accumulates
 * any quantity over a whole catchment without recursion.
 *
 *   1. rasterise the sub-basins covering Nepal onto a regular grid
 *   2. sample terrain at every grid cell, counting what falls below each contour
 *   3. sweep the topology to turn per-basin counts into per-CATCHMENT areas
 *   4. attach the resulting fractions to each HydroRIVERS reach
 *
 * Output is two bytes per reach: the fraction of upstream catchment below 5000 m
 * and below 3000 m, each quantised to 0-255. Fractions rather than absolute
 * areas, because HydroRIVERS knows its own catchment area more precisely than
 * the basin polygon the reach happens to fall in does.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const SRC = 'https://data.hydrosheds.org/file/hydrobasins/standard/hybas_as_lev12_v1c.zip';
const CACHE = 'pipeline/.cache';
const ZIP = `${CACHE}/hybas_as_lev12.zip`;
const RIVERS = 'public/nepal-rivers.dat';
const OUT = 'public/nepal-hypso.dat';

/** Same window the bundled river network covers. */
const COVER = { west: 79.9, south: 26.2, east: 88.4, north: 30.6 };
/** Grid step in degrees. ~440 m at this latitude — ample over 130 km2 basins. */
const STEP = 0.004;
/** Terrain zoom. 512 px tiles at z10 is ~67 m sampling, finer than the grid. */
const DEM_ZOOM = 10;
/** The contours HYDEST cares about. */
const CONTOURS = [5000, 3000];

// ---------------------------------------------------------------------------
// 1. Fetch and open the archive
// ---------------------------------------------------------------------------

if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
if (!existsSync(ZIP)) {
  console.log(`downloading HydroBASINS level 12 Asia (~80 MB)…`);
  const t0 = Date.now();
  const r = await fetch(SRC);
  if (!r.ok) throw new Error(`HydroBASINS: HTTP ${r.status}`);
  writeFileSync(ZIP, Buffer.from(await r.arrayBuffer()));
  console.log(`  cached in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

/** Minimal zip reader — central directory walk, raw inflate. No dependency. */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // The local header's name/extra lengths can differ from the central copy.
    const dataStart =
      localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

console.log('opening archive…');
const files = unzip(readFileSync(ZIP));
const dbf = [...files].find(([n]) => n.toLowerCase().endsWith('.dbf'))[1];
const shp = [...files].find(([n]) => n.toLowerCase().endsWith('.shp'))[1];

// ---------------------------------------------------------------------------
// 2. Attributes (dBase III) and geometry (ESRI shapefile)
// ---------------------------------------------------------------------------

function readDbf(buf) {
  const numRecords = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields = [];
  // Field descriptor: name 0-10, type at 11, length at 16, decimals at 17.
  for (let p = 32; buf[p] !== 0x0d && p < headerLen; p += 32) {
    fields.push({
      name: buf.toString('ascii', p, p + 11).replace(/\0.*$/, ''),
      len: buf[p + 16],
    });
  }
  const rows = new Array(numRecords);
  for (let i = 0; i < numRecords; i++) {
    let p = headerLen + i * recordLen + 1; // +1 skips the deletion flag
    const o = {};
    for (const f of fields) {
      o[f.name] = buf.toString('ascii', p, p + f.len).trim();
      p += f.len;
    }
    rows[i] = o;
  }
  return rows;
}

/**
 * Polygon rings from a shapefile, in record order so they line up with the DBF.
 * Only shape type 5 (Polygon) is handled; HydroBASINS contains nothing else.
 * Records are read big-endian in the header, little-endian in the content —
 * that mix is the format, not a mistake.
 */
function readShp(buf, keep) {
  const polys = new Array(keep.length).fill(null);
  const wanted = new Set(keep);
  let off = 100; // file header
  let rec = 0;
  while (off < buf.length) {
    const contentLen = buf.readInt32BE(off + 4) * 2;
    const body = off + 8;
    if (wanted.has(rec)) {
      const type = buf.readInt32LE(body);
      if (type === 5) {
        const numParts = buf.readInt32LE(body + 36);
        const numPoints = buf.readInt32LE(body + 40);
        const partsAt = body + 44;
        const ptsAt = partsAt + numParts * 4;
        const rings = [];
        for (let p = 0; p < numParts; p++) {
          const from = buf.readInt32LE(partsAt + p * 4);
          const to = p + 1 < numParts ? buf.readInt32LE(partsAt + (p + 1) * 4) : numPoints;
          const ring = new Float64Array((to - from) * 2);
          for (let k = from; k < to; k++) {
            ring[(k - from) * 2] = buf.readDoubleLE(ptsAt + k * 16);
            ring[(k - from) * 2 + 1] = buf.readDoubleLE(ptsAt + k * 16 + 8);
          }
          rings.push(ring);
        }
        polys[keep.indexOf(rec)] = rings;
      }
    }
    off = body + contentLen;
    rec++;
  }
  return polys;
}

console.log('reading attributes…');
const rows = readDbf(dbf);
console.log(`  ${rows.length} sub-basins in Asia`);

// Shapefile record bounding boxes let us pick the window without decoding
// every ring: each polygon record carries its own box at a fixed offset.
const inWindow = [];
{
  let off = 100;
  let rec = 0;
  while (off < shp.length) {
    const contentLen = shp.readInt32BE(off + 4) * 2;
    const body = off + 8;
    if (shp.readInt32LE(body) === 5) {
      const xmin = shp.readDoubleLE(body + 4);
      const ymin = shp.readDoubleLE(body + 12);
      const xmax = shp.readDoubleLE(body + 20);
      const ymax = shp.readDoubleLE(body + 28);
      if (xmax >= COVER.west && xmin <= COVER.east && ymax >= COVER.south && ymin <= COVER.north) {
        inWindow.push(rec);
      }
    }
    off = body + contentLen;
    rec++;
  }
}
console.log(`  ${inWindow.length} of them touch the Nepal window`);

console.log('decoding geometry…');
const geom = readShp(shp, inWindow);
const basins = inWindow.map((rec, i) => ({
  id: rows[rec].HYBAS_ID,
  next: rows[rec].NEXT_DOWN,
  subAreaKm2: Number(rows[rec].SUB_AREA),
  upAreaKm2: Number(rows[rec].UP_AREA),
  sort: Number(rows[rec].SORT),
  rings: geom[i],
}));
console.log(`  ${basins.filter((b) => b.rings).length} polygons decoded`);

// ---------------------------------------------------------------------------
// 3. Rasterise sub-basins onto the grid
// ---------------------------------------------------------------------------

const NX = Math.round((COVER.east - COVER.west) / STEP);
const NY = Math.round((COVER.north - COVER.south) / STEP);
console.log(`rasterising ${NX} x ${NY} = ${((NX * NY) / 1e6).toFixed(2)} M cells…`);

/** Basin index per cell, -1 for none. 16 bits is not enough for 40k basins. */
const cellBasin = new Int32Array(NX * NY).fill(-1);

/**
 * Scanline fill. For each raster row, intersect every ring edge with the row's
 * centre latitude, sort the crossings, and fill between alternate pairs — the
 * even-odd rule, which handles the interior holes HydroBASINS polygons have.
 */
for (let bi = 0; bi < basins.length; bi++) {
  const rings = basins[bi].rings;
  if (!rings) continue;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const r of rings) {
    for (let k = 1; k < r.length; k += 2) {
      if (r[k] < ymin) ymin = r[k];
      if (r[k] > ymax) ymax = r[k];
    }
  }
  const rowFrom = Math.max(0, Math.floor((ymin - COVER.south) / STEP));
  const rowTo = Math.min(NY - 1, Math.ceil((ymax - COVER.south) / STEP));
  const xs = [];
  for (let row = rowFrom; row <= rowTo; row++) {
    const y = COVER.south + (row + 0.5) * STEP;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length / 2;
      for (let k = 0; k < n; k++) {
        const x1 = r[k * 2];
        const y1 = r[k * 2 + 1];
        const j = (k + 1) % n;
        const x2 = r[j * 2];
        const y2 = r[j * 2 + 1];
        // Half-open test, so a vertex exactly on the scanline counts once.
        if (y1 <= y === y2 <= y) continue;
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let p = 0; p + 1 < xs.length; p += 2) {
      const cFrom = Math.max(0, Math.ceil((xs[p] - COVER.west) / STEP - 0.5));
      const cTo = Math.min(NX - 1, Math.floor((xs[p + 1] - COVER.west) / STEP - 0.5));
      const base = row * NX;
      for (let c = cFrom; c <= cTo; c++) cellBasin[base + c] = bi;
    }
  }
}
const covered = cellBasin.reduce((a, v) => a + (v >= 0 ? 1 : 0), 0);
console.log(`  ${((covered / (NX * NY)) * 100).toFixed(1)}% of the window falls in a sub-basin`);

// ---------------------------------------------------------------------------
// 4. Sample terrain and count what lies below each contour
// ---------------------------------------------------------------------------

const nBasins = basins.length;
const cellsTotal = new Float64Array(nBasins);
const cellsBelow = CONTOURS.map(() => new Float64Array(nBasins));

console.log(`sampling terrain at z${DEM_ZOOM}…`);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto('about:blank');

const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

const tx0 = Math.floor(lonToTileX(COVER.west, DEM_ZOOM));
const tx1 = Math.floor(lonToTileX(COVER.east, DEM_ZOOM));
const ty0 = Math.floor(latToTileY(COVER.north, DEM_ZOOM));
const ty1 = Math.floor(latToTileY(COVER.south, DEM_ZOOM));
const tiles = [];
for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) tiles.push([x, y]);
console.log(`  ${tiles.length} tiles to fetch`);

/**
 * Decode a batch of tiles in the browser and return, for each, the elevation
 * grid. Done browser-side because that is where the app's Terrarium decode
 * lives — canvas gives us the PNG pixels without adding an image dependency.
 */
async function fetchTiles(batch) {
  return page.evaluate(
    async ([list, z]) => {
      const load = (x, y) =>
        new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            let d;
            try {
              d = ctx.getImageData(0, 0, c.width, c.height).data;
            } catch {
              return resolve(null);
            }
            // Terrarium: elev = R*256 + G + B/256 - 32768. Send back Int16 metres.
            const out = new Int16Array(c.width * c.height);
            for (let i = 0, p = 0; i < out.length; i++, p += 4) {
              out[i] = Math.max(-32768, Math.min(32767, d[p] * 256 + d[p + 1] - 32768));
            }
            resolve({ w: c.width, h: c.height, data: Array.from(out) });
          };
          img.onerror = () => resolve(null);
          img.src = `https://terrain.reearth.land/terrarium/elevation/${z}/${x}/${y}.png`;
        });
      const res = [];
      for (const [x, y] of list) res.push(await load(x, y));
      return res;
    },
    [batch, DEM_ZOOM]
  );
}

/** Elevation lookup built from the tiles fetched so far. */
const grids = new Map();
const LANES = 6;
for (let i = 0; i < tiles.length; i += LANES) {
  const batch = tiles.slice(i, i + LANES);
  const got = await fetchTiles(batch);
  for (let k = 0; k < batch.length; k++) {
    if (got[k]) grids.set(`${batch[k][0]}/${batch[k][1]}`, got[k]);
  }
  if (i % 60 === 0) process.stdout.write(`\r  ${Math.min(i + LANES, tiles.length)}/${tiles.length}`);
}
process.stdout.write(`\r  ${tiles.length}/${tiles.length} tiles\n`);
await browser.close();

const elevAt = (lat, lon) => {
  const fx = lonToTileX(lon, DEM_ZOOM);
  const fy = latToTileY(lat, DEM_ZOOM);
  const g = grids.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
  if (!g) return NaN;
  const px = Math.min(g.w - 1, Math.floor((fx % 1) * g.w));
  const py = Math.min(g.h - 1, Math.floor((fy % 1) * g.h));
  return g.data[py * g.w + px];
};

console.log('counting cells by elevation…');
// Each cell's ground area varies with latitude; weight by cos(lat) so the
// fractions are true area fractions and not cell-count fractions.
for (let row = 0; row < NY; row++) {
  const lat = COVER.south + (row + 0.5) * STEP;
  const w = Math.cos((lat * Math.PI) / 180);
  const base = row * NX;
  for (let c = 0; c < NX; c++) {
    const bi = cellBasin[base + c];
    if (bi < 0) continue;
    const z = elevAt(lat, COVER.west + (c + 0.5) * STEP);
    if (!Number.isFinite(z)) continue;
    cellsTotal[bi] += w;
    for (let k = 0; k < CONTOURS.length; k++) if (z < CONTOURS[k]) cellsBelow[k][bi] += w;
  }
}

// ---------------------------------------------------------------------------
// 5. Sweep the topology: per-basin counts become per-CATCHMENT areas
// ---------------------------------------------------------------------------

console.log('accumulating upstream…');
const byId = new Map(basins.map((b, i) => [b.id, i]));
// SORT runs downstream to upstream, so walking it backwards visits every basin
// after all of its own upstream basins — one pass, no recursion.
const order = basins.map((_, i) => i).sort((a, b) => basins[b].sort - basins[a].sort);

const accTotal = Float64Array.from(cellsTotal);
const accBelow = cellsBelow.map((v) => Float64Array.from(v));
for (const i of order) {
  const d = byId.get(basins[i].next);
  if (d === undefined) continue; // flows out of the window, or terminal
  accTotal[d] += accTotal[i];
  for (let k = 0; k < CONTOURS.length; k++) accBelow[k][d] += accBelow[k][i];
}

const fracs = CONTOURS.map((_, k) =>
  Float64Array.from(accTotal, (t, i) => (t > 0 ? accBelow[k][i] / t : NaN))
);

{
  const f = [...fracs[0]].filter(Number.isFinite).sort((a, b) => a - b);
  console.log(
    `  below 5000 m: median ${(f[f.length >> 1] * 100).toFixed(0)}%, ` +
      `${(f.filter((v) => v > 0.99).length / f.length * 100).toFixed(0)}% of basins entirely below`
  );
}

// ---------------------------------------------------------------------------
// 6. Attach to every HydroRIVERS reach
// ---------------------------------------------------------------------------

console.log('attaching to river reaches…');
const rb = readFileSync(RIVERS);
const dv = new DataView(rb.buffer, rb.byteOffset, rb.byteLength);
if (dv.getUint32(0, true) !== 0x4e505231) throw new Error('river network: bad magic');
const count = dv.getUint32(4, true);
const scale = dv.getUint32(12, true);
const len = new Int32Array(count);
let o = 16;
for (let i = 0; i < count; i++) {
  len[i] = dv.getUint16(o + 9, true);
  o += 11;
}

const out = Buffer.alloc(count * 2);
let attached = 0;
for (let i = 0; i < count; i++) {
  let x = 0;
  let y = 0;
  let lastLat = NaN;
  let lastLon = NaN;
  for (let k = 0; k < len[i]; k++) {
    if (k === 0) {
      x = dv.getInt32(o, true);
      y = dv.getInt32(o + 4, true);
      o += 8;
    } else {
      x += dv.getInt16(o, true);
      y += dv.getInt16(o + 2, true);
      o += 4;
    }
    lastLat = y / scale;
    lastLon = x / scale;
  }
  // The reach's outlet decides which sub-basin's accumulated catchment it sits in.
  const col = Math.floor((lastLon - COVER.west) / STEP);
  const row = Math.floor((lastLat - COVER.south) / STEP);
  let f5 = NaN;
  let f3 = NaN;
  if (col >= 0 && col < NX && row >= 0 && row < NY) {
    const bi = cellBasin[row * NX + col];
    if (bi >= 0) {
      f5 = fracs[0][bi];
      f3 = fracs[1][bi];
    }
  }
  // 255 is the sentinel for "unknown"; 0-254 maps onto 0..1.
  out[i * 2] = Number.isFinite(f5) ? Math.round(Math.max(0, Math.min(1, f5)) * 254) : 255;
  out[i * 2 + 1] = Number.isFinite(f3) ? Math.round(Math.max(0, Math.min(1, f3)) * 254) : 255;
  if (Number.isFinite(f5)) attached++;
}

writeFileSync(OUT, out);
console.log(`wrote ${OUT}: ${count} reaches, ${(out.length / 1024).toFixed(1)} KB`);
console.log(`  with hypsometry: ${attached} (${((attached / count) * 100).toFixed(1)}%)`);
