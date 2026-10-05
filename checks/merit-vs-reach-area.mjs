/**
 * What would it cost to drop MERIT Hydro?
 *
 *   node --experimental-strip-types --no-warnings checks/merit-vs-reach-area.mjs
 *
 * MERIT Hydro is the one CC-BY-NC licence in this stack. CLAUDE.md has said
 * since it was written that going commercial "would require contacting the
 * developer or dropping it", and in all that time nobody has measured what
 * dropping it would actually cost. That makes it an unpriced decision sitting
 * under every flow figure the app produces.
 *
 * It is measurable, and cheaply, because the alternative is already in hand:
 * `rivers.ts` carries BOTH `uplandKm2` — MERIT's 92 m flow-accumulation area,
 * sampled per vertex — and `reachUplandKm2`, HydroRIVERS' own attribute. The
 * app prefers MERIT and falls back to the reach where MERIT is absent, so a
 * MERIT-free build is not hypothetical; it is the fallback path everywhere.
 *
 * WHAT AREA ACTUALLY DRIVES. Not the flood model, which reads a GloFAS cell, and
 * not the mapped network's own discharge, which is a HydroRIVERS attribute.
 * Catchment area feeds the REGRESSIONS — Modified HYDEST and its below-3000 and
 * below-5000 terms — and the regressions are half of the shipped blend. So this
 * scores exactly the half that would move.
 *
 * MERIT ALSO HAS A KNOWN DEFECT that dropping it would remove: it bleeds across
 * confluences, and 8.9% of order-1 points read more than twice the reach's own
 * area. A bleed and a genuine rescue are indistinguishable at a point. So this
 * is not a foregone conclusion in either direction, which is the whole reason
 * to measure rather than assume.
 */
import { readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (path.startsWith('/')) return new Response(readFileSync(`public${path}`), { status: 200 });
  return realFetch(path, init);
};

