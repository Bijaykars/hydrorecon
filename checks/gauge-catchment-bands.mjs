/**
 * Is the gauge population's easiness the network's, or the filter's - and what
 * does the flow error look like on the catchments projects actually sit on?
 *
 *   python pipeline/build-dhm-catchments.py        # once; needs the DHM PDF
 *   node --experimental-strip-types --no-warnings checks/gauge-catchment-bands.mjs
 *
 * CLAUDE.md's oldest known weakness: "the gauge population is systematically
 * easier than the use population" - DHM gauges on a median ~800 km2 (1,957 km2
 * for the 69 that carry the headline), projects near 100-160. Three changes have
 * looked good on gauges and failed on plants for exactly that reason.
 *
 * The headline set is filtered to TEN complete years, and long records live on
 * big rivers. DHM publishes a drainage area for every station it operates, with
 * no reference to how long anyone holds a record, so the network's own size
 * distribution can be read off and set against the filtered one. If the network
 * is also small-catchment, the gauge/plant gap is the project's filter; if not,
 * it is the network.
 *
 * WHAT THIS CAN AND CANNOT SUPPORT. The comparison is the annual MEAN of the
 * shipped blend, sqrt(network x Modified HYDEST) x BLEND_BIAS_CORRECTION, against
 * the gauge mean - the same thing checks/blend-weights.mjs and
 * checks/merit-vs-reach-area.mjs score. An annual mean survives a short record
 * better than anything else; section 4 measures by how much, by resampling the
 * long records. A DRY-SEASON SHARE does not survive 3 years, and section 4 says
 * by how many points. Nothing here scores a seasonal quantity at a short gauge.
 *
 * HARNESS RULES THIS FILE IS BUILT AROUND.
 *  - Rule 2: n is printed for every cell. Tiers are cumulative AND the
 *    INCREMENTAL rows (3-9 years) are printed alone, because comparing 10+ with
 *    3+ mixes a changed population with a changed record, and the only honest
 *    comparison of tiers is on rows that differ by nothing but their record.
 *    No figure here is compared with the CLAUDE.md headline except where the
 *    replication row reproduces the same population on purpose.
 *  - Rule 4: the specific-discharge screen the headline uses is itself a filter
 *    that can bite small catchments harder. How many rows it removes, by band,
 *    and whether they were really mis-snaps, is printed.
 *
 * MEASURING A CATCHMENT TWO WAYS. The band is DHM's own printed drainage area
 * where the join found one (independent of the engine), and the engine's snapped
 * MERIT area otherwise, marked. The ratio between the two is itself reported:
 * where the snapped channel carries a different area from the gauge's, the row
 * is measuring channel matching and not hydrology.
 */
import { readFileSync, existsSync } from 'node:fs';

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

const CATCH = 'sources/dhm-catchments.json';
if (!existsSync(CATCH)) {
  console.error(`${CATCH} is missing - run: python pipeline/build-dhm-catchments.py`);
  process.exit(1);
}
const { hasReachData, nearestReach, SNAP_KM } = await import('../src/rivers.ts');
const { modifiedHydestAnnualMean } = await import('../src/engine/modified-hydest.ts');
const { BLEND_BIAS_CORRECTION } = await import('../src/engine/flowchoice.ts');
const { engineSignature } = await import('../pipeline/engine-signature.mjs');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8')).stations;
const table = JSON.parse(readFileSync(CATCH, 'utf8')).stations;
const dhm = new Map(table.map((s) => [s.id, s]));

const SPECIFIC_MIN = 0.005; // same screen as checks/blend-weights.mjs
const SPECIFIC_MAX = 0.25;
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const BANDS = [
  { name: '<100', lo: 0, hi: 100 },
  { name: '100-500', lo: 100, hi: 500 },
  { name: '500-2000', lo: 500, hi: 2000 },
  { name: '>2000', lo: 2000, hi: Infinity },
];
const bandOf = (a) => BANDS.findIndex((b) => a >= b.lo && a < b.hi);
const TIERS = [10, 5, 3];

