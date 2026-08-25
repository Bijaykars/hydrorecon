/**
 * Which route gives the best DRY-SEASON flow on an ungauged catchment?
 *
 *   node --experimental-strip-types --no-warnings checks/lowflow-route.mjs
 *
 * checks/workbook-method.mjs showed that reading a flow-duration curve off
 * twelve monthly means overstates Q95 by about 59%. Q95 is dry-season firm
 * flow: it sets firm capacity and dry-season energy, which is the half of a
 * Nepali scheme's revenue that is worth the most per unit. A 59% optimism there
 * is the single most consequential bias found in the office method, and I told
 * the user that a daily-series route would do better. That claim needs testing
 * rather than asserting.
 *
 * Three routes are available on an ungauged site, and all three are offline:
 *
 *   A  the office route — percentile of the twelve estimated monthly means
 *   B  Modified HYDEST's OWN published flow-duration regressions
 *   C  a regional annual mean, shaped by the national Q/mean curve that
 *      engine/fdcshape.ts already derives from 81 gauged records
 *
 * Truth is DHM's measured daily quantiles. Nothing here needs the discharge
 * service, so the comparison can be made while it is rate limited.
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

const { nearestReach, hasReachData } = await import('../src/rivers.ts');
const { mhspScreen } = await import('../src/engine/mhsp.ts');
const {
  modifiedHydestAnnualMean,
  modifiedHydestFlowAt,
} = await import('../src/engine/modified-hydest.ts');
const { NATIONAL_SHAPE } = await import('../src/engine/fdcshape.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

function excelPercentile(values, k) {
  const v = [...values].sort((a, b) => a - b);
  const idx = k * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

/** The national Q/mean ratio at an exceedance, interpolated as the app does. */
function shapeRatio(p) {
  const pts = NATIONAL_SHAPE.points;
  const t = NATIONAL_SHAPE.ratio;
  if (p <= pts[0]) return t[0];
  if (p >= pts[pts.length - 1]) return t[t.length - 1];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (p <= pts[i + 1]) {
      const f = (p - pts[i]) / (pts[i + 1] - pts[i]);
      return t[i] + (t[i + 1] - t[i]) * f;
    }
  }
  return t[t.length - 1];
}

const TARGETS = [
  ['Q40', 0.4, 'q40'],
  ['Q60', 0.6, 'q60'],
  ['Q80', 0.8, 'q80'],
  ['Q95 (firm)', 0.95, 'q95'],
];

const rows = [];
for (const s of records.stations) {
  if (s.lat == null || !s.q || (s.completeYears ?? 0) < 5 || !(s.meanCms > 0)) continue;
  if (!hasReachData(s.lat, s.lon)) continue;
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > 1) continue;
  const r = hit.nearest;
  const A = r.uplandKm2;
  if (!(A > 0) || !Number.isFinite(r.below5000Frac)) continue;
  const spec = s.meanCms / A;
  if (spec < 0.005 || spec > 0.25) continue;

  const mmp = Number.isFinite(r.monsoonMm) ? r.monsoonMm : undefined;
  const m = mhspScreen(A, mmp);
  if (!m || m.months.length !== 12) continue;
  const mod = {
    below3000Km2: A * r.below3000Frac,
    below5000Km2: A * r.below5000Frac,
    averageAltitudeM: r.averageAltitudeM,
    annualWetnessMm: r.annualPrecipMm,
  };
  const modMean = modifiedHydestAnnualMean(mod);
  if (!(modMean > 0)) continue;

  rows.push({ q: s.q, months: m.months, mod, modMean });
}

const stat = (v) => {
  const l = v.filter((x) => x > 0).map(Math.log).sort((a, b) => a - b);
  if (!l.length) return null;
  return {
    n: l.length,
    median: Math.exp(l[Math.floor(l.length / 2)]),
    typ: Math.exp(l.reduce((a, b) => a + Math.abs(b), 0) / l.length),
    w15: (l.filter((x) => Math.abs(x) <= Math.log(1.5)).length / l.length) * 100,
  };
};

console.log(`\n${rows.length} gauges with a measured flow-duration curve and a snapped catchment\n`);
for (const [label, p, key] of TARGETS) {
  console.log(`${label}`);
  console.log(
    `  ${'route'.padEnd(38)}${'median'.padStart(9)}${'typ.err'.padStart(9)}${'within 1.5x'.padStart(13)}`
  );
  const routes = [
    ['A  percentile of MHSP monthly means', (r) => excelPercentile(r.months, 1 - p)],
    ['B  Modified HYDEST flow-duration', (r) => modifiedHydestFlowAt(r.mod, p)],
    ['C  Modified HYDEST mean x national shape', (r) => r.modMean * shapeRatio(p)],
  ];
  for (const [name, f] of routes) {
    const v = rows.map((r) => {
      const est = f(r);
      const truth = r.q[key];
      return est > 0 && truth > 0 ? est / truth : 0;
    });
    const st = stat(v);
    if (!st) continue;
    console.log(
      `  ${name.padEnd(38)}${st.median.toFixed(2).padStart(8)}x${st.typ.toFixed(2).padStart(8)}x` +
        `${(st.w15.toFixed(0) + '%').padStart(12)}`
    );
  }
  console.log('');
}
