/**
 * Does the no-discharge-data method actually work?
 *
 *   node --experimental-strip-types --no-warnings checks/design-flow-vs-gauges.mjs
 *
 * A Nepali licensing workbook estimates design flow from catchment area and a
 * rainfall figure, and never opens a gauge record. This app instead runs a
 * global flood model, rescales it to a mapped network, and now corrects its
 * flow-duration shape. The second is far more machinery. Machinery is only
 * worth carrying if it is more accurate.
 *
 * DHM's own gauges can settle it. Every station here has a MEASURED flow
 * duration curve. Snap it to the river network, read the catchment and the
 * monsoon rainfall the app would read, predict Q45 without ever looking at the
 * record, and compare.
 *
 * Q45 rather than Q40 because Q45 is the figure Nepali practice sizes on, and
 * it is what the workbook computes.
 *
 * Five predictors:
 *   workbook-percentile  what the sheet ACTUALLY does: 55th percentile of the
 *                        twelve MHSP monthly means
 *   workbook-fdc         the NEA daily flow-duration regression sitting unused
 *                        on the same sheet
 *   mhsp x shape         MHSP's annual mean, times the national Q45/mean ratio
 *   hydest x shape       WECS/DHM's annual mean, times the same ratio
 *   network x shape      the mapped network's mean, times the same ratio —
 *                        this is what the app now effectively does
 */
import { readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u);
  if (p.startsWith('/')) return new Response(readFileSync(`public${p}`), { status: 200 });
  return realFetch(p, i);
};

const { nearestReach, hasReachData } = await import('../src/rivers.ts');
const { mhspScreen, mhspFlowAtExceedance } = await import('../src/engine/mhsp.ts');
const { allMonthlyFlows } = await import('../src/engine/hydest.ts');
const { NATIONAL_SHAPE } = await import('../src/engine/fdcshape.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

const SNAP_KM = 1.0;
const MIN_YEARS = 10;
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;

/** National Q45/mean, log-interpolated between the published Q40 and Q50. */
const shapeAt = (p) => {
  const pts = NATIONAL_SHAPE.points;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (p >= pts[i] && p <= pts[i + 1]) {
      const t = (p - pts[i]) / (pts[i + 1] - pts[i]);
      return Math.exp(
        Math.log(NATIONAL_SHAPE.ratio[i]) +
          t * (Math.log(NATIONAL_SHAPE.ratio[i + 1]) - Math.log(NATIONAL_SHAPE.ratio[i]))
      );
    }
  }
  return NATIONAL_SHAPE.ratio[2];
};
const SHAPE45 = shapeAt(0.45);

/** Excel PERCENTILE, so the workbook's own method is reproduced exactly. */
const excelPercentile = (vals, p) => {
  const s = [...vals].sort((a, b) => a - b);
  const r = p * (s.length - 1);
  const lo = Math.floor(r);
  return lo === s.length - 1 ? s[lo] : s[lo] + (r - lo) * (s[lo + 1] - s[lo]);
};

const rows = [];
let skipped = 0;
let misSnapped = 0;
for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < MIN_YEARS || !s.q) { skipped++; continue; }
  // Measured Q45, interpolated between the published Q40 and Q50.
  if (!(s.q.q40 > 0) || !(s.q.q50 > 0)) { skipped++; continue; }
  const measured = Math.exp((Math.log(s.q.q40) + Math.log(s.q.q50)) / 2);
  if (!hasReachData(s.lat, s.lon)) { skipped++; continue; }
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) { skipped++; continue; }
  const r = hit.nearest;
  const A = r.uplandKm2;
  if (!(A > 0) || !Number.isFinite(r.monsoonMm) || !Number.isFinite(r.below5000Frac)) {
    skipped++; continue;
  }
  if (s.meanCms / A < SPECIFIC_MIN || s.meanCms / A > SPECIFIC_MAX) { misSnapped++; continue; }

  const m = mhspScreen(A, r.monsoonMm);
  const hy = allMonthlyFlows({
    totalKm2: A,
    below5000Km2: A * r.below5000Frac,
    below3000Km2: A * r.below3000Frac,
    monsoonMm: r.monsoonMm,
  });
  if (!m || m.months.length < 12 || hy.length < 12) { skipped++; continue; }
  const hyMean = hy.reduce((t, x) => t + x.cms, 0) / 12;

  rows.push({
    river: s.river,
    A,
    measured,
    p: {
      'workbook-percentile': excelPercentile(m.months, 1 - 0.45),
      'workbook-fdc': mhspFlowAtExceedance(A, 0.45, r.monsoonMm),
      'mhsp x shape': m.annualMeanCms * SHAPE45,
      'hydest x shape': hyMean * SHAPE45,
      'network x shape': r.meanDischargeCms * SHAPE45,
    },
  });
}

const NAMES = Object.keys(rows[0].p);
console.log(`\nDESIGN FLOW (Q45) vs ${rows.length} DHM gauges with ${MIN_YEARS}+ complete years`);
console.log(`skipped ${skipped}, rejected ${misSnapped} mis-snapped`);
console.log(`national Q45/mean = ${SHAPE45.toFixed(3)}\n`);
console.log('predictor              bias   1-sigma band     ±25%  ±50%  factor2  typ.err');
const score = {};
for (const name of NAMES) {
  const lr = rows.map((x) => Math.log(x.p[name] / x.measured)).filter(Number.isFinite);
  const mu = lr.reduce((a, b) => a + b, 0) / lr.length;
  const sd = Math.sqrt(lr.reduce((a, b) => a + (b - mu) ** 2, 0) / lr.length);
  const w = (f) => ((lr.filter((x) => Math.abs(x) <= Math.log(f)).length / lr.length) * 100).toFixed(0);
  const typ = Math.exp(lr.reduce((a, b) => a + Math.abs(b), 0) / lr.length);
  score[name] = typ;
  console.log(
    `${name.padEnd(21)} ${Math.exp(mu).toFixed(2)}x  ` +
      `${Math.exp(mu - sd).toFixed(2)}x-${Math.exp(mu + sd).toFixed(2)}x  ` +
      `${w(1.25).padStart(5)}% ${w(1.5).padStart(5)}% ${w(2).padStart(7)}%  ${typ.toFixed(2)}x`
  );
}
const best = NAMES.reduce((a, b) => (score[a] <= score[b] ? a : b));
console.log(`\nbest: ${best} (${score[best].toFixed(2)}x typical error)`);
console.log(
  `the sheet's own method is ${(score['workbook-percentile'] / score[best]).toFixed(2)}x ` +
    `the typical error of the best`
);
