/**
 * Runnable check for the energy / FDC math.  `npm run check`
 *
 * No test framework on purpose — node's own assert, run through node's TS stripper.
 * If the physics breaks, this fails.
 */
import assert from 'node:assert/strict';
import {
  RHO,
  G,
  HOURS_PER_YEAR,
  CFS_TO_CMS,
  BENCHMARK,
  buildFdc,
  flowAtExceedance,
  powerW,
  minMonthlyMean,
  netHead,
  residualForBasis,
  turbineFlow,
  annualEnergy,
  energyFromFdcTrapezoid,
  seasonalRatio,
  wetDryEnergy,
  haversineKm,
  type PlantParams,
} from '../src/engine/hydro.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};
/** Relative closeness. 1e-3 absorbs any legitimate rho/g convention choice (0.064% spread). */
const near = (a: number, b: number, relTol = 1e-3, what = '') =>
  assert.ok(
    Math.abs(a - b) <= relTol * Math.abs(b),
    `${what}: ${a} not within ${relTol * 100}% of ${b}`
  );

console.log('\nP = rho*g*Q*H*eta');

ok('constants are the ESHA convention', () => {
  assert.equal(RHO, 1000);
  assert.equal(G, 9.81);
  assert.equal(RHO * G, 9810);
});

ok('worked example: Q=10, H=50, eta=0.85 -> 4,169,250 W', () => {
  const p = powerW(10, 50, 0.85);
  assert.equal(p, 4169250);
  assert.equal(p / 1e3, 4169.25); // kW
  assert.equal(p / 1e6, 4.16925); // MW
});

ok('hydraulic ceiling at eta=1 is 4.905 MW', () => {
  assert.equal(powerW(10, 50, 1.0), 4905000);
});

ok('P is linear in Q, H and eta (100x in -> 100x out)', () => {
  near(powerW(100, 500, 0.85), 100 * 100 * powerW(1, 5, 0.85), 1e-12);
  assert.equal(powerW(100, 500, 0.85), 416925000);
});

ok('degenerate inputs give exactly 0, never NaN', () => {
  assert.equal(powerW(0, 50, 0.85), 0);
  assert.equal(powerW(10, 0, 0.85), 0);
  assert.equal(powerW(-5, 50, 0.85), 0); // negative discharge at tidal gauges
});

ok('E = P * 8760 -> 36.52263 GWh/yr, and MWh/GWh conversions line up', () => {
  const kW = powerW(10, 50, 0.85) / 1e3;
  const kWh = kW * HOURS_PER_YEAR;
  assert.equal(kWh, 36522630);
  near(kWh / 1e3, 36522.63, 1e-12, 'MWh');
  near(kWh / 1e6, 36.52263, 1e-12, 'GWh');
  // The GWh/yr = MW * 8.76 * CF shortcut identity.
  near(4.16925 * 8.76 * 1.0, 36.52263, 1e-12, 'shortcut identity');
});

console.log('\nunit conversions');

ok('ft3/s -> m3/s factor is 0.3048^3 to 10 significant figures', () => {
  near(CFS_TO_CMS, 0.3048 ** 3, 1e-9);
});

ok('a real USGS reading converts correctly', () => {
  // Potomac 01646500, 2026-08-10, 2480 ft3/s (measured, this session).
  near(2480 * CFS_TO_CMS, 70.2258, 1e-5);
});

console.log('\nreal-plant back-check: ' + BENCHMARK.name);

ok('published capacity implies a credible overall efficiency', () => {
  const hydraulicW = RHO * G * BENCHMARK.designFlowCms * BENCHMARK.netHeadM;
  const impliedEta = (BENCHMARK.capacityMW * 1e6) / hydraulicW;
  near(hydraulicW / 1e6, 24.829, 1e-3, 'hydraulic MW');
  near(impliedEta, 0.890, 5e-3, 'implied eta');
  // Sanity band for turbine x generator x transformer.
  assert.ok(impliedEta > 0.75 && impliedEta < 0.95, `eta ${impliedEta} outside plausible band`);
});

