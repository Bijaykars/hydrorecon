/**
 * MHSP is checked against a real licensing-stage workbook, not against itself.
 *
 * The reference is the Dorje Khola HPP "Q45 Power Calculation" sheet: a 7.37 km²
 * catchment, 2000 mm annual wetness index, whose consultant computed all twelve
 * monthly flows in Excel. If a coefficient here is ever mistyped, these twelve
 * numbers stop matching to 1e-6 and this check fails.
 */
import assert from 'node:assert/strict';
import { mhspScreen, mhspFlowAtExceedance } from '../src/engine/mhsp.ts';

const A = 7.365741936216001;
const MMP = 0.8 * 2000; // the workbook's convention: monsoon = 80% of annual

// Every monthly flow the workbook's own cells produced.
const WORKBOOK = [
  0.17512927266588416, 0.13876007640914292, 0.12144652055225988, 0.1202366514803904,
  0.08205620296618155, 0.4421123221165212, 1.4017524001315838, 1.7423849107960983,
  1.4179373895545744, 0.7087670514201903, 0.33851496028578437, 0.21301034647807152,
];

const s = mhspScreen(A, MMP);
assert.ok(s, 'MHSP returned nothing for a valid catchment');
assert.equal(s.months.length, 12);
s.months.forEach((q, i) => {
  assert.ok(
    Math.abs(q - WORKBOOK[i]) < 1e-9,
    `month ${i + 1}: got ${q}, workbook ${WORKBOOK[i]}`
  );
});
assert.ok(Math.abs(s.driest.cms - 0.08205620296618155) < 1e-9, 'driest month');
assert.equal(s.driest.month, 4, 'May is the driest month here');

// The workbook's own unused Q45 regression, on the same sheet, cell G42:J42.
assert.ok(
  Math.abs(s.fdc.find((p) => p.p === 0.45)!.cms - 0.24998537227789688) < 1e-9,
  'Q45 from the NEA daily flow-duration regression'
);

// Monotone: a flow exceeded more often is smaller.
for (let i = 1; i < s.fdc.length; i++) {
  assert.ok(s.fdc[i].cms < s.fdc[i - 1].cms, `FDC not monotone at ${s.fdc[i].p}`);
}

// Interpolation lands on published points exactly, and stays between them.
assert.ok(Math.abs(mhspFlowAtExceedance(A, 0.45, MMP)! - 0.24998537227789688) < 1e-9);
const q55 = mhspFlowAtExceedance(A, 0.55, MMP)!;
const q45 = mhspFlowAtExceedance(A, 0.45, MMP)!;
const q65 = mhspFlowAtExceedance(A, 0.65, MMP)!;
assert.ok(q65 < q55 && q55 < q45, 'Q55 must sit between Q45 and Q65');

// Without rainfall, the five rainfall-free months still answer — and are unchanged.
const dry = mhspScreen(A);
assert.ok(dry, 'MHSP should answer the dry season without a rainfall layer');
assert.equal(dry.months.length, 5, 'only Jan-May are rainfall-free');
assert.ok(Number.isNaN(dry.annualMeanCms), 'five months is not an annual mean');
dry.months.forEach((q, i) => {
  assert.ok(Math.abs(q - WORKBOOK[i]) < 1e-9, `dry-season month ${i + 1} drifted`);
});
// Three of six FDC points need no rainfall either.
assert.equal(dry.fdc.length, 3);

assert.equal(mhspScreen(0), null, 'a zero catchment has no flow');
assert.equal(mhspScreen(-1), null);

console.log('mhsp.check: OK — reproduces the Dorje Khola workbook to 1e-9');
