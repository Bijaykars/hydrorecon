import assert from 'node:assert/strict';
import raw from '../src/data/nepal-hazards.json' with { type: 'json' };
import {
  BIPAD_PERIOD,
  BIPAD_RECORD_COUNT,
  BIPAD_RETRIEVED,
  hazardsFor,
  pointToPathKm,
} from '../src/hazards.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('\nNepal BIPAD hazard incidents');

ok('the national snapshot is current, substantial and explicitly dated', () => {
  assert.equal(BIPAD_RECORD_COUNT, 9102);
  assert.equal(BIPAD_RETRIEVED, '2026-08-13');
  assert.equal(BIPAD_PERIOD.from, '2011-05-14');
  assert.equal(BIPAD_PERIOD.to, '2026-08-12');
});

ok('the privacy allow-list leaves only id, date, latitude and longitude per record', () => {
  const bundle = raw as any;
  assert.match(bundle._source, /^https:\/\/bipadportal\.gov\.np\/api\/v1\/incident\/$/);
  assert.match(bundle._crs, /EPSG:4326/);
  assert.deepEqual(
    bundle.categories.map((category: any) => category.slug),
    ['landslide', 'flood', 'earthquake', 'glof', 'avalanche', 'inundation']
  );
  for (const category of bundle.categories) {
    assert.deepEqual(
      Object.keys(category).sort(),
      ['id', 'records', 'rejected', 'slug', 'title'].sort()
    );
    for (const record of category.records) {
      assert.equal(record.length, 4, 'upstream fields must never be spread into the bundle');
      assert.ok(Number.isSafeInteger(record[0]) && record[0] > 0);
      assert.match(record[1], /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(record[2] >= 26 && record[2] <= 31);
      assert.ok(record[3] >= 80 && record[3] <= 89);
    }
  }
});

ok('local projected point-to-line distance recognises a point on the middle of a reach', () => {
  const path = [
    { lat: 28, lon: 84 },
    { lat: 28, lon: 84.2 },
  ];
  assert.ok(pointToPathKm({ lat: 28, lon: 84.1 }, path) < 0.001);
  assert.ok(Math.abs(pointToPathKm({ lat: 28.1, lon: 84.1 }, path) - 11.06) < 0.1);
});

ok('a known BIPAD landslide is discovered at its mapped point', () => {
  const screen = hazardsFor([{ lat: 27.60988, lon: 87.82613 }], 1);
  const hit = screen.records.find((record) => record.id === 372);
  assert.ok(hit, 'BIPAD incident 372 should be inside its own 1 km screen');
  assert.ok(hit.distanceKm < 0.001);
  assert.equal(hit.kind, 'landslide');
  assert.match(hit.url, /bipadportal\.gov\.np\/incidents\/372\/response$/);
});

ok('category zeroes remain explicit without being called hazard absence', () => {
  const screen = hazardsFor([], 15);
  assert.equal(screen.total, 0);
  assert.equal(screen.categories.length, 6);
  assert.ok(screen.categories.every((category) => category.count === 0));
  assert.match(screen.limitation, /no-record is not no-hazard/i);
  assert.equal(screen.categories.find((category) => category.kind === 'glof')?.nationwideRecords, 0);
});

ok('a corridor never returns a point beyond its declared radius', () => {
  const screen = hazardsFor([{ lat: 28.2096, lon: 83.9856 }], 15);
  assert.ok(screen.records.every((record) => record.distanceKm <= 15));
  assert.equal(screen.total, screen.categories.reduce((sum, category) => sum + category.count, 0));
});

ok('invalid radii fail instead of producing an unbounded query', () => {
  assert.throws(() => hazardsFor([{ lat: 28, lon: 84 }], 0), /positive/);
});

console.log(`\n${passed} hazard checks passed\n`);
