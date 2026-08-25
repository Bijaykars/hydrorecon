/**
 * Nepal's rivers as OpenStreetMap actually traced them.
 *
 *   node pipeline/build-osm-rivers.mjs
 *
 * WHY: the app's channel geometry comes from HydroRIVERS, which is derived at
 * about 500 m. Measured on this app's own reaches that leaves straight runs of
 * 350 m at the median and up to 3.7 km — you cannot place an intake on a bend
 * because the data has no bend there. It also under-measures the waterway,
 * since a chord across a meander is shorter than the meander.
 *
 * Inferring the true line from terrain was tried twice and rejected both times
 * (see snapPathToValley in src/api.ts): it cannot systematically improve head,
 * only add variance to it. The answer is not to infer the river. It is to use a
 * river someone has already traced.
 *
 * WHAT THIS DOES NOT CHANGE: HydroRIVERS keeps its job. It carries catchment
 * area, long-term discharge and the upstream/downstream topology that the whole
 * app is built on, and OSM has none of those. This supplies geometry only.
 *
 * HOW IT GETS THE DATA: Overpass answers 504 for a query this size, so the
 * source is Geofabrik's prepared Nepal extract. That archive is a gigabyte and
 * almost all of it is roads and buildings, so rather than download it whole
 * this reads the ZIP central directory over an HTTP range request, finds the
 * two waterway members, and fetches only those byte ranges.
 *
 * LICENCE: OpenStreetMap contributors, ODbL 1.0. The extract written here is a
 * derived database and stays ODbL — a licence on the DATA file, not on this
 * repository's MIT code, the same split already used for the grid and the
 * bundled HydroRIVERS extract.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const ARCHIVE = 'https://download.geofabrik.de/asia/nepal-latest-free.shp.zip';
const CACHE = 'pipeline/.cache';
const OUT = 'public/nepal-osm-rivers.json';
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

/**
 * Geofabrik is mirrored and occasionally slow to connect, and a single
 * ConnectTimeout should not throw away a job that is otherwise cheap. Each
 * request gets a few attempts with a generous timeout.
 */
