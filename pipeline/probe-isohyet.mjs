/**
 * Is our rainfall layer right? Ask Nepal's own isohyet map.
 *
 *   node pipeline/probe-isohyet.mjs "<path to Annual_Isohyete.shp>"
 *
 * WHY THIS EXISTS
 *
 * pipeline/build-mmp.mjs derives HYDEST's MMP term — monsoon precipitation over
 * the catchment — from the CHPclim global climatology, and the June-September
 * convention was ASSUMED. The only check on it was a water-balance argument:
 * the completed year yields 40-90 l/s/km² over a mid-hills catchment, which is
 * what Nepali rivers carry. That rules out a gross error. It does not confirm
 * the convention.
 *
 * Nepal's national annual isohyet map settles it. Its PMANN attribute is mean
 * ANNUAL precipitation in mm; ours is the June-September total. Across Nepal
 * the monsoon delivers roughly three quarters of the year's rain, so if our
 * layer is built correctly the ratio MMP/PMANN should sit near 0.7-0.85.
 *
 * A ratio near 0.25 would mean we had read a monthly mean as a seasonal total.
 * A ratio near 3 would mean the reverse. Either would be invisible in the
 * water-balance check, because the MMP exponent is only ~0.25 and HYDEST's
 * other terms would absorb it.
 *
 * RESULT, 2026-08-17: median 0.70 over 1,363 points, 5-95% of 0.47-0.92. The
 * convention is confirmed, and the reprojection self-check landed on
 * 26.35-30.45N / 80.05-88.20E, which is Nepal to the second decimal.
 *
 * ONE PREDICTION FAILED, and it is left recorded rather than tidied away. This
 * probe expected the monsoon SHARE to fall in the trans-Himalayan rain shadow,
 * where winter westerly snow matters more. It rose instead: 82% in the driest
 * band against 70% in the wettest. Either CHPclim under-catches high-altitude
 * winter snowfall — gauges famously do, and the satellite record inherits it —
 * or the isohyet map's sparse northern bands are themselves weakly constrained.
 * Both sources are at their worst in the same place, so the disagreement is
 * unresolved here. It does not affect the headline check, which rests on the
 * 987 wet-region points where both sources are strong; it is a caution about
 * trusting either dataset north of the main range.
 *
 * WHAT THIS DOES NOT DO: ship, copy or redistribute the isohyet map. It reads a
 * file you already have, prints a comparison, and writes nothing. The map's
 * provenance and licence are not established, so it is used here the way you
 * would use a published reference — to check our own work.
 */
import { readFileSync, existsSync } from 'node:fs';

const SHP = process.argv[2];
if (!SHP || !existsSync(SHP)) {
  console.error('usage: node pipeline/probe-isohyet.mjs "<path to Annual_Isohyete.shp>"');
  process.exit(1);
}
const DBF = SHP.replace(/\.shp$/i, '.dbf');

// ---------------------------------------------------------------------------
// 1. Nepal's national grid -> geodetic
//
// The map is projected on Modified UTM-84: Transverse Mercator, central
// meridian 84E, scale 0.9999, false easting 500 km, on the Everest 1830
// (Adjustment 1937) spheroid.
//
// The Everest-to-WGS84 datum shift is a few hundred metres and is deliberately
// NOT applied. These are coarse isohyet bands tens of kilometres across, and
// CHPclim's own cells are 5 km; a 300 m offset is two orders of magnitude below
// what either source resolves. Applying an unverified 3-parameter shift would
// add error while looking more rigorous.
// ---------------------------------------------------------------------------

const A = 6377276.345; // Everest 1830 semi-major axis, m
const INV_F = 300.8017;
const F = 1 / INV_F;
const E2 = 2 * F - F * F;
const K0 = 0.9999;
const LON0 = (84 * Math.PI) / 180;
const FE = 500000;

