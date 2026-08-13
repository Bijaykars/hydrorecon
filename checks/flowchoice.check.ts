/**
 * Flow authority.  part of `npm run check`
 *
 * The chooser decides which global model an entire study's magnitude rests on,
 * so the wrong branch here understates a river two-hundred-fold or resurrects
 * an off-channel cell the app already learned to discard. Both historical
 * failures are pinned as cases.
 */
import assert from 'node:assert/strict';
import { chooseFlowMagnitude, DISAGREE_RATIO } from '../src/engine/flowchoice.ts';
import { annualMeanCms, driestMonthFlow } from '../src/engine/hydest.ts';

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

ok('when both global sources fail an annual-capable judge, the regression takes over', () => {
  // With MMP the judge states a full annual mean. Make the model 6x above it
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
  assert.match(c.note, /both global sources fail/);
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

function meanOf(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

console.log(`\n${passed} flowchoice checks passed\n`);
