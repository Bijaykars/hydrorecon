/**
 * Leave-one-out validation of the gauge-transfer rule.
 *
 *   node --experimental-strip-types --no-warnings checks/transfer-loo.mjs
 *
 * Half the fleet turned out to run on a TRANSFERRED DHM record rather than a
 * model (checks in pipeline/build-fleet-validation.mjs report it now). On those
 * sites the whole flow-choice apparatus is bypassed and the answer rests
 * entirely on one rule in src/dhm.ts: borrow the nearest gauge whose catchment
 * is closest in size, and scale its flows by the area ratio.
 *
 * That rule has never been tested. It is also not obviously right. Area ratio
 * and distance are proxies for hydrological similarity, not the thing itself:
 * two catchments of equal size on opposite sides of a rain shadow transfer
 * badly, and the rule cannot see it.
 *
 * A transfer rule can only be tested by asking it to predict a gauge it is not
 * allowed to see, so bestTransfer takes an excludeId for exactly this.
 *
 * Two questions:
 *   1. How accurate is a transfer, by the grade the rule assigns it? If the
 *      grades do not separate, they are decoration.
 *   2. Is the LINEAR area scaling right? Flow rarely scales with area to the
 *      first power — the literature puts the exponent nearer 0.8 — and the
 *      exponent is one number that applies to every transferred site.
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
const { bestTransfer } = await import('../src/dhm.ts');
const { modifiedHydestAnnualMean } = await import('../src/engine/modified-hydest.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

/** Mean flow by station id, from the same records the app validates against. */
const meanById = new Map();
for (const s of records.stations) if (s.meanCms > 0) meanById.set(String(s.id), s.meanCms);

const rows = [];
for (const s of records.stations) {
  if (s.lat == null || !(s.meanCms > 0) || (s.completeYears ?? 0) < 5) continue;
  if (!hasReachData(s.lat, s.lon)) continue;
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > 1) continue;
  const r = hit.nearest;
  const A = r.uplandKm2;
  if (!(A > 0) || !Number.isFinite(r.below5000Frac)) continue;
  const spec = s.meanCms / A;
  if (spec < 0.005 || spec > 0.25) continue; // the gauge itself is mis-snapped

  const t = await bestTransfer(s.lat, s.lon, A, String(s.id)).catch(() => null);
  if (!t) continue;
  const donorMean = meanById.get(String(t.station.id));
  if (!(donorMean > 0) || !(t.gaugeKm2 > 0)) continue;

  rows.push({
    river: s.river,
    truth: s.meanCms,
    donorMean,
    areaRatio: A / t.gaugeKm2,
    quality: t.quality,
    km: t.straightKm,
    donorYears: t.station.completeYears ?? 0,
    siteKm2: A,
    modified: modifiedHydestAnnualMean({
      below3000Km2: A * r.below3000Frac,
      below5000Km2: A * r.below5000Frac,
      averageAltitudeM: r.averageAltitudeM,
      annualWetnessMm: r.annualPrecipMm,
    }),
  });
}

const stat = (v) => {
  const l = v.filter((x) => x > 0).map(Math.log).sort((a, b) => a - b);
  if (!l.length) return null;
  return {
    n: l.length,
    median: Math.exp(l[Math.floor(l.length / 2)]),
    typ: Math.exp(l.reduce((a, b) => a + Math.abs(b), 0) / l.length),
    w2: (l.filter((x) => Math.abs(x) <= Math.log(2)).length / l.length) * 100,
  };
};

/** What the app does today: donor flow times the area ratio, exponent 1. */
const predict = (r, exp) => r.donorMean * Math.pow(r.areaRatio, exp);

console.log(`\n${rows.length} gauges predicted from another gauge they could not see\n`);
console.log(`  ${'grade'.padEnd(14)}${'n'.padStart(5)}${'median'.padStart(9)}${'typ.err'.padStart(9)}${'within 2x'.padStart(11)}`);
for (const g of ['close', 'usable', 'indicative', 'ALL']) {
  const sub = g === 'ALL' ? rows : rows.filter((r) => r.quality === g);
  const st = stat(sub.map((r) => predict(r, 1) / r.truth));
  if (!st) continue;
  console.log(
    `  ${g.padEnd(14)}${String(st.n).padStart(5)}${st.median.toFixed(2).padStart(8)}x` +
      `${st.typ.toFixed(2).padStart(8)}x${(st.w2.toFixed(0) + '%').padStart(10)}`
  );
}

