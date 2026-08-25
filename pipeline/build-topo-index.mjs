/**
 * Nepal's 1:25,000 survey sheets, as a map overlay you can actually see.
 *
 *   node pipeline/build-topo-index.mjs "<path to TOPOMAPS folder>"
 *
 * WHY THIS IS THE MOST VALUABLE THING IN THE PRIVATE FOLDER
 *
 * Every elevation in this app comes from a 30 m global DEM carrying about
 * +/-15 m of vertical error, and head is the second-largest uncertainty in the
 * whole estimate. Nepal's own topographic sheets carry SURVEYED contours and
 * spot heights at 1:25,000 — roughly 2.15 m per pixel here. Laying one under
 * the intake is how an engineer stops guessing at the terrain and starts
 * reading it.
 *
 * The app cannot ship 4.2 GB of scanned government maps, and would not be
 * allowed to. What it can do is show them from where they already sit on disk.
 *
 * WHAT THIS BUILDS: a small index only — sheet name, and the four corners of
 * each scan in WGS84. No imagery is copied, converted or moved. At high zoom
 * the app adds the handful of sheets in view as MapLibre image sources, served
 * straight off the original folder by a dev-server route (see vite.config.ts).
 *
 * THE GEOREFERENCING. Each scan has an ESRI world file (.jgwx) holding a full
 * affine transform, rotation included — these sheets are not axis-aligned, and
 * treating them as a plain bounding box would smear a 2 m map by hundreds of
 * metres. The transform maps pixel to Nepal's national grid (Modified UTM-84 on
 * the Everest 1830 spheroid), so each corner is transformed and then inverted
 * to latitude and longitude. MapLibre's image source takes four corners and
 * handles the rotation itself, which is exactly the shape of this problem.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

const ROOT = process.argv[2];
if (!ROOT || !existsSync(ROOT)) {
  console.error('usage: node pipeline/build-topo-index.mjs "<path to TOPOMAPS folder>"');
  process.exit(1);
}
const OUT_DIR = 'sources/local';
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// --- Nepal Modified UTM-84 (Everest 1830 Adj. 1937) -> geodetic ------------
// Same inverse as build-local-gis.mjs; the datum shift is skipped for the same
// reason, and here it matters even less: a sheet is 7.5 arc-minutes across.
const A_AX = 6377276.345;
const F = 1 / 300.8017;
const E2 = 2 * F - F * F;
const K0 = 0.9999;

/**
 * Nepal's Modified UTM is not one projection but three, with central meridians
 * at 81, 84 and 87 degrees east for the western, central and eastern sheets.
 * A world file records only pixel-to-grid; it does not say which zone its grid
 * is. Assuming 84 for everything put the western sheets three degrees adrift,
 * which the extent self-check below caught.
 *
 * The sheet number resolves it. Nepal numbers its maps by the degree square
 * they sit in — "2884 10" is the block at 28N 84E, "2981 12" at 29N 81E — so
 * each candidate meridian is tried and the one that lands the scan on its own
 * declared square wins. A sheet whose name disagrees with all three is dropped
 * rather than placed on a guess.
 */
const MERIDIANS = [81, 84, 87];

function inverseTMAt(easting, northing, cmDeg) {
  const LON0 = (cmDeg * Math.PI) / 180;
  return inverseTMCore(easting, northing, LON0);
}

