/**
 * HYDEST — Nepal's national ungauged-flow regression.  part of `npm run check`
 *
 * The coefficients are transcribed from a published table, so the first job is
 * proving the transcription is faithful and the algebra around it is right. The
 * second is proving the method behaves the way the hydrology says it should:
 * more catchment means more water, and catchment above the snowline does not
 * count towards dry-season flow, which is the entire reason the method needs
 * hypsometry and the entire reason a total-area shortcut had to be abandoned.
 */
import assert from 'node:assert/strict';
import {
  RAINFALL_FREE_MONTHS,
  RETURN_PERIODS,
  designFlood,
  driestMonthFlow,
  drySeasonAgreement,
  drySeasonFlows,
  monthlyFlow,
  MONTH_NAMES,
} from '../src/engine/hydest.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};
const near = (a: number, b: number, tol: number, what = '') =>
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} != ${b} (tol ${tol})`);

console.log('\nhydest: the coefficient table as published');

ok('only the five rainfall-free months are answered, and they are Jan-May', () => {
  assert.deepEqual(
    RAINFALL_FREE_MONTHS.map((m) => MONTH_NAMES[m]),
    ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
    'the months with a zero precipitation exponent'
  );
  // Every monsoon month must refuse rather than guess at MMP.
  for (let m = 5; m <= 11; m++) {
    assert.equal(
      monthlyFlow({ totalKm2: 1000, below5000Km2: 1000, below3000Km2: 800 }, m),
      null,
      `${MONTH_NAMES[m]} must not be answered without precipitation data`
    );
  }
});

ok('January reproduces the published equation by hand', () => {
  // Q_Jan = 0.0142 · (A_below5000 + 1)^0.9777, no other term.
  const q = monthlyFlow({ totalKm2: 1000, below5000Km2: 1000, below3000Km2: 700 }, 0)!;
  near(q, 0.0142 * 1001 ** 0.9777, 1e-12, 'Jan');
  // A_total must not enter: its exponent is zero for this month.
  const same = monthlyFlow({ totalKm2: 99999, below5000Km2: 1000, below3000Km2: 700 }, 0)!;
  near(same, q, 1e-12, 'A_total leaked into a month whose exponent is zero');
});

console.log('\nhydest: does it behave like hydrology?');

ok('more catchment below the snowline means more dry-season water', () => {
  let prev = 0;
  for (const a of [10, 50, 200, 1000, 5000, 20000]) {
    const q = monthlyFlow({ totalKm2: a, below5000Km2: a, below3000Km2: a * 0.8 }, 0)!;
    assert.ok(q > prev, `${a} km2 gave ${q}, no more than the smaller catchment`);
    prev = q;
  }
});

ok('dry-season yield lands where a Nepali mid-hill catchment sits', () => {
  // Specific discharge in litres per second per km2 — the figure a hydrologist
  // would sanity-check first. Nepal's dry-season yield runs single digits to
  // mid-teens; an order-of-magnitude transcription slip would leave this band.
  for (const a of [100, 1000, 5000]) {
    const q = monthlyFlow({ totalKm2: a, below5000Km2: a, below3000Km2: a }, 0)!;
    const lps = (q / a) * 1000;
    assert.ok(lps > 3 && lps < 20, `${a} km2 yields ${lps.toFixed(1)} l/s/km2 in January`);
  }
});

ok('a high-altitude catchment is not credited with dry-season flow it has not got', () => {
  // This is the failure that made the hypsometry pipeline necessary. A
  // trans-Himalayan catchment lying almost entirely above 5000 m must produce
  // far less than the same area in the mid-hills — using total area as a stand-in
  // once put January at 85% of the annual mean on a monsoon river.
  const area = 500;
  const midHill = monthlyFlow({ totalKm2: area, below5000Km2: area, below3000Km2: 400 }, 0)!;
  const transHim = monthlyFlow({ totalKm2: area, below5000Km2: area * 0.05, below3000Km2: 0 }, 0)!;
  assert.ok(
    transHim < midHill / 10,
    `high catchment gave ${transHim.toFixed(2)} against ${midHill.toFixed(2)} m3/s`
  );
});

ok('the driest month is found, and it is one of the five', () => {
  const input = { totalKm2: 1200, below5000Km2: 900, below3000Km2: 600 };
  const all = drySeasonFlows(input);
  assert.equal(all.length, 5, 'five answerable months');
  const driest = driestMonthFlow(input)!;
  assert.ok(driest, 'a driest month must be identifiable');
  for (const m of all) assert.ok(m.cms >= driest.cms - 1e-12, `${MONTH_NAMES[m.month]} is drier`);
  // Nepal's dry season bottoms out in the pre-monsoon months, not in January.
  assert.ok(
    ['Feb', 'Mar', 'Apr', 'May'].includes(MONTH_NAMES[driest.month]),
    `driest month came out as ${MONTH_NAMES[driest.month]}`
  );
});

console.log('\nhydest: design floods');

ok('the two-point log-normal fit returns its own anchors exactly', () => {
  // sigma is defined as ln(Q100/Q2)/2.326, so evaluating at S=0 and S=2.326
  // must give back Q2 and Q100 with no drift. If this identity fails the
  // return-period algebra is wrong, whatever the numbers look like.
  const input = { totalKm2: 900, below5000Km2: 800, below3000Km2: 700 };
  const a = input.below3000Km2;
  near(designFlood(input, 2)!, 1.8767 * (a + 1) ** 0.8737, 1e-9, 'Q2');
  near(designFlood(input, 100)!, 14.63 * (a + 1) ** 0.7342, 1e-9, 'Q100');
});

ok('a rarer flood is always a bigger one', () => {
  const input = { totalKm2: 900, below5000Km2: 800, below3000Km2: 700 };
  let prev = 0;
  for (const t of RETURN_PERIODS) {
    const q = designFlood(input, t)!;
    assert.ok(q > prev, `Q${t} = ${q} is not above Q of the shorter return period`);
    prev = q;
  }
});

ok('flood peaks are plausible for a Nepali catchment', () => {
  // Nepali rivers are flashy: a 100-year peak of roughly 1-4 m3/s per km2 on a
  // mid-sized catchment. Well outside that and a coefficient has been mistyped.
  for (const a of [100, 1000, 5000]) {
    const q100 = designFlood({ totalKm2: a, below5000Km2: a, below3000Km2: a }, 100)!;
    const perKm2 = q100 / a;
    assert.ok(perKm2 > 0.8 && perKm2 < 8, `${a} km2 gives ${perKm2.toFixed(2)} m3/s/km2 at Q100`);
  }
  // Snow and ice above 3000 m add annual volume but not a rainfall flood peak,
  // so a glaciated catchment must give a smaller peak than a rain-fed one.
  const rainFed = designFlood({ totalKm2: 800, below5000Km2: 800, below3000Km2: 800 }, 100)!;
  const glaciated = designFlood({ totalKm2: 800, below5000Km2: 300, below3000Km2: 100 }, 100)!;
  assert.ok(glaciated < rainFed, 'high catchment should not flood harder than a rain-fed one');
});

console.log('\nhydest: disagreement is surfaced, not averaged away');

ok('a factor-of-two gap is the line between agreeing and not', () => {
  assert.equal(drySeasonAgreement(10, 10)!.agree, true);
  assert.equal(drySeasonAgreement(10, 19)!.agree, true);
  assert.equal(drySeasonAgreement(10, 21)!.agree, false);
  // The ratio is symmetric — which source is larger must not change the verdict.
  near(drySeasonAgreement(10, 40)!.ratio, drySeasonAgreement(40, 10)!.ratio, 1e-12);
  assert.equal(drySeasonAgreement(0, 10), null, 'a zero flow cannot be compared');
});

console.log(`\n${passed} hydest checks passed\n`);