/**
 * The grades came out backwards — 'close', the only grade trusted to override
 * the model, scored WORSE than the looser 'usable'. Before believing that,
 * check whether the grade is standing in for catchment size: a nearby gauge of
 * similar area is most easily found on small headwaters, and small catchments
 * are harder for every method measured this session.
 */
console.log('');
console.log('is the grade standing in for catchment size?');
for (const g of ['close', 'usable']) {
  const sub = rows.filter((r) => r.quality === g);
  if (!sub.length) continue;
  const km2 = sub.map((r) => r.siteKm2).sort((a, b) => a - b);
  const big = stat(sub.filter((r) => r.siteKm2 >= 500).map((r) => predict(r, 1) / r.truth));
  console.log(
    `  ${g.padEnd(12)}median catchment ${km2[km2.length >> 1].toFixed(0).padStart(6)} km2   ` +
      (big ? `500+ km2 only: ${big.typ.toFixed(2)}x typ.err (n=${big.n})` : 'no 500+ km2 cases')
  );
}

/**
 * The bar the app actually applies before a transfer may override the model:
 * grade 'close' and a long donor record. Everything else is shown to the
 * engineer but forbidden from moving the number, so that subset is what
 * decides whether the feature helps.
 */
const overriding = rows.filter((r) => r.quality === 'close' && r.donorYears >= 10);
console.log(`\nthe subset allowed to OVERRIDE the model (close, 10+ donor years): n=${overriding.length}`);
for (const [label, f] of [
  ['transferred gauge', (r) => predict(r, 1)],
  ['Modified HYDEST', (r) => r.modified],
]) {
  const st = stat(overriding.map((r) => f(r) / r.truth).filter((x) => x > 0));
  if (!st) continue;
  console.log(
    `  ${label.padEnd(20)}${st.median.toFixed(2).padStart(8)}x${st.typ.toFixed(2).padStart(8)}x` +
      `${(st.w2.toFixed(0) + '%').padStart(10)}   n=${st.n}`
  );
}

/**
 * The decisive question for the override rule. It admits a donor only when the
 * grade is 'close' AND the record is 10+ years. Those two bars were introduced
 * together, justified by one plant (Chilime) that a FIVE-year neighbour ruined.
 * If the years bar is doing the work, the grade bar excludes good donors for
 * nothing.
 */
console.log('');
console.log('with a 10+ year donor, does the grade still matter?');
for (const g of ['close', 'usable']) {
  const sub = rows.filter((r) => r.quality === g && r.donorYears >= 10);
  const st = stat(sub.map((r) => predict(r, 1) / r.truth));
  if (!st) continue;
  console.log(
    `  ${g.padEnd(12)}${String(st.n).padStart(4)}  median ${st.median.toFixed(2)}x   ` +
      `typ.err ${st.typ.toFixed(2)}x   within 2x ${st.w2.toFixed(0)}%`
  );
}
const both = rows.filter((r) => (r.quality === 'close' || r.quality === 'usable') && r.donorYears >= 10);
const stBoth = stat(both.map((r) => predict(r, 1) / r.truth));
if (stBoth) {
  console.log(
    `  ${'both'.padEnd(12)}${String(stBoth.n).padStart(4)}  median ${stBoth.median.toFixed(2)}x   ` +
      `typ.err ${stBoth.typ.toFixed(2)}x   within 2x ${stBoth.w2.toFixed(0)}%`
  );
}

console.log(`\narea-scaling exponent, on the overriding subset`);
console.log(`  ${'exponent'.padEnd(12)}${'median'.padStart(9)}${'typ.err'.padStart(9)}${'within 2x'.padStart(11)}`);
for (const e of [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]) {
  const st = stat(overriding.map((r) => predict(r, e) / r.truth));
  if (!st) continue;
  console.log(
    `  ${(e === 1 ? '1.00 (shipped)' : e.toFixed(2)).padEnd(12)}${st.median.toFixed(2).padStart(8)}x` +
      `${st.typ.toFixed(2).padStart(8)}x${(st.w2.toFixed(0) + '%').padStart(10)}`
  );
}
