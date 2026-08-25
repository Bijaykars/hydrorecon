/**
 * Every river vertex, pulled onto the traced channel.
 *
 *   node --experimental-strip-types --no-warnings pipeline/snap-vertices-to-osm.mjs
 *
 * This exists to make MERIT Hydro samplable. Its `upa` raster carries a large
 * value only ON the channel, so it must be read at a point that is genuinely in
 * the river. HydroRIVERS vertices are not: derived at about 500 m, they sit a
 * few hundred metres off, and reading MERIT there returns a headwater trickle.
 *
 * Widening the read window was the obvious workaround and it is wrong — past a
 * few hundred metres the window finds whatever trunk river passes nearby and
 * invents catchment. Measured on the DHM gauges (checks/osm-snap-export.mjs):
 *
 *   at a 93 m window   raw vertices 36% plausible, traced vertices 91%
 *   at 186 m           raw 50%,                    traced 93%
 *
 * So the fix is to move the point, not to widen the window. A small window
 * cannot steal a neighbour, which is what makes the result trustworthy.
 *
 * Writes positions only. The raster sampling happens in Python, where PIL is.
 *
 * OUTPUT: pipeline/.cache/osm-snapped-vertices.bin
 *   u32 magic 'OSV1', u32 vertexCount, then per vertex i32 lat*1e6, i32 lon*1e6.
 *   Unmatched vertices keep their modelled position, so the array is always
 *   complete and parallel to the vertex block in nepal-rivers.dat.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

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

const { snapPathToOsm, osmRiversAvailable } = await import('../src/osm-rivers.ts');
const { haversineKm } = await import('../src/engine/hydro.ts');

if (!(await osmRiversAvailable())) {
  console.error('public/nepal-osm-rivers.json missing — run pipeline/build-osm-rivers.mjs');
  process.exit(1);
}

const buf = readFileSync('public/nepal-rivers.dat');
const magic = buf.readUInt32LE(0);
if (magic !== 0x4e505231) throw new Error(`unexpected magic ${magic.toString(16)}`);
const count = buf.readUInt32LE(4);
const nverts = buf.readUInt32LE(8);
const scale = buf.readUInt32LE(12);
console.log(`${count} reaches, ${nverts} vertices, grid 1/${scale} degree`);

let off = 16;
const nvs = new Array(count);
for (let r = 0; r < count; r++) {
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

const outLat = Float64Array.from(lat);
const outLon = Float64Array.from(lon);
let matchedReaches = 0;
let movedVerts = 0;
let totalMoveM = 0;

let vi = 0;
for (let r = 0; r < count; r++) {
  const nv = nvs[r];
  if (nv < 3) {
    vi += nv;
    continue;
  }
  // The matcher decides which watercourse a RUN of points belongs to, so it is
  // given the whole reach at once rather than one vertex at a time.
  const path = new Array(nv);
  let km = 0;
  for (let k = 0; k < nv; k++) {
    if (k > 0) km += haversineKm([lat[vi + k - 1], lon[vi + k - 1]], [lat[vi + k], lon[vi + k]]);
    path[k] = { lat: lat[vi + k], lon: lon[vi + k], km };
  }
  const snap = await snapPathToOsm(path).catch(() => null);
  if (snap && snap.matched >= 0.6) {
    matchedReaches++;
    for (let k = 0; k < nv; k++) {
      const d = haversineKm([lat[vi + k], lon[vi + k]], [snap.path[k].lat, snap.path[k].lon]);
      if (d > 0) {
        movedVerts++;
        totalMoveM += d * 1000;
      }
      outLat[vi + k] = snap.path[k].lat;
      outLon[vi + k] = snap.path[k].lon;
    }
  }
  vi += nv;
  if (r % 5000 === 0) console.log(`  ${r}/${count} reaches`);
}

console.log(
  `matched ${matchedReaches}/${count} reaches (${((matchedReaches / count) * 100).toFixed(0)}%), ` +
    `moved ${movedVerts} vertices by ${(totalMoveM / Math.max(1, movedVerts)).toFixed(0)} m on average`
);

if (!existsSync('pipeline/.cache')) mkdirSync('pipeline/.cache', { recursive: true });
const out = Buffer.alloc(8 + nverts * 8);
out.writeUInt32LE(0x4f535631, 0);
out.writeUInt32LE(nverts, 4);
for (let i = 0; i < nverts; i++) {
  out.writeInt32LE(Math.round(outLat[i] * 1e6), 8 + i * 8);
  out.writeInt32LE(Math.round(outLon[i] * 1e6), 8 + i * 8 + 4);
}
writeFileSync('pipeline/.cache/osm-snapped-vertices.bin', out);
console.log(`wrote pipeline/.cache/osm-snapped-vertices.bin (${out.length} bytes)`);
