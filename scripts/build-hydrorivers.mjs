/**
 * Build the bundled Nepal river network from HydroRIVERS v1.0 (Asia).
 *
 *   node scripts/build-hydrorivers.mjs
 *
 * Why a build step: the Asia shapefile is a 90 MB zip. It sends CORS headers, so a
 * browser *could* fetch it, but nobody should. We extract Nepal once and ship a
 * compact binary that answers the question the global model cannot:
 *   UPLAND_SKM  — upstream catchment area at this reach, km²
 *   DIS_AV_CMS  — long-term mean discharge at this reach, m³/s
 *
 * Output: public/nepal-rivers.dat, lazy-loaded only when a point is in Nepal.
 *
 * Format (little-endian):
 *   magic  u32  0x4E505231 'NPR1'
 *   count  u32  reach count
 *   verts  u32  total vertex count
 *   scale  u32  coordinate grid divisor (480 => 1/480 degree, the native grid)
 *   then count records of:
 *     i32 upland_x10, i32 dis_x1000, u8 ord, u16 nverts
 *   then vertex block, per reach: first vertex absolute (i32 x, i32 y),
 *     remaining as i16 deltas. HydroRIVERS coordinates sit exactly on the
 *     1/480-degree grid, so deltas are tiny and gzip compresses them hard.
 */
import AdmZip from 'adm-zip';
import * as shapefile from 'shapefile';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = 'https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_as_shp.zip';
// .dat, not .bin: proxies and endpoint security commonly block .bin downloads.
// Measured here — identical file, .bin returned HTTP 204 with an empty body while
// .dat returned 200 with all 1,461,059 bytes.
const OUT = 'public/nepal-rivers.dat';
const WORK = process.env.HR_WORK ?? join(tmpdir(), 'hydrorivers');
const ZIP = join(WORK, 'asia.zip');
// Nepal, with a small margin so border reaches are included.
const BOX = { west: 79.9, south: 25.9, east: 89.1, north: 31.1 };
const SCALE = 480;

mkdirSync(WORK, { recursive: true });
mkdirSync('public', { recursive: true });

if (!existsSync(ZIP)) {
  console.log(`downloading ${SRC} (~90 MB)…`);
  const res = await fetch(SRC);
  if (!res.ok) throw new Error(`HydroSHEDS: HTTP ${res.status}`);
  writeFileSync(ZIP, Buffer.from(await res.arrayBuffer()));
}
const { statSync } = await import('node:fs');
console.log(`zip: ${(statSync(ZIP).size / 1e6).toFixed(1)} MB`);

const zip = new AdmZip(ZIP);
const entryFor = (ext) => {
  const e = zip.getEntries().find((x) => x.entryName.toLowerCase().endsWith(ext));
  if (!e) throw new Error(`no ${ext} in archive`);
  return e;
};
const shp = zip.readFile(entryFor('.shp'));
const dbf = zip.readFile(entryFor('.dbf'));
console.log(`shp ${(shp.length / 1e6).toFixed(1)} MB, dbf ${(dbf.length / 1e6).toFixed(1)} MB — parsing…`);

const t0 = Date.now();
const src = await shapefile.open(shp, dbf);
const reaches = [];
let scanned = 0;
for (;;) {
  const { done, value } = await src.read();
  if (done) break;
  scanned++;
  const g = value?.geometry;
  if (!g || g.type !== 'LineString') continue;
  const coords = g.coordinates;
  // Keep a reach if any vertex falls inside the box.
  let inside = false;
  for (const [x, y] of coords) {
    if (x >= BOX.west && x <= BOX.east && y >= BOX.south && y <= BOX.north) {
      inside = true;
      break;
    }
  }
  if (!inside) continue;
  const p = value.properties ?? {};
  reaches.push({
    upland: Number(p.UPLAND_SKM) || 0,
    dis: Number(p.DIS_AV_CMS) || 0,
    ord: Math.max(0, Math.min(255, Number(p.ORD_STRA) || 0)),
    coords,
  });
}
console.log(`scanned ${scanned.toLocaleString()} Asia reaches in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`kept ${reaches.length.toLocaleString()} inside Nepal`);

const totalVerts = reaches.reduce((n, r) => n + r.coords.length, 0);
console.log(`vertices: ${totalVerts.toLocaleString()} (${(totalVerts / reaches.length).toFixed(2)} per reach)`);

// ---- encode ----
const head = Buffer.alloc(16);
head.writeUInt32LE(0x4e505231, 0);
head.writeUInt32LE(reaches.length, 4);
head.writeUInt32LE(totalVerts, 8);
head.writeUInt32LE(SCALE, 12);

const meta = Buffer.alloc(reaches.length * 11);
let mo = 0;
for (const r of reaches) {
  meta.writeInt32LE(Math.round(r.upland * 10), mo);
  meta.writeInt32LE(Math.round(r.dis * 1000), mo + 4);
  meta.writeUInt8(r.ord, mo + 8);
  meta.writeUInt16LE(Math.min(65535, r.coords.length), mo + 9);
  mo += 11;
}

// Vertices: absolute first point per reach, then int16 deltas.
const verts = Buffer.alloc(totalVerts * 8);
let vo = 0;
let clamped = 0;
for (const r of reaches) {
  let px = 0;
  let py = 0;
  r.coords.forEach(([lon, lat], i) => {
    const x = Math.round(lon * SCALE);
    const y = Math.round(lat * SCALE);
    if (i === 0) {
      verts.writeInt32LE(x, vo);
      verts.writeInt32LE(y, vo + 4);
      vo += 8;
    } else {
      let dx = x - px;
      let dy = y - py;
      // Deltas beyond int16 would corrupt the line; clamp and count so it is visible.
      if (dx < -32768 || dx > 32767 || dy < -32768 || dy > 32767) clamped++;
      dx = Math.max(-32768, Math.min(32767, dx));
      dy = Math.max(-32768, Math.min(32767, dy));
      verts.writeInt16LE(dx, vo);
      verts.writeInt16LE(dy, vo + 2);
      vo += 4;
    }
    px = x;
    py = y;
  });
}
const out = Buffer.concat([head, meta, verts.subarray(0, vo)]);
writeFileSync(OUT, out);

console.log(`\nwrote ${OUT}`);
console.log(`  raw    ${(out.length / 1024).toFixed(1)} KB`);
console.log(`  gzip   ${(gzipSync(out, { level: 9 }).length / 1024).toFixed(1)} KB`);
if (clamped) console.log(`  WARNING: ${clamped} vertex deltas clamped to int16`);

// Sanity: report a few large rivers so the numbers can be eyeballed.
const big = [...reaches].sort((a, b) => b.upland - a.upland).slice(0, 5);
console.log('\nlargest catchments in the extract:');
for (const r of big) {
  console.log(`  UPLAND ${r.upland.toFixed(0).padStart(7)} km²   DIS_AV ${r.dis.toFixed(1).padStart(8)} m³/s   order ${r.ord}`);
}
