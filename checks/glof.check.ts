/**
 * The GLOF danger filter, which once could not fire at all.
 *
 *   node --experimental-strip-types --no-warnings checks/glof.check.ts
 *
 * `glofDangerSignals` decides whether the report warns about an upstream glacial
 * lake. The version before it filtered on `areaHa ?? areaKm2 * 100 ?? 0` through
 * an `as unknown as` cast, and `ConnectedGlacialLake` has neither field — the
 * builder keeps centroids and drops the polygons. Area was 0 on every lake, so
 * the risky set was empty on every site and the report printed "none is both
 * large and close" whatever sat upstream.
 *
 * It survived because the SAFE branch is what renders on almost every site, and
 * a hazard screen that always says "safe" looks exactly like a site that is.
 * These cases exist so the dangerous branch is exercised on every run, not only
 * when a dangerous site happens to be opened.
 */
import assert from 'node:assert/strict';
import { glofDangerSignals, GLOF_ROUTE_KM } from '../src/report.ts';
import type { ConnectedGlacialLake } from '../src/connectivity.ts';

let passed = 0;
const ok = (n: string, f: () => void) => {
  f();
  passed++;
  console.log(`  ok  ${n}`);
};

const lake = (over: Partial<ConnectedGlacialLake> = {}): ConnectedGlacialLake =>
  ({
    id: 'GLO_TEST',
    country: 'Nepal',
    basin: 'Koshi',
    connectivity: 'Glacier-fed',
    elevationM: 4800,
    expansionRateKm2Yr: null,
    expansionUncertaintyKm2Yr: null,
    expansionSignificant: null,
    timeSeriesOutlier: null,
    lat: 28.1,
    lon: 86.5,
    pdgl: null,
    snapKm: 0.4,
    snapped: { lat: 28.1, lon: 86.5 },
    routeKm: 20,
    route: [],
    routeGeometryIncluded: true,
    ...over,
  }) as ConnectedGlacialLake;

ok('THE REGRESSION: an ICIMOD-listed lake upstream must warn', () => {
  const r = glofDangerSignals([lake({ pdgl: { rank: 1, name: 'Tsho Rolpa' }, routeKm: 22 })]);
  assert.equal(r.risky.length, 1, 'the screen failed OPEN — this is the bug it was written for');
  assert.equal(r.listed.length, 1);
  assert.equal(r.listed[0].pdgl?.name, 'Tsho Rolpa');
});

ok('a glacier-fed lake with a significant expansion trend warns', () => {
  const r = glofDangerSignals([
    lake({ expansionSignificant: true, expansionRateKm2Yr: 0.004, timeSeriesOutlier: false }),
  ]);
  assert.equal(r.growing.length, 1);
  assert.equal(r.risky.length, 1);
});

ok('distance is a cut, not a suggestion: a listed lake beyond the route cap does not warn', () => {
  const r = glofDangerSignals([
    lake({ pdgl: { rank: 1, name: 'Far Lake' }, routeKm: GLOF_ROUTE_KM + 1 }),
  ]);
  assert.equal(r.risky.length, 0);
});

ok('a NON glacier-fed lake never enters on an expansion trend alone', () => {
  const r = glofDangerSignals([
    lake({ connectivity: 'Non Glacier-fed', expansionSignificant: true, expansionRateKm2Yr: 0.004 }),
  ]);
  assert.equal(r.risky.length, 0, 'the outburst mechanism is not there');
});

ok('a trend the SOURCE flags as an outlier is not our evidence to use', () => {
  const r = glofDangerSignals([
    lake({ expansionSignificant: true, expansionRateKm2Yr: 0.004, timeSeriesOutlier: true }),
  ]);
  assert.equal(r.risky.length, 0);
});

ok('a SHRINKING glacier-fed lake does not warn', () => {
  const r = glofDangerSignals([
    lake({ expansionSignificant: true, expansionRateKm2Yr: -0.004, timeSeriesOutlier: false }),
  ]);
  assert.equal(r.risky.length, 0);
});

ok('a listed lake is counted once, as listed, never in both buckets', () => {
  const r = glofDangerSignals([
    lake({ pdgl: { rank: 2, name: 'Both' }, expansionSignificant: true, expansionRateKm2Yr: 0.01 }),
  ]);
  assert.equal(r.listed.length, 1);
  assert.equal(r.growing.length, 0);
  assert.equal(r.risky.length, 1);
});

ok('an ordinary mapped lake upstream is not a warning', () => {
  const r = glofDangerSignals([lake(), lake({ id: 'GLO_B', routeKm: 5 })]);
  assert.equal(r.risky.length, 0);
});

ok('an empty upstream is empty, not a crash', () => {
  const r = glofDangerSignals([]);
  assert.deepEqual([r.listed.length, r.growing.length, r.risky.length], [0, 0, 0]);
});

ok('mixed upstream: only the two that qualify come back', () => {
  const r = glofDangerSignals([
    lake({ id: 'a', pdgl: { rank: 1, name: 'Listed' }, routeKm: 12 }),
    lake({ id: 'b', expansionSignificant: true, expansionRateKm2Yr: 0.002, routeKm: 55 }),
    lake({ id: 'c', routeKm: 3 }),
    lake({ id: 'd', pdgl: { rank: 3, name: 'TooFar' }, routeKm: 200 }),
    lake({ id: 'e', connectivity: 'Non Glacier-fed', expansionSignificant: true, expansionRateKm2Yr: 1 }),
  ]);
  assert.deepEqual(r.risky.map((l) => l.id).sort(), ['a', 'b']);
});

console.log(`\nglof: ${passed} checks passed`);
