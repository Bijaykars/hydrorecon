/**
 * Is the runoff-coefficient tail glacier melt? Now asked with actual ice.
 *
 *   node --experimental-strip-types --no-warnings checks/glaciers-vs-waterbalance.mjs
 *
 * `checks/waterbalance-vs-fleet.mjs` found that 22 of 69 measured DHM records
 * imply a runoff coefficient above 1, and tested the obvious explanation — snow
 * and ice melt — against the only proxy the app had: the share of catchment
 * above 5,000 m. That correlated at rho 0.26, which was weak enough to reject
 * the explanation but not strong enough to be sure the PROXY was not the
 * problem. Above 5,000 m in Nepal is mostly bare rock.
 *
 * RGI 7.0 removes the excuse. 6,816 glacier outlines with their own areas, cut
 * to the three transboundary basins, routed to each gauge down the same directed
 * network the lake connectivity screen uses. This is glacierised fraction as
 * measured, not inferred from a contour.
 *
 * If ice explains the tail, the coefficient rises with the glacierised fraction
 * and a two-tier ceiling becomes defensible. If it does not, one constant stands
 * and the tail is input error.
 */
import { readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (path.startsWith('/')) return new Response(readFileSync(`public${path}`), { status: 200 });
  return realFetch(path, init);
};

const { nearestReach, hasReachData } = await import('../src/rivers.ts');
const { glaciersUpstreamOf } = await import('../src/glaciers.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

const SECONDS_PER_YEAR = 31_556_952;
const SNAP_KM = 1.0;
const MIN_YEARS = 10;
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;

const quantile = (xs, q) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const spearman = (xs, ys) => {
  const rank = (v) => {
    const idx = v.map((x, k) => [x, k]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    for (let k = 0; k < idx.length; k++) r[idx[k][1]] = k + 1;
    return r;
  };
  const a = rank(xs);
  const b = rank(ys);
  const n = a.length;
  const m = (n + 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let k = 0; k < n; k++) {
    num += (a[k] - m) * (b[k] - m);
    da += (a[k] - m) ** 2;
    db += (b[k] - m) ** 2;
  }
  return num / Math.sqrt(da * db);
};

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
  const km2 = r.uplandKm2;
  const rainMm = r.annualPrecipMm;
  if (!(km2 > 0) || !(rainMm > 0)) {
    skipped++;
    continue;
  }
  const specific = st.meanCms / km2;
  if (specific < SPECIFIC_MIN || specific > SPECIFIC_MAX) {
    skipped++;
    continue;
  }

  const ice = await glaciersUpstreamOf({ lat: st.lat, lon: st.lon }, km2).catch(() => null);
  rows.push({
    id: st.id,
    river: st.river,
    km2,
    rainMm,
    measured: st.meanCms,
    coefficient: (st.meanCms * SECONDS_PER_YEAR * 1000) / (km2 * 1e6) / rainMm,
    iceKm2: ice?.iceKm2 ?? 0,
    iceFrac: ice?.glacierisedFraction ?? 0,
    glaciers: ice?.connected.length ?? 0,
    lowestFrontM: ice?.lowestFrontM ?? null,
    aboveFrac: Number.isFinite(r.below5000Frac) ? 1 - r.below5000Frac : null,
  });
  process.stdout.write(`\r  ${rows.length} gauges routed…`);
}
process.stdout.write('\r');

console.log(`${'='.repeat(74)}`);
console.log('GLACIERISED FRACTION vs THE RUNOFF COEFFICIENT — measured ice, 69 gauges');
console.log('='.repeat(74));
console.log(`${rows.length} DHM gauges, ${MIN_YEARS}+ complete years, plausible specific discharge (${skipped} set aside).\n`);

const band = (label, xs) => {
  const cs = xs.map((x) => x.coefficient);
  if (!cs.length) {
    console.log(`  ${label.padEnd(30)} n=  0`);
    return;
  }
  console.log(
    `  ${label.padEnd(30)} n=${String(cs.length).padStart(3)}  ` +
      `median ${quantile(cs, 0.5).toFixed(2)}  p90 ${quantile(cs, 0.9).toFixed(2)}  ` +
      `max ${Math.max(...cs).toFixed(2)}  over 1.0: ${cs.filter((v) => v > 1).length}`
  );
};

band('no connected ice at all', rows.filter((x) => x.iceFrac === 0));
band('under 2% glacierised', rows.filter((x) => x.iceFrac > 0 && x.iceFrac <= 0.02));
band('2-10% glacierised', rows.filter((x) => x.iceFrac > 0.02 && x.iceFrac <= 0.1));
band('over 10% glacierised', rows.filter((x) => x.iceFrac > 0.1));

const withIce = rows.filter((x) => x.iceFrac != null);
console.log('\n  rank correlation of the measured coefficient with:');
console.log(
  `    glacierised fraction (RGI, measured)  rho ${spearman(withIce.map((x) => x.iceFrac), withIce.map((x) => x.coefficient)).toFixed(2)}`
);
const withHyp = rows.filter((x) => x.aboveFrac != null);
console.log(
  `    share above 5,000 m (the old proxy)   rho ${spearman(withHyp.map((x) => x.aboveFrac), withHyp.map((x) => x.coefficient)).toFixed(2)}`
);
console.log(
  `\n  and the proxy against the real thing:  rho ${spearman(withHyp.map((x) => x.aboveFrac), withHyp.map((x) => x.iceFrac)).toFixed(2)}`
);
console.log('  (if that is high the proxy was fine; if it is low the proxy was measuring a mountain)');

const iced = rows.filter((x) => x.iceFrac > 0.02);
const bare = rows.filter((x) => x.iceFrac <= 0.02);
console.log(
  `\n  a two-tier ceiling would need ${bare.length ? Math.max(...bare.map((x) => x.coefficient)).toFixed(2) : '–'} ` +
    `for the ${bare.length} barely-glacierised catchments and ` +
    `${iced.length ? Math.max(...iced.map((x) => x.coefficient)).toFixed(2) : '–'} for the ${iced.length} glacierised ones.`
);

console.log('\n  the gauges over 1.0, with the ice actually upstream of them:');
for (const f of rows.filter((x) => x.coefficient > 1).sort((a, b) => b.coefficient - a.coefficient)) {
  console.log(
    `    C ${f.coefficient.toFixed(2)}  ${String(f.river ?? '').slice(0, 20).padEnd(21)}` +
      `${f.km2.toFixed(0).padStart(6)} km²  ` +
      `ice ${f.iceKm2.toFixed(1).padStart(7)} km² = ${(f.iceFrac * 100).toFixed(1).padStart(5)}%  ` +
      `${String(f.glaciers).padStart(3)} glaciers  ` +
      `front ${f.lowestFrontM == null ? '   n/a' : `${f.lowestFrontM} m`}`
  );
}

const noIceOver1 = rows.filter((x) => x.coefficient > 1 && x.iceFrac === 0);
console.log(
  `\n  ${noIceOver1.length} of the ${rows.filter((x) => x.coefficient > 1).length} exceedances have NO connected ice at all.`
);
console.log('');
