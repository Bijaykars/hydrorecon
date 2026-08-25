/**
 * Runnable check for the energy / FDC math.  `npm run check`
 *
 * No test framework on purpose — node's own assert, run through node's TS stripper.
 * If the physics breaks, this fails.
 */
import assert from 'node:assert/strict';
import { discover, evaluate } from '../src/engine/discover.ts';
import { uncertaintyFor } from '../src/engine/uncertainty.ts';
import { selectTurbine, turbineCurve } from '../src/engine/turbine.ts';
import {
  RHO,
  G,
  HOURS_PER_YEAR,
  CFS_TO_CMS,
  BENCHMARK,
  NEA_ROR_PPA,
  NEPAL_EFLOW_POLICY,
  POWER_DURATION_GUIDANCE,
  buildFdc,
  flowAtExceedance,
  powerW,
  powerDurationSummary,
  ppaReferenceValue,
  enforceNepalEflowFloor,
  minMonthlyMean,
  netHead,
  netHeadAt,
  residualForBasis,
  turbineFlow,
  annualEnergy,
  annualEnergyByYear,
  energyFromFdcTrapezoid,
  valueAtExceedance,
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

ok('head loss follows Q^2, so it is only fully charged at design flow', () => {
  // At design flow the two laws must agree, or rated power would move.
  near(netHeadAt(base, base.designFlowCms), netHead(base), 1e-12, 'at design flow');
  // At half design flow the plant pays a quarter of the design-point loss.
  near(netHeadAt(base, 5), 100 * (1 - 0.05 * 0.25), 1e-12, 'at half design flow');
  // Shut down, the conduit carries nothing and loses nothing.
  near(netHeadAt(base, 0), 100, 1e-12, 'at zero flow');
  // Monotonic: more flow can never mean more head.
  for (let q = 0; q <= 10; q += 0.5) {
    assert.ok(
      netHeadAt(base, q) <= netHeadAt(base, Math.max(0, q - 0.5)) + 1e-12,
      `head rose with flow at ${q}`
    );
  }
});

ok('the Q^2 law raises annual energy, and only on the low-flow days', () => {
  // A monsoon-shaped year: most days sit well below design flow.
  const record = Array.from({ length: 3650 }, (_, d) => {
    const doy = d % 365;
    return 3 + 60 * Math.exp(-((doy - 200) ** 2) / (2 * 45 ** 2));
  });
  // The old flat-fraction behaviour, reproduced by folding the design-point
  // loss into gross head and zeroing the loss term.
  const flat: PlantParams = { ...base, grossHeadM: 100 * 0.95, headLossFrac: 0 };
  const now = annualEnergy(record, base);
  const old = annualEnergy(record, flat);
  assert.ok(now.gwhPerYear > old.gwhPerYear, 'expected the correction to recover energy');
  // Small and one-directional. If this ever exceeds the loss assumption itself
  // the law has been applied to something other than the loss.
  const gain = (now.gwhPerYear - old.gwhPerYear) / old.gwhPerYear;
  assert.ok(gain < base.headLossFrac, `gain ${(gain * 100).toFixed(2)}% exceeds the loss assumption`);
  // Rated power is defined at design flow, where nothing changed.
  near(now.ratedPowerW, old.ratedPowerW, 1e-12, 'rated power moved');
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

ok('daily P90/P95 power dispatches the same residual, Q² loss and efficiency as energy', () => {
  const duration = powerDurationSummary(new Array(365).fill(10), base)!;
  const turbineQ = 9; // 10 river - 1 residual
  const expected = powerW(turbineQ, netHeadAt(base, turbineQ), base.efficiency);
  near(duration.dailyP90W, expected, 1e-12, 'daily P90 power');
  near(duration.dailyP95W, expected, 1e-12, 'daily P95 power');
  assert.equal(duration.zeroOutputFraction, 0);
  assert.equal(duration.days, 365);
});

ok('dry shutdown days drive dependable output to zero and the result cannot claim firm capacity', () => {
  const duration = powerDurationSummary([
    ...new Array(80).fill(10),
    ...new Array(20).fill(1),
  ], base)!;
  assert.equal(duration.dailyP90W, 0);
  assert.equal(duration.dailyP95W, 0);
  assert.equal(duration.zeroOutputFraction, 0.2);
  assert.match(POWER_DURATION_GUIDANCE.reference, /ESHA 2004.*section 3\.7/i);
  assert.match(POWER_DURATION_GUIDANCE.interpretation, /not contractual firm capacity.*availability/i);
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

ok('Nepal environmental-flow scenarios cannot fall below the policy floor', () => {
  assert.equal(enforceNepalEflowFloor(0), 0.1);
  assert.equal(enforceNepalEflowFloor(0.05), 0.1);
  assert.equal(enforceNepalEflowFloor(0.1), 0.1);
  assert.equal(enforceNepalEflowFloor(0.25), 0.25);
  assert.equal(enforceNepalEflowFloor(Number.NaN), 0.1);
});

ok('the Nepal policy metadata preserves the higher-EIA rule and non-claim', () => {
  assert.equal(NEPAL_EFLOW_POLICY.minimumFractionOfLowestMonthlyMean, 0.1);
  assert.match(NEPAL_EFLOW_POLICY.policy, /section 6\.1\.1/i);
  assert.match(NEPAL_EFLOW_POLICY.interpretation, /higher of at least 10%.*EIA-required minimum/i);
  assert.match(NEPAL_EFLOW_POLICY.interpretation, /not an approved ecological-flow determination/i);
  assert.match(NEPAL_EFLOW_POLICY.source, /^https:\/\/doed\.gov\.np\//);
  assert.match(NEPAL_EFLOW_POLICY.lawCommission, /^https:\/\/repository\.lawcommission\.gov\.np\//);
});

console.log('\nwet/dry PPA season split');

ok('published NEA base rates convert seasonal GWh to million NPR without a hidden unit factor', () => {
  const value = ppaReferenceValue(100, 20)!;
  // 100 GWh × 4.8 NPR/kWh + 20 GWh × 8.4 NPR/kWh = NPR 648 million.
  near(value.grossMillionNpr, 648, 1e-12);
  near(value.blendedNprPerKwh, 5.4, 1e-12);
});

ok('zero generation gives zero gross reference value and invalid energy is refused', () => {
  assert.deepEqual(ppaReferenceValue(0, 0), { grossMillionNpr: 0, blendedNprPerKwh: 0 });
  assert.equal(ppaReferenceValue(-1, 2), null);
  assert.equal(ppaReferenceValue(Number.NaN, 2), null);
});

ok('the published-rate metadata forbids automatic escalation and flags the 100 MW boundary', () => {
  assert.equal(NEA_ROR_PPA.wetNprPerKwh, 4.8);
  assert.equal(NEA_ROR_PPA.dryNprPerKwh, 8.4);
  assert.equal(NEA_ROR_PPA.postedRateCapacityUpToMW, 100);
  assert.match(NEA_ROR_PPA.escalation, /not applied/i);
  assert.match(NEA_ROR_PPA.interpretation, /not a PPA entitlement.*NPV.*LCOE/i);
});

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

ok('the NEA 8+4 boundaries fall in mid-April and mid-December', () => {
  const d = ['2022-04-13', '2022-04-14', '2022-12-15', '2022-12-16'];
  const v = [10, 10, 10, 10];
  const { wetDays, dryDays } = wetDryEnergy(d, v, base);
  assert.equal(wetDays, 2, 'Apr 14 and Dec 15 are wet');
  assert.equal(dryDays, 2, 'Apr 13 and Dec 16 are dry');
});

ok('the alternative NEA 6+6 boundaries run from late May through November', () => {
  const d = ['2022-05-29', '2022-05-30', '2022-11-30', '2022-12-01'];
  const v = [10, 10, 10, 10];
  const { wetDays, dryDays } = wetDryEnergy(d, v, base, 'nea-6-6');
  assert.equal(wetDays, 2, 'May 30 and Nov 30 are wet');
  assert.equal(dryDays, 2, 'May 29 and Dec 1 are dry');
});

ok('annual reliability excludes incomplete years and orders P90 below P50', () => {
  const dates: string[] = [];
  const values: number[] = [];
  for (const [year, q, days] of [[2019, 6, 365], [2020, 12, 366], [2021, 20, 100]] as const) {
    const start = Date.UTC(year, 0, 1);
    for (let k = 0; k < days; k++) {
      dates.push(new Date(start + k * 864e5).toISOString().slice(0, 10));
      values.push(q);
    }
  }
  const annual = annualEnergyByYear(dates, values, base);
  assert.deepEqual(annual.map((x) => x.year), [2019, 2020]);
  assert.ok(valueAtExceedance(annual.map((x) => x.gwh), 0.9) <= valueAtExceedance(annual.map((x) => x.gwh), 0.5));
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


// ---------------------------------------------------------------------------
// Scheme discovery
// ---------------------------------------------------------------------------

console.log('\nscheme discovery');

/** A synthetic river: constant slope, constant flow, evenly spaced samples. */
function ramp(points = 120, dropPerKm = 40, spacingKm = 0.12, meanCms = 12) {
  return Array.from({ length: points }, (_, k) => ({
    km: k * spacingKm,
    lat: 28 + k * 1e-4,
    lon: 84,
    elevationM: 2000 - k * spacingKm * dropPerKm,
    meanCms,
  }));
}

const steady = (path: ReturnType<typeof ramp>) => ({
  path,
  series: new Array(2000).fill(12),
  seriesMeanCms: 12,
  residualCms: 0,
  exceedance: 0.4,
  efficiency: 0.85,
  headLossFrac: 0,
  minFlowFrac: 0.2,
  // Whole-reach sweep, so the existing discovery checks keep their coverage.
  intakeWindowKm: Number.POSITIVE_INFINITY,
});

ok('evaluate reproduces P = rho*g*Q*H*eta by hand', () => {
  const s = evaluate(steady(ramp()), 0, 50)!;
  assert.ok(s, 'expected a scheme');
  // 50 steps x 0.12 km x 40 m/km = 240 m of drop.
  near(s.grossHeadM, 240, 1e-9);
  near(s.waterwayKm, 6, 1e-9);
  near(s.designFlowCms, 12, 1e-9); // flat series -> Q40 = 12, no residual

  // `headLossFrac: 0` above is only a FALLBACK now. Every scheme gets its own
  // headrace and penstock sized, and they cost head whatever the caller
  // declares — a 6 km waterway is not free just because nobody priced it.
  assert.ok(s.waterway, 'a 12 m3/s, 240 m duty point must be sizeable');
  assert.ok(
    s.netHeadM < 240 && s.netHeadM > 240 * 0.9,
    `net head ${s.netHeadM} m is not a plausible loss on 240 m of gross`
  );
  near(s.netHeadM, 240 * (1 - s.waterway!.lossFrac), 1e-9, 'net head vs sized loss');

  // The identity itself is still checked by hand, on the head the engine used.
  const c = turbineCurve(12, s.netHeadM)!;
  assert.ok(c, 'a 12 m3/s duty point must select a machine');

  /**
   * RATED POWER IS ON THE CURVE AT DESIGN FLOW, not at the curve's best point.
   *
   * This assertion used to demand `c.peak`, and the engine obliged. But peak
   * efficiency generally occurs below full gate — here 0.9300 against 0.9008
   * at design flow — so nameplate was computed with one efficiency while every
   * dispatched day used another, and capacity read about 3% high against the
   * energy beside it. Both now use `at(designFlow)`.
   */
  assert.ok(
    c.at(12) < c.peak,
    'this fixture is only meaningful while design flow sits off the best point'
  );
  near(s.turbinePeak, c.at(12), 1e-12);
  near(s.capacityMW, (1000 * 9.81 * 12 * s.netHeadM * c.at(12) * 0.85) / 1e6, 1e-9);
});

ok('scheme PPA and P90 figures use the exact same dispatch as headline energy', () => {
  const dates: string[] = [];
  const series: number[] = [];
  for (const [year, q] of [[2019, 9], [2020, 15]] as const) {
    const days = year === 2020 ? 366 : 365;
    const start = Date.UTC(year, 0, 1);
    for (let k = 0; k < days; k++) {
      dates.push(new Date(start + k * 864e5).toISOString().slice(0, 10));
      series.push(q);
    }
  }
  const input = {
    ...steady(ramp()),
    dates,
    series,
    seriesMeanCms: series.reduce((a, b) => a + b, 0) / series.length,
  };
  const s = evaluate(input, 0, 50)!;
  assert.ok(s.reliability, 'dated daily flow must produce reliability diagnostics');
  near(
    s.reliability!.ppaEightFour.wetGwh + s.reliability!.ppaEightFour.dryGwh,
    s.energyGwh,
    1e-9,
    'PPA split vs headline dispatch'
  );
  assert.ok(s.reliability!.p90Gwh <= s.reliability!.p50Gwh);
  const ppa = s.reliability!.ppaEightFour;
  near(
    ppa.grossReferenceValueMillionNpr,
    ppa.wetGwh * 4.8 + ppa.dryGwh * 8.4,
    1e-12,
    'scheme PPA reference value'
  );
  near(
    ppa.blendedBaseRateNprPerKwh,
    ppa.grossReferenceValueMillionNpr / (ppa.wetGwh + ppa.dryGwh),
    1e-12,
    'scheme blended base rate'
  );
});

ok('an intake on a bigger catchment gets proportionally more water', () => {
  const path = ramp();
  for (let k = 60; k < path.length; k++) path[k].meanCms = 24; // a tributary joins
  const upper = evaluate(steady(path), 0, 50)!;
  const lower = evaluate(steady(path), 61, 111)!;
  near(lower.designFlowCms / upper.designFlowCms, 2, 1e-9);
  near(lower.flowScale / upper.flowScale, 2, 1e-9, 'the displayed intake record uses the same scale');
  // Power tracks flow, but not to the last digit: the runner-size term in the
  // efficiency correlation gives the larger machine a small scale advantage.
  const ratio = lower.capacityMW / upper.capacityMW;
  assert.ok(ratio > 2 && ratio < 2.05, `capacity ratio ${ratio} should exceed 2 slightly`);
});

ok('a tributary joining BELOW the intake never reaches the turbine', () => {
  const plain = ramp();
  const joined = ramp();
  for (let k = 60; k < joined.length; k++) joined[k].meanCms = 48;
  const a = evaluate(steady(plain), 0, 50)!;
  const b = evaluate(steady(joined), 0, 50)!;
  near(b.designFlowCms, a.designFlowCms, 1e-12);
  near(b.capacityMW, a.capacityMW, 1e-12);
});

ok('residual flow is removed before the turbine', () => {
  const s = evaluate({ ...steady(ramp()), residualCms: 2 }, 0, 50)!;
  near(s.designFlowCms, 10, 1e-9); // 12 available, 2 stays in the river
});

ok('a powerhouse upstream of the intake is rejected outright', () => {
  assert.equal(evaluate(steady(ramp()), 50, 20), null);
  assert.equal(evaluate(steady(ramp()), 10, 10), null);
});

ok('discovery searches many pairs and returns explained alternatives', () => {
  const r = discover(steady(ramp(200)));
  assert.ok(r.evaluated > 50, `only evaluated ${r.evaluated}`);
  assert.ok(r.schemes.length > 0, 'expected at least one scheme');
  for (const s of r.schemes) {
    assert.ok(s.j > s.i, 'powerhouse must be downstream of the intake');
    assert.ok(s.grossHeadM > 0, 'head must be positive');
    assert.ok(s.reasons.length > 0, 'every alternative must say why it survived');
  }
});

ok('no surviving alternative is dominated by another', () => {
  const r = discover(steady(ramp(200)));
  for (const a of r.schemes) {
    for (const b of r.schemes) {
      if (a === b) continue;
      const dominated =
        b.energyGwh >= a.energyGwh &&
        b.waterwayKm <= a.waterwayKm &&
        b.grossHeadM >= a.grossHeadM &&
        (b.energyGwh > a.energyGwh || b.waterwayKm < a.waterwayKm);
      assert.ok(!dominated, 'a dominated scheme survived the Pareto filter');
    }
  }
});


ok('the intake stays near the click unless a wide sweep is asked for', () => {
  // The bug this guards: with the whole reach open, energy grows downstream
  // (bigger catchment) so the winner always sat at the far end. Measured on the
  // Marsyangdi, the intake landed 9.6 km from the click and the powerhouse
  // 18.6 km. A click on a map has to mean "here".
  const path = ramp(200);
  for (let k = 100; k < path.length; k++) path[k].meanCms = 60; // a big tributary joins

  const anchored = discover({ ...steady(path), intakeWindowKm: 2 });
  assert.ok(anchored.schemes.length > 0, 'anchored search must still find schemes');
  for (const s of anchored.schemes) {
    assert.ok(
      path[s.i].km <= 2 + 1e-9,
      `intake at ${path[s.i].km.toFixed(2)} km escaped the 2 km window`
    );
  }

  // Widened, it is allowed to chase the tributary far downstream.
  const wide = discover({ ...steady(path), intakeWindowKm: Number.POSITIVE_INFINITY });
  const furthest = Math.max(...wide.schemes.map((s) => path[s.i].km));
  assert.ok(furthest > 2, 'a wide sweep should reach past the anchor window');
  assert.ok(
    Math.max(...wide.schemes.map((s) => s.capacityMW)) >=
      Math.max(...anchored.schemes.map((s) => s.capacityMW)),
    'the wide sweep cannot be worse than the anchored one'
  );
});

ok('a flat river yields nothing rather than a bad scheme', () => {
  // 0.5 m/km over 24 km never reaches the 15 m minimum head.
  assert.equal(discover(steady(ramp(200, 0.5))).schemes.length, 0);
});

ok('longer waterways buy more head — the trade-off the list must preserve', () => {
  const path = ramp();
  const short = evaluate(steady(path), 0, 20)!;
  const long = evaluate(steady(path), 0, 80)!;
  assert.ok(long.grossHeadM > short.grossHeadM);
  assert.ok(long.energyGwh > short.energyGwh);
  assert.ok(long.waterwayKm > short.waterwayKm);
});


console.log('\nturbine selection and part-load curves (HydroGenerate port)');

ok('turbine regions match HydroGenerate for classic duty points', () => {
  assert.equal(selectTurbine(2, 400), 'Pelton'); // high head, small flow
  assert.equal(selectTurbine(50, 100), 'Francis'); // above Kaplan's 80 m ceiling
  assert.equal(selectTurbine(400, 8), 'Kaplan'); // low head, large flow
  // 300 m3/s at 30 m sits inside both Francis and Kaplan; HydroGenerate breaks
  // the tie on nearest polygon centroid, which gives Kaplan — also the machine
  // actually used at that duty.
  assert.equal(selectTurbine(300, 30), 'Kaplan');
  assert.equal(selectTurbine(3, 30), 'Crossflow'); // small head, small flow
  assert.equal(selectTurbine(5000, 2000), null); // outside every region
});

ok('part-load efficiency peaks below design flow and is never negative', () => {
  const c = turbineCurve(12, 240)!;
  assert.ok(c, 'expected a curve');
  assert.ok(c.peak > 0.7 && c.peak < 0.96, `peak ${c.peak} implausible`);
  for (let f = 0; f <= 1.2; f += 0.02) {
    const e = c.at(f * 12);
    assert.ok(e >= 0 && e <= 1, `efficiency ${e} out of range at ${f}`);
  }
  // Below the machine's minimum the unit is off, not merely inefficient.
  assert.equal(c.at(0.01 * 12), 0);
});

ok('the Francis correction returns full-load efficiency at design flow', () => {
  // The ported source squares only the denominator, which does not converge to
  // the published full-load value. Guard the corrected form.
  const c = turbineCurve(20, 120)!;
  assert.equal(c.type, 'Francis');
  const atDesign = c.at(20);
  assert.ok(atDesign > 0.8 && atDesign < c.peak + 1e-9, `full load ${atDesign} vs peak ${c.peak}`);
});

ok('a crossflow still produces at half flow', () => {
  // The ported source divides by q, driving this to zero at 0.5*Qd. A crossflow
  // is chosen precisely for part-load, so that would be badly wrong.
  const c = turbineCurve(3, 30)!;
  assert.equal(c.type, 'Crossflow');
  assert.ok(c.at(1.5) > 0.6, `half-flow efficiency ${c.at(1.5)} too low`);
});

ok('a part-load curve yields less energy than a flat best-point efficiency', () => {
  // The whole point of curves: a river that spends most of the year well below
  // design flow cannot be credited with peak efficiency every day.
  const series = Array.from({ length: 365 }, (_, i) => (i < 90 ? 12 : 3));
  const c = turbineCurve(12, 240)!;
  const common = {
    grossHeadM: 240,
    headLossFrac: 0,
    designFlowCms: 12,
    residualFlowCms: 0,
    minFlowFrac: c.minFlowFrac,
  };
  const flat = annualEnergy(series, { ...common, efficiency: c.peak });
  const curved = annualEnergy(series, {
    ...common,
    efficiency: c.peak,
    efficiencyAt: (q: number) => c.at(q),
  });
  assert.ok(curved.gwhPerYear < flat.gwhPerYear, 'curve must cost energy at part load');
  assert.ok(curved.gwhPerYear > 0.5 * flat.gwhPerYear, 'but not collapse it');
});


console.log('\nuncertainty');

ok('the band always contains the reported figure', () => {
  const inp = steady(ramp(200));
  const s = evaluate(inp, 0, 50)!;
  const u = uncertaintyFor(inp, s, 12, 12)!;
  assert.ok(u, 'expected a band');
  assert.ok(u.capacityMW.low <= s.capacityMW && s.capacityMW <= u.capacityMW.high,
    `${s.capacityMW} outside ${u.capacityMW.low}..${u.capacityMW.high}`);
  assert.ok(u.capacityMW.low >= 0, 'a band may not go negative');
});

ok('a corroborated flow gives a narrower band than an uncorroborated one', () => {
  const inp = steady(ramp(200));
  const s = evaluate(inp, 0, 50)!;
  const agree = uncertaintyFor(inp, s, 12, 12.5)!;      // two models within 2x
  const disagree = uncertaintyFor(inp, s, 12, 400)!;    // cell clearly off-channel
  const width = (u: typeof agree) => u.capacityMW.high - u.capacityMW.low;
  assert.ok(width(disagree) > width(agree),
    'losing corroboration must widen the band');
});

ok('a wild disagreement does not blow the band up without limit', () => {
  // The bug this guards: propagating the raw disagreement produced "0-341 MW"
  // on a reach where the two models spanned 3.4 and 130.9 m3/s. The off-channel
  // cell has already been identified and discarded; quoting it as a plausible
  // outcome double-counts an error the app corrected.
  const inp = steady(ramp(200));
  const s = evaluate(inp, 0, 50)!;
  const mild = uncertaintyFor(inp, s, 12, 30)!;
  const wild = uncertaintyFor(inp, s, 12, 12000)!;
  const width = (u: typeof mild) => u.capacityMW.high - u.capacityMW.low;
  near(width(wild), width(mild), 1e-9, 'band width must not track the disagreement size');
  assert.ok(wild.capacityMW.low > 0, 'the low end must stay above zero');
  assert.ok(wild.capacityMW.high < 3 * s.capacityMW, 'the high end must stay sane');
});

ok('flow is named as the dominant driver, ahead of terrain', () => {
  const inp = steady(ramp(200));
  const s = evaluate(inp, 0, 50)!;
  const u = uncertaintyFor(inp, s, 12, 12)!;
  assert.equal(u.drivers[0].name, 'River flow', 'drivers must be sorted by influence');
  assert.ok(u.drivers[0].swingPct > u.drivers[1].swingPct);
  for (const d of u.drivers) assert.ok(d.note.length > 10, 'each driver must explain itself');
});

console.log(`\n${passed} checks passed\n`);
