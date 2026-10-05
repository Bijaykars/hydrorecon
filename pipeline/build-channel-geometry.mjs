/**
 * The drawn river, following the channel instead of cutting across it.
 *
 *   node --experimental-strip-types --no-warnings pipeline/build-channel-geometry.mjs
 *
 * WHAT WAS WRONG. `snap-vertices-to-osm.mjs` pulls every HydroRIVERS vertex onto
 * the traced channel and writes them "parallel to the vertex block" — exactly
 * one output position per input position. HydroRIVERS vertices are about 500 m
 * apart, so the drawn river ends up as a chain of corners that ARE on the water
 * joined by straight lines that are not. Over a Himalayan meander that reads as
 * a blue line running across a hillside while the imagery plainly shows the
 * river going round it. The corners were snapped; the chords were kept.
 *
 * WHAT THIS DOES. OSM already holds the course at 124 m per vertex over 92,053
 * km of Nepali waterway, and `snapPathToOsm` already works out which traced way
 * each vertex matched — it just discarded that. `densifyAlongTrace` walks the
 * matched way between consecutive vertices and emits its intermediate points,
 * so the drawn line follows the river.
 *
 * DRAWING ONLY, and the distinction is the whole reason this is safe. The
 * engine samples elevations on the MODELLED vertices, deliberately: `rivers.ts`
 * and `osm-rivers.ts` both record that moving the course under the engine was
 * measured against the ten built plants and lost — head improved from a 26% to
 * a 20% median error while capacity error went from 17% to 28%, and Upper Bhote
 * Koshi, which HydroRIVERS gets to within 2%, regressed to 35%. What the engine
 * already takes from the trace is the LENGTH factor, which is a property of the
 * course rather than of the endpoints. This file changes no number in any
 * report; it changes what a reader sees on the map.
 *
 * ORDER 2 AND ABOVE ONLY, because that is what `riversGeoJson` draws. Densifying
 * the headwater streams nobody renders would triple the store for nothing.
 *
 * OUTPUT: public/nepal-channel.dat
 *   u32 magic 'NCH1', u32 reachCount, u32 totalVerts, u32 scale(1e6),
 *   then reachCount x u32 vertex counts (0 = no traced geometry, draw as before),
 *   then the vertices as i32 lat*1e6, i32 lon*1e6.
 *   Plain absolute pairs, not deltas: the file is fetched once and 3 MB of
 *   packing cleverness is not worth the decoder it would need.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u).replace(/^undefined/, '');
  if (p.startsWith('/') || /^[\w.-]+\.(json|dat|bin)$/.test(p)) {
    try {
      return new Response(readFileSync(`public/${p.replace(/^\//, '')}`), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return realFetch(p, i);
};

const { snapPathToOsm, osmRiversAvailable, densifyAlongTrace, osmLines } = await import(
  '../src/osm-rivers.ts'
);
const { haversineKm } = await import('../src/engine/hydro.ts');

if (!(await osmRiversAvailable())) {
  console.error('public/nepal-osm-rivers.json missing — run pipeline/build-osm-rivers.mjs');
  process.exit(1);
}
const lines = await osmLines();

const buf = readFileSync('public/nepal-rivers.dat');
if (buf.readUInt32LE(0) !== 0x4e505231) throw new Error('unexpected magic in nepal-rivers.dat');
const count = buf.readUInt32LE(4);
const nverts = buf.readUInt32LE(8);
const scale = buf.readUInt32LE(12);
console.log(`${count} reaches, ${nverts} vertices, ${lines.length} traced OSM lines`);

let off = 16;
const nvs = new Array(count);
const ord = new Uint8Array(count);
for (let r = 0; r < count; r++) {
  ord[r] = buf.readUInt8(off + 8);
  nvs[r] = buf.readUInt16LE(off + 9);
  off += 11;
}

const lat = new Float64Array(nverts);
const lon = new Float64Array(nverts);
{
  let vi = 0;
  for (let r = 0; r < count; r++) {
    let x = buf.readInt32LE(off);
    let y = buf.readInt32LE(off + 4);
    off += 8;
    lat[vi] = y / scale;
    lon[vi] = x / scale;
    vi++;
    for (let k = 1; k < nvs[r]; k++) {
      x += buf.readInt16LE(off);
      y += buf.readInt16LE(off + 2);
      off += 4;
      lat[vi] = y / scale;
      lon[vi] = x / scale;
      vi++;
    }
  }
  if (vi !== nverts) throw new Error(`decoded ${vi} vertices, header said ${nverts}`);
}

/** Same bar the snapper uses: below it the match is not trusted at all. */
const MIN_MATCHED = 0.6;

