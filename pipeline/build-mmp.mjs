/**
 * Monsoon precipitation per catchment — the input that completes HYDEST.
 *
 *   npm run build:mmp
 *
 * WHY: HYDEST's monthly equation is Q = C · A^a1 · (A5000+1)^a2 · MMP^a3, and
 * without MMP — the monsoon wetness index, mm of monsoon-season precipitation
 * over the catchment — six months of Nepal's own regression have sat empty.
 * Filling them does two things. The panel's HYDEST table becomes a full annual
 * regime instead of Jan–May. And the flow arbitration gains a Nepali opinion
 * about the ANNUAL mean, which matters because validation against built plants
 * showed reaches where both global flow sources are broken at once (the
 * Chilime read 1.6 m³/s in one and 44 in the other around a river carrying
 * about ten). A regression fitted to Nepali gauges is exactly the referee for
 * that fight.
 *
 * SOURCE: CHPclim v2 (Climate Hazards Center, UCSB) — 0.05° monthly
 * precipitation climatology, the station-anchored surface underneath CHIRPS.
 * Public domain. Four months, June through September, ~32 MB each, cached.
 * The TIFFs are LZW-compressed with one row per strip, so only the ~100 rows
 * covering the Nepal window are ever decoded.
 *
 * MMP DEFINITION: the June–September TOTAL, in mm, averaged over the upstream
 * catchment — the convention of the WECS 1990 isohyet map the regression was
 * fitted against. The exponent is ~0.25, so even a misreading of the
 * convention by a factor of two would move flows by only ~19%; the printed
 * cross-check against reaches the plant validation proved sane is what pins it.
 *
 * OUTPUT: public/nepal-hypso.dat grows from 2 to 4 bytes per reach — the two
 * existing hypsometry bytes are PRESERVED (no re-sampling of terrain), plus a
 * uint16 of catchment-mean MMP in mm (0xffff = unknown).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const CACHE = 'pipeline/.cache';
const RIVERS = 'public/nepal-rivers.dat';
const HYPSO = 'public/nepal-hypso.dat';
const MONTHS = ['06', '07', '08', '09'];
const URL = (mm) => `https://data.chc.ucsb.edu/products/CHPclim/v2/monthly_9090/CHPclim2.90-90.${mm}.tif`;

/** Same window and grid as build-hypsometry.mjs — the basins must line up. */
const COVER = { west: 79.9, south: 26.2, east: 88.4, north: 30.6 };
const STEP = 0.004;

if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

// ---------------------------------------------------------------------------
// 1. CHPclim: fetch, and decode just the rows the window needs
// ---------------------------------------------------------------------------

/** TIFF-variant LZW: MSB-first codes, 9→12 bits with early change. */
function lzw(src, dstLen) {
  const out = new Uint8Array(dstLen);
  let op = 0;
  let data = 0;
  let bits = 0;
  let pos = 0;
  let width = 9;
  const CLEAR = 256;
  const EOI = 257;
  let dict;
  let next;
  let prev = null;
  const reset = () => {
    dict = new Array(4096);
    for (let i = 0; i < 256; i++) dict[i] = Uint8Array.of(i);
    next = 258;
    width = 9;
    prev = null;
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
    if (code === EOI) break;
    if (code === CLEAR) {
      reset();
      continue;
    }
    let entry;
    if (dict[code]) entry = dict[code];
    else if (code === next && prev) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev);
      entry[prev.length] = prev[0];
    } else throw new Error(`bad LZW code ${code} at ${pos}`);
    out.set(entry, op);
    op += entry.length;
    if (prev) {
      const e = new Uint8Array(prev.length + 1);
      e.set(prev);
      e[prev.length] = entry[0];
      dict[next++] = e;
      if (next === 511) width = 10;
      else if (next === 1023) width = 11;
      else if (next === 2047) width = 12;
    }
    prev = entry;
  }
  return out;
}

/** The window's rows with a margin. Row r covers latitude 90 − (r+0.5)·0.05. */
const ROW0 = Math.floor((90 - (COVER.north + 0.5)) / 0.05);
const ROW1 = Math.ceil((90 - (COVER.south - 0.5)) / 0.05);