ok('published generation implies a credible plant factor', () => {
  const pf = (BENCHMARK.annualEnergyGWh * 1e9) / (BENCHMARK.capacityMW * 1e6 * HOURS_PER_YEAR);
  near(pf, 0.712, 5e-3, 'plant factor');
  assert.ok(pf > 0.3 && pf < 0.95, `plant factor ${pf} outside plausible run-of-river band`);
});

ok('our own annualEnergy reproduces the benchmark from a synthetic steady record', () => {
  // A river holding exactly the design flow all year, with the plant's implied efficiency,
  // must return the published capacity as rated power.
  const impliedEta = (BENCHMARK.capacityMW * 1e6) / (RHO * G * BENCHMARK.designFlowCms * BENCHMARK.netHeadM);
  const params: PlantParams = {
    grossHeadM: BENCHMARK.netHeadM, // treat as net by zeroing losses
    headLossFrac: 0,
    efficiency: impliedEta,
    designFlowCms: BENCHMARK.designFlowCms,
    residualFlowCms: 0,
    minFlowFrac: 0,
  };
  const r = annualEnergy(new Array(365).fill(BENCHMARK.designFlowCms), params);
  near(r.ratedPowerW / 1e6, BENCHMARK.capacityMW, 1e-6, 'rated MW');
  near(r.grossPlantFactor, 1.0, 1e-9, 'plant factor at steady design flow');
  near(r.gwhPerYear, BENCHMARK.capacityMW * 8.76, 1e-6, 'GWh at CF=1');
});

console.log('\nflow-duration curve');

const series = [10, 8, 6, 4, 2]; // m3/s

ok('FDC is sorted descending with Weibull exceedance m/(n+1)', () => {
  const fdc = buildFdc(series);
  assert.deepEqual(fdc.map((d) => d.q), [10, 8, 6, 4, 2]);
  assert.deepEqual(fdc.map((d) => d.p), [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]);
});

ok('the USGS -999999 sentinel is dropped, not sorted into the low-flow tail', () => {
  const fdc = buildFdc([10, 8, -999999, 6, 4, 2]);
  assert.equal(fdc.length, 5);
  assert.equal(Math.min(...fdc.map((d) => d.q)), 2);
  // The bug this guards: a sentinel would become the P90 flow and zero the firm energy.
  assert.ok(flowAtExceedance(fdc, 0.9) > 0);
});

ok('NaN and Infinity are dropped too', () => {
  assert.equal(buildFdc([1, NaN, 2, Infinity, 3]).length, 3);
});

ok('an empty or all-sentinel record yields an empty FDC, not a crash', () => {
  assert.deepEqual(buildFdc([]), []);
  assert.deepEqual(buildFdc([-999999, -999999]), []);
  assert.ok(Number.isNaN(flowAtExceedance([], 0.5)));
});

ok('Q50 of the 5-point series is the median, by construction', () => {
  near(flowAtExceedance(buildFdc(series), 0.5), 6, 1e-12);
});

ok('exceedance interpolates monotonically and clamps outside the range', () => {
  const fdc = buildFdc(series);
  const q10 = flowAtExceedance(fdc, 0.1);
  const q40 = flowAtExceedance(fdc, 0.4);
  const q90 = flowAtExceedance(fdc, 0.9);
  assert.ok(q10 >= q40 && q40 >= q90, 'FDC must be non-increasing in exceedance');
  assert.equal(q10, 10); // clamped to the first point
  assert.equal(q90, 2); // clamped to the last
});

ok('a 3650-day record gives a strictly non-increasing curve', () => {
  const rnd = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
  const big = Array.from({ length: 3650 }, () => 0.5 + 40 * rnd() ** 3);
  const fdc = buildFdc(big);
  assert.equal(fdc.length, 3650);
  for (let i = 1; i < fdc.length; i++) {
    assert.ok(fdc[i].q <= fdc[i - 1].q, `not descending at ${i}`);
    assert.ok(fdc[i].p > fdc[i - 1].p, `exceedance not increasing at ${i}`);
  }
});

