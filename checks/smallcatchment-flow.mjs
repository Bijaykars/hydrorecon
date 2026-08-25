/**
 * On small catchments, which flow source should the engine believe?
 *
 *   node --experimental-strip-types --no-warnings checks/smallcatchment-flow.mjs
 *
 * checks/flow-vs-gauges.mjs turned up a size-dependent bias that had not been
 * looked at before: measured against DHM's gauges, the mapped network's
 * long-term mean is unbiased on catchments of 500 km2 and up (median 1.00x) and
 * reads 35% LOW below that (median 0.65x). Most Nepali schemes are on small
 * catchments, so this is a bulk problem, not a tail one.
 *
 * engine/flowchoice.ts currently lets the network carry the magnitude unless the
 * two global sources disagree beyond a factor of three, with the regional
 * regression acting only as a tie-breaker. If the regional methods are less
 * biased down here, that ordering is wrong for the majority of sites — and this
 * is the measurement that decides it, one that has been argued about all
 * session on contradictory evidence.
 *
 * Everything here is offline: bundled network, bundled hypsometry, bundled DHM
 * record summaries. No flood model, so this compares the NETWORK against the
 * REGIONAL methods only — the third source needs a live fetch and is a separate
 * question.
 */
import { readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u).replace(/^undefined/, '');
  if (p.startsWith('/') || /^[\w.-]+\.(json|dat|bin)$/.test(p)) {
    try {
      return new Response(readFileSync(`public/${p.replace(/^\//, '')}`), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return realFetch(p, i);
};

const { nearestReach, hasReachData } = await import('../src/rivers.ts');
const { mhspScreen } = await import('../src/engine/mhsp.ts');
const { modifiedHydestAnnualMean } = await import('../src/engine/modified-hydest.ts');
const { BLEND_BIAS_CORRECTION } = await import('../src/engine/flowchoice.ts');
const { allMonthlyFlows } = await import('../src/engine/hydest.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

const SNAP_KM = 1.0;
/**
 * Record length, as a command-line argument.
 *
 * The 100-500 km2 band -- the one that decides whether the regional methods
 * should outrank the network -- held only 13 gauges at 10 complete years, which
 * is too few to act on. Relaxing to 5 years roughly doubles the national sample.
 *
 * A 5-year mean is a noisier estimate of the long-term mean than a 20-year one,
 * so every source's typical error rises. But the noise is in the MEASUREMENT,
 * which all three sources are scored against equally, so it should not move the
 * RANKING between them. If the ranking does flip when the threshold moves, the
 * ranking was never real -- which is itself worth knowing before shipping.
 */
const MIN_YEARS = Number(process.argv[2] ?? 10);
/** A gauge whose measured flow is impossible on its snapped catchment is
 *  measuring the snapping, not the flow source. */
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;

const rows = [];
for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < MIN_YEARS || !(s.meanCms > 0)) continue;
  if (!hasReachData(s.lat, s.lon)) continue;
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) continue;
  const r = hit.nearest;
  const A = r.uplandKm2;
  if (!(A > 0) || !Number.isFinite(r.below5000Frac)) continue;
  const spec = s.meanCms / A;
  if (spec < SPECIFIC_MIN || spec > SPECIFIC_MAX) continue;

  const mmp = Number.isFinite(r.monsoonMm) ? r.monsoonMm : undefined;
  const m = mhspScreen(A, mmp);
  const hy = allMonthlyFlows({
    totalKm2: A,
    below5000Km2: A * r.below5000Frac,
    below3000Km2: A * r.below3000Frac,
    ...(mmp ? { monsoonMm: mmp } : {}),
  });
  if (!m || m.months.length < 12 || hy.length < 12) continue;

  const mod = modifiedHydestAnnualMean({
    below3000Km2: A * r.below3000Frac,
    below5000Km2: A * r.below5000Frac,
    averageAltitudeM: r.averageAltitudeM,
    annualWetnessMm: r.annualPrecipMm,
  });

  /**
   * A BLEND of the two most independent sources available.
   *
   * The mapped network is a global hydrological model; Modified HYDEST is a
   * regression fitted to Nepali gauges. They share no input data and fail for
   * unrelated reasons — the network mis-snaps onto the wrong channel, the
   * regression is blind to anything its four terms do not carry. Averaging in
   * log space is the standard way to exploit that: if the errors are even
   * partly independent, the blend beats both parents. If they are not, it lands
   * between them and nothing is gained. Either way it is worth measuring before
   * assuming the best single source is the best answer.
   */
  /**
   * The blend AS THE ENGINE SHIPS IT, constant imported rather than retyped.
   *
   * This line used to be a bare `sqrt(network x mod)`, which stopped being what
   * the app computes the moment flowchoice.ts gained its measured bias
   * correction — so the harness went on scoring a formula nothing ran. A
   * harness that reimplements the engine measures the copy.
   */
  const blend =
    r.meanDischargeCms > 0 && mod && mod > 0
      ? Math.sqrt(r.meanDischargeCms * mod) * BLEND_BIAS_CORRECTION
      : NaN;

  rows.push({
    blend,
    modified: mod ?? NaN,
    river: s.river,
    A,
    measured: s.meanCms,
    network: r.meanDischargeCms,
    mhsp: m.annualMeanCms,
    hydest: hy.reduce((t, x) => t + x.cms, 0) / 12,
  });
}