async function loadMonth(mm) {
  const path = `${CACHE}/chpclim.${mm}.tif`;
  if (!existsSync(path)) {
    console.log(`downloading CHPclim ${mm} (~32 MB)…`);
    const r = await fetch(URL(mm));
    if (!r.ok) throw new Error(`CHPclim ${mm}: HTTP ${r.status}`);
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  }
  const buf = readFileSync(path);
  if (buf.readUInt16LE(0) !== 0x4949) throw new Error('not little-endian TIFF');
  const ifd = buf.readUInt32LE(4);
  const n = buf.readUInt16LE(ifd);
  const tag = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const t = buf.readUInt16LE(e);
    const type = buf.readUInt16LE(e + 2);
    const count = buf.readUInt32LE(e + 4);
    const val = type === 3 && count === 1 ? buf.readUInt16LE(e + 8) : buf.readUInt32LE(e + 8);
    tag[t] = { type, count, val };
  }
  const w = tag[256].val;
  const h = tag[257].val;
  if (tag[259].val !== 5 || tag[278].val !== 1 || (tag[317]?.val ?? 1) !== 1) {
    throw new Error(`unexpected layout: compression ${tag[259].val}, rps ${tag[278].val}`);
  }
  const offAt = (k) => buf.readUInt32LE(tag[273].val + k * 4);
  const lenAt = (k) => buf.readUInt32LE(tag[279].val + k * 4);
  const rows = new Map();
  for (let r = Math.max(0, ROW0); r <= Math.min(h - 1, ROW1); r++) {
    const raw = lzw(buf.subarray(offAt(r), offAt(r) + lenAt(r)), w * 4);
    rows.set(r, new Float32Array(raw.buffer, raw.byteOffset, w));
  }
  return { rows, w };
}

console.log(`decoding CHPclim rows ${ROW0}–${ROW1} for ${MONTHS.length} months…`);
const monthGrids = [];
for (const mm of MONTHS) monthGrids.push(await loadMonth(mm));

/** June–September total at a point, mm. NaN over nodata. */
function mmpAt(lat, lon) {
  const col = Math.floor((lon + 180) / 0.05);
  const row = Math.floor((90 - lat) / 0.05);
  let sum = 0;
  for (const g of monthGrids) {
    const line = g.rows.get(row);
    const v = line ? line[col] : NaN;
    if (!(v >= 0)) return NaN; // nodata is a large negative
    sum += v;
  }
  return sum;
}

// A place with a famous answer each: Pokhara is one of the wettest towns in
// Asia, Jomsom sits in the trans-Himalayan rain shadow two ridges away.
console.log(
  `  probe — Pokhara ${mmpAt(28.21, 83.99).toFixed(0)} mm, ` +
    `Kathmandu ${mmpAt(27.7, 85.32).toFixed(0)} mm, Jomsom ${mmpAt(28.78, 83.72).toFixed(0)} mm`
);

// ---------------------------------------------------------------------------
// 2. Basins: identical machinery to build-hypsometry.mjs
// ---------------------------------------------------------------------------

const ZIP = `${CACHE}/hybas_as_lev12.zip`;
if (!existsSync(ZIP)) {
  console.log('downloading HydroBASINS level 12 Asia (~80 MB)…');
  const r = await fetch('https://data.hydrosheds.org/file/hydrobasins/standard/hybas_as_lev12_v1c.zip');
  if (!r.ok) throw new Error(`HydroBASINS: HTTP ${r.status}`);
  writeFileSync(ZIP, Buffer.from(await r.arrayBuffer()));
}

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
    const dataStart =
      localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

console.log('opening HydroBASINS…');
const files = unzip(readFileSync(ZIP));
const dbf = [...files].find(([n]) => n.toLowerCase().endsWith('.dbf'))[1];
const shp = [...files].find(([n]) => n.toLowerCase().endsWith('.shp'))[1];

function readDbf(buf) {
  const numRecords = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields = [];
  for (let p = 32; buf[p] !== 0x0d && p < headerLen; p += 32) {
    fields.push({ name: buf.toString('ascii', p, p + 11).replace(/\0.*$/, ''), len: buf[p + 16] });
  }
  const rows = new Array(numRecords);
  for (let i = 0; i < numRecords; i++) {
    let p = headerLen + i * recordLen + 1;
    const o = {};
    for (const f of fields) {
      o[f.name] = buf.toString('ascii', p, p + f.len).trim();
      p += f.len;
    }
    rows[i] = o;
  }
  return rows;
}

