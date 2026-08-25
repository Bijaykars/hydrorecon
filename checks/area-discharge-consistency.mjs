/**
 * Do the catchment AREA and the catchment DISCHARGE describe the same catchment?
 *
 *   node --experimental-strip-types --no-warnings checks/area-discharge-consistency.mjs
 *
 * A reach object carries both, and since MERIT was wired in they come from
 * DIFFERENT sources: uplandKm2 is sampled from MERIT Hydro at the matched
 * VERTEX, while meanDischargeCms is HydroRIVERS' value for the whole REACH.
 * Nothing forces them to agree, and I introduced that split without checking it.
 *
 * It matters because the pair is used as a pair. Specific discharge — the
 * physics test this project leans on everywhere — is discharge divided by area,
 * so one source supplies the numerator and another the denominator. If MERIT
 * says 7,000 km2 where HydroRIVERS thinks it is on a 40 km2 side channel, the
 * ratio is meaningless even though both numbers are individually defensible.
 *
 * This measures the disagreement directly, on the gauges, where a third and
 * independent number — the measured flow — can say which one is right.
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
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

const SNAP_KM = 1.0;
const rows = [];
for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < 5 || !(s.meanCms > 0)) continue;
  if (!hasReachData(s.lat, s.lon)) continue;
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) continue;
  const r = hit.nearest;
  if (!(r.uplandKm2 > 0) || !(r.reachUplandKm2 > 0)) continue;
  rows.push({
    river: s.river,
    merit: r.uplandKm2,
    hydro: r.reachUplandKm2,
    dis: r.meanDischargeCms,
    measured: s.meanCms,
  });
}

const q = (v, p) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

const ratios = rows.map((r) => r.merit / r.hydro);
console.log(`\n${rows.length} gauges snapped within ${SNAP_KM} km\n`);
console.log('MERIT area / HydroRIVERS reach area');
console.log(`  p10 ${q(ratios, 0.1).toFixed(2)}x   median ${q(ratios, 0.5).toFixed(2)}x   p90 ${q(ratios, 0.9).toFixed(2)}x`);
console.log(`  disagree by more than 2x: ${ratios.filter((x) => x > 2 || x < 0.5).length}/${rows.length}`);

// The pair is used as a pair. Which denominator puts specific discharge in the
// band Nepal actually runs at, 0.005 to 0.25 m3/s per km2?
const band = (v) => v.filter((x) => x >= 0.005 && x <= 0.25).length;
const specMerit = rows.map((r) => r.dis / r.merit);
const specHydro = rows.map((r) => r.dis / r.hydro);
console.log('\nnetwork discharge / area, against the 0.005-0.25 physical band');
console.log(`  with MERIT area        ${band(specMerit)}/${rows.length} in band`);
console.log(`  with HydroRIVERS area  ${band(specHydro)}/${rows.length} in band`);

/**
 * The 0.005-0.25 band, applied to the network's OWN discharge over MERIT's area,
 * is a free offline mis-snap detector -- but only if it does not fire on rivers
 * that are merely dry. Nepal has genuinely arid trans-Himalayan catchments, and
 * flagging those would be worse than the mis-snaps it catches. The measured flow
 * is the referee: if the network agrees with the gauge, the flag was wrong.
 */
console.log('');
console.log('out-of-band cases, with the gauge as referee');
for (const r of rows) {
  const spec = r.dis / r.merit;
  if (spec >= 0.005 && spec <= 0.25) continue;
  const agree = r.dis / r.measured;
  console.log(
    `  ${(r.river ?? '?').slice(0, 22).padEnd(24)}spec ${spec.toFixed(5).padStart(9)}` +
      `  network/measured ${agree.toFixed(3).padStart(8)}x  ${agree > 0.5 && agree < 2 ? 'FALSE POSITIVE' : 'genuine mis-snap'}`
  );
}
