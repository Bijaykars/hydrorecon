/**
 * The canal/tunnel read, on terrain whose answer is known by construction.
 *
 *   node --experimental-strip-types --no-warnings checks/corridor.check.ts
 *
 * Two things can go wrong here and neither shows up as an error. The
 * perpendicular can be computed the wrong way round, which samples ALONG the
 * valley instead of across it and reports a gorge as flat. And the gentler bank
 * can be taken as the mean of the two rather than the minimum, which reports a
 * buildable terrace as unbuildable because the opposite wall is vertical.
 *
 * Both were live bugs in the probe this module came from — one measured a
 * valley's tilt instead of its steepness, the other sampled the Tibetan plateau
 * — so the arithmetic is pinned against synthetic ground with a known slope.
 */
import assert from 'node:assert';
import {
  CANAL_MAX_GRADE_PCT,
  crossSectionPoints,
  readCrossSlopes,
} from '../src/engine/corridor.ts';

/** A due-east river, so the perpendicular must run north-south. */
const path = Array.from({ length: 40 }, (_, k) => ({
  lat: 28,
  lon: 84 + k * 0.002,
  km: k * 0.2,
}));

const pts = crossSectionPoints(path, 0, path.length - 1);
assert.ok(pts.length > 0 && pts.length % 3 === 0, 'points come in centre/left/right triples');

/**
 * The offsets must move in LATITUDE for an east-west river. If they move in
 * longitude the perpendicular is backwards and every reading is the along-river
 * slope, which on a real river is gentle everywhere — a silent, plausible lie.
 */
const [c0, l0, r0] = pts;
assert.ok(
  Math.abs(l0.lat - c0.lat) > Math.abs(l0.lon - c0.lon),
  'perpendicular to an east-west river must run north-south'
);
assert.ok((l0.lat - c0.lat) * (r0.lat - c0.lat) < 0, 'the two offsets must straddle the channel');
const offsetM = Math.abs(l0.lat - c0.lat) * 111320;
assert.ok(Math.abs(offsetM - 100) < 1, `offset should be 100 m, got ${offsetM.toFixed(1)}`);

/** A symmetric valley rising 50 m over the 100 m offset: a 50% grade, benchable. */
const symmetric = pts.map((_, k) => (k % 3 === 0 ? 1000 : 1050));
const gentle = readCrossSlopes(symmetric)!;
assert.ok(gentle, 'a valley with both banks readable must produce a verdict');
assert.ok(
  Math.abs(gentle.medianGradePct - 50) < 1e-6,
  `50 m over 100 m is a 50% grade, got ${gentle.medianGradePct}`
);
assert.equal(gentle.canalFrac, 1, 'a 50% grade is below the canal threshold');
assert.equal(gentle.tunnelKm, 0);

/** One vertical wall, one 20 m terrace. The terrace decides it. */
const oneSided = pts.map((_, k) => (k % 3 === 0 ? 1000 : k % 3 === 1 ? 1400 : 1020));
const terrace = readCrossSlopes(oneSided)!;
assert.ok(
  Math.abs(terrace.medianGradePct - 20) < 1e-6,
  `the GENTLER bank decides: expected 20%, got ${terrace.medianGradePct}`
);
assert.equal(terrace.canalFrac, 1, 'a terrace on one wall is buildable');

/** Both walls steep: nothing to bench, so the whole corridor is tunnel. */
const gorge = pts.map((_, k) => (k % 3 === 0 ? 1000 : 1000 + CANAL_MAX_GRADE_PCT + 20));
const tunnel = readCrossSlopes(gorge)!;
assert.equal(tunnel.canalFrac, 0, 'both banks past the threshold means no canal');
assert.ok(tunnel.tunnelKm > 0, 'a tunnelled corridor must report a length');

/** Missing terrain must drop the station, not read as a cliff or a plain. */
assert.equal(readCrossSlopes([NaN, NaN, NaN]), null);
assert.equal(readCrossSlopes([]), null);
assert.equal(crossSectionPoints(path, 5, 5).length, 0, 'a zero-length corridor has no stations');

console.log('corridor.check ok');
console.log(
  `  ${gentle.stations} stations over ${path[path.length - 1].km.toFixed(1)} km; ` +
    `symmetric 50% grade benchable, one-sided terrace read at ${terrace.medianGradePct}%, ` +
    `gorge ${(tunnel.canalFrac * 100).toFixed(0)}% benchable`
);