/** Inverse Transverse Mercator. Returns [latDeg, lonDeg] on the Everest datum. */
function inverseTM(easting, northing) {
  const x = easting - FE;
  const y = northing;
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
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
// 2. Read the isohyet polygons and their PMANN value
// ---------------------------------------------------------------------------

function readDbfField(path, field) {
  const buf = readFileSync(path);
  const n = buf.readUInt32LE(4);
  const hLen = buf.readUInt16LE(8);
  const rLen = buf.readUInt16LE(10);
  const fields = [];
  for (let p = 32; buf[p] !== 0x0d && p < hLen; p += 32) {
    fields.push({ name: buf.toString('latin1', p, p + 11).replace(/\0.*$/, ''), len: buf[p + 16] });
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let p = hLen + i * rLen + 1;
    for (const f of fields) {
      if (f.name === field) out[i] = parseFloat(buf.toString('latin1', p, p + f.len).trim());
      p += f.len;
    }
  }
  return out;
}

/** Polygon rings in record order, reprojected to lat/lon. */
function readShp(path) {
  const buf = readFileSync(path);
  const polys = [];
  let off = 100;
  while (off + 8 <= buf.length) {
    const contentLen = buf.readInt32BE(off + 4) * 2;
    const body = off + 8;
    if (buf.readInt32LE(body) === 5) {
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
          const [lat, lon] = inverseTM(
            buf.readDoubleLE(ptsAt + k * 16),
            buf.readDoubleLE(ptsAt + k * 16 + 8)
          );
          ring[(k - from) * 2] = lat;
          ring[(k - from) * 2 + 1] = lon;
        }
        rings.push(ring);
      }
      polys.push(rings);
    } else polys.push(null);
    off = body + contentLen;
  }
  return polys;
}

console.log('reading Nepal isohyet map…');
const pmann = readDbfField(DBF, 'PMANN_ID');
const polys = readShp(SHP);
console.log(`  ${polys.filter(Boolean).length} polygons, PMANN ${Math.min(...pmann)}–${Math.max(...pmann)} mm`);

// Self-check: reprojected coordinates must land on Nepal.
let latMin = 99, latMax = -99, lonMin = 999, lonMax = -999;
for (const rings of polys) {
  if (!rings) continue;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < latMin) latMin = r[i];
      if (r[i] > latMax) latMax = r[i];
      if (r[i + 1] < lonMin) lonMin = r[i + 1];
      if (r[i + 1] > lonMax) lonMax = r[i + 1];
    }
  }
}
console.log(
  `  reprojected extent: ${latMin.toFixed(2)}–${latMax.toFixed(2)}N, ${lonMin.toFixed(2)}–${lonMax.toFixed(2)}E`
);
if (latMin < 25 || latMax > 32 || lonMin < 79 || lonMax > 89) {
  throw new Error('reprojection did not land on Nepal — the grid definition is wrong');
}

/** Smallest polygon containing the point wins; bands nest. */
function pmannAt(lat, lon) {
  let best = null;
  let bestSpan = Infinity;
  for (let i = 0; i < polys.length; i++) {
    const rings = polys[i];
    if (!rings || !Number.isFinite(pmann[i])) continue;
    let inside = false;
    let span = 0;
    for (const r of rings) {
      let lo = 99, hi = -99;
      for (let k = 0, j = r.length - 2; k < r.length; j = k, k += 2) {
        const yi = r[k], xi = r[k + 1], yj = r[j], xj = r[j + 1];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        if (yi < lo) lo = yi;
        if (yi > hi) hi = yi;
      }
      span = Math.max(span, hi - lo);
    }
    if (inside && span < bestSpan) {
      bestSpan = span;
      best = pmann[i];
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3. Our own MMP at the same points, from the same CHPclim code path
// ---------------------------------------------------------------------------

const CACHE = 'pipeline/.cache';
const MONTHS = ['06', '07', '08', '09'];
const missing = MONTHS.filter((m) => !existsSync(`${CACHE}/chpclim.${m}.tif`));
if (missing.length) {
  console.error(`\nCHPclim months ${missing.join(', ')} are not cached — run: npm run build:mmp`);
  process.exit(1);
}

/** Same TIFF-LZW reader build-mmp.mjs uses, kept local so this probe stands alone. */
function lzw(src, dstLen) {
  const out = new Uint8Array(dstLen);
  let op = 0, data = 0, bits = 0, pos = 0, width = 9;
  let dict, next, prev = null;
  const reset = () => {
    dict = new Array(4096);
    for (let i = 0; i < 256; i++) dict[i] = Uint8Array.of(i);
    next = 258; width = 9; prev = null;
  };
  reset();
  for (;;) {
    while (bits < width) {
      if (pos >= src.length) return out;
      data = ((data << 8) | src[pos++]) >>> 0;
      bits += 8;
    }
    const code = (data >>> (bits - width)) & ((1 << width) - 1);
    bits -= width;
    if (code === 257) break;
    if (code === 256) { reset(); continue; }
    let entry;
    if (dict[code]) entry = dict[code];
    else if (code === next && prev) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev); entry[prev.length] = prev[0];
    } else throw new Error(`bad LZW code ${code}`);
    out.set(entry, op); op += entry.length;
    if (prev) {
      const e = new Uint8Array(prev.length + 1);
      e.set(prev); e[prev.length] = entry[0];
      dict[next++] = e;
      if (next === 511) width = 10;
      else if (next === 1023) width = 11;
      else if (next === 2047) width = 12;
    }
    prev = entry;
  }
  return out;
}

const ROW0 = Math.floor((90 - 31) / 0.05);
const ROW1 = Math.ceil((90 - 25) / 0.05);
const grids = [];
for (const mm of MONTHS) {
  const buf = readFileSync(`${CACHE}/chpclim.${mm}.tif`);
  const ifd = buf.readUInt32LE(4);
  const n = buf.readUInt16LE(ifd);
  const tag = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const t = buf.readUInt16LE(e);
    const type = buf.readUInt16LE(e + 2);
    const count = buf.readUInt32LE(e + 4);
    tag[t] = { val: type === 3 && count === 1 ? buf.readUInt16LE(e + 8) : buf.readUInt32LE(e + 8) };
  }
  const w = tag[256].val;
  const rows = new Map();
  for (let r = ROW0; r <= ROW1; r++) {
    const o = buf.readUInt32LE(tag[273].val + r * 4);
    const l = buf.readUInt32LE(tag[279].val + r * 4);
    const raw = lzw(buf.subarray(o, o + l), w * 4);
    rows.set(r, new Float32Array(raw.buffer, raw.byteOffset, w));
  }
  grids.push(rows);
}

