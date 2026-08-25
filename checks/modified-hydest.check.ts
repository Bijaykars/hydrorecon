/**
 * Does our Modified HYDEST reproduce the office's spreadsheet exactly?
 *
 *   node --experimental-strip-types --no-warnings checks/modified-hydest.check.ts
 *
 * The expected values below are not hand-computed and not taken from a paper.
 * They are the numbers Excel itself had cached in the workbook's own cells for
 * the Dorje Khola project, read straight out of the sheet XML. So this compares
 * our arithmetic against the arithmetic that is actually run in the office,
 * which is the only comparison that settles whether an engineer using both will
 * see the same figure.
 *
 * A transcription error in a coefficient is the failure this guards against.
 * There are eighty of them and they are the kind of thing that produces a
 * plausible-looking flow which is quietly wrong, forever.
 */
import assert from 'node:assert';
import {
  modifiedHydestAnnualMean,
  modifiedHydestFdc,
  modifiedHydestMonthly,
  modifiedHydestQ45,
  type ModifiedHydestInput,
} from '../src/engine/modified-hydest.ts';

/** Workbook cells B8, B9, B10, B11 for the Dorje Khola Hydropower Project. */
const DORJE: ModifiedHydestInput = {
  below3000Km2: 7243042.8042000001 / 1e6,
  below5000Km2: (7243042.8042000001 + 122699.132016) / 1e6,
  averageAltitudeM: 2624.761814,
  annualWetnessMm: 2000,
};

/** Cached results from cells B51:B56 — the months Excel had evaluated. */
const MONTHLY_EXPECTED: Record<string, number> = {
  Jul: 3.1239580574500296,
  Aug: 4.5475186029776262,
  Sep: 3.0735236733286095,
  Oct: 1.586735038647362,
  Nov: 0.7943254755870176,
  Dec: 0.54967120898614186,
};

/** Cached results from cells B66:B69 — the flow-duration points. */
const FDC_EXPECTED: Record<number, number> = {
  0.4: 0.92431160918437449,
  0.6: 0.51238532073516074,
  0.8: 0.37159582470589309,
  0.95: 0.25875583497196042,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthly = modifiedHydestMonthly(DORJE);
assert.ok(monthly, 'the four workbook inputs must produce twelve monthly flows');

for (const [name, want] of Object.entries(MONTHLY_EXPECTED)) {
  const got = monthly[MONTHS.indexOf(name)];
  const rel = Math.abs(got - want) / want;
  assert.ok(rel < 1e-9, `${name}: got ${got}, workbook says ${want} (relative ${rel.toExponential(2)})`);
}

const fdc = modifiedHydestFdc(DORJE);
assert.ok(fdc, 'the four workbook inputs must produce a flow-duration curve');
for (const [p, want] of Object.entries(FDC_EXPECTED)) {
  const got = fdc.find((x) => x.p === Number(p))?.cms;
  assert.ok(got != null, `no flow-duration point at ${p}`);
  const rel = Math.abs(got - want) / want;
  assert.ok(rel < 1e-9, `Q${Number(p) * 100}: got ${got}, workbook says ${want}`);
}

/**
 * The workbook reads Q45 as Q60 + (Q60 - Q40)/20 * (45 - 60), which is straight
 * interpolation between the Q40 and Q60 rows. Reproduce that exact expression
 * from the cached endpoints and require our own interpolation to agree.
 */
const q40 = FDC_EXPECTED[0.4];
const q60 = FDC_EXPECTED[0.6];
const q45Workbook = q60 + ((q60 - q40) / 20) * (45 - 60);
const q45 = modifiedHydestQ45(DORJE);
assert.ok(q45 != null, 'Q45 must be available');
assert.ok(
  Math.abs(q45 - q45Workbook) / q45Workbook < 1e-9,
  `Q45: got ${q45}, workbook interpolation gives ${q45Workbook}`
);

/** Missing inputs must return null rather than a confident wrong number. */
assert.equal(modifiedHydestMonthly({ ...DORJE, averageAltitudeM: 0 }), null);
assert.equal(modifiedHydestQ45({ ...DORJE, annualWetnessMm: 0 }), null);

/**
 * March to May take the root form and must not move when elevation or rainfall
 * changes. This is the structural claim of the method, not an accident of the
 * numbers, so it is asserted rather than assumed.
 */
const wetter = modifiedHydestMonthly({ ...DORJE, annualWetnessMm: 4000, averageAltitudeM: 4000 });
assert.ok(wetter);
for (const m of ['Mar', 'Apr', 'May']) {
  const i = MONTHS.indexOf(m);
  assert.equal(wetter[i], monthly[i], `${m} must depend on area alone`);
}
assert.ok(wetter[MONTHS.indexOf('Jul')] > monthly[MONTHS.indexOf('Jul')], 'July must respond to rain');

const annual = modifiedHydestAnnualMean(DORJE);
assert.ok(annual && annual > 0);

console.log('modified-hydest.check ok');
console.log(`  Dorje Khola: annual mean ${annual.toFixed(3)} m3/s, Q45 ${q45.toFixed(4)} m3/s`);
console.log(`  10 monthly and flow-duration cells reproduced to better than 1e-9`);