function inverseTMCore(easting, northing, LON0) {
  const x = easting - 500000;
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const mu = northing / K0 / (A_AX * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const ep2 = E2 / (1 - E2);
  const C1 = ep2 * cos1 * cos1;
  const T1 = tan1 * tan1;
  const N1 = A_AX / Math.sqrt(1 - E2 * sin1 * sin1);
  const R1 = (A_AX * (1 - E2)) / (1 - E2 * sin1 * sin1) ** 1.5;
  const D = x / (N1 * K0);
  const lat =
    phi1 -
    ((N1 * tan1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon =
    LON0 +
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) /
      cos1;
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

/**
 * Width and height from the JPEG header alone.
 *
 * Walking the marker chain costs a few hundred bytes per file instead of
 * decoding ten megabytes of image, and the dimensions are all the world file
 * needs to place the corners.
 */
function jpegSize(path) {
  const fd = readFileSync(path, { flag: 'r' });
  if (fd[0] !== 0xff || fd[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < fd.length) {
    if (fd[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = fd[p + 1];
    // SOF0..SOF15, excluding the non-frame markers DHT(c4), JPGA(c8), DAC(cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: fd.readUInt16BE(p + 5), w: fd.readUInt16BE(p + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    p += 2 + fd.readUInt16BE(p + 2);
  }
  return null;
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;

const files = readdirSync(ROOT).filter((f) => /\.jpe?g$/i.test(f));
console.log(`${files.length} scanned sheets found`);

const sheets = [];
let noWorld = 0;
let noSize = 0;
for (const f of files) {
  const stem = f.replace(/\.jpe?g$/i, '');
  const world = ['.jgwx', '.jgw', '.jpgw'].map((e) => `${ROOT}/${stem}${e}`).find(existsSync);
  if (!world) {
    noWorld++;
    continue;
  }
  const size = jpegSize(`${ROOT}/${f}`);
  if (!size) {
    noSize++;
    continue;
  }
  // ESRI world file order: A, D, B, E, C, F
  //   x = A*col + B*row + C ,  y = D*col + E*row + F
  // C and F are the CENTRE of the top-left pixel, so the image edge sits half
  // a pixel further out — negligible at 2 m, but free to get right.
  const [A, D, B, E, C, Fw] = readFileSync(world, 'utf8')
    .trim()
    .split(/\s+/)
    .map(Number);
  if (![A, D, B, E, C, Fw].every(Number.isFinite)) {
    noWorld++;
    continue;
  }
  const c0 = -0.5;
  const c1 = size.w - 0.5;
  const r0 = -0.5;
  const r1 = size.h - 0.5;

  /**
   * The sheet's own declared degree square, from the leading four digits of its
   * number: "2884 10 Bahundada" -> 28N, 84E. Sheets whose names do not carry it
   * fall back to "any meridian that lands inside Nepal".
   */
  const tag = /^(\d{2})(\d{2})\b/.exec(stem);
  const wantLat = tag ? Number(tag[1]) : null;
  const wantLon = tag ? Number(tag[2]) : null;

  let best = null;
  for (const cm of MERIDIANS) {
    const at = (col, row) =>
      inverseTMAt(A * col + B * row + C, D * col + E * row + Fw, cm);
    const pts = [at(c0, r0), at(c1, r0), at(c1, r1), at(c0, r1)];
    const cLat = pts.reduce((s, p) => s + p[0], 0) / 4;
    const cLon = pts.reduce((s, p) => s + p[1], 0) / 4;
    // A sheet lies within the degree square it is named for, so its centre is
    // inside [deg, deg+1) on both axes, with a little slack for edge sheets.
    const err =
      wantLat !== null
        ? Math.abs(cLat - (wantLat + 0.5)) + Math.abs(cLon - (wantLon + 0.5))
        : cLat > 26 && cLat < 31 && cLon > 79.5 && cLon < 88.5
          ? 1
          : 99;
    if (!best || err < best.err) best = { err, pts, cm };
  }
  // Beyond a degree of disagreement the placement is not trustworthy.
  if (!best || best.err > 1.2) {
    noWorld++;
    continue;
  }

  // MapLibre wants [lon, lat] going top-left, top-right, bottom-right, bottom-left.
  const corners = best.pts.map(([la, lo]) => [r5(lo), r5(la)]);
  const lats = corners.map((c) => c[1]);
  const lons = corners.map((c) => c[0]);
  sheets.push({
    f,
    n: stem,
    z: best.cm,
    c: corners,
    b: [r5(Math.min(...lats)), r5(Math.min(...lons)), r5(Math.max(...lats)), r5(Math.max(...lons))],
  });
}

if (!sheets.length) throw new Error('no georeferenced sheets — is this the TOPOMAPS folder?');

// Self-check: the sheets must cover Nepal and each must be roughly the size of
// a 7.5' quad. A wrong world-file column order would sail through silently
// otherwise, placing every map in the Indian Ocean or shrinking it to a point.
const allLat = sheets.flatMap((s) => [s.b[0], s.b[2]]);
const allLon = sheets.flatMap((s) => [s.b[1], s.b[3]]);
const spanKm = sheets.map((s) => (s.b[2] - s.b[0]) * 111);
spanKm.sort((a, b) => a - b);
const medianSpan = spanKm[spanKm.length >> 1];
console.log(
  `  extent ${Math.min(...allLat).toFixed(2)}–${Math.max(...allLat).toFixed(2)}N, ` +
    `${Math.min(...allLon).toFixed(2)}–${Math.max(...allLon).toFixed(2)}E`
);
console.log(`  median sheet height ${medianSpan.toFixed(1)} km`);
if (Math.min(...allLat) < 25 || Math.max(...allLat) > 32 || Math.min(...allLon) < 79 || Math.max(...allLon) > 89) {
  throw new Error('sheets did not land on Nepal — check the world-file column order');
}
if (medianSpan < 5 || medianSpan > 40) {
  throw new Error(`median sheet is ${medianSpan.toFixed(1)} km, which is not a 1:25,000 quad`);
}

writeFileSync(
  `${OUT_DIR}/topo-index.json`,
  JSON.stringify({
    _note:
      'PRIVATE LAYER — index only. The scans stay where they are and are served by the dev ' +
      'server from their original folder. Not redistributable; gitignored.',
    _what: 'Nepal 1:25,000 topographic sheet scans, georeferenced corners',
    sheets,
  })
);
console.log(`\nwrote ${OUT_DIR}/topo-index.json: ${sheets.length} sheets`);
if (noWorld) console.log(`  ${noWorld} skipped: no world file`);
if (noSize) console.log(`  ${noSize} skipped: unreadable JPEG header`);
console.log(`\nAdd to .env.local so the dev server can find the scans:\n  HYDRORECON_TOPO_DIR=${ROOT}`);
