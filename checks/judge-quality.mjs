/**
 * Which regression makes the better JUDGE?
 *
 *   node --experimental-strip-types --no-warnings checks/judge-quality.mjs
 *
 * engine/flowchoice.ts does not use its regression as a flow estimate. It uses
 * it as a REFEREE: when the mapped network and the flood model disagree beyond
 * a factor of three, the regression decides which of them to believe. So the
 * question is not "which regression is most accurate" — that was measured in
 * checks/smallcatchment-flow.mjs — but "which regression most reliably notices
 * that the network is wrong, without crying wolf when it is right".
 *
 * Those are different questions and can have different answers. A regression
 * with a small typical error but a systematic bias will disagree with a correct
 * network reading at a steady rate, and every one of those is a false alarm
 * that demotes a good number.
 *
 * The gauges make it decidable. Truth is the measured mean; the network reading
 * is what the app would have used; a judge "flags" when it disagrees with the
 * network by more than flowchoice's own threshold. Then precision and recall
 * are just counting.
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
const { allMonthlyFlows } = await import('../src/engine/hydest.ts');
const { mhspScreen } = await import('../src/engine/mhsp.ts');
const { modifiedHydestAnnualMean } = await import('../src/engine/modified-hydest.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

/** flowchoice.ts DISAGREE_RATIO — the threshold this whole test is about. */
const DISAGREE = 3;
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;

const rows = [];
for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < 5 || !(s.meanCms > 0)) continue;
  if (!hasReachData(s.lat, s.lon)) continue;
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > 1) continue;
  const r = hit.nearest;
  const A = r.uplandKm2;
  if (!(A > 0) || !Number.isFinite(r.below5000Frac) || !(r.meanDischargeCms > 0)) continue;

  /**
   * A gauge whose own measured flow is impossible on its snapped catchment is
   * measuring the snapping, not the network — including it would score the
   * judges against a truth that is itself wrong.
   */
  const spec = s.meanCms / A;
  if (spec < SPECIFIC_MIN || spec > SPECIFIC_MAX) continue;

  const mmp = Number.isFinite(r.monsoonMm) ? r.monsoonMm : undefined;
  const hy = allMonthlyFlows({
    totalKm2: A,
    below5000Km2: A * r.below5000Frac,
    below3000Km2: A * r.below3000Frac,
    ...(mmp ? { monsoonMm: mmp } : {}),
  });
  const m = mhspScreen(A, mmp);
  const mod = modifiedHydestAnnualMean({
    below3000Km2: A * r.below3000Frac,
    below5000Km2: A * r.below5000Frac,
    averageAltitudeM: r.averageAltitudeM,
    annualWetnessMm: r.annualPrecipMm,
  });

  rows.push({
    river: s.river,
    truth: s.meanCms,
    network: r.meanDischargeCms,
    hydest: hy.length === 12 ? hy.reduce((t, x) => t + x.cms, 0) / 12 : NaN,
    mhsp: m ? m.annualMeanCms : NaN,
    modified: mod ?? NaN,
  });
}

const off = (a, b) => Math.max(a / b, b / a);

console.log(`\n${rows.length} gauges with a network reading and a plausible measured flow`);
const bad = rows.filter((r) => off(r.network, r.truth) > DISAGREE);
console.log(
  `the network is wrong by more than ${DISAGREE}x on ${bad.length} of them ` +
    `(${((bad.length / rows.length) * 100).toFixed(0)}%) — these are what a judge must catch\n`
);

console.log(
  `${'judge'.padEnd(18)}${'covers'.padStart(8)}${'caught'.padStart(9)}${'missed'.padStart(8)}` +
    `${'false alarms'.padStart(14)}${'precision'.padStart(11)}${'recall'.padStart(8)}`
);
for (const [name, key] of [
  ['WECS/DHM 1990', 'hydest'],
  ['MHSP 1997', 'mhsp'],
  ['Modified HYDEST', 'modified'],
]) {
  const seen = rows.filter((r) => Number.isFinite(r[key]) && r[key] > 0);
  const flags = seen.filter((r) => off(r[key], r.network) > DISAGREE);
  const truly = seen.filter((r) => off(r.network, r.truth) > DISAGREE);
  const caught = flags.filter((r) => off(r.network, r.truth) > DISAGREE).length;
  const falseAlarm = flags.length - caught;
  const precision = flags.length ? (caught / flags.length) * 100 : NaN;
  const recall = truly.length ? (caught / truly.length) * 100 : NaN;
  console.log(
    `${name.padEnd(18)}${String(seen.length).padStart(8)}${String(caught).padStart(9)}` +
      `${String(truly.length - caught).padStart(8)}${String(falseAlarm).padStart(14)}` +
      `${(Number.isFinite(precision) ? precision.toFixed(0) + '%' : '—').padStart(11)}` +
      `${(Number.isFinite(recall) ? recall.toFixed(0) + '%' : '—').padStart(8)}`
  );
}

/**
 * A flag is only useful if what it promotes is better than what it demoted.
 * Catching a bad network reading and then replacing it with a worse number is
 * not an improvement, and precision alone cannot see that.
 */
console.log('\nwhen a judge fires, does its own value beat the network it rejected?');
for (const [name, key] of [
  ['WECS/DHM 1990', 'hydest'],
  ['MHSP 1997', 'mhsp'],
  ['Modified HYDEST', 'modified'],
]) {
  const flags = rows.filter(
    (r) => Number.isFinite(r[key]) && r[key] > 0 && off(r[key], r.network) > DISAGREE
  );
  if (!flags.length) continue;
  const better = flags.filter((r) => off(r[key], r.truth) < off(r.network, r.truth)).length;
  console.log(
    `  ${name.padEnd(18)}${String(better).padStart(3)}/${flags.length} times closer to the gauge`
  );
}