console.log('\nturbine constraints');

const base: PlantParams = {
  grossHeadM: 100,
  headLossFrac: 0.05,
  efficiency: 0.85,
  designFlowCms: 10,
  residualFlowCms: 1,
  minFlowFrac: 0.2,
};

ok('net head applies the loss fraction', () => {
  near(netHead(base), 95, 1e-12);
});

ok('residual flow is subtracted before the turbine cap', () => {
  near(turbineFlow(5, base), 4, 1e-12); // 5 - 1 residual
});

ok('flow above design is capped at design, not passed through', () => {
  assert.equal(turbineFlow(500, base), 10);
});

ok('below the minimum operating flow the turbine stops (0, not a trickle)', () => {
  // 2.9 - 1 = 1.9 < 0.2*10 = 2  -> off
  assert.equal(turbineFlow(2.9, base), 0);
  // 3.1 - 1 = 2.1 > 2 -> on
  near(turbineFlow(3.1, base), 2.1, 1e-12);
});

ok('a river below the residual flow yields nothing', () => {
  assert.equal(turbineFlow(0.5, base), 0);
  assert.equal(turbineFlow(0, base), 0);
});

console.log('\nannual energy');

ok('the two integration methods agree (mean-of-days vs FDC trapezoid)', () => {
  const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
  const record = Array.from({ length: 7300 }, () => 0.2 + 30 * rnd() ** 2.5);
  const exact = annualEnergy(record, base).gwhPerYear;
  const trapz = energyFromFdcTrapezoid(buildFdc(record), base);
  assert.ok(exact > 0, 'expected non-zero energy');
  near(trapz, exact, 5e-3, 'trapezoid vs mean-of-days');
});

ok('gross plant factor is bounded by 1 and matches energy/rated', () => {
  const record = Array.from({ length: 365 }, (_, i) => 2 + 20 * Math.abs(Math.sin(i / 58)));
  const r = annualEnergy(record, base);
  assert.ok(r.grossPlantFactor > 0 && r.grossPlantFactor <= 1, `pf=${r.grossPlantFactor}`);
  near(r.gwhPerYear, (r.ratedPowerW * HOURS_PER_YEAR * r.grossPlantFactor) / 1e9, 1e-9);
});

ok('a dry river yields zero energy and zero utilisation, not NaN', () => {
  const r = annualEnergy(new Array(365).fill(0), base);
  assert.equal(r.gwhPerYear, 0);
  assert.equal(r.utilisationFrac, 0);
  assert.ok(Number.isFinite(r.grossPlantFactor));
});

ok('an empty record yields zeros, not NaN (station with no discharge data)', () => {
  const r = annualEnergy([], base);
  assert.equal(r.gwhPerYear, 0);
  assert.ok(Number.isFinite(r.ratedPowerW));
});

ok('raising residual flow can only reduce energy', () => {
  const record = Array.from({ length: 1000 }, (_, i) => 1 + 15 * ((i % 97) / 97));
  const low = annualEnergy(record, { ...base, residualFlowCms: 0 }).gwhPerYear;
  const high = annualEnergy(record, { ...base, residualFlowCms: 5 }).gwhPerYear;
  assert.ok(high < low, `residual flow increased energy: ${high} >= ${low}`);
});

ok('oversizing the turbine cannot raise the plant factor', () => {
  const record = Array.from({ length: 1000 }, (_, i) => 1 + 15 * ((i % 97) / 97));
  const small = annualEnergy(record, { ...base, designFlowCms: 5 });
  const big = annualEnergy(record, { ...base, designFlowCms: 40 });
  assert.ok(big.gwhPerYear >= small.gwhPerYear, 'more capacity should not yield less energy');
  assert.ok(big.grossPlantFactor < small.grossPlantFactor, 'bigger turbine must dilute plant factor');
});

