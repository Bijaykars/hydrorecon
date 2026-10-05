import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { riverDisplayFromSnap, displayGeoJson, buildRiverDisplay } from '../src/river-display.ts';
import type { OsmSnap } from '../src/osm-rivers.ts';

const path = [{ lat: 28, lon: 85, km: 0 }, { lat: 28, lon: 85.002, km: 1 }];
const snap: OsmSnap = { path, matches: [{ line: 0, seg: 0 }, { line: 0, seg: 1 }], movedM: 0, matched: 1, lengthBeforeKm: 1, lengthAfterKm: 1 };
const display = riverDisplayFromSnap(path, snap, [{ p: [28, 85, 28.0005, 85.001, 28, 85.002] }]);
assert.equal(display.segments[0].traced, true);
assert.deepEqual(display.segments[0].coordinates, [[85, 28], [85.001, 28.0005], [85.002, 28]]);
assert.equal(displayGeoJson(display).features.length, 1);
const unmatched = riverDisplayFromSnap(path, { ...snap, matches: [null, null] }, []);
assert.equal(unmatched.segments[0].traced, false);
assert.deepEqual(unmatched.points.map(({ lat, lon }) => ({ lat, lon })), path.map(({ lat, lon }) => ({ lat, lon })));
const changedWay = riverDisplayFromSnap(path, { ...snap, matches: [{ line: 0, seg: 0 }, { line: 1, seg: 1 }] }, []);
assert.equal(changedWay.segments[0].traced, false, 'Never invent a traced connection across different waterways');

// Actual Ilep/Tatopani geometry from the user's screenshot area. No runtime APIs.
globalThis.fetch = (async (input) => {
  try { return new Response(readFileSync(`public/${String(input).replace(/^\//, '')}`)); }
  catch { return new Response(null, { status: 404 }); }
}) as typeof fetch;
const { downstreamPath } = await import('../src/rivers.ts');
const actual = (await downstreamPath(28.226, 85.073, 22))!;
const before = JSON.stringify(actual);
const geometry = (await buildRiverDisplay(actual))!;
assert.equal(JSON.stringify(actual), before, 'Display correction must not mutate engine inputs');
assert.equal(geometry.points.length, actual.length);
assert.ok(geometry.points[8].offsetM > 100 && geometry.points[8].offsetM < 500, 'Expose the measured intake display offset');
assert.ok(geometry.points[8].lon < 85.072, 'The traced intake is west of the coarse model line at Ilep');
const selected = displayGeoJson(geometry, 8, 30);
assert.deepEqual((selected.features[0].geometry as GeoJSON.LineString).coordinates[0], [geometry.points[8].lon, geometry.points[8].lat]);
assert.ok(geometry.segments.reduce((sum, segment) => sum + segment.coordinates.length - 1, 1) > actual.length, 'Include intermediate bends, not only snapped endpoints');
console.log(`River display checks passed; Ilep intake display offset ${geometry.points[8].offsetM.toFixed(1)} m. Engine inputs unchanged.`);
