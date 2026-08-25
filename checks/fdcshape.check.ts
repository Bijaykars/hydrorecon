/**
 * The shape correction must fix what is broken and touch nothing else.
 *
 * Two properties matter more than the correction itself. It must not move the
 * mean, because magnitude belongs to the mapped network and a shape fix that
 * quietly rescaled the river would be a magnitude fix in disguise. And it must
 * not reorder the days, because seasonality, the monthly minimum and therefore
 * the residual-flow release are all read off the day order.
 */
import assert from 'node:assert/strict';
import { judgeShape, correctShape, NATIONAL_SHAPE } from '../src/engine/fdcshape.ts';

const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;

// --- the national curve itself --------------------------------------------
assert.ok(NATIONAL_SHAPE.stations >= 50, `only ${NATIONAL_SHAPE.stations} stations`);
for (let i = 1; i < NATIONAL_SHAPE.ratio.length; i++) {
  assert.ok(
    NATIONAL_SHAPE.ratio[i] < NATIONAL_SHAPE.ratio[i - 1],
    'a flow exceeded more often must be smaller'
  );
  assert.ok(NATIONAL_SHAPE.low[i] <= NATIONAL_SHAPE.high[i], 'band inverted');
}
// Q40/mean anchors the whole diagnosis; if this drifts, the argument changed.
const q40 = NATIONAL_SHAPE.ratio[2];
assert.ok(q40 > 0.5 && q40 < 0.7, `Q40/mean median is ${q40}, expected ~0.59`);

// --- a realistic Nepali year, built FROM the national curve ----------------
// Monsoon-shaped: sorted descending then scattered back across the year.
const N = 365 * 5;
const nepali: number[] = [];
for (let k = 0; k < N; k++) {
  const p = k / (N - 1);
  const pts = NATIONAL_SHAPE.points;
  let r = NATIONAL_SHAPE.ratio[0];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (p >= pts[i] && p <= pts[i + 1]) {
      const t = (p - pts[i]) / (pts[i + 1] - pts[i]);
      r = Math.exp(
        Math.log(NATIONAL_SHAPE.ratio[i]) +
          t * (Math.log(NATIONAL_SHAPE.ratio[i + 1]) - Math.log(NATIONAL_SHAPE.ratio[i]))
      );
    }
  }
  nepali.push(r * 50);
}
const vOk = judgeShape(nepali, 0.4);
assert.ok(vOk, 'a full series should be judgeable');
assert.equal(vOk.implausible, false, 'a curve built from the national shape must pass');
assert.equal(vOk.designFactor, 1, 'a passing series must not be corrected');

// --- a too-flashy series, the failure actually observed --------------------
// Cube it: same days, far more concentrated in the peak.
const flashy = nepali.map((v) => v ** 3);
const vBad = judgeShape(flashy, 0.4);
assert.ok(vBad, 'flashy series should be judgeable');
assert.ok(vBad.implausible, 'a cubed series must be caught as implausible');
assert.ok(vBad.ratio < vBad.band[0], 'it should fail on the LOW side, as the model does');
assert.ok(vBad.designFactor > 1.5, `expected a large lift, got ${vBad.designFactor}`);

// --- the correction's two invariants --------------------------------------
const fixed = correctShape(flashy, 0.4);
assert.equal(fixed.length, flashy.length);
assert.ok(
  Math.abs(mean(fixed) - mean(flashy)) / mean(flashy) < 1e-9,
  `mean moved: ${mean(flashy)} -> ${mean(fixed)}`
);
// Day order preserved: wettest stays wettest, every rank intact.
const rank = (v: readonly number[]) =>
  Array.from({ length: v.length }, (_, i) => i).sort((a, b) => v[b] - v[a]);
assert.deepEqual(rank(fixed), rank(flashy), 'the correction reordered the days');

// And it actually lands inside the band it was aiming at.
const after = judgeShape(fixed, 0.4)!;
assert.equal(after.implausible, false, `still implausible after correction: ${after.ratio}`);
assert.ok(
  after.ratio > vBad.ratio,
  'correcting a too-flashy series must RAISE its design flow'
);

/**
 * IT NEVER MAKES A CURVE WORSE.
 *
 * The correction rewrites the middle of the record but leaves the tails in the
 * record's own proportions, then rescales everything to hold the mean. On a
 * spike series the untouched top 5% dominates that rescale and drags the
 * corrected middle down with it: Q40/mean started at 0.1545 against a target of
 * 0.593, was reported as corrected 3.839×, and came out at 0.02985 — five times
 * further from plausible than it began, while the panel called it corrected.
 *
 * A post-condition is the fix, not a better remap: the result is judged by the
 * same test that flagged the input, and a correction that did not close the gap
 * is discarded in favour of the record as supplied.
 */
{
  const spike = Array.from({ length: 3650 }, (_, i) => (i % 365 === 0 ? 4000 : 0.4));
  const before = judgeShape(spike, 0.4)!;
  assert.ok(before.implausible, 'the spike fixture must be flagged, or it tests nothing');
  const out = correctShape(spike, 0.4);
  const gap = (s: readonly number[]) => {
    const v = judgeShape(s, 0.4)!;
    return Math.abs(Math.log(v.ratio / v.band[1]));
  };
  assert.ok(
    gap(out) <= gap(spike) + 1e-12,
    `correction moved the curve further from plausible: ${gap(spike)} -> ${gap(out)}`
  );
}

// --- refuses to guess ------------------------------------------------------
assert.equal(judgeShape([1, 2, 3], 0.4), null, 'too short to judge');
assert.equal(judgeShape(new Array(400).fill(0), 0.4), null, 'a dry river has no shape');
assert.deepEqual(correctShape([0, 0, 0], 0.4), [0, 0, 0], 'nothing to correct');

console.log(
  `fdcshape.check ok\n  national Q40/mean ${q40.toFixed(3)} ` +
    `(band ${NATIONAL_SHAPE.low[2].toFixed(2)}-${NATIONAL_SHAPE.high[2].toFixed(2)}) ` +
    `from ${NATIONAL_SHAPE.stations} gauges\n  flashy series lifted ${vBad.designFactor.toFixed(2)}x, ` +
    `mean and day order unchanged`
);
