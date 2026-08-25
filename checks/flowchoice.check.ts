/**
 * Flow authority.  part of `npm run check`
 *
 * The chooser decides which global model an entire study's magnitude rests on,
 * so the wrong branch here understates a river two-hundred-fold or resurrects
 * an off-channel cell the app already learned to discard. Both historical
 * failures are pinned as cases.
 */
import assert from 'node:assert/strict';
import { BLEND_BIAS_CORRECTION, chooseFlowMagnitude, DISAGREE_RATIO } from '../src/engine/flowchoice.ts';
import { annualMeanCms, driestMonthFlow } from '../src/engine/hydest.ts';
import { modifiedHydestAnnualMean } from '../src/engine/modified-hydest.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

/** Two synthetic years, flat within each month so month means are exact. */
function series(byMonth: (m: number) => number): { dates: string[]; values: number[] } {
  const dates: string[] = [];
  const values: number[] = [];
  for (const y of [2018, 2019]) {
    for (let m = 0; m < 12; m++) {
      for (let d = 1; d <= 28; d++) {
        dates.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
        values.push(byMonth(m));
      }
    }
  }
  return { dates, values };
}

/** A mid-hills catchment HYDEST can judge. */
const HYDEST = { totalKm2: 400, below5000Km2: 380, below3000Km2: 250 };
const judge = driestMonthFlow(HYDEST)!;

/** Monsoon-shaped year whose driest-month value is exactly `dry`. */
const shaped = (dry: number) => series((m) => (m >= 5 && m <= 8 ? dry * 12 : m === judge.month ? dry : dry * 2));

console.log('\nflowchoice: who sets the magnitude');

ok('agreement within rescaling range keeps the network, no judging', () => {
  const s = shaped(judge.cms);
  const c = chooseFlowMagnitude({ dates: s.dates, series: s.values, networkMeanCms: meanOf(s.values) * 2, hydest: HYDEST });
  assert.equal(c.authority, 'network');
  assert.ok(c.disagreement <= DISAGREE_RATIO);
  assert.equal(c.judgeCms, null, 'no judging when there is no real dispute');
});

ok('no network magnitude means the model runs as-is', () => {
  const s = shaped(judge.cms);
  const c = chooseFlowMagnitude({ dates: s.dates, series: s.values, networkMeanCms: 0, hydest: HYDEST });
  assert.equal(c.authority, 'model');
});

ok('the Tamakoshi failure: a broken network loses to the model when HYDEST agrees with the model', () => {
  // The record's dry season lands on HYDEST's figure; the network claims the
  // river is 200x smaller. This is the 0.3 m3/s on a 1,754 km2 catchment that
  // priced a built 456 MW plant at 0.4 MW.
  const s = shaped(judge.cms);
  const c = chooseFlowMagnitude({ dates: s.dates, series: s.values, networkMeanCms: meanOf(s.values) / 200, hydest: HYDEST });
  assert.equal(c.authority, 'model', 'the regression should have sided with the flood model');
  assert.ok(c.judgeCms! > 0 && c.modelCms! > 0);
  assert.match(c.note, /flood model/);
});

ok('the Marsyangdi failure stays fixed: an off-channel cell loses to the network', () => {
  // The record is 60x too big for this river (the ~5 km cell is on a different
  // channel); the network's mean is right, and rescaling by it puts the dry
  // season back on HYDEST's figure.
  const s = shaped(judge.cms * 60);
  const c = chooseFlowMagnitude({ dates: s.dates, series: s.values, networkMeanCms: meanOf(s.values) / 60, hydest: HYDEST });
  assert.equal(c.authority, 'network', 'the off-channel cell must not win');
});

ok('when both global sources are far from the annual regional estimate, it becomes a declared screening fallback', () => {
  // With MMP the comparison states a full annual mean. Make the model 6x above it
  // and the network 8x below it — the Chilime pattern — and neither deserves
  // to win. The record keeps its shape, rescaled onto the regression.
  const WET = { ...HYDEST, monsoonMm: 1500 };
  const s = shaped(judge.cms);
  const mean = meanOf(s.values);
  const c = chooseFlowMagnitude({
    dates: s.dates,
    series: s.values.map((v) => (v * (annualMeanCms(WET)! * 6)) / mean),
    networkMeanCms: annualMeanCms(WET)! / 8,
    hydest: WET,
  });
  assert.equal(c.authority, 'hydest', 'neither broken source should carry the magnitude');
  assert.equal(c.judgeKind, 'annual');
  assert.ok(Math.abs(c.targetMeanCms! - annualMeanCms(WET)!) < 1e-9, 'target must be the regression mean');
  assert.match(c.note, /both global sources sit far from the WECS\/DHM regional estimate/);
  assert.match(c.note, /screening and needs a gauge record/);
});