console.log('\nresidual flow basis');

ok('on a monsoon river, 10% of the annual mean exceeds the dry-season flow', () => {
  // Synthetic Nepal-like year: heavy monsoon Jun-Sep, thin dry season.
  const dates: string[] = [];
  const vals: number[] = [];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 28; d++) {
      dates.push(`2020-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      vals.push(m >= 6 && m <= 9 ? 300 : 5);
    }
  }
  // mean = (4*300 + 8*5)/12 = 103.33 -> 10% = 10.33, which is MORE than the whole
  // 5 m3/s dry-season flow. That is the failure mode this default guards against.
  const annual = residualForBasis('meanAnnual', dates, vals);
  const minMon = residualForBasis('minMonth', dates, vals);
  const dryFlow = 5;
  assert.ok(annual > dryFlow, `temperate basis ${annual} should exceed dry-season flow ${dryFlow}`);
  assert.ok(minMon < dryFlow, `min-month basis ${minMon} should stay below ${dryFlow}`);
  near(minMon, 0.5, 1e-9, 'minMonth residual');
  assert.ok(minMon < annual, 'min-month basis must be the smaller of the two here');
});

ok('minMonthlyMean picks the lowest month, not the lowest day', () => {
  const dates: string[] = [];
  const vals: number[] = [];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 28; d++) {
      dates.push(`2021-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      // March holds a single very low day but a high monthly mean.
      vals.push(m === 3 ? (d === 1 ? 0.1 : 90) : m === 11 ? 5 : 50);
    }
  }
  near(minMonthlyMean(dates, vals), 5, 1e-9);
});

ok('manual basis derives nothing', () => {
  assert.ok(Number.isNaN(residualForBasis('manual', ['2020-01-01'], [10])));
});

console.log('\nwet/dry PPA season split');

ok('wet + dry energy sums back to the annual total', () => {
  const dates: string[] = [];
  const vals: number[] = [];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 28; d++) {
      dates.push(`2022-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      vals.push(m >= 6 && m <= 9 ? 40 : 6);
    }
  }
  const { wetGwh, dryGwh, wetDays, dryDays } = wetDryEnergy(dates, vals, base);
  const total = annualEnergy(vals, base).gwhPerYear;
  near(wetGwh + dryGwh, total, 1e-9, 'seasonal split vs annual total');
  assert.equal(wetDays + dryDays, dates.length);
  assert.ok(wetGwh > dryGwh, 'monsoon energy should land in the wet season');
});

ok('season boundaries fall mid-April and mid-December, not on month ends', () => {
  const d = ['2022-04-14', '2022-04-15', '2022-12-14', '2022-12-15'];
  const v = [10, 10, 10, 10];
  const { wetDays, dryDays } = wetDryEnergy(d, v, base);
  assert.equal(wetDays, 2, 'Apr 15 and Dec 14 are wet');
  assert.equal(dryDays, 2, 'Apr 14 and Dec 15 are dry');
});

console.log('\nseasonality and geometry');

ok('monsoon/dry ratio picks the right months', () => {
  const dates: string[] = [];
  const vals: number[] = [];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 28; d++) {
      dates.push(`2020-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      vals.push(m === 7 ? 100 : m === 2 ? 5 : 20);
    }
  }
  const s = seasonalRatio(dates, vals);
  assert.equal(s.wettestMonth, 6); // July, 0-indexed
  assert.equal(s.driestMonth, 1); // February
  near(s.ratio, 20, 1e-9);
});

ok('haversine matches a known separation', () => {
  // Potomac gauge -> Washington DC, ~11 km.
  const d = haversineKm([38.94977778, -77.12763889], [38.9072, -77.0369]);
  assert.ok(d > 8 && d < 14, `got ${d} km`);
  assert.equal(haversineKm([10, 20], [10, 20]), 0);
});

console.log(`\n${passed} checks passed\n`);
