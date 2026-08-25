import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CASCADE_MAX_ROUTE_KM,
  CASCADE_MAX_SNAP_KM,
  CASCADE_ROUTE_GEOMETRY_LIMIT,
  canonicalDoedProjects,
  cascadeFor,
  doedProjectKey,
  isAdvancedDoedStage,
} from '../src/cascade.ts';
import { licencesAlong, loadLicences, type DoedProject } from '../src/context.ts';
import { downstreamPath } from '../src/rivers.ts';

let passed = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('\nDoED directed project and cascade candidates');

const project = (over: Partial<DoedProject> = {}): DoedProject => ({
  name: 'Test Project',
  river: 'Test Khola',
  district: 'Test',
  capacityMW: 10,
  promoter: 'Test',
  stage: 'Survey application',
  licenceNo: 'TEST',
  issued: '2020-01-01',
  validUntil: null,
  commissioned: null,
  lat: 28,
  lon: 84,
  bounds: [27.99, 83.99, 28.01, 84.01],
  source: 'https://doed.gov.np/',
  ...over,
});

await ok('canonicalization keeps the most advanced lifecycle row without merging different capacities', () => {
  const canonical = canonicalDoedProjects([
    project({ stage: 'Survey application', licenceNo: 'A' }),
    project({ stage: 'Construction licence', licenceNo: 'B', issued: '2024-01-01' }),
    project({ capacityMW: 11, licenceNo: 'C' }),
  ]);
  assert.equal(canonical.length, 2);
  assert.equal(canonical.find((row) => row.capacityMW === 10)?.stage, 'Construction licence');
  assert.equal(doedProjectKey(canonical[0]).includes('|'), true);
  assert.equal(isAdvancedDoedStage('Operating'), true);
  assert.equal(isAdvancedDoedStage('Survey licence'), false);
});

await ok('the official bundle has a stable, explicit duplicate-lifecycle audit', async () => {
  const all = await loadLicences();
  const canonical = canonicalDoedProjects(all);
  assert.equal(all.length, 1169);
  /**
   * ONE collapse, not two.
   *
   * Keying on name and capacity alone merged two genuinely different survey
   * applications — licence 10327 (Nicholas Energy, Lapha Gad) and 10403
   * (Namaste Energy, Lapatgad), both "Laphagad Hydropower Project, 4.6 MW" —
   * and quietly deleted one from every cascade and neighbour screen. Adding the
   * river to the key keeps them apart while still collapsing the one real
   * lifecycle pair, Isuwa Pror Cascade-2 moving from survey to construction.
   */
  assert.equal(canonical.length, 1168);
  assert.equal(all.length - canonical.length, 1);
  assert.equal(new Set(canonical.map(doedProjectKey)).size, canonical.length);

  // The two Laphagad applications must both survive, on their own licences.
  const laphagad = canonical.filter((p) => /laphagad/i.test(p.name));
  assert.equal(laphagad.length, 2, 'two distinct Laphagad applications must not be merged');
  assert.equal(new Set(laphagad.map((p) => p.licenceNo)).size, 2);
});

await ok('the bundled directed screen separates direct, upstream and downstream records', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('nepal-rivers.dat') || url.endsWith('nepal-hypso.dat')) {
      const name = url.split('/').at(-1)!;
      return new Response(await readFile(new URL(`../public/${name}`, import.meta.url)), { status: 200 });
    }
    return originalFetch(input, init);
  };
  try {
    const all = await loadLicences();
    const path = await downstreamPath(27.97, 83.55, 22);
    assert.ok(path && path.length > 100);
    const intakeIndex = 3;
    const powerIndex = Math.max(10, Math.floor(path.length * 0.7));
    const direct = licencesAlong(all, path.slice(intakeIndex, powerIndex + 1));
    const screen = await cascadeFor(
      { intake: path[intakeIndex], power: path[powerIndex] },
      all,
      direct
    );
    assert.ok(screen);
    assert.ok(screen.upstream.length > 50, 'a high-order Kali Gandaki reach should discover many upstream candidates');
    assert.ok(screen.downstream.length > 0);
    assert.equal(screen.registry.geolocatedRecords, 1169);
    assert.equal(screen.registry.canonicalRecords, 1168);
    assert.equal(screen.directReachRecords, direct.length);
    const directKeys = new Set(direct.map(doedProjectKey));
    const candidates = [...screen.upstream, ...screen.downstream];
    assert.ok(candidates.every((candidate) => !directKeys.has(doedProjectKey(candidate))));
    assert.ok(screen.upstream.every((candidate) => candidate.direction === 'upstream'));
    assert.ok(screen.downstream.every((candidate) => candidate.direction === 'downstream'));
    assert.ok(candidates.every((candidate) => candidate.snapKm <= CASCADE_MAX_SNAP_KM));
    assert.ok(candidates.every((candidate) => candidate.routeKm <= CASCADE_MAX_ROUTE_KM));
    assert.equal(
      candidates.filter((candidate) => candidate.routeGeometryIncluded).length,
      CASCADE_ROUTE_GEOMETRY_LIMIT
    );
    assert.ok(candidates.filter((candidate) => !candidate.routeGeometryIncluded).every((candidate) => candidate.route.length === 0));
    assert.match(screen.limitation, /does not prove shared water.*legal overlap.*cascade operation/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`\n${passed} cascade checks passed\n`);
