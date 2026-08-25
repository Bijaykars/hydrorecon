/**
 * Design-level seismic hazard for Nepal, from the GEM global model.
 *
 *   node pipeline/build-pga.mjs
 *
 * WHY: fault-trace distance is orientation, not a design input. What a
 * feasibility memo actually quotes is peak ground acceleration at a return
 * period — and the GEM Global Seismic Hazard Map v2023 publishes exactly that:
 * PGA on rock at 475-year return (10% in 50 years), the reference case of
 * nearly every building code including Nepal's NBC 105.
 *
 * SOURCE: GEM-GSHM_PGA-475y-rock_v2023 (Zenodo 8409647), CC BY-NC-SA 4.0.
 * Private, non-commercial use. The GeoTIFF is a plain uncompressed float64
 * grid at 0.05 degrees (~5.5 km), one row per strip, which this reads
 * directly — no GIS stack, no decompression.
 *
 * WHAT THE NUMBER IS NOT: site-specific. It is on rock; soft valley sediment
 * amplifies shaking well beyond it (Kathmandu 2015 proved that), and a real
 * design uses a site response study. Said in the app wherever it shows.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'sources/gem-pga/v2023_1_pga_475_rock_3min.tif';
const OUT = 'src/data/nepal-pga.json';

// Window: all of Nepal with a margin.
const LAT0 = 31.0; // north edge
const LAT1 = 26.0; // south edge
const LON0 = 79.5;
const LON1 = 88.5;

const b = readFileSync(SRC);
if (b.readUInt16LE(0) !== 0x4949) throw new Error('expected little-endian TIFF');
const ifd = b.readUInt32LE(4);
const nTags = b.readUInt16LE(ifd);
const tags = {};
for (let i = 0; i < nTags; i++) {
  const o = ifd + 2 + i * 12;
  tags[b.readUInt16LE(o)] = { type: b.readUInt16LE(o + 2), count: b.readUInt32LE(o + 4), value: b.readUInt32LE(o + 8) };
}
const width = tags[256].value;
const height = tags[257].value;
if (tags[259].value !== 1 || tags[258].value !== 64 || tags[278].value !== 1) {
  throw new Error('layout changed — expected uncompressed float64, one row per strip');
}
// Grid origin and cell size from the GeoTIFF tie point.
const scaleOff = tags[33550].value;
const dLon = b.readDoubleLE(scaleOff);
const dLat = b.readDoubleLE(scaleOff + 8);
const tieOff = tags[33922].value;
const west = b.readDoubleLE(tieOff + 24);
const north = b.readDoubleLE(tieOff + 32);

const stripOffsets = tags[273];
const stripAt = (row) => b.readUInt32LE(stripOffsets.value + row * 4);

const row0 = Math.max(0, Math.floor((north - LAT0) / dLat));
const row1 = Math.min(height - 1, Math.ceil((north - LAT1) / dLat));
const col0 = Math.max(0, Math.floor((LON0 - west) / dLon));
const col1 = Math.min(width - 1, Math.ceil((LON1 - west) / dLon));
const rows = row1 - row0 + 1;
const cols = col1 - col0 + 1;

/** PGA in thousandths of g — integer, compact, and finer than the model's own accuracy. */
const data = new Array(rows * cols);
let nodata = 0;
for (let r = 0; r < rows; r++) {
  const strip = stripAt(row0 + r);
  for (let c = 0; c < cols; c++) {
    const v = b.readDoubleLE(strip + (col0 + c) * 8);
    if (!Number.isFinite(v) || v > 1e300 || v < 0) {
      data[r * cols + c] = -1;
      nodata++;
    } else {
      data[r * cols + c] = Math.round(v * 1000);
    }
  }
}

const out = {
  _source: 'GEM Global Seismic Hazard Map v2023.1, PGA 475-year return on rock. CC BY-NC-SA 4.0.',
  _url: 'https://doi.org/10.5281/zenodo.8409646',
  _retrieved: new Date().toISOString().slice(0, 10),
  _units: 'thousandths of g; -1 = no data',
  lat0: north - row0 * dLat, // north edge of first cell row
  lon0: west + col0 * dLon, // west edge of first cell column
  dLat,
  dLon,
  rows,
  cols,
  data,
};
const json = JSON.stringify(out);
writeFileSync(OUT, json);

// Self-check against published values: GEM's own map puts Kathmandu around
// 0.3–0.6 g and the western Nepal seismic gap higher than the east.
const at = (lat, lon) => {
  const r = Math.floor((out.lat0 - lat) / dLat);
  const c = Math.floor((lon - out.lon0) / dLon);
  return data[r * cols + c] / 1000;
};
const ktm = at(27.7, 85.32);
const west1 = at(29.3, 81.2);
const east1 = at(27.1, 87.3);
console.log(`wrote ${OUT}: ${(json.length / 1024).toFixed(1)} KB, ${rows}x${cols} cells, ${nodata} nodata`);
console.log(`  Kathmandu ${ktm} g · far-west ${west1} g · east ${east1} g`);
if (!(ktm > 0.2 && ktm < 0.8)) throw new Error(`Kathmandu PGA ${ktm} g is outside any published range — check indexing`);