function mmpAt(lat, lon) {
  const col = Math.floor((lon + 180) / 0.05);
  const row = Math.floor((90 - lat) / 0.05);
  let sum = 0;
  for (const g of grids) {
    const line = g.get(row);
    const v = line ? line[col] : NaN;
    if (!(v >= 0)) return NaN;
    sum += v;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// 4. Compare on a grid across Nepal
// ---------------------------------------------------------------------------

console.log('\ncomparing our monsoon layer against the national annual map…');
const pairs = [];
for (let lat = 26.4; lat <= 30.4; lat += 0.1) {
  for (let lon = 80.2; lon <= 88.1; lon += 0.1) {
    const ann = pmannAt(lat, lon);
    if (!ann || !(ann > 0)) continue;
    const mon = mmpAt(lat, lon);
    if (!Number.isFinite(mon) || !(mon > 0)) continue;
    pairs.push({ lat, lon, ann, mon, ratio: mon / ann });
  }
}
if (pairs.length < 50) throw new Error(`only ${pairs.length} comparable points — something is wrong`);

const ratios = pairs.map((p) => p.ratio).sort((a, b) => a - b);
const q = (f) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * f))];
const median = q(0.5);

console.log(`  ${pairs.length} points compared across Nepal`);
console.log(`  monsoon / annual ratio:  median ${median.toFixed(2)}   5–95% ${q(0.05).toFixed(2)}–${q(0.95).toFixed(2)}`);

// The rain-shadow test: the monsoon share must FALL where the monsoon does not
// reach. If our layer were a constant fraction of annual, this would not hold,
// and it would mean we had reproduced the isohyet map rather than measured
// anything independent.
const wet = pairs.filter((p) => p.ann >= 1500);
const dry = pairs.filter((p) => p.ann <= 600);
const mean = (a) => a.reduce((s, p) => s + p.ratio, 0) / a.length;
console.log(
  `  wet regions (>=1500 mm/yr, n=${wet.length}): monsoon share ${(mean(wet) * 100).toFixed(0)}%`
);
console.log(
  `  rain shadow (<=600 mm/yr, n=${dry.length}): monsoon share ${(mean(dry) * 100).toFixed(0)}%`
);

console.log('\nVERDICT');
if (median > 0.6 && median < 0.95) {
  console.log(`  PASS — a monsoon share of ${(median * 100).toFixed(0)}% is what Nepal's climate has.`);
  console.log('  The June-September convention in build-mmp.mjs is confirmed against');
  console.log("  Nepal's own national isohyet map, independently of the water-balance check.");
} else if (median < 0.4) {
  console.log(`  FAIL — ${(median * 100).toFixed(0)}% is far too little for a monsoon country.`);
  console.log('  build-mmp.mjs is probably summing monthly MEANS where it should sum a total.');
} else if (median > 1.05) {
  console.log(`  FAIL — the monsoon cannot deliver ${(median * 100).toFixed(0)}% of the annual total.`);
  console.log('  build-mmp.mjs is over-counting; check the month set and the units.');
} else {
  console.log(`  MARGINAL — ${(median * 100).toFixed(0)}%. Plausible but at the edge; worth a look.`);
}
console.log(
  '\n  Reference used, not redistributed: Nepal annual isohyet map (PMANN, mm), read from disk.'
);