const q = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '  - ');
/** Seeded, so the interval printed is the interval next time. */
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

console.log(`engineSignature ${engineSignature()}   BLEND_BIAS_CORRECTION ${BLEND_BIAS_CORRECTION}   SNAP_KM ${SNAP_KM}\n`);

/* ------------------------------------------------------------------ 1 */
console.log('='.repeat(78));
console.log('1. THE DHM NETWORK, BEFORE ANY RECORD-LENGTH FILTER');
console.log('='.repeat(78));
const heldIds = new Set(records.map((s) => s.id));
const areas = table.map((s) => s.drainageKm2).filter((a) => a > 0);
console.log(`DHM table: ${table.length} stations, ${areas.length} with a drainage area.`);
console.log(
  `  min ${Math.min(...areas).toFixed(1)}  p25 ${q(areas, 0.25).toFixed(0)}  median ${q(areas, 0.5).toFixed(0)}  ` +
    `p75 ${q(areas, 0.75).toFixed(0)}  max ${Math.max(...areas).toFixed(0)} km2`
);
console.log(`  under 100 km2: ${areas.filter((a) => a < 100).length}   under 200: ${areas.filter((a) => a < 200).length}   under 500: ${areas.filter((a) => a < 500).length}`);
const bandCounts = (as) => BANDS.map((b) => as.filter((a) => a >= b.lo && a < b.hi).length);
const showBands = (label, as) =>
  console.log(
    `  ${label.padEnd(44)} n=${String(as.length).padStart(3)}  ` +
      bandCounts(as).map((n, i) => `${BANDS[i].name} ${String(n).padStart(3)}`).join('  ') +
      `   median ${as.length ? q(as, 0.5).toFixed(0) : '-'} km2`
  );
console.log('\nBy band (count of stations):');
showBands('all DHM stations in the table', areas);
showBands('  of which the project HOLDS a record for', table.filter((s) => heldIds.has(s.id)).map((s) => s.drainageKm2));
showBands('  of which it does NOT', table.filter((s) => !heldIds.has(s.id)).map((s) => s.drainageKm2));

/* ------------------------------------------------------------------ 2 */
console.log(`\n${'='.repeat(78)}`);
console.log('2. THE JOIN, AND WHAT THE PROJECT ACTUALLY HOLDS');
console.log('='.repeat(78));
const matched = records.filter((s) => dhm.has(s.id));
const unmatched = records.filter((s) => !dhm.has(s.id));
console.log(`${records.length} records held. Joined on station number: ${matched.length} matched, ${unmatched.length} not.`);
const km = (a, b, x, y) => Math.hypot((a - x) * 111.2, (b - y) * 111.2 * Math.cos((a * Math.PI) / 180));
const disp = matched.filter((s) => s.lat != null).map((s) => km(s.lat, s.lon, dhm.get(s.id).lat, dhm.get(s.id).lon));
console.log(
  `  coordinate agreement, record vs DHM table, ${disp.length} matched with coordinates: ` +
    `median ${q(disp, 0.5).toFixed(2)} km, >1 km ${disp.filter((d) => d > 1).length}, >5 km ${disp.filter((d) => d > 5).length}, >20 km ${disp.filter((d) => d > 20).length}`
);
console.log('  unmatched records (no area in the DHM table under that number):');
for (const s of unmatched) {
  console.log(`    ${s.id.padEnd(7)} ${String(s.river).slice(0, 18).padEnd(19)} ${String(s.location ?? '').slice(0, 26).padEnd(27)} ${String(s.completeYears).padStart(2)} complete yr  mean ${s.meanCms} m3/s`);
}
console.log('\nCatchment size of the records HELD (DHM printed area, matched rows only):');
for (const t of [0, 3, 5, 10]) {
  const as = matched.filter((s) => s.completeYears >= t).map((s) => dhm.get(s.id).drainageKm2);
  showBands(t === 0 ? 'all held records' : `held, ${t}+ complete years`, as);
}
console.log('  (the engine-snapped area is used below only where DHM printed none)');

