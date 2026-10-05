import assert from 'node:assert/strict';
import { analogueFlow, type FlowDonor } from '../src/engine/flow-analogue.ts';
import { compareFlowMagnitudes, comparisonCsv, comparisonSeriesMean } from '../src/engine/flow-comparison.ts';
import { evaluate, type SchemeInput } from '../src/engine/discover.ts';
const target = { area: 100, rain: 1500, elevation: 1800, low: 0.8, high: 0.05 };
const donors: FlowDonor[] = Array.from({ length: 7 }, (_, k) => ({ ...target, area: 50 + k * 10, truth: (50 + k * 10) * 0.03,
  id: String(k), river: 'Test', lat: 28, lon: 84, years: 12, from: 2000, to: 2011 }));
const estimate = analogueFlow(target, donors)!;
assert.ok(Math.abs(estimate.meanCms - 3) < 1e-10, 'Known identical specific runoff transfers exactly');
assert.equal(estimate.donors.length, 5);
assert.ok(Math.abs(estimate.donors.reduce((sum, d) => sum + d.weight, 0) - 1) < 1e-12);
assert.ok(estimate.donors.every((d, k) => !k || d.distance >= estimate.donors[k - 1].distance));
assert.equal(analogueFlow({ ...target, rain: NaN }, donors), null);
assert.equal(analogueFlow({ ...target, low: 0.9, high: 0.2 }, donors), null);
assert.equal(analogueFlow(target, donors.slice(0, 4)), null);
assert.equal(analogueFlow({ ...target, area: 10000 }, donors)?.weakMatch, true);
const input: SchemeInput = { path: Array.from({ length: 61 }, (_, k) => ({ km: k / 10, lat: 28 - k / 10000, lon: 84, elevationM: 2000 - 5 * k, meanCms: 2 })),
  series: Array.from({ length: 365 }, (_, k) => 8 + 4 * Math.sin(k / 365 * 2 * Math.PI)), seriesMeanCms: 2,
  residualCms: 0.4, exceedance: 0.4, efficiency: 0.9, headLossFrac: 0.05, minFlowFrac: 0.2, intakeWindowKm: 0, maxWaterwayKm: 6 };
// A measured record uses a network-reference denominator; its true mean is 8.
const chosen = evaluate(input, 0, 40)!;
const before = JSON.stringify(input);
const actualMean = comparisonSeriesMean(input);
assert.ok(Math.abs(actualMean - 8) < 1e-12);
const rows = compareFlowMagnitudes(input, chosen, [
  { id: 'equal', name: 'Same, "record"', meanCms: actualMean, note: 'Test' },
  { id: 'twice', name: 'Twice', meanCms: actualMean * 2, note: 'Test' },
  { id: 'bad', name: 'Missing', meanCms: NaN, note: 'Test' },
]);
assert.equal(rows.length, 2);
assert.ok(Math.abs(rows[0].scheme!.capacityMW - chosen.capacityMW) < 1e-9);
assert.ok(Math.abs(rows[0].scheme!.energyGwh - chosen.energyGwh) < 1e-9);
assert.ok(Math.abs(rows[1].scheme!.designFlowCms / chosen.designFlowCms - 2) < 1e-12);
assert.ok(Math.abs(rows[1].scheme!.residualCms / chosen.residualCms - 2) < 1e-12, 'Release rule follows the river magnitude');
assert.equal(rows[1].scheme!.grossHeadM, chosen.grossHeadM);
assert.equal(rows[1].scheme!.waterwayKm, chosen.waterwayKm);
assert.deepEqual(rows[1].scheme!.intake, chosen.intake);
assert.equal(JSON.stringify(input), before, 'Comparison never modifies active inputs');
const csv = comparisonCsv(rows, chosen);
assert.ok(csv.includes('"Same, ""record"""'));
assert.ok(csv.includes('comparison only'));
assert.ok(csv.includes('Net head m'));
console.log('Flow comparison: analogue transfer, invalid/weak matches, measured-record normalization, hydraulic recalculation, release scaling, fixed geometry and CSV passed.');
