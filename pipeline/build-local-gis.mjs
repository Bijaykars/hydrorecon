/**
 * Private GIS layers, from a Nepali engineer's own working folder.
 *
 *   node pipeline/build-local-gis.mjs "<path to the GIS folder>"
 *
 * WHY THIS IS SEPARATE FROM EVERY OTHER PIPELINE
 *
 * Every other layer in this app comes from a source with a licence that permits
 * redistribution, and ships in src/data/ with that licence named. These do not.
 * The local-unit boundaries carry an explicit HERMES term — non-commercial use
 * only, no redistribution without consent — and the isohyet map, topo sheet
 * index and protected-area files arrived through a private channel with
 * provenance that has not been established.
 *
 * Private use is squarely within those terms. Publishing is not. So this
 * pipeline writes to src/data/local/, which .gitignore excludes, and nothing it
 * produces can be committed by accident. The app treats these layers as
 * optional: absent, everything works exactly as before, which is also what a
 * clone of this repository would see.
 *
 * If the licences are ever cleared, moving a layer into src/data/ and naming
 * its source is a two-line change. Until then the separation is the point.
 *
 * WHAT IT BUILDS
 *
 *   sheets.json    678 topographic sheet footprints — which 1:25,000 survey
 *                  sheet to order for a site, by its official number and name.
 *                  Nepal's sheets carry surveyed contours and spot heights, so
 *                  this answers "what do I buy" without shipping the maps.
 *   isohyet.json   112 mean-annual-precipitation bands, 200-5000 mm.
 *   buffers.json   16 buffer zones — legally distinct from the parks they ring
 *                  and absent from the OpenStreetMap layer the app ships.
 *   units.json     776 municipalities, with province and district — the body an
 *                  application actually goes to.
 *
 * Two of these are on Nepal's national grid (Modified UTM-84 on the Everest
 * 1830 spheroid) and are reprojected here; the rest are already WGS84.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const ROOT = process.argv[2];
if (!ROOT || !existsSync(ROOT)) {
  console.error('usage: node pipeline/build-local-gis.mjs "<path to the GIS folder>"');
  process.exit(1);
}
const OUT_DIR = "sources/local";
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Nepal Modified UTM-84 (Everest 1830 Adjustment 1937) -> geodetic
//
// The datum shift to WGS84 is a few hundred metres and is deliberately not
// applied: isohyet bands are tens of kilometres wide and a survey sheet is
// 7.5 arc-minutes, so the shift sits far below what either layer resolves.
// pipeline/probe-isohyet.mjs records the same reasoning and self-checks the
// reprojection against Nepal's known extent.
// ---------------------------------------------------------------------------
const A = 6377276.345;
const F = 1 / 300.8017;
const E2 = 2 * F - F * F;
const K0 = 0.9999;
const LON0 = (84 * Math.PI) / 180;

function inverseTM(easting, northing) {
  const x = easting - 500000;
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const mu = northing / K0 / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
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
  const N1 = A / Math.sqrt(1 - E2 * sin1 * sin1);
  const R1 = (A * (1 - E2)) / (1 - E2 * sin1 * sin1) ** 1.5;
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

// ---------------------------------------------------------------------------
// Shapefile + dBase readers. Same shape as build-hypsometry.mjs, no dependency.
// ---------------------------------------------------------------------------

function readDbf(path) {
  const buf = readFileSync(path);
  const n = buf.readUInt32LE(4);
  const hLen = buf.readUInt16LE(8);
  const rLen = buf.readUInt16LE(10);
  const fields = [];
  for (let p = 32; buf[p] !== 0x0d && p < hLen; p += 32) {
    fields.push({
      name: buf.toString('latin1', p, p + 11).replace(/\0.*$/, ''),
      len: buf[p + 16],
    });
  }
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    let p = hLen + i * rLen + 1;
    const o = {};
    // The Nepali-named layer is UTF-8; ASCII names decode identically either way.
    for (const f of fields) {
      o[f.name] = buf.toString('utf8', p, p + f.len).replace(/\0/g, '').trim();
      p += f.len;
    }
    rows[i] = o;
  }
  return rows;
}

/** Rings per record, as flat [lat, lon, …]. `project` converts each vertex. */
function readShp(path, project) {
  const buf = readFileSync(path);
  const out = [];
  let off = 100;
  while (off + 8 <= buf.length) {
    const contentLen = buf.readInt32BE(off + 4) * 2;
    const body = off + 8;
    const type = buf.readInt32LE(body);
    if (type === 5 || type === 3) {
      const numParts = buf.readInt32LE(body + 36);
      const numPoints = buf.readInt32LE(body + 40);
      const partsAt = body + 44;
      const ptsAt = partsAt + numParts * 4;
      const rings = [];
      for (let p = 0; p < numParts; p++) {
        const from = buf.readInt32LE(partsAt + p * 4);
        const to = p + 1 < numParts ? buf.readInt32LE(partsAt + (p + 1) * 4) : numPoints;
        const ring = [];
        for (let k = from; k < to; k++) {
          const [lat, lon] = project(
            buf.readDoubleLE(ptsAt + k * 16),
            buf.readDoubleLE(ptsAt + k * 16 + 8)
          );
          ring.push(lat, lon);
        }
        rings.push(ring);
      }
      out.push(rings);
    } else out.push(null);
    off = body + contentLen;
  }
  return out;
}

