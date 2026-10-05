import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discover, evaluate, type SchemeInput } from '../src/engine/discover.ts';

const input: SchemeInput = {
  path: Array.from({ length: 221 }, (_, k) => ({ km: k * 0.1, lat: 28 - k * 0.0009, lon: 84, elevationM: 2000 - k * 4, meanCms: 10 })),
  series: Array.from({ length: 365 }, (_, k) => 10 + 5 * Math.sin(k / 58)),
  seriesMeanCms: 10, residualCms: 1, exceedance: 0.4, efficiency: 0.9,
  headLossFrac: 0.05, minFlowFrac: 0.2, intakeWindowKm: 0,
};
for (const limit of [5, 6, 10]) {
  const bounded = { ...input, maxWaterwayKm: limit };
  const found = discover(bounded);
  assert.ok(found.schemes.length > 0);
  assert.ok(found.schemes.every((s) => s.i === 0 && s.waterwayKm <= limit + 1e-9));
  assert.ok(evaluate(bounded, 0, limit * 10), 'Exact boundary is accepted');
  assert.equal(evaluate(bounded, 0, limit * 10 + 1), null, 'Manual layouts obey the same limit');
  const stretched = { ...bounded, path: input.path.map((p, k) => ({ ...p, km: k < 2 ? p.km : p.km * 1.7 })) };
  assert.ok(discover(stretched).schemes.every((s) => s.waterwayKm <= limit + 1e-9), 'Actual chainage controls the cap, even with irregular spacing');
  assert.ok(discover({ ...bounded, intakeWindowKm: Infinity }).schemes.every((s) => s.waterwayKm <= limit + 1e-9), 'Corridor search keeps the per-layout limit');
}
assert.equal(evaluate({ ...input, maxWaterwayKm: NaN }, 0, 10), null);

globalThis.fetch = (async (url) => {
  try { return new Response(readFileSync(`public/${String(url).replace(/^\//, '')}`)); }
  catch { return new Response(null, { status: 404 }); }
}) as typeof fetch;
const { downstreamPath, nearestReach } = await import('../src/rivers.ts');
let moved = 0;
for (const p of [[28.30127, 84.12791], [28.30228, 84.03105], [28.226, 85.073]]) {
  const hit = (await nearestReach(p[0], p[1]))!;
  const continuous = (await downstreamPath(p[0], p[1], 10, 0.12, { continuousStart: true }))!;
  const legacy = (await downstreamPath(p[0], p[1], 10))!;
  assert.ok(continuous.length > 5);
  assert.equal(continuous[0].lat, hit.nearest.point.lat);
  assert.equal(continuous[0].lon, hit.nearest.point.lon);
  assert.equal(continuous[0].uplandKm2, hit.nearest.uplandKm2);
  assert.equal(continuous[0].networkIndex, hit.nearest.networkIndex);
  assert.ok(continuous.at(-1)!.km <= 10 + 1e-9);
  assert.ok(continuous.every((v, k) => k === 0 || v.km > continuous[k - 1].km));
  if (Math.hypot(continuous[0].lat - legacy[0].lat, continuous[0].lon - legacy[0].lon) > 1e-6) moved++;
}
assert.ok(moved >= 2, 'Regression fixtures must exercise points between stored vertices');
console.log('Layout checks passed: 5/6/10 km caps, manual and corridor limits, fixed intake, and continuous river starts.');
