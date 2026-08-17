/** Official Nepal DoED register integrity and spatial conflict screening. */
import assert from 'node:assert/strict';
import raw from '../src/data/doed-projects.json' with { type: 'json' };
import { DOED_RETRIEVED, DOED_UPDATED, licencesAlong, loadLicences, type Licence } from '../src/context.ts';

let passed = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

type Registry = {
  _source: string; _retrieved: string; _updated: string; _privacy: string;
  pages: { url: string; records: number; usableCoordinates: number }[];
  projects: {
    name: string; promoter: string; stage: string; source: string;
    lat: number | null; lon: number | null;
    bounds: [number, number, number, number] | null;
  }[];
};
const registry = raw as unknown as Registry;

console.log('\ncontext: official DoED hydropower register');

await ok('all nine official hydro tables are present and dated', () => {
  assert.equal(registry.pages.length, 9);
  assert.match(registry._source, /Department of Electricity Development/);
  assert.match(registry._retrieved, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(registry._updated, /^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  assert.equal(DOED_RETRIEVED, registry._retrieved);
  assert.equal(DOED_UPDATED, registry._updated);
  for (const page of registry.pages) {
    assert.match(page.url, /^https:\/\/doed\.gov\.np\/pages\/[a-z0-9]+\/$/);
    assert.ok(page.records > 0, `${page.url}: empty table`);
  }
});

await ok('page counts reconcile exactly with the bundled records', () => {
  const total = registry.pages.reduce((sum, p) => sum + p.records, 0);
  const geolocated = registry.pages.reduce((sum, p) => sum + p.usableCoordinates, 0);
  assert.equal(registry.projects.length, total);
  assert.equal(registry.projects.filter((p) => p.lat !== null).length, geolocated);
  assert.ok(total > 1100, `only ${total} official records`);
});

await ok('coordinates retain and sit inside DoED published ranges', () => {
  for (const p of registry.projects) {
    assert.ok(p.name, 'project without a name');
    if (p.lat === null || p.lon === null) {
      assert.equal(p.bounds, null);
      continue;
    }
    assert.ok(p.bounds, `${p.name}: point without published bounds`);
    const [south, west, north, east] = p.bounds!;
    assert.ok(p.lat >= south && p.lat <= north, `${p.name}: latitude outside range`);
    assert.ok(p.lon >= west && p.lon <= east, `${p.name}: longitude outside range`);
    assert.ok(p.lat > 26 && p.lat < 31 && p.lon > 80 && p.lon < 89, `${p.name}: outside Nepal`);
  }
});

await ok('all official lifecycle categories are represented', () => {
  const stages = new Set(registry.projects.map((p) => p.stage));
  assert.deepEqual(stages, new Set([
    'Survey licence', 'Construction licence', 'Operating',
    'Survey application', 'Construction application',
  ]));
  assert.ok(
    registry.projects.some((p) => p.name === 'Madhya Marsyangdi' && p.stage === 'Operating'),
    'known operating Marsyangdi plant is absent'
  );
});

await ok('contact details are excluded from the public bundle', () => {
  assert.match(registry._privacy, /omitted/i);
  const text = JSON.stringify(registry.projects.map((p) => p.promoter));
  for (const pattern of [
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
    /(?<!\d)9[678]\d{8}(?!\d)/,
    /(?<!\d)0?1[- ]?\d{7}(?!\d)/,
  ]) {
    const hit = pattern.exec(text);
    assert.ok(!hit, `contact detail in promoter field: ${hit?.[0]}`);
  }
});

const fixture = (over: Partial<Omit<Licence, 'distanceKm'>>): Omit<Licence, 'distanceKm'> => ({
  name: 'Test HEP', river: 'Test', district: 'Test', capacityMW: 10, promoter: 'Test Energy',
  stage: 'Survey application', licenceNo: '1', issued: '2082-01-01', validUntil: null,
  commissioned: null, lat: 28, lon: 84.5, bounds: [27.99, 84, 28.01, 85],
  source: 'https://doed.gov.np/pages/appslhydromorethan1/', ...over,
});

await ok('proximity uses the published range, not a misleading midpoint', () => {
  const hits = licencesAlong([fixture({})], [{ lat: 28, lon: 84.01 }], 1);
  assert.equal(hits.length, 1, 'a range crossing the reach was missed');
  assert.equal(hits[0].distanceKm, 0, 'point inside the published range must be zero away');
});

await ok('operating and construction conflicts sort ahead of applications', () => {
  const path = [{ lat: 28, lon: 84.01 }];
  const hits = licencesAlong([
    fixture({ name: 'Nearby application', stage: 'Survey application', bounds: [28, 84.01, 28, 84.01], lat: 28, lon: 84.01 }),
    fixture({ name: 'Operating plant', stage: 'Operating', bounds: [28, 84.02, 28, 84.02], lat: 28, lon: 84.02 }),
  ], path, 2);
  assert.equal(hits[0].name, 'Operating plant');
});

await ok('the offline loader returns every geolocated official record', async () => {
  const projects = await loadLicences();
  assert.equal(projects.length, registry.projects.filter((p) => p.lat !== null).length);
});

console.log(`\n${passed} DoED context checks passed\n`);
