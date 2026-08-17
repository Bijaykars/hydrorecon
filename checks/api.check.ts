import assert from 'node:assert/strict';
import {
  completeCalendarYears,
  DEM_TILE_TIMEOUT_MS,
  demAnalysisZoom,
  settleWithin,
} from '../src/api.ts';

let passed = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const year = (y: number, days: number, offset = 0) => {
  const start = Date.UTC(y, 0, 1);
  return Array.from({ length: days }, (_, k) => ({
    date: new Date(start + k * 864e5).toISOString().slice(0, 10),
    value: offset + k,
  }));
};

console.log('\nflow API record coverage');

await ok('partial calendar years cannot bias the flow-duration curve', () => {
  const rows = [...year(2019, 365), ...year(2020, 200, 10_000), ...year(2021, 365, 20_000)];
  const got = completeCalendarYears(rows.map((x) => x.date), rows.map((x) => x.value), 1);
  assert.deepEqual(got.years, [2019, 2021]);
  assert.equal(got.values.length, 730);
  assert.ok(!got.dates.some((d) => d.startsWith('2020-')));
});

await ok('a leap year requires its leap day when exact coverage is requested', () => {
  const rows = [...year(2020, 365), ...year(2024, 366, 1000)];
  const got = completeCalendarYears(rows.map((x) => x.date), rows.map((x) => x.value), 1);
  assert.deepEqual(got.years, [2024]);
});

await ok('dates and discharge values remain aligned after trimming', () => {
  const rows = [...year(2022, 50, -500), ...year(2023, 365, 30_000)];
  const got = completeCalendarYears(rows.map((x) => x.date), rows.map((x) => x.value), 1);
  assert.equal(got.dates[0], '2023-01-01');
  assert.equal(got.values[0], 30_000);
  assert.equal(got.dates.at(-1), '2023-12-31');
  assert.equal(got.values.at(-1), 30_364);
});

await ok('a stalled terrain request resolves to its fallback before the late response', async () => {
  const started = Date.now();
  const late = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));
  const got = await settleWithin(late, 20, 'fallback');
  assert.equal(got, 'fallback');
  assert.ok(Date.now() - started < 150);
});

await ok('a healthy terrain request keeps its real response', async () => {
  assert.equal(await settleWithin(Promise.resolve('tile'), 100, 'fallback'), 'tile');
});

await ok('Nepal profiles stop zooming once 30 m terrain is actually resolved', () => {
  assert.equal(demAnalysisZoom(512, 17, 30, 28.67), 12);
  assert.equal(demAnalysisZoom(256, 15, 30, 28.67), 13);
});

await ok('the terrain deadline tolerates a normal multi-tile public-host response', () => {
  assert.ok(DEM_TILE_TIMEOUT_MS >= 6000);
  assert.ok(DEM_TILE_TIMEOUT_MS <= 10_000);
});

console.log(`\n${passed} flow-coverage checks passed\n`);