const stat = (v) => {
  const lr = v.filter((x) => x > 0).map(Math.log);
  if (!lr.length) return null;
  const s = [...lr].sort((a, b) => a - b);
  const mu = lr.reduce((a, b) => a + b, 0) / lr.length;
  const mae = lr.reduce((a, b) => a + Math.abs(b), 0) / lr.length;
  return {
    n: lr.length,
    median: Math.exp(s[Math.floor(s.length / 2)]),
    bias: Math.exp(mu),
    typ: Math.exp(mae),
    w2: (lr.filter((x) => Math.abs(x) <= Math.log(2)).length / lr.length) * 100,
  };
};

/**
 * The weights this comparison must be read with.
 *
 * A national average over the gauges answers "how well does each source do on a
 * DHM station?" — and DHM stations sit on big rivers. Snapped to the network
 * their median catchment is about 800 km2, two thirds of them order 4 or above.
 * The DoED project list, which is where this tool is actually pointed, has a
 * median catchment near 100 km2 with three quarters at order 3 or below.
 *
 * So the validation population is an order of magnitude larger than the use
 * population, and any single headline number is weighted towards rivers nobody
 * is screening. The bands below exist for that reason, and the project-weighted
 * line at the end re-weights them by where the projects actually are.
 */
const PROJECT_SHARE = { 'under 100 km2': 0.5, '100-500 km2': 0.32, '500 km2 and up': 0.18 };

const bands = [
  ['under 100 km2', (r) => r.A < 100],
  ['100-500 km2', (r) => r.A >= 100 && r.A < 500],
  ['500 km2 and up', (r) => r.A >= 500],
  ['ALL', () => true],
];

console.log(`\n${rows.length} gauges, ${MIN_YEARS}+ complete years, plausible specific discharge\n`);
for (const [label, pick] of bands) {
  const sub = rows.filter(pick);
  if (!sub.length) continue;
  console.log(`${label}  (n=${sub.length})`);
  console.log(`  ${'source'.padEnd(16)}${'median'.padStart(8)}${'bias'.padStart(8)}${'typ.err'.padStart(9)}${'within 2x'.padStart(11)}`);
  for (const [name, key] of [
    ['mapped network', 'network'],
    ['MHSP 1997', 'mhsp'],
    ['WECS/DHM 1990', 'hydest'],
    ['Modified HYDEST', 'modified'],
    ['network x ModHYDEST', 'blend'],
  ]) {
    const v = sub.map((r) =>
      key === 'both' ? Math.sqrt(r.mhsp * r.hydest) / r.measured : r[key] / r.measured
    );
    const st = stat(v);
    if (!st) continue;
    console.log(
      `  ${name.padEnd(16)}${st.median.toFixed(2).padStart(7)}x${st.bias.toFixed(2).padStart(7)}x` +
        `${st.typ.toFixed(2).padStart(8)}x${st.w2.toFixed(0).padStart(10)}%`
    );
  }
  console.log('');
}

/**
 * The same three sources, re-weighted from "per gauge" to "per project".
 * This is the number that answers the question the tool is asked.
 */
console.log('project-weighted typical error (bands weighted by where DoED projects sit)');
for (const [name, key] of [
  ['mapped network', 'network'],
  ['MHSP 1997', 'mhsp'],
  ['WECS/DHM 1990', 'hydest'],
  ['Modified HYDEST', 'modified'],
  ['network x ModHYDEST', 'blend'],
]) {
  let acc = 0;
  let wsum = 0;
  for (const [label, pick] of bands) {
    const w = PROJECT_SHARE[label];
    if (!w) continue;
    const sub = rows.filter(pick);
    if (!sub.length) continue;
    const st = stat(sub.map((r) => r[key] / r.measured));
    if (!st) continue;
    acc += w * Math.log(st.typ);
    wsum += w;
  }
  if (wsum > 0) console.log(`  ${name.padEnd(18)}${Math.exp(acc / wsum).toFixed(2)}x`);
}
