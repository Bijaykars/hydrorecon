/**
 * Land cover along an alignment, on a raster whose answer is known in advance.
 *
 * The store itself is 598 MB of ESA WorldCover and cannot be a unit fixture, so
 * this stubs the two routes with a synthetic raster: a 10x10 grid, forest on
 * the left half, cropland on the right, one no-data cell. A line crossing the
 * boundary then has an arithmetic answer, and the accounting either reproduces
 * it or it does not.
 *
 * What this is guarding is the accounting, not the data. Kilometres attributed
 * to the wrong class, a double-counted vertex, or a no-data cell quietly
 * counted as ground would each produce a plausible-looking forest figure that
 * a reader would act on.
 */
import assert from 'node:assert/strict';

// ~1 km cells. The module samples every 30 m, so a cell holds about 32 samples
// and a boundary lands within a thirtieth of a cell. At 0.001 deg — one tenth
// of this — a two-cell line was only seven samples long and a boundary falling
// exactly on a sample put the split at 4/7 rather than 1/2, which is the
// fixture quantising, not the accounting failing.
const CELL = 0.01;
const N = 10;
const WEST = 85.0;
const NORTH = 28.0;
const TREE = 10;
const CROP = 40;

/** Left half forest, right half cropland, one hole at row 0 column 9. */
const grid = new Uint8Array(N * N);
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) grid[r * N + c] = c < N / 2 ? TREE : CROP;
}
grid[0 * N + 9] = 0;

const meta = {
  _what: 'synthetic',
  _source: 'test fixture',
  _limitation: 'none',
  rows: N,
  cols: N,
  pixelDeg: CELL,
  west: WEST,
  north: NORTH,
  east: WEST + N * CELL,
  south: NORTH - N * CELL,
  nodata: 0,
  nativeM: 10,
  cellM: 30,
  classes: { '10': 'Tree cover', '40': 'Cropland' },
};

globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  if (u.startsWith('/worldcover/meta')) {
    return new Response(JSON.stringify(meta), { status: 200 });
  }
  if (u.startsWith('/worldcover/window')) {
    const q = new URLSearchParams(u.split('?')[1] ?? '');
    const num = (k: string) => Number(q.get(k));
    const [row0, col0, rows, cols] = ['row0', 'col0', 'rows', 'cols'].map(num);
    const out = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) out[r * cols + c] = grid[(row0 + r) * N + (col0 + c)];
    }
    return new Response(out, { status: 200 });
  }
  return new Response('', { status: 404 });
}) as typeof fetch;

const { screenLandcover, TREE_COVER, CROPLAND } = await import('../src/landcover.ts');

let passed = 0;
const ok = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('\nland cover along the alignment');

// Row 5 (lat just under 28.0 - 5*CELL), running west to east across the
// forest/crop boundary at column 5.
const midLat = NORTH - 5.5 * CELL;
const line = (lon0: number, lon1: number) => [
  { lat: midLat, lon: WEST + lon0 * CELL },
  { lat: midLat, lon: WEST + lon1 * CELL },
];

await ok('a line wholly inside one class is wholly attributed to it', async () => {
  const r = await screenLandcover(line(0.5, 4.5));
  assert.ok(r, 'no screen returned');
  assert.equal(r.along.length, 1);
  assert.equal(r.along[0].code, TREE_COVER);
  assert.ok(Math.abs(r.along[0].share - 1) < 1e-9, `share was ${r.along[0].share}`);
});

await ok('a line crossing the boundary splits in the right proportion', async () => {
  // Columns 1..9 : four cells of forest, five of cropland.
  const r = await screenLandcover(line(1, 10));
  assert.ok(r);
  const tree = r.along.find((a) => a.code === TREE_COVER)!;
  const crop = r.along.find((a) => a.code === CROPLAND)!;
  assert.ok(Math.abs(tree.share - 4 / 9) < 0.02, `forest share ${tree.share}`);
  assert.ok(Math.abs(crop.share - 5 / 9) < 0.02, `cropland share ${crop.share}`);
  // The two shares must exhaust the line: a class silently dropped would still
  // leave each individual share looking reasonable.
  assert.ok(Math.abs(tree.share + crop.share - 1) < 1e-9);
});

await ok('kilometres sum to the length of the line, not to the cell count', async () => {
  const r = await screenLandcover(line(1, 10));
  assert.ok(r);
  const summed = r.along.reduce((a, b) => a + b.km, 0);
  assert.ok(Math.abs(summed - r.waterwayKm) < 1e-9, `${summed} vs ${r.waterwayKm}`);
  // 9 cells of longitude at 28 N.
  const expectedKm = 9 * CELL * 111.32 * Math.cos((28 * Math.PI) / 180);
  assert.ok(Math.abs(r.waterwayKm - expectedKm) / expectedKm < 0.01, `${r.waterwayKm} km`);
});

await ok('no-data is reported as unknown, never as ground', async () => {
  // Row 0 columns 8..10 is one cropland cell and one hole.
  const topLat = NORTH - 0.5 * CELL;
  const r = await screenLandcover([
    { lat: topLat, lon: WEST + 8 * CELL },
    { lat: topLat, lon: WEST + 10 * CELL },
  ]);
  assert.ok(r);
  assert.ok(Math.abs(r.unknownShare - 0.5) < 0.02, `unknown share ${r.unknownShare}`);
  // The hole must not appear as a class, and must not be counted as cropland.
  assert.equal(r.along.length, 1);
  assert.equal(r.along[0].code, CROPLAND);
});

await ok('the ends are read where the structures go, not at the bounding box', async () => {
  const r = await screenLandcover(line(1, 9));
  assert.ok(r);
  assert.equal(r.intake, 'Tree cover');
  assert.equal(r.powerhouse, 'Cropland');
});

await ok('a path outside the store is refused rather than answered', async () => {
  const r = await screenLandcover([
    { lat: 10, lon: 10 },
    { lat: 10.01, lon: 10.01 },
  ]);
  assert.equal(r, null);
});

console.log(`\n${passed} land-cover checks passed`);
