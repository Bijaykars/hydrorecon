/**
 * Collector-intake screening rules.
 *
 *   node --experimental-strip-types --no-warnings checks/collector.check.ts
 *
 * The case that matters most is `already-counted`: a tributary upstream on the
 * same river carries water that the main intake ALREADY takes, and adding it
 * would inflate the answer with no field evidence contradicting it.
 */
import assert from 'node:assert/strict';
import { assessCollectors, type CollectorInput } from '../src/collector.ts';

const MAIN = { elevationM: 1000, meanCms: 10, uplandKm2: 500, grossHeadM: 300 };
const base: CollectorInput = {
  lat: 28,
  lon: 85,
  elevationM: 1030,
  meanCms: 2,
  uplandKm2: 90,
  channelKm: 2,
  nestedUpstream: false,
};

const one = (over: Partial<CollectorInput>) => assessCollectors(MAIN, [{ ...base, ...over }]).items[0];

// A sound tributary counts, and contributes exactly its share of the flow.
const good = one({});
assert.equal(good.verdict, 'ok');
assert.equal(good.ratio, 0.2);
assert.equal(good.warnings.length, 0);

// A hillside is not an intake, whatever its elevation.
assert.equal(one({ meanCms: null, elevationM: 2500 }).verdict, 'not-a-stream');
assert.equal(one({ meanCms: 0 }).verdict, 'not-a-stream');

// The double-count trap: same river, upstream of the intake.
const nested = one({ nestedUpstream: true });
assert.equal(nested.verdict, 'already-counted');
assert.equal(nested.ratio, 0);

// Below the headpond, or within the terrain's own error of it.
assert.equal(one({ elevationM: 940 }).verdict, 'below-headpond');
assert.equal(one({ elevationM: 1001 }).verdict, 'below-headpond');
assert.equal(one({ elevationM: null }).verdict, 'below-headpond');

// The twin-intake case: a branch that merges below the intake cannot be piped
// UP to the headpond, so the advice must be to bring the intake DOWN instead.
const twin = one({ elevationM: 900, joinsMainBelowIntakeKm: 3.2, junctionPathIndex: 40 });
assert.equal(twin.verdict, 'below-headpond');
assert.equal(twin.biggerThanMain, false);
assert.ok(twin.reason.includes('3.2 km below the intake'), `advice missing: ${twin.reason}`);
assert.ok(/moving the MAIN intake/.test(twin.reason), 'should advise moving the main intake');
// Without a junction it stays the plain refusal — no invented confluence.
assert.ok(!/MAIN intake/.test(one({ elevationM: 900 }).reason));

/**
 * The wrong-river case, and the one that costs the most head if missed: the
 * branch below the intake is the LARGER river. Dropping the intake to the
 * confluence surrenders every metre down to it; taking the big river at its
 * own level does not. The advice must say so.
 */
const wrongRiver = one({
  elevationM: 900,
  meanCms: 54,
  uplandKm2: 1741,
  joinsMainBelowIntakeKm: 5.2,
  junctionPathIndex: 60,
});
assert.equal(wrongRiver.verdict, 'below-headpond');
assert.equal(wrongRiver.biggerThanMain, true);
assert.ok(/bigger river/.test(wrongRiver.reason), `swap advice missing: ${wrongRiver.reason}`);
assert.ok(/54.0 m³\/s against 10.0 m³\/s/.test(wrongRiver.reason), 'should quote both flows');
// A smaller branch must never be called the bigger river.
assert.equal(one({ elevationM: 900, meanCms: 1 }).biggerThanMain, false);

/**
 * Enough height, but spread over too much distance to flow.
 *
 * The fall here has to CLEAR the terrain-error bar before the gradient test is
 * reached at all. This fixture used to sit at 1004 m — a 4 m apparent rise the
 * DEM cannot resolve — and only read as "too flat" because the gravity bar was
 * 2 m, smaller than the ±15 m error the module documents beside it.
 */
assert.equal(one({ elevationM: 1016, channelKm: 20 }).verdict, 'too-flat');

// And a fall inside terrain error is not gravity-feasible, however long the run.
assert.equal(one({ elevationM: 1004, channelKm: 12 }).verdict, 'below-headpond');
assert.match(one({ elevationM: 1004, channelKm: 12 }).reason, /inside the terrain's own error/);

// Cautions that still count: wasteful drop, long channel, poor value, bigger river.
const high = one({ elevationM: 1120 }); // 120 m = 40% of 300 m gross head
assert.equal(high.verdict, 'ok');
assert.ok(high.warnings.some((w) => w.includes('gross head')), 'expected a wasted-head caution');

const far = one({ elevationM: 1200, channelKm: 9 });
assert.equal(far.verdict, 'ok');
assert.ok(far.warnings.some((w) => w.includes('link channel')), 'expected a long-channel caution');
assert.ok(far.warnings.some((w) => w.includes('per m³/s')), 'expected a value caution');

const bigger = one({ uplandKm2: 900 });
assert.ok(bigger.warnings.some((w) => w.includes('larger catchment')), 'expected a main-stem caution');

// Only sound intakes reach the total. Distinct coordinates: two pins on one
// channel are a double-count, which the next block tests deliberately.
const mixed = assessCollectors(MAIN, [
  base,
  { ...base, lat: 28.01, nestedUpstream: true },
  { ...base, lat: 28.02, meanCms: null },
  { ...base, lat: 28.03, meanCms: 3 },
]);
assert.equal(mixed.counted, 2);

/**
 * THE SAME WATER CANNOT BE ADDED TWICE.
 *
 * Every rule above asks whether a collector's water already reaches the MAIN
 * intake. None asked whether it already reaches another COLLECTOR, so two pins
 * on one tributary were both counted in full and the headline gain doubled —
 * two identical 0.2 intakes produced a 0.4 gain from one stream.
 */
const duplicated = assessCollectors(MAIN, [base, { ...base }]);
assert.equal(duplicated.counted, 1, 'two pins on the same channel are one collector');
assert.equal(duplicated.gainFrac, 0.2, 'the gain must not double');
assert.equal(duplicated.items[1].verdict, 'already-counted');

// Two pins sharing a junction into the main waterway are the same water too.
const sameReach = assessCollectors(MAIN, [
  { ...base, linkPathIndex: 40 },
  { ...base, lat: 28.05, lon: 85.05, linkPathIndex: 40 },
]);
assert.equal(sameReach.counted, 1, 'one link junction is one collector');
assert.ok(Math.abs(mixed.gainFrac - 0.5) < 1e-9, `gainFrac ${mixed.gainFrac}, expected 0.5`);

console.log('collector.check ok');
console.log(`  sound tributary adds ${(good.ratio * 100).toFixed(0)}% of the main flow`);
console.log(`  ${mixed.counted}/4 counted, total gain +${(mixed.gainFrac * 100).toFixed(0)}%`);
