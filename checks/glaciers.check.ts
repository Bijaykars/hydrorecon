/**
 * The glacier bundle, and the arithmetic on top of it.
 *
 *   node --experimental-strip-types --no-warnings checks/glaciers.check.ts
 *
 * `src/glaciers.ts` is small but it is the kind of small that goes wrong
 * quietly: a lazy fetch that can silently return nothing, a column order that
 * has to match a Python writer in another language, and a fraction that is only
 * meaningful if area and catchment are in the same units.
 *
 * The column order is the sharp edge. `pipeline/build-nepal-glaciers.py` writes
 * positional arrays to save 2 MB of repeated key names, and `glaciers.ts` reads
 * them back by index. Terminus type was already dropped from the middle of that
 * record once — it was 6,816 copies of "not assigned" — and every field after it
 * shifted by one. Nothing threw; the areas would simply have become surge codes.
 * So the shape is asserted against the bundle's own `_record` string, which the
 * builder writes from the same list it serialises.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const ok = (n: string, f: () => void) => {
  f();
  passed++;
  console.log(`  ok  ${n}`);
};

const bundle = JSON.parse(readFileSync('public/nepal-glaciers.json', 'utf8')) as {
  _record: string;
  _license: string;
  _counts: { glaciers: number; totalIceKm2: number };
  _simplification: { toleranceM: number; minAreaKm2: number; areaDriftPct: number };
  _extent: { latMin: number; latMax: number; lonMin: number; lonMax: number };
  glaciers: unknown[][];
};

ok('the bundle is where the app fetches it from, not in the JS bundle', () => {
  // A static import of this file would inline 2.4 MB into first paint. It lives
  // in public/ for that reason; if someone moves it back, this fails.
  assert.ok(bundle.glaciers.length > 6000, `only ${bundle.glaciers.length} glaciers`);
  let inSrc = false;
  try {
    readFileSync('src/data/nepal-glaciers.json');
    inSrc = true;
  } catch {
    inSrc = false;
  }
  assert.equal(inSrc, false, 'nepal-glaciers.json is back in src/data/ — it would be inlined into the bundle');
});

/** The reader indexes this array. If the writer reorders it, everything shifts. */
const RECORD = 'id, name, areaKm2, cenLat, cenLon, zminM, zmedM, zmaxM, surgeType, rings';

ok('the positional record still matches what glaciers.ts indexes', () => {
  assert.equal(bundle._record, RECORD, 'the builder changed the column order — src/glaciers.ts reads by index');
  assert.equal(RECORD.split(', ').length, 10);
  for (const g of bundle.glaciers.slice(0, 50)) assert.equal(g.length, 10, 'row width does not match the record');
});

ok('every row is the type its column says it is', () => {
  for (const g of bundle.glaciers.slice(0, 200)) {
    assert.equal(typeof g[0], 'string', 'id');
    assert.equal(typeof g[1], 'string', 'name (empty string, never null)');
    assert.ok(typeof g[2] === 'number' && (g[2] as number) > 0, 'areaKm2');
    assert.ok(typeof g[5] === 'number' && typeof g[7] === 'number', 'elevations');
    assert.ok(Array.isArray(g[9]) && (g[9] as unknown[]).length > 0, 'rings');
  }
});

ok('elevations are ordered zmin <= zmed <= zmax, so a range is never negative', () => {
  for (const g of bundle.glaciers) {
    const [zmin, zmed, zmax] = [g[5] as number, g[6] as number, g[7] as number];
    assert.ok(zmin <= zmed && zmed <= zmax, `${g[0]}: ${zmin}/${zmed}/${zmax}`);
  }
});

ok('every centroid sits inside the declared transboundary extent', () => {
  const e = bundle._extent;
  for (const g of bundle.glaciers) {
    const [lat, lon] = [g[3] as number, g[4] as number];
    assert.ok(lat >= e.latMin && lat <= e.latMax, `${g[0]} lat ${lat}`);
    assert.ok(lon >= e.lonMin && lon <= e.lonMax, `${g[0]} lon ${lon}`);
  }
});

ok('rings are [lon, lat] and closed enough to fill, not [lat, lon]', () => {
  // A transposed ring is the classic GeoJSON bug and it draws Nepal in Somalia.
  const e = bundle._extent;
  for (const g of bundle.glaciers.slice(0, 300)) {
    for (const ring of g[9] as number[][][]) {
      assert.ok(ring.length >= 4, `${g[0]} ring of ${ring.length}`);
      for (const [lon, lat] of ring.slice(0, 4)) {
        assert.ok(lon >= e.lonMin - 0.2 && lon <= e.lonMax + 0.2, `${g[0]} ring lon ${lon} — transposed?`);
        assert.ok(lat >= e.latMin - 0.2 && lat <= e.latMax + 0.2, `${g[0]} ring lat ${lat} — transposed?`);
      }
    }
  }
});

ok('simplification is declared and has not silently eaten the ice', () => {
  assert.ok(bundle._simplification.toleranceM <= 100, 'tolerance loosened past what the tongues survive');
  assert.ok(
    Math.abs(bundle._simplification.areaDriftPct) < 3,
    `outline area drifted ${bundle._simplification.areaDriftPct}% — use areaKm2, and re-check the tolerance`
  );
});

ok('the licence is the one that let this ship', () => {
  assert.equal(bundle._license, 'CC-BY-4.0');
});

/**
 * The published total. RGI's own areas sum to about 8,016 km2 over these three
 * basins; a wildly different figure means the extent or the minimum-area filter
 * moved and every glacierised fraction moved with it.
 */
ok('the total ice is the published total', () => {
  const summed = bundle.glaciers.reduce((t, g) => t + (g[2] as number), 0);
  assert.ok(Math.abs(summed - bundle._counts.totalIceKm2) < 1, `summed ${summed} vs stated ${bundle._counts.totalIceKm2}`);
  assert.ok(summed > 7000 && summed < 9000, `${summed} km2 of ice is not the ~8,016 these basins hold`);
});

console.log(`\nglaciers: ${passed} checks passed`);
