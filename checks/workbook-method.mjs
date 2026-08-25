/**
 * Two steps in the office workbook that can be checked against measurement.
 *
 *   node --experimental-strip-types --no-warnings checks/workbook-method.mjs
 *
 * Reading the whole workbook rather than one sheet turns up two places where a
 * convenient approximation is standing in for a quantity that is actually
 * available. Both are testable against DHM's own records, which carry measured
 * daily flow-duration quantiles AND measured monthly means for the same gauge —
 * so each can be isolated with no model in the way at all.
 *
 * 1. THE FLOW-DURATION CURVE FROM TWELVE MONTHLY MEANS.
 *
 *    'MHSP(NEA , 1997)'!B25:B39 reads the design flow as
 *    PERCENTILE(C9:C20, 1 - p), where C9:C20 are the twelve monthly means. A
 *    flow-duration curve describes DAILY flow; twelve monthly averages have had
 *    the within-month variation removed before the percentile is taken. Feeding
 *    each gauge its OWN measured monthly means and comparing against its OWN
 *    measured quantiles isolates that one step exactly.
 *
 * 2. MONSOON PRECIPITATION AS A FLAT 0.8 OF THE ANNUAL TOTAL.
 *
 *    'MHSP(NEA , 1997)'!B5 = 0.8 * 'Modified Hydest'!B11. MHSP needs monsoon
 *    precipitation and the sheet only asks the user for an annual figure, so a
 *    national constant bridges them. The bundled climatology has both numbers
 *    per catchment and can say what the ratio really is.
 */
import { readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u).replace(/^undefined/, '').replace(/^\//, '');
  if (/^[\w.-]+\.(json|dat|bin)$/.test(p)) {
    try {
      return new Response(readFileSync(`public/${p}`), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return realFetch(String(u), i);
};

const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

/** Excel's PERCENTILE: sorted ascending, linear between neighbours. */
function excelPercentile(values, k) {
  const v = [...values].sort((a, b) => a - b);
  const idx = k * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

const POINTS = [
  ['q5', 0.05],
  ['q20', 0.2],
  ['q40', 0.4],
  ['q50', 0.5],
  ['q60', 0.6],
  ['q80', 0.8],
  ['q95', 0.95],
];

const err = [];
let used = 0;
for (const s of records.stations) {
  if (!s.q || !Array.isArray(s.monthly) || s.monthly.length !== 12) continue;
  if ((s.completeYears ?? 0) < 5) continue;
  if (!s.monthly.every((m) => m > 0)) continue;
  used++;
  for (const [key, p] of POINTS) {
    const truth = s.q[key];
    if (!(truth > 0)) continue;
    err.push({ key, ratio: excelPercentile(s.monthly, 1 - p) / truth });
  }
}

const stat = (v) => {
  const l = v.map(Math.log).sort((a, b) => a - b);
  return {
    n: l.length,
    median: Math.exp(l[Math.floor(l.length / 2)]),
    typ: Math.exp(l.reduce((a, b) => a + Math.abs(b), 0) / l.length),
  };
};

console.log(`\n1. FLOW DURATION FROM TWELVE MONTHLY MEANS`);
console.log(`   ${used} gauges with both measured monthly means and measured daily quantiles`);
console.log(`   no model anywhere: the gauge's own monthly means against its own daily curve\n`);
console.log(`   ${'point'.padEnd(8)}${'n'.padStart(5)}${'median'.padStart(9)}${'typ.err'.padStart(9)}`);
for (const [key] of POINTS) {
  const st = stat(err.filter((e) => e.key === key).map((e) => e.ratio));
  if (!st.n) continue;
  console.log(
    `   ${key.padEnd(8)}${String(st.n).padStart(5)}${st.median.toFixed(2).padStart(8)}x${st.typ.toFixed(2).padStart(8)}x`
  );
}

/**
 * Q45 is the workbook's headline. It is not a published quantile, so the
 * reference is interpolated between the measured Q40 and Q60 exactly the way
 * 'Modified Hydest'!B71 interpolates its own.
 */
const q45 = [];
for (const s of records.stations) {
  if (!s.q || !Array.isArray(s.monthly) || s.monthly.length !== 12) continue;
  if ((s.completeYears ?? 0) < 5 || !s.monthly.every((m) => m > 0)) continue;
  const { q40, q60 } = s.q;
  if (!(q40 > 0) || !(q60 > 0)) continue;
  const truth = q60 + ((q60 - q40) / 20) * (45 - 60);
  q45.push(excelPercentile(s.monthly, 1 - 0.45) / truth);
}
const s45 = stat(q45);
console.log(
  `\n   Q45, the design flow this workbook exists to produce:` +
    `\n     median ${s45.median.toFixed(2)}x   typical error ${s45.typ.toFixed(2)}x   (n=${s45.n})`
);

// ---------------------------------------------------------------------------

const { nearestReach, hasReachData } = await import('../src/rivers.ts');
const { mhspFlowAtExceedance, mhspScreen } = await import('../src/engine/mhsp.ts');
const { modifiedHydestFlowAt } = await import('../src/engine/modified-hydest.ts');

/**
 * Which Q45 should the office actually use?
 *
 * The sheet computes THREE and ships one. 'MHSP(NEA , 1997)'!B29 is the
 * percentile of monthly means and is what the Power sheet consumes; B41 on the
 * same sheet is MHSP's own published Q45 REGRESSION, computed and then left
 * unused; and 'Modified Hydest'!B71 interpolates that method's published
 * flow-duration regressions. Measured Q45 decides between them.
 *
 * ALL THREE MUST START FROM CATCHMENT PROPERTIES ALONE. The first version of
 * this comparison fed the percentile route the gauge's own MEASURED monthly
 * means, and it won comfortably — which proved nothing except that measured
 * data beats a regression. An office screening an ungauged site has no measured
 * monthly means; it has MHSP's ESTIMATES of them. So the percentile is taken
 * over the estimated twelve, which is what the workbook actually does.
 */
const cmp = [];
for (const st of records.stations) {
  if (st.lat == null || !st.q || (st.completeYears ?? 0) < 5) continue;
  if (!Array.isArray(st.monthly) || st.monthly.length !== 12 || !st.monthly.every((m) => m > 0)) continue;
  const { q40, q60 } = st.q;
  if (!(q40 > 0) || !(q60 > 0)) continue;
  if (!hasReachData(st.lat, st.lon)) continue;
  const hit = await nearestReach(st.lat, st.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > 1) continue;
  const r = hit.nearest;
  const A = r.uplandKm2;
  if (!(A > 0) || !Number.isFinite(r.below5000Frac)) continue;
  const truth = q60 + ((q60 - q40) / 20) * (45 - 60);
  if (!(truth > 0)) continue;
  const spec = st.meanCms / A;
  if (spec < 0.005 || spec > 0.25) continue;

  const mmp = Number.isFinite(r.monsoonMm) ? r.monsoonMm : undefined;
  const mhspReg = mhspFlowAtExceedance(A, 0.45, mmp);
  const mod = modifiedHydestFlowAt(
    {
      below3000Km2: A * r.below3000Frac,
      below5000Km2: A * r.below5000Frac,
      averageAltitudeM: r.averageAltitudeM,
      annualWetnessMm: r.annualPrecipMm,
    },
    0.45
  );
  cmp.push({
    truth,
    monthlyPercentile: (() => {
      const m = mhspScreen(A, mmp);
      return m && m.months.length === 12 ? excelPercentile(m.months, 1 - 0.45) : null;
    })(),
    mhspRegression: mhspReg,
    modified: mod,
    // What the Power sheet actually ships: B5 = (Modified Hydest Q45 + MHSP Q45)/2.
    workbookAverage: (() => {
      const m = mhspScreen(A, mmp);
      const pc = m && m.months.length === 12 ? excelPercentile(m.months, 1 - 0.45) : null;
      return pc != null && mod != null ? (pc + mod) / 2 : null;
    })(),
  });
}

console.log(`
3. WHICH Q45? ${cmp.length} gauges with a measured flow-duration curve
`);
console.log(`   ${'estimator'.padEnd(34)}${'median'.padStart(9)}${'typ.err'.padStart(9)}${'within 1.5x'.padStart(13)}`);
for (const [label, key] of [
  ['percentile of MHSP monthly (shipped)', 'monthlyPercentile'],
  ['MHSP Q45 regression (computed, unused)', 'mhspRegression'],
  ['Modified HYDEST flow-duration', 'modified'],
  ['the two averaged — what Power!B5 ships', 'workbookAverage'],
]) {
  const v = cmp.map((c) => c[key]).map((x, i) => (x > 0 ? x / cmp[i].truth : null)).filter((x) => x);
  if (!v.length) continue;
  const st = stat(v);
  const w = (v.filter((x) => x > 1 / 1.5 && x < 1.5).length / v.length) * 100;
  console.log(
    `   ${label.padEnd(34)}${st.median.toFixed(2).padStart(8)}x${st.typ.toFixed(2).padStart(8)}x${(w.toFixed(0) + '%').padStart(12)}   n=${st.n}`
  );
}


const ratios = [];
for (const s of records.stations) {
  if (s.lat == null || !hasReachData(s.lat, s.lon)) continue;
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > 1) continue;
  const r = hit.nearest;
  if (Number.isFinite(r.monsoonMm) && Number.isFinite(r.annualPrecipMm) && r.annualPrecipMm > 0) {
    ratios.push({ river: s.river, f: r.monsoonMm / r.annualPrecipMm });
  }
}
ratios.sort((a, b) => a.f - b.f);
const q = (p) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))].f;
console.log(`\n2. MONSOON AS A FRACTION OF THE ANNUAL TOTAL, ${ratios.length} gauged catchments`);
console.log(`   the workbook assumes a flat 0.80\n`);
console.log(
  `   p5 ${q(0.05).toFixed(2)}   p25 ${q(0.25).toFixed(2)}   median ${q(0.5).toFixed(2)}   ` +
    `p75 ${q(0.75).toFixed(2)}   p95 ${q(0.95).toFixed(2)}`
);
const out = ratios.filter((r) => Math.abs(r.f - 0.8) > 0.1).length;
console.log(`   more than 0.10 away from 0.80: ${out}/${ratios.length}`);
console.log(`   driest: ${ratios[0].river} ${ratios[0].f.toFixed(2)}`);
console.log(`   wettest: ${ratios[ratios.length - 1].river} ${ratios[ratios.length - 1].f.toFixed(2)}`);