const wgs84 = (x, y) => [y, x]; // shapefiles store x=lon, y=lat
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** Douglas-Peucker, so 776 municipality outlines do not become a 40 MB file. */
function simplify(flat, tolDeg) {
  const n = flat.length / 2;
  if (n <= 3) return flat;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let worstD = 0;
    const ay = flat[a * 2];
    const ax = flat[a * 2 + 1];
    const dy = flat[b * 2] - ay;
    const dx = flat[b * 2 + 1] - ax;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const py = flat[i * 2];
      const px = flat[i * 2 + 1];
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worstD > tolDeg && worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r5(flat[i * 2]), r5(flat[i * 2 + 1]));
  return out;
}

const find = (...cands) => cands.find((p) => existsSync(`${ROOT}/${p}`));
const wrote = [];
const write = (name, obj) => {
  const json = JSON.stringify(obj);
  writeFileSync(`${OUT_DIR}/${name}`, json);
  wrote.push(`${name}  ${(json.length / 1024).toFixed(0)} KB`);
};

const NOTE =
  'PRIVATE LAYER — supplied through a private channel, provenance not established. ' +
  'Local use only; not redistributable. Excluded from git by .gitignore.';

// ---------------------------------------------------------------------------
// 1. Topographic sheet index — which survey sheet covers a site
// ---------------------------------------------------------------------------
{
  const shp = find('Grid_Admin/grid_nepal.shp');
  if (shp) {
    const rows = readDbf(`${ROOT}/${shp.replace(/\.shp$/, '.dbf')}`);
    const geom = readShp(`${ROOT}/${shp}`, inverseTM);
    const sheets = [];
    for (let i = 0; i < geom.length; i++) {
      const rings = geom[i];
      if (!rings?.length) continue;
      let latMin = 99, latMax = -99, lonMin = 999, lonMax = -999;
      for (const r of rings) {
        for (let k = 0; k < r.length; k += 2) {
          if (r[k] < latMin) latMin = r[k];
          if (r[k] > latMax) latMax = r[k];
          if (r[k + 1] < lonMin) lonMin = r[k + 1];
          if (r[k + 1] > lonMax) lonMax = r[k + 1];
        }
      }
      const t = rows[i] ?? {};
      // A sheet is a lat/lon box; storing the box beats storing the ring.
      sheets.push({
        n: (t.SHEETNO ?? '').trim(),
        r: (t.NEWFIELD6 ?? '').trim(),
        b: [r4(latMin), r4(lonMin), r4(latMax), r4(lonMax)],
      });
    }
    write('sheets.json', { _note: NOTE, _what: 'Nepal 1:25,000 topographic sheet index', sheets });
    console.log(`sheets: ${sheets.length}`);
  } else console.log('sheets: grid_nepal.shp not found, skipped');
}