const { nearestReach, hasReachData } = await import('../src/rivers.ts');
const { modifiedHydestAnnualMean } = await import('../src/engine/modified-hydest.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

const SNAP_KM = 1.0;
const MIN_YEARS = 10;
/** The measured correction that recentres the blend; see engine/flowchoice.ts. */
const BLEND_BIAS_CORRECTION = 1.1458;

const q = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
/** Typical error in log space, reported as a factor — the project's usual metric. */
const typicalError = (ratios) => {
  const ls = ratios.map((r) => Math.abs(Math.log(r)));
  return Math.exp(q(ls, 0.5));
};
const geoMean = (xs) => Math.exp(xs.reduce((t, x) => t + Math.log(x), 0) / xs.length);

const rows = [];
let skipped = 0;
for (const st of records.stations) {
  if (st.lat == null || !(st.completeYears >= MIN_YEARS) || !(st.meanCms > 0)) {
    skipped++;
    continue;
  }
  if (!hasReachData(st.lat, st.lon)) {
    skipped++;
    continue;
  }
  const hit = await nearestReach(st.lat, st.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) {
    skipped++;
    continue;
  }
  const r = hit.nearest;
  const network = r.meanDischargeCms;
  if (
    !(network > 0) ||
    !(r.uplandKm2 > 0) ||
    !(r.reachUplandKm2 > 0) ||
    !Number.isFinite(r.below5000Frac) ||
    !Number.isFinite(r.below3000Frac) ||
    !Number.isFinite(r.averageAltitudeM) ||
    !Number.isFinite(r.annualPrecipMm)
  ) {
    skipped++;
    continue;
  }

  /** The blend as shipped, with whichever catchment area is handed to it. */
  const blendWith = (km2) => {
    const mod = modifiedHydestAnnualMean({
      below5000Km2: km2 * r.below5000Frac,
      below3000Km2: km2 * r.below3000Frac,
      averageAltitudeM: r.averageAltitudeM,
      annualWetnessMm: r.annualPrecipMm,
    });
    return mod && mod > 0 ? Math.sqrt(network * mod) * BLEND_BIAS_CORRECTION : null;
  };

  const merit = blendWith(r.uplandKm2);
  const reach = blendWith(r.reachUplandKm2);
  if (!merit || !reach) {
    skipped++;
    continue;
  }

  rows.push({
    id: st.id,
    river: st.river,
    measured: st.meanCms,
    meritKm2: r.uplandKm2,
    reachKm2: r.reachUplandKm2,
    areaRatio: r.uplandKm2 / r.reachUplandKm2,
    areaSource: r.areaSource,
    meritRatio: merit / st.meanCms,
    reachRatio: reach / st.meanCms,
  });
}

console.log(`\n${'='.repeat(74)}`);
console.log('DROPPING MERIT HYDRO — what the licence would cost, at 69 DHM gauges');
console.log('='.repeat(74));
console.log(`${rows.length} gauges with ${MIN_YEARS}+ complete years and both areas present (${skipped} set aside).\n`);

const report = (label, key) => {
  const rs = rows.map((x) => x[key]);
  console.log(
    `  ${label.padEnd(30)} median ${q(rs, 0.5).toFixed(2)}x  bias ${geoMean(rs).toFixed(2)}x  ` +
      `typ.err ${typicalError(rs).toFixed(2)}x  within 2x ${((rs.filter((v) => v > 0.5 && v < 2).length / rs.length) * 100).toFixed(0)}%`
  );
};

console.log('BLEND AGAINST THE MEASURED MEAN');
report('with MERIT (as shipped)', 'meritRatio');
report('with HydroRIVERS area only', 'reachRatio');

/**
 * Paired, because the denominator cannot move here — every row carries both
 * answers. This is the comparison harness rule 2 exists to protect.
 */
const better = rows.filter((x) => Math.abs(Math.log(x.reachRatio)) < Math.abs(Math.log(x.meritRatio)));
const worse = rows.filter((x) => Math.abs(Math.log(x.reachRatio)) > Math.abs(Math.log(x.meritRatio)));
const same = rows.length - better.length - worse.length;
console.log(
  `\n  PAIRED on ${rows.length} identical gauges: dropping MERIT is closer on ${better.length}, ` +
    `further on ${worse.length}, unchanged on ${same}.`
);

console.log('\nHOW OFTEN DO THE TWO AREAS EVEN DIFFER');
const diff = rows.filter((x) => Math.abs(x.areaRatio - 1) > 0.01);
console.log(`  ${diff.length}/${rows.length} gauges have areas differing by more than 1%.`);
console.log(
  `  area ratio MERIT/reach: p10 ${q(rows.map((x) => x.areaRatio), 0.1).toFixed(2)}  ` +
    `median ${q(rows.map((x) => x.areaRatio), 0.5).toFixed(2)}  ` +
    `p90 ${q(rows.map((x) => x.areaRatio), 0.9).toFixed(2)}`
);
const bled = rows.filter((x) => x.areaRatio > 2);
console.log(`  ${bled.length}/${rows.length} read more than 2x the reach's own area — the documented bleed.`);

console.log('\n  the gauges where the choice matters most:');
const moved = [...rows]
  .sort((a, b) => Math.abs(Math.log(b.meritRatio / b.reachRatio)) - Math.abs(Math.log(a.meritRatio / a.reachRatio)))
  .slice(0, 10);
for (const x of moved) {
  console.log(
    `    ${String(x.river ?? '').slice(0, 20).padEnd(21)}` +
      `MERIT ${x.meritKm2.toFixed(0).padStart(6)} km2 vs reach ${x.reachKm2.toFixed(0).padStart(6)} km2  ` +
      `blend ${x.meritRatio.toFixed(2)}x -> ${x.reachRatio.toFixed(2)}x`
  );
}

/**
 * THE TRAP, TESTED RATHER THAN INVOKED.
 *
 * CLAUDE.md names this failure mode four times: the gauge population is
 * systematically easier than the use population. DHM gauges sit on a median
 * catchment of ~800 km2 and DoED projects near ~100 km2; gauges are order 4-5
 * and projects order 1-3; MERIT's bleed rate is ~1% at gauges and ~9% at
 * projects. Three separate changes have looked good on gauges and failed on
 * plants for exactly this reason.
 *
 * So the gauge result above cannot carry this decision alone. What CAN be
 * measured offline is the INPUT that drives it: how far apart the two areas sit
 * at real project intakes, against how far apart they sit at gauges. If they
 * diverge much more at projects, the gauge A/B is scoring the easy half.
 */
const fleet = JSON.parse(readFileSync('src/data/fleet-validation.json', 'utf8'));
const plantRows = [];
for (const pl of fleet.plants) {
  const res = pl.result;
  if (!res?.ok || !res.snappedIntake) continue;
  const [plat, plon] = res.snappedIntake;
  if (!hasReachData(plat, plon)) continue;
  const phit = await nearestReach(plat, plon).catch(() => null);
  if (!phit) continue;
  const pr = phit.nearest;
  if (!(pr.uplandKm2 > 0) || !(pr.reachUplandKm2 > 0)) continue;
  plantRows.push({ ratio: pr.uplandKm2 / pr.reachUplandKm2, km2: pr.uplandKm2 });
}

const spread = (label, ratios) =>
  console.log(
    `  ${label.padEnd(32)} n=${String(ratios.length).padStart(3)}  ` +
      `differ >1%: ${((ratios.filter((v) => Math.abs(v - 1) > 0.01).length / ratios.length) * 100).toFixed(0)}%  ` +
      `over 2x: ${((ratios.filter((v) => v > 2).length / ratios.length) * 100).toFixed(0)}%  ` +
      `p90 ${q(ratios, 0.9).toFixed(2)}  max ${Math.max(...ratios).toFixed(1)}`
  );

console.log('\nTHE TRAP: DO THE TWO AREAS DIVERGE MORE WHERE PROJECTS ACTUALLY SIT?');
spread('the 69-gauge population', rows.map((x) => x.areaRatio));
spread('commissioned plant intakes', plantRows.map((x) => x.ratio));
console.log(
  `  median catchment: gauges ${q(rows.map((x) => x.meritKm2), 0.5).toFixed(0)} km2, ` +
    `plants ${q(plantRows.map((x) => x.km2), 0.5).toFixed(0)} km2`
);
console.log('  If the plant row is materially worse, the gauge A/B above scores the easy half and');
console.log('  this licence decision needs a full fleet re-run behind it, not this file.');

console.log('\nThis prices ONE licence decision. It is not the whole cost of dropping MERIT: the');
console.log('per-vertex area also drives the catchment shown to the user, the specific-discharge');
console.log('plausibility screen and the water balance. What it does settle is whether the FLOW');
console.log('would get worse, which is the part that decides whether the app still works.\n');