const perReach = new Array(count).fill(null);
let vi = 0;
let drawn = 0;
let densified = 0;
let tracedSeg = 0;
let totalSeg = 0;
let kmBefore = 0;
let kmAfter = 0;
for (let r = 0; r < count; r++) {
  const nv = nvs[r];
  const base = vi;
  vi += nv;
  if (ord[r] < 2 || nv < 3) continue;
  drawn++;
  const path = new Array(nv);
  let km = 0;
  for (let k = 0; k < nv; k++) {
    if (k > 0) km += haversineKm([lat[base + k - 1], lon[base + k - 1]], [lat[base + k], lon[base + k]]);
    path[k] = { lat: lat[base + k], lon: lon[base + k], km };
  }
  const snap = await snapPathToOsm(path).catch(() => null);
  if (!snap || snap.matched < MIN_MATCHED) continue;
  const dense = densifyAlongTrace(snap, lines);
  // A densified line that gained nothing is not worth a row in the store; the
  // renderer's existing per-vertex fallback already draws that case correctly.
  if (dense.coordinates.length <= nv) continue;
  densified++;
  tracedSeg += dense.tracedSegments;
  totalSeg += dense.totalSegments;
  let before = 0;
  for (let k = 1; k < nv; k++) {
    before += haversineKm([snap.path[k - 1].lat, snap.path[k - 1].lon], [snap.path[k].lat, snap.path[k].lon]);
  }
  let after = 0;
  for (let k = 1; k < dense.coordinates.length; k++) {
    const a = dense.coordinates[k - 1];
    const b = dense.coordinates[k];
    after += haversineKm([a[1], a[0]], [b[1], b[0]]);
  }
  kmBefore += before;
  kmAfter += after;
  perReach[r] = dense.coordinates;
  if (r % 5000 === 0) console.log(`  ${r}/${count} reaches — ${densified} densified`);
}

const totalVerts = perReach.reduce((a, c) => a + (c ? c.length : 0), 0);
console.log(
  `\n${drawn} reaches are drawn (order >= 2); ${densified} gained traced geometry ` +
    `(${((100 * densified) / Math.max(1, drawn)).toFixed(0)}%)`
);
console.log(
  `  ${tracedSeg} of ${totalSeg} segments spliced ` +
    `(${((100 * tracedSeg) / Math.max(1, totalSeg)).toFixed(0)}%); the rest kept their chord ` +
    'because the match changed line, ran backwards, or detoured'
);
console.log(
  `  drawn length ${kmBefore.toFixed(0)} km -> ${kmAfter.toFixed(0)} km ` +
    `(+${((100 * (kmAfter - kmBefore)) / Math.max(1, kmBefore)).toFixed(1)}%), ` +
    `${totalVerts.toLocaleString()} vertices`
);
if (!densified) {
  console.error('nothing densified — refusing to write an empty store');
  process.exit(1);
}

const out = Buffer.alloc(16 + count * 4 + totalVerts * 8);
out.writeUInt32LE(0x4e434831, 0);
out.writeUInt32LE(count, 4);
out.writeUInt32LE(totalVerts, 8);
out.writeUInt32LE(1e6, 12);
let p = 16;
for (let r = 0; r < count; r++) {
  out.writeUInt32LE(perReach[r] ? perReach[r].length : 0, p);
  p += 4;
}
for (let r = 0; r < count; r++) {
  const c = perReach[r];
  if (!c) continue;
  for (const [x, y] of c) {
    out.writeInt32LE(Math.round(y * 1e6), p);
    out.writeInt32LE(Math.round(x * 1e6), p + 4);
    p += 8;
  }
}
writeFileSync('public/nepal-channel.dat', out);
console.log(`\nwrote public/nepal-channel.dat (${(out.length / 1e6).toFixed(2)} MB)`);