// ---------------------------------------------------------------------------
// 2. Mean annual precipitation bands
// ---------------------------------------------------------------------------
{
  const shp = find('Isohyete/Annual_Isohyete.shp', 'My process/Isohyete/Isohyete/Annual_Isohyete.shp');
  if (shp) {
    const rows = readDbf(`${ROOT}/${shp.replace(/\.shp$/, '.dbf')}`);
    const geom = readShp(`${ROOT}/${shp}`, inverseTM);
    const bands = [];
    for (let i = 0; i < geom.length; i++) {
      if (!geom[i]?.length) continue;
      const mm = parseFloat(rows[i]?.PMANN_ID);
      if (!Number.isFinite(mm) || mm <= 0) continue;
      bands.push({ mm, rings: geom[i].map((r) => simplify(r, 0.002)) });
    }
    write('isohyet.json', { _note: NOTE, _what: 'Mean annual precipitation, mm', bands });
    console.log(`isohyet: ${bands.length} bands`);
  } else console.log('isohyet: not found, skipped');
}

// ---------------------------------------------------------------------------
// 3. Buffer zones — a permitting regime the OSM layer does not carry
// ---------------------------------------------------------------------------
{
  const shp = find(
    'My process/ProtectedAreas/BufferZone_WGS.shp',
    'My process/My process/ProtectedAreas/BufferZone_WGS.shp'
  );
  if (shp) {
    const geom = readShp(`${ROOT}/${shp}`, wgs84);
    const zones = geom
      .filter(Boolean)
      .map((rings) => ({ rings: rings.map((r) => simplify(r, 0.001)) }));
    write('buffers.json', { _note: NOTE, _what: 'Protected-area buffer zones', zones });
    console.log(`buffers: ${zones.length} zones`);
  } else console.log('buffers: not found, skipped');
}

// ---------------------------------------------------------------------------
// 4. Municipalities — the body an application goes to
// ---------------------------------------------------------------------------
{
  const parts = [0, 1, 2, 3]
    .map((k) =>
      find(
        `My process/Local Unit Shapefiles/Local Unit Shapefiles/hermes_NPL_new_wgs_${k}.shp`,
        `My process/My process/Local Unit Shapefiles/Local Unit Shapefiles/hermes_NPL_new_wgs_${k}.shp`
      )
    )
    .filter(Boolean);
  if (parts.length) {
    const units = [];
    for (const shp of parts) {
      const rows = readDbf(`${ROOT}/${shp.replace(/\.shp$/, '.dbf')}`);
      const geom = readShp(`${ROOT}/${shp}`, wgs84);
      for (let i = 0; i < geom.length; i++) {
        if (!geom[i]?.length) continue;
        const t = rows[i] ?? {};
        if (!t.LOCAL) continue;
        units.push({
          n: t.LOCAL,
          d: t.DISTRICT ?? '',
          p: t.PR_NAME ?? '',
          t: t.TYPE ?? '',
          rings: geom[i].map((r) => simplify(r, 0.002)),
        });
      }
    }
    write('units.json', {
      _note: `${NOTE} Source states: HERMES database, non-commercial use only, no redistribution.`,
      _what: 'Municipalities (gaunpalika / nagarpalika)',
      units,
    });
    console.log(`units: ${units.length}`);
  } else console.log('units: not found, skipped');
}

console.log(`\nwrote to ${OUT_DIR}/ (gitignored):`);
for (const w of wrote) console.log(`  ${w}`);