/* ------------------------------------------------------------------ 3 */
const rows = [];
const dropped = { noCoord: 0, offNet: 0, noSources: 0 };
for (const s of records) {
  if (s.lat == null || !(s.meanCms > 0)) { dropped.noCoord++; continue; }
  if (!hasReachData(s.lat, s.lon)) { dropped.offNet++; continue; }
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) { dropped.offNet++; continue; }
  const r = hit.nearest;
  const A = r.uplandKm2;
  const mod = modifiedHydestAnnualMean({
    below3000Km2: A * r.below3000Frac,
    below5000Km2: A * r.below5000Frac,
    averageAltitudeM: r.averageAltitudeM,
    annualWetnessMm: r.annualPrecipMm,
  });
  if (!(A > 0) || !Number.isFinite(r.below5000Frac) || !(mod > 0) || !(r.meanDischargeCms > 0)) { dropped.noSources++; continue; }
  const blend = Math.sqrt(r.meanDischargeCms * mod) * BLEND_BIAS_CORRECTION;
  const d = dhm.get(s.id);
  // Mean of the COMPLETE years only. meanCms averages every day present, partial
  // years included, so a short record can carry a missing monsoon in its mean.
  let cleanMean = null;
  let annual = [];
  const f = `sources/dhm/${s.id}.json`;
  if (existsSync(f)) {
    const yrs = JSON.parse(readFileSync(f, 'utf8')).years;
    for (const y of Object.keys(yrs)) {
      const days = yrs[y];
      const have = days.filter((v) => v != null);
      if (have.length >= 350) annual.push({ mean: mean(have), dry: dryShare(days) });
    }
    if (annual.length) cleanMean = mean(annual.map((a) => a.mean));
  }
  rows.push({
    id: s.id, river: s.river, years: s.completeYears, measured: s.meanCms, cleanMean, annual,
    A, dhmA: d?.drainageKm2 ?? null,
    area: d?.drainageKm2 ?? A, areaSrc: d ? 'dhm' : 'engine',
    spec: s.meanCms / A, ratio: blend / s.meanCms, cleanRatio: cleanMean ? blend / cleanMean : null,
    areaRatio: d ? A / d.drainageKm2 : null,
  });
}
/** Dec-May share of the year's volume - NEA's dry season. */
function dryShare(days) {
  const off = [0];
  for (const n of MONTH_DAYS) off.push(off[off.length - 1] + n);
  const sum = (a, b) => days.slice(a, b).reduce((t, v) => t + (v ?? 0), 0);
  const total = sum(0, days.length);
  return total > 0 ? (sum(off[0], off[5]) + sum(off[11], off[12])) / total : null;
}
for (const r of rows) r.band = bandOf(r.area);
const screened = (r) => r.spec >= SPECIFIC_MIN && r.spec <= SPECIFIC_MAX;

console.log(`\n${'='.repeat(78)}`);
console.log('3. THE SHIPPED BLEND AGAINST THE MEASURED MEAN, BY CATCHMENT SIZE');
console.log('='.repeat(78));
console.log(`${rows.length} records run (set aside: ${dropped.noCoord} no coordinates, ${dropped.offNet} off the network or beyond ${SNAP_KM} km, ${dropped.noSources} missing a source).`);
console.log('ratio = blend / measured; >1 reads high. typ.err = exp(mean |ln ratio|), the project\'s metric.');
console.log('Brackets are seeded 95% bootstrap intervals on bias and on typ.err. "TOO FEW" marks n < 8: do not read it.\n');