const tries = async (label, fn) => {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.log(`  ${label}: attempt ${attempt} failed (${e.cause?.code ?? e.message}), retrying…`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw last;
};

const range = (from, to) =>
  tries(`bytes ${from}-${to}`, async () => {
    const res = await fetch(ARCHIVE, {
      headers: { Range: `bytes=${from}-${to}` },
      signal: AbortSignal.timeout(300_000),
    });
    if (res.status !== 206) throw new Error(`range request refused: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });

const total = await tries('archive size', async () => {
  const res = await fetch(ARCHIVE, { method: 'HEAD', signal: AbortSignal.timeout(120_000) });
  const n = Number(res.headers.get('content-length'));
  if (!(n > 0)) throw new Error('no content-length on the archive');
  return n;
});
console.log(`archive ${(total / 1e6).toFixed(0)} MB`);

// --- locate the waterway members without downloading the archive -----------
const tail = await range(Math.max(0, total - 65536), total - 1);
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) {
  if (tail.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) throw new Error('no end-of-central-directory record');
const cdOffset = tail.readUInt32LE(eocd + 16);
const cdSize = tail.readUInt32LE(eocd + 12);
const cd = await range(cdOffset, cdOffset + cdSize - 1);

const members = new Map();
let p = 0;
while (p < cd.length && cd.readUInt32LE(p) === 0x02014b50) {
  const method = cd.readUInt16LE(p + 10);
  const compressed = cd.readUInt32LE(p + 20);
  const uncompressed = cd.readUInt32LE(p + 24);
  const nameLen = cd.readUInt16LE(p + 28);
  const extraLen = cd.readUInt16LE(p + 30);
  const commentLen = cd.readUInt16LE(p + 32);
  const localOffset = cd.readUInt32LE(p + 42);
  const name = cd.slice(p + 46, p + 46 + nameLen).toString('latin1');
  members.set(name, { method, compressed, uncompressed, localOffset });
  p += 46 + nameLen + extraLen + commentLen;
}
const wanted = [...members.keys()].filter((k) => /waterways.*\.(shp|dbf)$/i.test(k));
if (!wanted.length) throw new Error(`no waterway layer in the archive: ${[...members.keys()].join(', ')}`);
console.log(`members: ${members.size}, taking ${wanted.join(' + ')}`);

/** Pull one member out, reading only its own bytes. */
async function member(name) {
  const cached = `${CACHE}/geofabrik-${name.replace(/[^a-z0-9.]+/gi, '-')}`;
  if (existsSync(cached)) {
    console.log(`  (cached) ${name}`);
    return readFileSync(cached);
  }
  const m = members.get(name);
  // The local header repeats the name and extra field, and its extra field may
  // differ in length from the central one, so read it rather than assume.
  const local = await range(m.localOffset, m.localOffset + 29);
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  const start = m.localOffset + 30 + nameLen + extraLen;
  const raw = await range(start, start + m.compressed - 1);
  const out = m.method === 0 ? raw : inflateRawSync(raw);
  if (out.length !== m.uncompressed) throw new Error(`${name}: inflated ${out.length}, expected ${m.uncompressed}`);
  writeFileSync(cached, out);
  console.log(`  ${name}: ${(out.length / 1e6).toFixed(1)} MB`);
  return out;
}

const shpName = wanted.find((n) => /\.shp$/i.test(n));
const dbfName = wanted.find((n) => /\.dbf$/i.test(n));
const shp = await member(shpName);
const dbf = await member(dbfName);

// --- dBASE III: one record per shape, in the same order --------------------
const dbfRecords = (() => {
  const headerLen = dbf.readUInt16LE(8);
  const recordLen = dbf.readUInt16LE(10);
  const count = dbf.readUInt32LE(4);
  const fields = [];
  for (let o = 32; dbf[o] !== 0x0d; o += 32) {
    fields.push({ name: dbf.slice(o, o + 11).toString('latin1').replace(/\0.*$/, ''), len: dbf[o + 16] });
  }
  const rows = [];
  for (let i = 0; i < count; i++) {
    const base = headerLen + i * recordLen + 1; // skip the deletion flag
    const row = {};
    let o = base;
    for (const f of fields) {
      row[f.name] = dbf.slice(o, o + f.len).toString('latin1').trim();
      o += f.len;
    }
    rows.push(row);
  }
  return rows;
})();

// --- ESRI shapefile, PolyLine (type 3) -------------------------------------
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const shapes = [];
{
  let o = 100; // file header
  while (o + 8 <= shp.length) {
    const contentLen = shp.readInt32BE(o + 4) * 2;
    const body = o + 8;
    const type = shp.readInt32LE(body);
    if (type === 3) {
      const numParts = shp.readInt32LE(body + 36);
      const numPoints = shp.readInt32LE(body + 40);
      const partsAt = body + 44;
      const pointsAt = partsAt + numParts * 4;
      for (let part = 0; part < numParts; part++) {
        const from = shp.readInt32LE(partsAt + part * 4);
        const to = part + 1 < numParts ? shp.readInt32LE(partsAt + (part + 1) * 4) : numPoints;
        const line = [];
        for (let k = from; k < to; k++) {
          line.push([shp.readDoubleLE(pointsAt + k * 16), shp.readDoubleLE(pointsAt + k * 16 + 8)]);
        }
        if (line.length >= 2) shapes.push({ index: shapes.length, recNo: shapes.length, line });
      }
    }
    o = body + contentLen;
  }
}
console.log(`shapefile: ${shapes.length} polylines, ${dbfRecords.length} attribute rows`);

/**
 * Keep the watercourses a scheme can sit on.
 *
 * Rivers and streams are the channels this app screens. Drains, ditches and
 * canals are man-made and do not carry a catchment, and including them would
 * let an intake snap onto an irrigation ditch beside the river.
 */
const KEEP = new Set(['river', 'stream']);

/**
 * Drop vertices that do not change where the line runs. Only the distance to
 * the nearest point on a channel matters here, so a vertex within the tolerance
 * of the straight segment spanning its neighbours carries no information. At
 * 15 m this stays far finer than the 500 m data it replaces.
 */
function simplify(pts, tolDeg) {
  if (pts.length <= 2) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let worstD = 0;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worstD > tolDeg && worst > 0) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
const TOL_DEG = 15 / 111320;

const lines = [];
let vertsIn = 0;
let vertsOut = 0;
let kept = 0;
for (const s of shapes) {
  const attrs = dbfRecords[s.recNo] ?? {};
  const cls = (attrs.fclass || '').toLowerCase();
  if (!KEEP.has(cls)) continue;
  kept++;
  vertsIn += s.line.length;
  const simp = simplify(s.line, TOL_DEG).map(([x, y]) => [r5(y), r5(x)]);
  vertsOut += simp.length;
  lines.push({ r: cls === 'river' ? 1 : 0, p: simp.flat() });
}

const bundle = {
  _source: 'OpenStreetMap contributors, ODbL 1.0, via Geofabrik Nepal extract.',
  _note: 'Derived database. Redistribution of this file is governed by ODbL, not the MIT licence on the code. Geometry only — catchment area and discharge come from HydroRIVERS.',
  _retrieved: new Date().toISOString().slice(0, 10),
  _format: 'lines[].p is a flat [lat, lon, lat, lon, ...]; r=1 marks a river, 0 a stream',
  lines,
};
const json = JSON.stringify(bundle);
writeFileSync(OUT, json);
console.log(`\nwrote ${OUT}: ${(json.length / 1e6).toFixed(1)} MB`);
console.log(`  ${kept} watercourses kept of ${shapes.length} (${vertsIn} vertices simplified to ${vertsOut})`);
console.log(`  rivers ${lines.filter((l) => l.r === 1).length}, streams ${lines.filter((l) => l.r === 0).length}`);