function readShp(buf, keep) {
  const polys = new Array(keep.length).fill(null);
  const wanted = new Set(keep);
  let off = 100;
  let rec = 0;
  while (off < buf.length) {
    const contentLen = buf.readInt32BE(off + 4) * 2;
    const body = off + 8;
    if (wanted.has(rec) && buf.readInt32LE(body) === 5) {
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
    off = body + contentLen;
    rec++;
  }
  return polys;
}

const rows = readDbf(dbf);
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
const geom = readShp(shp, inWindow);
const basins = inWindow.map((rec, i) => ({
  id: rows[rec].HYBAS_ID,
  next: rows[rec].NEXT_DOWN,
  sort: Number(rows[rec].SORT),
  rings: geom[i],
}));
console.log(`  ${basins.length} sub-basins in the window`);

const NX = Math.round((COVER.east - COVER.west) / STEP);
const NY = Math.round((COVER.north - COVER.south) / STEP);
const cellBasin = new Int32Array(NX * NY).fill(-1);
console.log(`rasterising ${NX} × ${NY} cells…`);
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

// ---------------------------------------------------------------------------
// 3. Area-weighted monsoon precipitation per basin, accumulated upstream
// ---------------------------------------------------------------------------

console.log('averaging monsoon precipitation over catchments…');
const nBasins = basins.length;
const areaSum = new Float64Array(nBasins);
const precipSum = new Float64Array(nBasins);
for (let row = 0; row < NY; row++) {
  const lat = COVER.south + (row + 0.5) * STEP;
  const w = Math.cos((lat * Math.PI) / 180);
  const base = row * NX;
  for (let c = 0; c < NX; c++) {
    const bi = cellBasin[base + c];
    if (bi < 0) continue;
    const p = mmpAt(lat, COVER.west + (c + 0.5) * STEP);
    if (!Number.isFinite(p)) continue;
    areaSum[bi] += w;
    precipSum[bi] += w * p;
  }
}

const byId = new Map(basins.map((b, i) => [b.id, i]));
const order = basins.map((_, i) => i).sort((a, b) => basins[b].sort - basins[a].sort);
const accArea = Float64Array.from(areaSum);
const accPrecip = Float64Array.from(precipSum);
for (const i of order) {
  const d = byId.get(basins[i].next);
  if (d === undefined) continue;
  accArea[d] += accArea[i];
  accPrecip[d] += accPrecip[i];
}
const mmp = Float64Array.from(accArea, (a, i) => (a > 0 ? accPrecip[i] / a : NaN));

{
  const v = [...mmp].filter(Number.isFinite).sort((a, b) => a - b);
  console.log(
    `  catchment MMP: median ${v[v.length >> 1].toFixed(0)} mm, ` +
      `5–95% ${v[Math.floor(v.length * 0.05)].toFixed(0)}–${v[Math.floor(v.length * 0.95)].toFixed(0)} mm`
  );
}

// ---------------------------------------------------------------------------
// 4. Attach per reach, preserving the existing hypsometry bytes
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

const old = readFileSync(HYPSO);
const stride = old.length === count * 4 ? 4 : 2;
if (old.length !== count * stride) throw new Error(`hypso file is ${old.length} bytes for ${count} reaches`);

const out = Buffer.alloc(count * 4);
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
  out[i * 4] = old[i * stride];
  out[i * 4 + 1] = old[i * stride + 1];
  const col = Math.floor((lastLon - COVER.west) / STEP);
  const row = Math.floor((lastLat - COVER.south) / STEP);
  let m = NaN;
  if (col >= 0 && col < NX && row >= 0 && row < NY) {
    const bi = cellBasin[row * NX + col];
    if (bi >= 0) m = mmp[bi];
  }
  const enc = Number.isFinite(m) ? Math.min(65534, Math.round(m)) : 0xffff;
  out.writeUInt16LE(enc, i * 4 + 2);
  if (enc !== 0xffff) attached++;
}

writeFileSync(HYPSO, out);
console.log(`wrote ${HYPSO}: ${count} reaches × 4 bytes, ${(out.length / 1024).toFixed(1)} KB`);
console.log(`  with MMP: ${attached} (${((attached / count) * 100).toFixed(1)}%)`);