function stat(rs, key = 'ratio') {
  const v = rs.map((r) => r[key]).filter(Number.isFinite);
  if (!v.length) return null;
  const e = v.map((x) => Math.log(x));
  const typ = (xs) => Math.exp(mean(xs.map(Math.abs)));
  const rand = rng(12345 + v.length);
  const boots = [];
  const bootBias = [];
  for (let b = 0; b < 2000; b++) {
    const draw = Array.from({ length: e.length }, () => e[(rand() * e.length) | 0]);
    boots.push(typ(draw));
    bootBias.push(Math.exp(mean(draw)));
  }
  return {
    n: v.length,
    median: q(v, 0.5),
    bias: Math.exp(mean(e)),
    biasLo: q(bootBias, 0.025),
    biasHi: q(bootBias, 0.975),
    typ: typ(e),
    lo: q(boots, 0.025),
    hi: q(boots, 0.975),
    w2: (100 * v.filter((x) => x > 0.5 && x < 2).length) / v.length,
  };
}
const line = (label, rs, key) => {
  const s = stat(rs, key);
  if (!s) return `  ${label.padEnd(13)} n=  0`;
  return (
    `  ${label.padEnd(13)} n=${String(s.n).padStart(3)}  median ${f2(s.median)}x  bias ${f2(s.bias)}x [${f2(s.biasLo)}-${f2(s.biasHi)}]  ` +
    `typ.err ${f2(s.typ)}x [${f2(s.lo)}-${f2(s.hi)}]  within 2x ${s.w2.toFixed(0).padStart(3)}%` +
    (s.n < 8 ? '  TOO FEW' : '')
  );
};
function bandTable(title, rs, key) {
  console.log(title);
  BANDS.forEach((b, i) => console.log(line(b.name, rs.filter((r) => r.band === i), key)));
  console.log(line('<200 (pooled)', rs.filter((r) => r.area < 200), key));
  console.log(line('<500 (pooled)', rs.filter((r) => r.area < 500), key));
  console.log(line('ALL', rs, key));
}

console.log('--- replication: the headline population, by the headline rules');
const head = rows.filter((r) => r.years >= 10 && screened(r));
console.log(line('10+ yr, ALL', head));
console.log('    (CLAUDE.md: 69 gauges, typ.err ~1.37x with the LOO bias fit; this scores the shipped constant)');
console.log(`    median catchment of these ${head.length}: ${q(head.map((r) => r.area), 0.5).toFixed(0)} km2 by the band area, ${q(head.map((r) => r.A), 0.5).toFixed(0)} km2 engine-snapped`);

for (const t of TIERS) {
  console.log(`\n${'-'.repeat(78)}\nTIER: ${t}+ complete years (cumulative), screened as the headline is`);
  bandTable('', rows.filter((r) => r.years >= t && screened(r)));
}
console.log(`\n${'-'.repeat(78)}\nINCREMENTAL: stations with 5-9 complete years ONLY (the rows 5+ adds to 10+)`);
bandTable('', rows.filter((r) => r.years >= 5 && r.years < 10 && screened(r)));
console.log(`\n${'-'.repeat(78)}\nINCREMENTAL: stations with 3-4 complete years ONLY (the rows 3+ adds to 5+)`);
bandTable('', rows.filter((r) => r.years >= 3 && r.years < 5 && screened(r)));

console.log(`\n${'-'.repeat(78)}\nSAME 3+ TIER, scored against the mean of COMPLETE YEARS ONLY (meanCms includes partial years)`);
const t3 = rows.filter((r) => r.years >= 3 && screened(r) && r.cleanRatio);
bandTable('', t3, 'cleanRatio');
const shift = t3.map((r) => Math.abs(Math.log(r.cleanMean / r.measured)));
console.log(`  meanCms vs complete-year mean: median |shift| ${(100 * (Math.exp(q(shift, 0.5)) - 1)).toFixed(1)}%, p90 ${(100 * (Math.exp(q(shift, 0.9)) - 1)).toFixed(1)}%, worst ${(100 * (Math.exp(Math.max(...shift)) - 1)).toFixed(0)}%`);

