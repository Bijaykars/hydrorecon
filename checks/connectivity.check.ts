import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import raw from '../src/data/nepal-glacial-lakes.json' with { type: 'json' };
import {
  GLACIAL_LAKE_COUNT,
  GLACIAL_LAKE_RETRIEVED,
  glacialLakeInventory,
} from '../src/glacial-lakes.ts';
import {
  ROUTE_GEOMETRY_LIMIT,
  upstreamConnectivityFor,
} from '../src/connectivity.ts';
import {
  traceDirectedConnection,
  type DirectedNetworkAdapter,
} from '../src/rivers.ts';

let passed = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('\nupstream lake and incident connectivity');

await ok('the GLO snapshot is current, attributed and exactly reproducible', () => {
  const inventory = glacialLakeInventory();
  assert.equal(GLACIAL_LAKE_COUNT, 4152);
  assert.equal(GLACIAL_LAKE_RETRIEVED, '2026-08-13');
  assert.equal(inventory.license, 'CC BY 4.0');
  assert.equal(inventory.checksum, 'md5:4c06a2561f7cec329e1de54df6fdafa0');
  assert.deepEqual(inventory.observations, { from: 2017, to: 2024, sensor: 'Sentinel-2' });
  assert.deepEqual(inventory.counts.countries, { Nepal: 2350, China: 1744, India: 58 });
  assert.deepEqual(inventory.counts.basins, { Koshi: 2308, Gandaki: 613, Karnali: 1231 });
  assert.match(inventory.limitation, /not necessarily dangerous/i);
});

await ok('the lake bundle is an explicit 11-field engineering allow-list', () => {
  const bundle = raw as any;
  assert.equal(bundle._crs, 'EPSG:4326 (WGS 84 longitude/latitude centroids)');
  assert.equal(bundle.lakes.length, 4152);
  assert.ok(bundle.lakes.every((lake: unknown[]) => lake.length === 11));
  assert.equal(new Set(bundle.lakes.map((lake: unknown[]) => lake[0])).size, 4152);
  assert.ok(bundle.lakes.every((lake: any[]) => lake[9] >= 27.4 && lake[9] <= 30.7));
  assert.ok(bundle.lakes.every((lake: any[]) => lake[10] >= 79.9 && lake[10] <= 88.9));
});

await ok('published growth and outlier flags are retained without inventing a danger rank', () => {
  const lakes = glacialLakeInventory().lakes;
  assert.equal(lakes.filter((lake) => lake.connectivity === 'Glacier-fed').length, 2733);
  assert.equal(lakes.filter((lake) => lake.timeSeriesOutlier === true).length, 40);
  assert.equal(
    lakes.filter((lake) =>
      lake.expansionSignificant === true &&
      (lake.expansionRateKm2Yr ?? 0) > 0 &&
      lake.timeSeriesOutlier !== true
    ).length,
    267
  );
  assert.ok(!Object.keys(raw as object).some((key) => /danger|hazard|risk/i.test(key)));
});

const reaches: [number, number][][] = [
  [[84, 28.003], [84, 28.002], [84, 28.001]],
  [[84, 28.001], [84, 28], [84.001, 28]],
  [[83.999, 28.003], [83.999, 28.002]],
];
const next = new Map([[0, 1], [2, 0]]);
const adapter: DirectedNetworkAdapter = {
  pointCount: (reach) => reaches[reach]?.length ?? 0,
  point: (reach, vertex) => reaches[reach][vertex],
  next: (reach) => next.get(reach) ?? null,
};

await ok('the pure walker follows downstream reaches and stops at the intake vertex', () => {
  const trace = traceDirectedConnection(
    adapter,
    { reachIndex: 2, vertex: 0 },
    { reachIndex: 1, vertex: 1 },
    5
  );
  assert.ok(trace);
  assert.deepEqual(trace.coordinates.at(-1), [84, 28]);
  assert.ok(trace.routeKm > 0.4 && trace.routeKm < 1);
});

await ok('same-reach sources below the target and overlong routes are rejected', () => {
  assert.equal(
    traceDirectedConnection(adapter, { reachIndex: 1, vertex: 2 }, { reachIndex: 1, vertex: 1 }, 5),
    null
  );
  assert.equal(
    traceDirectedConnection(adapter, { reachIndex: 2, vertex: 0 }, { reachIndex: 1, vertex: 1 }, 0.1),
    null
  );
});

await ok('the bundled network produces candidates but caps overlapping route geometry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('nepal-rivers.dat') || url.endsWith('nepal-hypso.dat')) {
      const name = url.split('/').at(-1)!;
      try {
        return new Response(await readFile(new URL(`../public/${name}`, import.meta.url)), { status: 200 });
      } catch {
        return new Response('', { status: 404 });
      }
    }
    return originalFetch(input, init);
  };
  try {
    const screen = await upstreamConnectivityFor({ lat: 28.210416666666667, lon: 83.99375 });
    assert.ok(screen);
    assert.equal(screen.lakes.length, 1);
    assert.ok(screen.incidents.length > 100);
    assert.equal(screen.lakes[0].id, 'GLO_84.0416_28.54786');
    assert.ok(screen.lakes[0].routeKm > 40 && screen.lakes[0].routeKm < 60);
    const all = [...screen.lakes, ...screen.incidents];
    assert.equal(all.filter((candidate) => candidate.routeGeometryIncluded).length, ROUTE_GEOMETRY_LIMIT);
    assert.ok(all.filter((candidate) => !candidate.routeGeometryIncluded).every((candidate) => candidate.route.length === 0));
    assert.match(screen.limitation, /not a susceptibility.*breach.*design-flood model/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`\n${passed} connectivity checks passed\n`);