ok('a candidate that satisfies the annual judge still wins normally', () => {
  const WET = { ...HYDEST, monsoonMm: 1500 };
  const target = annualMeanCms(WET)!;
  const s = shaped(judge.cms);
  const mean = meanOf(s.values);
  // Model sits right on the regression's annual mean; network is 20x low.
  const c = chooseFlowMagnitude({
    dates: s.dates,
    series: s.values.map((v) => (v * target) / mean),
    networkMeanCms: target / 20,
    hydest: WET,
  });
  assert.equal(c.authority, 'model');
  assert.equal(c.judgeKind, 'annual');
});

ok('outside Nepal there is no judge, and the network keeps its long-standing role', () => {
  const s = shaped(judge.cms);
  const c = chooseFlowMagnitude({ dates: s.dates, series: s.values, networkMeanCms: meanOf(s.values) / 200, hydest: null });
  assert.equal(c.authority, 'network');
  assert.match(c.note, /no independent judge/);
});

/**
 * The office's regression judges when its four inputs are present, and the
 * older one judges when they are not. The two must be distinguishable, or the
 * swap is untestable and silently reversible.
 */
ok('Modified HYDEST takes over as judge when its inputs are supplied', () => {
  const MOD = {
    below3000Km2: 300,
    below5000Km2: 340,
    averageAltitudeM: 2600,
    annualWetnessMm: 2000,
  };
  const target = modifiedHydestAnnualMean(MOD)!;
  const s = shaped(target);
  const mean = meanOf(s.values);
  // The model sits on the office regression's annual mean; the network is 20x low.
  const c = chooseFlowMagnitude({
    dates: s.dates,
    series: s.values.map((v) => (v * target) / mean),
    networkMeanCms: target / 20,
    hydest: HYDEST,
    modified: MOD,
  });
  assert.equal(c.authority, 'model');
  assert.ok(
    c.judgeCms != null && Math.abs(c.judgeCms - target) / target < 1e-9,
    `judge should be the Modified HYDEST mean ${target}, got ${c.judgeCms}`
  );
});

/**
 * When the two global sources agree, the magnitude is now their geometric mean
 * with the regional regression rather than the network alone. The factor must
 * be the geometric mean's ratio exactly, and must be absent when the regression
 * has nothing to say — otherwise the blend is silently either always or never
 * applied, and both failures look like working software.
 */
ok('agreement blends the network with the regional estimate', () => {
  const MOD = {
    below3000Km2: 300,
    below5000Km2: 340,
    averageAltitudeM: 2600,
    annualWetnessMm: 2000,
  };
  const regional = modifiedHydestAnnualMean(MOD)!;
  const s = shaped(regional);
  const network = meanOf(s.values) * 1.5; // inside the 3x agreement range
  const c = chooseFlowMagnitude({
    dates: s.dates,
    series: s.values,
    networkMeanCms: network,
    hydest: HYDEST,
    modified: MOD,
  });
  assert.equal(c.authority, 'network');
  /**
   * The blend carries its measured bias correction.
   *
   * The geometric mean of the two sources reads 0.8727× against 69 DHM gauges,
   * so the shipped magnitude includes the constant that recentres it. Asserting
   * the raw geometric mean would pin the engine to a figure it is measured to
   * be systematically low on.
   */
  const want = (Math.sqrt(network * regional) * BLEND_BIAS_CORRECTION) / network;
  assert.ok(
    c.magnitudeFactor != null && Math.abs(c.magnitudeFactor - want) / want < 1e-12,
    `factor should be ${want}, got ${c.magnitudeFactor}`
  );

  // Without the regression there is nothing to blend, and nothing must change.
  const plain = chooseFlowMagnitude({
    dates: s.dates,
    series: s.values,
    networkMeanCms: network,
    hydest: HYDEST,
  });
  assert.equal(plain.magnitudeFactor, undefined);
});

function meanOf(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

console.log(`\n${passed} flowchoice checks passed\n`);