console.log(`\n${'-'.repeat(78)}\nWHAT THE SPECIFIC-DISCHARGE SCREEN REMOVES (3+ yr), by band   [harness rule 4]`);
console.log('A removed row is a river the screen called impossible. If its engine area also disagrees with');
console.log('the DHM printed area by >2x it really was a mis-snap; if the areas agree, the screen removed a real river.');
BANDS.forEach((b, i) => {
  const all = rows.filter((r) => r.years >= 3 && r.band === i);
  const out = all.filter((r) => !screened(r));
  const matchedOut = out.filter((r) => r.areaRatio != null);
  const real = matchedOut.filter((r) => r.areaRatio > 0.5 && r.areaRatio < 2);
  console.log(
    `  ${b.name.padEnd(9)} ${String(all.length).padStart(3)} run, ${String(out.length).padStart(2)} removed ` +
      `(${matchedOut.length} with a DHM area: ${matchedOut.length - real.length} area-mismatch, ${real.length} areas agree)`
  );
});

console.log(`\n${'-'.repeat(78)}\nDOES THE ENGINE'S AREA AGREE WITH DHM'S? (3+ yr, matched rows, before the screen)`);
BANDS.forEach((b, i) => {
  const m = rows.filter((r) => r.years >= 3 && r.band === i && r.areaRatio != null);
  if (!m.length) return console.log(`  ${b.name.padEnd(9)} n=0`);
  const la = m.map((r) => Math.abs(Math.log(r.areaRatio)));
  console.log(
    `  ${b.name.padEnd(9)} n=${String(m.length).padStart(3)}  median |engine/DHM| ${Math.exp(q(la, 0.5)).toFixed(2)}x  ` +
      `outside 0.5-2x: ${m.filter((r) => r.areaRatio <= 0.5 || r.areaRatio >= 2).length}  outside 0.8-1.25x: ${m.filter((r) => r.areaRatio <= 0.8 || r.areaRatio >= 1.25).length}`
  );
});

console.log(`\n${'-'.repeat(78)}\nFLOW ERROR WHEN THE SNAPPED CHANNEL IS THE GAUGE'S OWN (engine area within 0.8-1.25x of DHM), 3+ yr, screened`);
console.log('This isolates the flow model from channel matching. It cannot be used as a use-population');
console.log('figure: a real intake has no DHM area to check against, and ~4% of plants mis-snap.');
bandTable('', rows.filter((r) => r.years >= 3 && screened(r) && r.areaRatio != null && r.areaRatio > 0.8 && r.areaRatio < 1.25));

/* ------------------------------------------------------------------ 4 */
console.log(`\n${'='.repeat(78)}`);
console.log('4. WHAT A SHORT RECORD CAN SUPPORT (resampled from the long ones)');
console.log('='.repeat(78));
console.log('Stations with 12+ complete years, from the daily files. For k = 3, 5, 10, draw 300 random sets of k');
console.log('complete years and compare their pooled mean (and Dec-May share of volume) with all of them.');
console.log('This is the error a k-year gauge carries before the model is wrong at all.\n');
const longRows = rows.filter((r) => r.annual.length >= 12);
const drawFloor = (rs, k) => {
  const rand = rng(777 + k);
  const mErr = [];
  const dErr = [];
  for (const r of rs) {
    const all = mean(r.annual.map((a) => a.mean));
    const allDry = mean(r.annual.filter((a) => a.dry != null).map((a) => a.dry));
    for (let d = 0; d < 300; d++) {
      const idx = new Set();
      while (idx.size < k) idx.add((rand() * r.annual.length) | 0);
      const sub = [...idx].map((i) => r.annual[i]);
      mErr.push(Math.abs(Math.log(mean(sub.map((a) => a.mean)) / all)));
      dErr.push(100 * Math.abs(mean(sub.filter((a) => a.dry != null).map((a) => a.dry)) - allDry));
    }
  }
  return { mean: Math.exp(mean(mErr)), p90: Math.exp(q(mErr, 0.9)), dry: mean(dErr), dryP90: q(dErr, 0.9) };
};
console.log(`  ${'subset'.padEnd(18)} ${'stations'.padStart(8)}   ${'k'.padStart(2)}   annual-mean error (typ / p90)   dry-share error, points (mean / p90)`);
for (const [label, sel] of [
  ['all long records', longRows],
  ...BANDS.map((b, i) => [b.name + ' km2', longRows.filter((r) => r.band === i)]),
]) {
  for (const k of [3, 5, 10]) {
    if (sel.length < 3) { console.log(`  ${label.padEnd(18)} ${String(sel.length).padStart(8)}   ${String(k).padStart(2)}   too few stations`); continue; }
    const f = drawFloor(sel, k);
    console.log(`  ${label.padEnd(18)} ${String(sel.length).padStart(8)}   ${String(k).padStart(2)}   ${f2(f.mean)}x / ${f2(f.p90)}x                    ${f.dry.toFixed(1)} / ${f.dryP90.toFixed(1)}`);
  }
}
console.log('\n  Read against the model error above: where the noise floor for k years is a large fraction of the');
console.log('  observed typ.err the row is mostly measuring the gauge. The dry-share column is the error budget for');
console.log('  any seasonal claim: compare it with the 3.7 pt bias and 5.1 pt typical error CLAUDE.md quotes. At 3');
console.log('  years it is the same order as the effect being measured, and no band holds enough short gauges to');
console.log('  score a verdict (a confusion matrix needs far more than 11), so none is attempted here.');

