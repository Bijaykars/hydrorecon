/**
 * Which regional method is right for Nepal — WECS/DHM 1990, or MHSP 1997?
 *
 *   node --experimental-strip-types --no-warnings checks/regional-vs-gauges.mjs
 *
 * Feasibility practice runs both and averages them, because at an ungauged
 * site there is nothing to prefer one by. There is here: 136 DHM gauges with
 * measured monthly means. Snap each to the river network, read the catchment
 * the app would read, run both regressions, and compare with what the river
 * actually did.
 *
 * The number that matters is the DRY SEASON. Nepal's PPA pays 8.40 NPR/kWh for
 * dry-season energy against 4.80 wet, and dry-season flow decides whether a
 * run-of-river scheme finances. Both methods get the dry season from catchment
 * area alone, with no rainfall term, so this is a clean comparison.
 */
import { readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (path.startsWith('/')) return new Response(readFileSync(`public${path}`), { status: 200 });
  return realFetch(path, init);
};

const { nearestReach, hasReachData } = await import('../src/rivers.ts');
const { mhspScreen } = await import('../src/engine/mhsp.ts');
const { allMonthlyFlows } = await import('../src/engine/hydest.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

const SNAP_KM = 1.0;
const MIN_YEARS = 10;
/**
 * Nepal runs 0.005-0.25 m3/s per km2. A gauge whose MEASURED mean implies a
 * specific discharge outside that for the catchment it snapped to has not
 * snapped to its own river — the Seti at a mapped 7 km2 is a tributary ditch
 * beside the Seti. Those gauges measure the snapping, not the method, and
 * scoring a regression on them is scoring the wrong thing.
 */
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;
let misSnapped = 0;

const rows = [];
let skipped = 0;
for (const s of records.stations) {
  if (s.lat == null || s.completeYears < MIN_YEARS || !s.monthly) { skipped++; continue; }
  if (!hasReachData(s.lat, s.lon)) { skipped++; continue; }
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) { skipped++; continue; }
  const r = hit.nearest;
  const A = r.uplandKm2;
  if (!(A > 0)) { skipped++; continue; }
  const specific = s.meanCms / A;
  if (specific < SPECIFIC_MIN || specific > SPECIFIC_MAX) { misSnapped++; continue; }
  const mmp = Number.isFinite(r.monsoonMm) ? r.monsoonMm : undefined;
  const b5 = Number.isFinite(r.below5000Frac) ? r.below5000Frac : NaN;
  const b3 = Number.isFinite(r.below3000Frac) ? r.below3000Frac : NaN;
  if (!Number.isFinite(b5)) { skipped++; continue; }

  const m = mhspScreen(A, mmp);
  const h = allMonthlyFlows({
    totalKm2: A, below5000Km2: A * b5, below3000Km2: A * b3, monsoonMm: mmp,
  });
  if (!m || !h.length) { skipped++; continue; }

  // Dry season = Jan..May, the rainfall-free months both methods can state.
  const measuredDry = s.monthly.slice(0, 5);
  const mhspDry = m.months.slice(0, 5);
  const hyByMonth = new Map(h.map((x) => [x.month, x.cms]));
  const hydestDry = [0, 1, 2, 3, 4].map((i) => hyByMonth.get(i));
  if (hydestDry.some((v) => v == null) || mhspDry.length < 5) { skipped++; continue; }

  const ratio = (a, b) => (b > 0 && a > 0 ? a / b : null);
  const geo = (xs) => Math.exp(xs.reduce((t, x) => t + Math.log(x), 0) / xs.length);
  const mR = mhspDry.map((q, i) => ratio(q, measuredDry[i])).filter(Boolean);
  const hR = hydestDry.map((q, i) => ratio(q, measuredDry[i])).filter(Boolean);
  if (mR.length < 5 || hR.length < 5) { skipped++; continue; }

  rows.push({
    id: s.id, river: s.river, A, years: s.completeYears,
    mhsp: geo(mR), hydest: geo(hR), avg: geo([geo(mR), geo(hR)]),
  });
}

const stat = (key) => {
  const v = rows.map((r) => r[key]).sort((a, b) => a - b);
  const logs = v.map(Math.log);
  const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mu) ** 2, 0) / logs.length);
  const within = (f) => (v.filter((x) => x >= 1 / f && x <= f).length / v.length) * 100;
  // Absolute log error: how far off, regardless of direction. The honest score.
  const mae = logs.reduce((a, b) => a + Math.abs(b), 0) / logs.length;
  return {
    median: v[Math.floor(v.length / 2)], bias: Math.exp(mu),
    band: [Math.exp(mu - sd), Math.exp(mu + sd)],
    w125: within(1.25), w2: within(2), mae: Math.exp(mae),
  };
};

console.log(`\nDRY-SEASON (Jan-May) FLOW vs ${rows.length} DHM gauges, ${MIN_YEARS}+ complete years`);
console.log(`skipped ${skipped} (short record, off network, or no hypsometry)\n`);
console.log('method            median  bias   1-sigma band    +/-25%  factor2  typ.err');
for (const [name, key] of [['MHSP 1997', 'mhsp'], ['WECS/DHM 1990', 'hydest'], ['average of both', 'avg']]) {
  const s = stat(key);
  console.log(
    `${name.padEnd(17)} ${s.median.toFixed(2).padStart(5)}x ${s.bias.toFixed(2).padStart(5)}x  ` +
    `${s.band[0].toFixed(2)}x-${s.band[1].toFixed(2)}x  ` +
    `${s.w125.toFixed(0).padStart(5)}%  ${s.w2.toFixed(0).padStart(6)}%  ${s.mae.toFixed(2)}x`
  );
}
const better = rows.filter((r) => Math.abs(Math.log(r.mhsp)) < Math.abs(Math.log(r.hydest))).length;
console.log(`\nMHSP closer on ${better}/${rows.length} gauges (${((better / rows.length) * 100).toFixed(0)}%)`);
const worst = [...rows].sort((a, b) => Math.abs(Math.log(b.avg)) - Math.abs(Math.log(a.avg))).slice(0, 5);
console.log('\nworst 5 for the averaged method:');
for (const r of worst) console.log(`  ${r.river.padEnd(22)} A=${r.A.toFixed(0).padStart(6)} km2  mhsp ${r.mhsp.toFixed(2)}x  hydest ${r.hydest.toFixed(2)}x`);
