import assert from 'node:assert/strict';
import bundle from '../src/data/nepal-faults.json' with { type: 'json' };
import { faultsFor, type FaultTrace } from '../src/faults.ts';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}

const trace = (
  points: [number, number][],
  over: Partial<FaultTrace> = {}
): FaultTrace => ({
  id: 'test-1',
  sourceId: 'TEST_1',
  name: 'Test fault',
  type: 'Reverse',
  reference: 'synthetic test geometry',
  points,
  ...over,
});

console.log('\nregional active faults');

ok('snapshot is pinned, attributed and explicitly share-alike', () => {
  assert.equal(bundle._commit, '56816508ad92fd6846dad1163b1c8c01376a2cd1');
  assert.equal(bundle._sha256, '603513086b4693de6008e3444959995c34683b30dac291856340522a76d8505e');
  assert.equal(bundle._license, 'CC BY-SA 4.0');
  assert.match(bundle._attribution, /Styron.*Pagani/i);
  assert.equal(bundle._crs, 'EPSG:4326');
});

ok('Nepal-plus-buffer derivative contains 55 faults and excludes fold axes', () => {
  assert.equal(bundle._regionalStructureCount, 59);
  assert.equal(bundle._regionalFaultSourceCount, 55);
  assert.equal(bundle.traces.length, 55);
  assert.ok(bundle.traces.every((item) => !['Syncline', 'Anticline'].includes(item.type)));
  assert.ok(bundle.traces.every((item) => item.points.length >= 2));
  assert.ok(
    bundle.traces.every((item) =>
      item.points.every(([lon, lat]) => lon >= 79.5 && lon <= 89 && lat >= 25.5 && lat <= 31)
    )
  );
});

ok('Main Frontal Thrust remains named and referenced', () => {
  const mft = bundle.traces.filter((item) => item.name === 'Main Frontal Thrust');
  assert.equal(mft.length, 7);
  assert.ok(mft.every((item) => item.type === 'Reverse' && item.reference));
});

ok('perpendicular mapped-line crossing is exact and carries reach chainage', () => {
  const result = faultsFor(
    [
      { lat: 28, lon: 84, km: 10 },
      { lat: 28, lon: 84.1, km: 20 },
    ],
    50,
    [trace([[84.05, 27.9], [84.05, 28.1]])]
  );
  assert.equal(result.crossings, 1);
  assert.equal(result.nearest?.intersectsReach, true);
  assert.equal(result.nearest?.distanceKm, 0);
  assert.ok(Math.abs((result.nearest?.chainageKm ?? 0) - 5) < 1e-8);
  assert.ok(Math.abs((result.nearest?.nearestReachPoint.lon ?? 0) - 84.05) < 1e-8);
});

ok('collinear overlap is treated as an intersection', () => {
  const result = faultsFor(
    [
      { lat: 28, lon: 84 },
      { lat: 28, lon: 84.1 },
    ],
    50,
    [trace([[84.04, 28], [84.08, 28]])]
  );
  assert.equal(result.crossings, 1);
  assert.equal(result.nearest?.distanceKm, 0);
});

ok('parallel separation is measured locally, not in Web Mercator', () => {
  const result = faultsFor(
    [
      { lat: 28, lon: 84 },
      { lat: 28, lon: 84.1 },
    ],
    50,
    [trace([[84, 28.1], [84.1, 28.1]])]
  );
  assert.ok(result.nearest);
  assert.ok(Math.abs(result.nearest.distanceKm - 11.0574) < 0.02);
  assert.equal(result.nearest.intersectsReach, false);
});

ok('outside-radius nearest trace remains visible but is not a nearby hit', () => {
  const result = faultsFor(
    [
      { lat: 28, lon: 84 },
      { lat: 28, lon: 84.1 },
    ],
    5,
    [trace([[84, 28.1], [84.1, 28.1]])]
  );
  assert.ok(result.nearest && result.nearest.distanceKm > 5);
  assert.equal(result.nearby.length, 0);
  assert.equal(result.crossings, 0);
  assert.match(result.limitation, /not surveyed/i);
  assert.match(result.limitation, /not.*seismic design|or seismic design/i);
});

ok('invalid radius and empty reach fail safely', () => {
  assert.throws(() => faultsFor([{ lat: 28, lon: 84 }], 0), /positive/);
  const empty = faultsFor([{ lat: 28, lon: 84 }]);
  assert.equal(empty.nearest, null);
  assert.equal(empty.nearby.length, 0);
});

console.log(`\n${passed} fault checks passed\n`);