/* ------------------------------------------------------------------ 5 */
console.log(`\n${'='.repeat(78)}`);
console.log('5. WHERE PROJECTS SIT, AND THE ERROR WEIGHTED TO THAT');
console.log('='.repeat(78));
const fleetPath = 'src/data/fleet-validation.json';
if (existsSync(fleetPath)) {
  const fleet = JSON.parse(readFileSync(fleetPath, 'utf8'));
  const pa = [];
  for (const pl of fleet.plants) {
    const res = pl.result;
    if (!res?.ok || !res.snappedIntake) continue;
    const [plat, plon] = res.snappedIntake;
    if (!hasReachData(plat, plon)) continue;
    const ph = await nearestReach(plat, plon).catch(() => null);
    if (ph?.nearest.uplandKm2 > 0) pa.push(ph.nearest.uplandKm2);
  }
  const shares = bandCounts(pa).map((n) => n / pa.length);
  showBands('commissioned plant intakes (engine area)', pa);
  console.log(`  plant shares by band: ${BANDS.map((b, i) => `${b.name} ${(100 * shares[i]).toFixed(0)}%`).join('  ')}`);
  console.log(`  note: plant bands use the engine's snapped area; gauge bands use DHM's printed one.\n`);
  const weighted = (rs) => {
    let s = 0, w = 0, empty = [];
    BANDS.forEach((b, i) => {
      const sub = rs.filter((r) => r.band === i && Number.isFinite(r.ratio));
      if (!sub.length) { if (shares[i] > 0) empty.push(b.name); return; }
      s += shares[i] * mean(sub.map((r) => Math.abs(Math.log(r.ratio))));
      w += shares[i];
    });
    return { typ: Math.exp(s / w), covered: w, empty };
  };
  console.log('  typ.err weighted by the PLANT band shares (bands with no gauge dropped and the weights renormalised):');
  for (const t of TIERS) {
    const rs = rows.filter((r) => r.years >= t && screened(r));
    const un = stat(rs);
    const w = weighted(rs);
    console.log(
      `    ${String(t).padStart(2)}+ yr  n=${String(rs.length).padStart(3)}  raw (gauge-weighted) ${f2(un.typ)}x   plant-weighted ${f2(w.typ)}x ` +
        `(covers ${(100 * w.covered).toFixed(0)}% of plants${w.empty.length ? `; no gauge in ${w.empty.join(', ')}` : ''})`
    );
  }
} else {
  console.log(`${fleetPath} missing; plant shares not computed.`);
}
console.log('\nA band with fewer than 8 rows is not a measurement. Nothing here changes an engine number.\n');
