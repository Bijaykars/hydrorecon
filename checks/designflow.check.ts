/**
 * The design-flow sweep, on a river whose behaviour is known in advance.
 *
 * The sweep exists to answer "is this the right size of machine", and the one
 * thing it must never do is answer it with different arithmetic from the panel
 * standing next to it. So the load-bearing check here is not that the curve
 * looks sensible — it is that the swept point at the design exceedance
 * reproduces `evaluate` EXACTLY, to the last bit. If those two ever drift, the
 * report shows a capacity in a table and a different capacity on a chart, and a
 * reader has no way to tell which is the scheme.
 *
 * The rest guards the shape a run-of-river trade-off must have: capacity rises
 * with design flow, the marginal megawatt earns steadily fewer hours, and the
 * dry-season share falls as the machine grows — the last of which is the whole
 * reason a developer would shrink one.
 */
import assert from 'node:assert/strict';
import { evaluate, type SchemeInput } from '../src/engine/discover.ts';
import { sweepDesignFlow } from '../src/engine/designflow.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

/**
 * Three years of daily flow with a real monsoon.
 *
 * Deterministic: a fixed seasonal curve times a repeating multiplier, never a
 * random draw, so a failure here is reproducible rather than a one-in-twenty
 * event that vanishes on re-run.
 */
const DAYS = 365 * 3;
const dates: string[] = [];
const series: number[] = [];
for (let d = 0; d < DAYS; d++) {
  const year = 2018 + Math.floor(d / 365);
  const doy = d % 365;
  const date = new Date(Date.UTC(year, 0, 1 + doy));
  dates.push(date.toISOString().slice(0, 10));
  // Peak in late July, trough in March — Nepal's shape.
  const season = Math.exp(2.0 * Math.cos((2 * Math.PI * (doy - 205)) / 365));
  const wobble = 1 + 0.25 * Math.sin(d * 1.7);
  series.push(2.5 * season * wobble);
}
const seriesMeanCms = series.reduce((a, b) => a + b, 0) / series.length;

/** 10 km of river falling 220 m, carrying the same mean throughout. */
const path = Array.from({ length: 21 }, (_, k) => ({
  km: k * 0.5,
  lat: 28 + k * 0.004,
  lon: 84.5,
  elevationM: 1400 - k * 11,
  meanCms: seriesMeanCms,
}));

const input: SchemeInput = {
  path,
  series,
  dates,
  seriesMeanCms,
  residualCms: 0.1 * Math.min(...series),
  exceedance: 0.4,
  efficiency: 0.9,
  headLossFrac: 0.05,
  minFlowFrac: 0.3,
  intakeWindowKm: 5,
};

console.log('\ndesign-flow sweep');

const started = Date.now();
const sweep = sweepDesignFlow(input, 0, 20);
const elapsed = Date.now() - started;

ok('the sweep produces a curve, not a pair of points', () => {
  assert.ok(sweep, 'no sweep returned');
  assert.ok(sweep.points.length >= 3, `only ${sweep.points.length} points`);
});

ok('it runs fast enough to sit in a render', () => {
  // Seventeen full evaluations including the interannual and PPA dispatch. This
  // is a memo in the app, so a second here is a second of blank panel.
  assert.ok(elapsed < 4000, `${elapsed} ms`);
  console.log(`      ${sweep!.points.length} sizes in ${elapsed} ms`);
});

ok('the chosen point reproduces the panel exactly, not approximately', () => {
  const s = evaluate(input, 0, 20);
  assert.ok(s, 'no scheme from evaluate');
  const chosen = sweep!.chosen;
  assert.ok(chosen, 'the design exceedance was not in the sweep');
  assert.equal(chosen.capacityMW, s.capacityMW);
  assert.equal(chosen.energyGwh, s.energyGwh);
  assert.equal(chosen.designFlowCms, s.designFlowCms);
  assert.equal(chosen.netHeadM, s.netHeadM);
});

ok('points are ordered by machine size, so "marginal" means what it says', () => {
  for (let k = 1; k < sweep!.points.length; k++) {
    assert.ok(
      sweep!.points[k].designFlowCms > sweep!.points[k - 1].designFlowCms,
      `design flow not increasing at index ${k}`
    );
  }
});

ok('a bigger design flow buys a bigger machine', () => {
  const first = sweep!.points[0];
  const last = sweep!.points[sweep!.points.length - 1];
  assert.ok(last.capacityMW > first.capacityMW, `${last.capacityMW} vs ${first.capacityMW}`);
});

ok('the last megawatt earns fewer hours than the first', () => {
  const marginal = sweep!.points.map((p) => p.marginalHours).filter((h): h is number => h !== null);
  assert.ok(marginal.length >= 2, 'no marginal steps');
  assert.equal(sweep!.points[0].marginalHours, null, 'the smallest point invented an increment');
  assert.ok(
    marginal[marginal.length - 1] < marginal[0],
    `marginal hours did not fall: ${marginal[0]} -> ${marginal[marginal.length - 1]}`
  );
  for (const h of marginal) assert.ok(Number.isFinite(h) && h > 0, `bad marginal ${h}`);
});

ok('shrinking the machine raises the dry-season share', () => {
  const small = sweep!.points[0];
  const big = sweep!.points[sweep!.points.length - 1];
  assert.ok(small.dryShareSixSix !== null && big.dryShareSixSix !== null, 'no dry share computed');
  assert.ok(
    small.dryShareSixSix > big.dryShareSixSix,
    `${small.dryShareSixSix} not above ${big.dryShareSixSix}`
  );
});

ok('the quoted dry-season limit is the largest machine that actually clears the bar', () => {
  const limit = sweep!.dryLimitSixSix;
  if (!limit) {
    // A river that never clears 30% has no limit to quote, and saying so is
    // the correct answer rather than quoting the smallest machine.
    assert.ok(sweep!.points.every((p) => (p.dryShareSixSix ?? 0) < 0.3));
    return;
  }
  assert.ok(limit.dryShareSixSix! >= 0.3, `quoted limit is at ${limit.dryShareSixSix}`);
  for (const p of sweep!.points) {
    if (p.designFlowCms > limit.designFlowCms) {
      assert.ok(
        (p.dryShareSixSix ?? 0) < 0.3,
        `a larger machine at Q${p.exceedance * 100} also clears the bar`
      );
    }
  }
});

ok('energy peaks where the sweep says it does', () => {
  for (const p of sweep!.points) {
    assert.ok(p.energyGwh <= sweep!.maxEnergy.energyGwh + 1e-9, 'a point beats the reported maximum');
  }
});

ok('a layout with no buildable machine yields no curve rather than a flat one', () => {
  // Two adjacent points: no head, so every duty point is rejected.
  const flat: SchemeInput = {
    ...input,
    path: path.map((p) => ({ ...p, elevationM: 1000 })),
  };
  assert.equal(sweepDesignFlow(flat, 0, 20), null);
});

console.log(`\n${passed} design-flow checks passed`);
