/**
 * Should the engine REFUSE a flow that exceeds the rain falling on its catchment?
 *
 *   node --experimental-strip-types --no-warnings checks/waterbalance-vs-fleet.mjs
 *
 * `src/report.ts` prints a runoff coefficient beside every mean flow, and above
 * 1 it says the flow is unresolved. That is a report-only change: it costs
 * nothing and it moves no number. Whether `flowchoice.ts` should go further and
 * REJECT such a candidate is a different question, and this harness is the
 * measurement CLAUDE.md requires before it could ship.
 *
 * THE SCREEN. Runoff depth is Q * seconds-per-year / area. Divided by rainfall
 * it is a runoff coefficient, and a catchment cannot deliver more water than
 * falls on it, so the coefficient is bounded above by roughly 1. Rainfall is
 * `annualPrecipMm` - CHPclim's catchment-mean ANNUAL total, carried per reach in
 * the bundled network, so this runs entirely offline and uses the same numbers
 * the app reads.
 *
 * THE TEST THAT MATTERS IS THE FALSE-POSITIVE ONE. A DHM gauge's mean is a
 * MEASUREMENT: the water was there. If the screen fires on a gauged record then
 * the screen is wrong - or the area or the rainfall under it is - and shipping
 * it into the engine would make the app refuse real rivers. That is Part A, and
 * nothing else here matters if Part A fails.
 *
 * Part B asks whether it discriminates: at the same gauges, does it fire more on
 * the app's candidates than on the measured truth?
 *
 * Part C runs it over the whole commissioned fleet, where there is no measured
 * truth but there is a licensed capacity to compare against.
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
const fleet = JSON.parse(readFileSync('src/data/fleet-validation.json', 'utf8'));

const SECONDS_PER_YEAR = 31_556_952;
const SNAP_KM = 1.0;
const MIN_YEARS = 10;

/**
 * Nepal runs 0.005-0.25 m3/s per km2 (the same window checks/regional-vs-gauges
 * uses). A gauge outside it has not snapped to its own river, so its AREA is
 * wrong and the screen firing there is the screen catching a mis-snap - which is
 * a different result from the screen being wrong, and has to be counted apart.
 */
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;

const coefficient = (cms, km2, annualMm) =>
  !(cms > 0) || !(km2 > 0) || !(annualMm > 0)
    ? null
    : (cms * SECONDS_PER_YEAR * 1000) / (km2 * 1e6) / annualMm;

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '–');
const quantile = (xs, q) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// ===========================================================================
// PART A + B — the gauges
// ===========================================================================
const rows = [];
let offNetwork = 0;
let noRain = 0;
let tooShort = 0;

for (const st of records.stations) {
  if (st.lat == null || st.lon == null) continue;
  if (!(st.completeYears >= MIN_YEARS)) {
    tooShort++;
    continue;
  }
  if (!(st.meanCms > 0)) {
    tooShort++;
    continue;
  }
  if (!hasReachData(st.lat, st.lon)) {
    offNetwork++;
    continue;
  }
  const hit = await nearestReach(st.lat, st.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) {
    offNetwork++;
    continue;
  }
  const r = hit.nearest;
  const km2 = r.uplandKm2;
  const rainMm = r.annualPrecipMm;
  if (!(rainMm > 0) || !(km2 > 0)) {
    noRain++;
    continue;
  }

  // the app's own candidates at this same point
  const network = r.meanDischargeCms > 0 ? r.meanDischargeCms : null;
  const modhydest =
    Number.isFinite(r.below5000Frac) && Number.isFinite(r.below3000Frac) && Number.isFinite(r.averageAltitudeM)
      ? modifiedHydestAnnualMean({
          below5000Km2: km2 * r.below5000Frac,
          below3000Km2: km2 * r.below3000Frac,
          averageAltitudeM: r.averageAltitudeM,
          annualWetnessMm: rainMm,
        })
      : null;
  const blend = network && modhydest ? Math.sqrt(network * modhydest) * 1.1458 : null;

  const specific = st.meanCms / km2;
  /**
   * The app holds no glacier ice extent — `nepal-glacial-lakes.json` is 4,152
   * LAKE points, which cannot give a melt area. What it does hold, per reach and
   * already feeding WECS/DHM, is hypsometry: the share of catchment below 5,000
   * m. Above 5,000 m in Nepal is essentially the perennial snow and ice zone, so
   * `1 - below5000Frac` is the proxy this test needs, and it costs nothing.
   */
  const aboveFrac = Number.isFinite(r.below5000Frac) ? 1 - r.below5000Frac : null;
  rows.push({
    id: st.id,
    river: st.river,
    measured: st.meanCms,
    km2,
    rainMm,
    aboveFrac,
    altitudeM: Number.isFinite(r.averageAltitudeM) ? r.averageAltitudeM : null,
    misSnapped: !(specific >= SPECIFIC_MIN && specific <= SPECIFIC_MAX),
    cMeasured: coefficient(st.meanCms, km2, rainMm),
    cNetwork: coefficient(network, km2, rainMm),
    cModHydest: coefficient(modhydest, km2, rainMm),
    cBlend: coefficient(blend, km2, rainMm),
  });
}

const clean = rows.filter((x) => !x.misSnapped);
const dirty = rows.filter((x) => x.misSnapped);

console.log(`\n${'='.repeat(74)}`);
console.log('PART A — does the screen fire on a MEASURED flow?');
console.log('='.repeat(74));
console.log(
  `${rows.length} DHM gauges, ${MIN_YEARS}+ complete years, snapped within ${SNAP_KM} km, with catchment rainfall.`
);
console.log(`  set aside: ${offNetwork} off the network or beyond the snap, ${tooShort} short or no mean, ${noRain} without rainfall\n`);

const report = (label, xs, key) => {
  const cs = xs.map((x) => x[key]).filter((v) => v != null && Number.isFinite(v));
  if (!cs.length) {
    console.log(`  ${label.padEnd(30)} no data`);
    return;
  }
  const fires = cs.filter((v) => v > 1).length;
  console.log(
    `  ${label.padEnd(30)} n=${String(cs.length).padStart(3)}  ` +
      `median ${quantile(cs, 0.5).toFixed(2)}  p90 ${quantile(cs, 0.9).toFixed(2)}  ` +
      `max ${Math.max(...cs).toFixed(2)}  ` +
      `FIRES ${String(fires).padStart(3)}/${cs.length} = ${pct(fires, cs.length)}`
  );
};

console.log('MEASURED means — every fire here is the screen calling a real river impossible');
report('all gauges', rows, 'cMeasured');
report('  plausible specific discharge', clean, 'cMeasured');
report('  mis-snapped (wrong catchment)', dirty, 'cMeasured');

const falsePositives = clean
  .filter((x) => x.cMeasured > 1)
  .sort((a, b) => b.cMeasured - a.cMeasured);
if (falsePositives.length) {
  console.log('\n  gauges the screen would wrongly refuse:');
  for (const f of falsePositives.slice(0, 12)) {
    console.log(
      `    ${String(f.id).padEnd(8)} ${String(f.river ?? '').padEnd(22)} ` +
        `measured ${f.measured.toFixed(2)} m3/s off ${f.km2.toFixed(0)} km2, ` +
        `rain ${f.rainMm.toFixed(0)} mm  ->  C ${f.cMeasured.toFixed(2)}`
    );
  }
}

console.log(`\n${'='.repeat(74)}`);
console.log('PART B — does it discriminate? Same gauges, the app’s own candidates');
console.log('='.repeat(74));
report('measured (ground truth)', clean, 'cMeasured');
report('mapped network', clean, 'cNetwork');
report('Modified HYDEST', clean, 'cModHydest');
report('blend as shipped', clean, 'cBlend');

// ===========================================================================
// PART C — the fleet
// ===========================================================================
console.log(`\n${'='.repeat(74)}`);
console.log('PART C — the whole commissioned fleet');
console.log('='.repeat(74));

const plants = [];
let noReach = 0;
for (const p of fleet.plants) {
  const r = p.result;
  if (!r?.ok || !(r.reachKm2 > 0) || !r.snappedIntake) continue;
  const [lat, lon] = r.snappedIntake;
  const hit = await nearestReach(lat, lon).catch(() => null);
  const rainMm = hit?.nearest?.annualPrecipMm;
  if (!(rainMm > 0)) {
    noReach++;
    continue;
  }
  const f = r.flow ?? null;
  plants.push({
    name: p.name,
    usedMeasured: Boolean(r.usedMeasured),
    authority: f?.authority ?? 'none',
    km2: r.reachKm2,
    rainMm,
    licenceMW: p.actual?.capacityMW ?? null,
    predictedMW: r.predicted?.capacityMW ?? null,
    waterwayKm: r.predicted?.waterwayKm ?? null,
    cShipped: coefficient(r.intakeMeanCms, r.reachKm2, rainMm),
    cNetwork: coefficient(f?.networkCms, r.reachKm2, rainMm),
    cModel: coefficient(f?.modelCms, r.reachKm2, rainMm),
    cJudge: coefficient(f?.judgeCms, r.reachKm2, rainMm),
  });
}

console.log(`${plants.length} scored plants carry a catchment, a rainfall and a flow (${noReach} without rainfall).\n`);

report('flow as shipped', plants, 'cShipped');
report('  the mapped network candidate', plants, 'cNetwork');
report('  the flood-model candidate', plants, 'cModel');
report('  the Modified HYDEST judge', plants, 'cJudge');

console.log('\nHOW MANY ROWS COULD A REFUSAL EVEN TOUCH');
const byAuthority = {};
for (const p of plants) {
  const k = p.usedMeasured ? 'transferred gauge record (flow choice bypassed)' : `flow choice: ${p.authority}`;
  byAuthority[k] ??= { n: 0, fires: 0 };
  byAuthority[k].n++;
  if (p.cShipped > 1) byAuthority[k].fires++;
}
for (const [k, v] of Object.entries(byAuthority).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(48)} ${String(v.n).padStart(3)} rows, screen fires on ${v.fires}`);
}

const fired = plants.filter((p) => p.cShipped > 1);
console.log(`\nWHERE IT FIRES (${fired.length} plants), IS THERE A CANDIDATE THAT PASSES?`);
let rescuable = 0;
for (const p of fired) {
  if ((p.cNetwork != null && p.cNetwork <= 1) || (p.cJudge != null && p.cJudge <= 1)) rescuable++;
}
console.log(`  ${rescuable}/${fired.length} have a network or regression candidate under the ceiling.`);

const ratio = (p) => (p.licenceMW > 0 && p.predictedMW > 0 ? p.predictedMW / p.licenceMW : null);
const rs = (xs) => xs.map(ratio).filter((v) => v != null);
const clean2 = plants.filter((p) => !(p.cShipped > 1));
const fr = rs(fired);
const cr = rs(clean2);
console.log('\nDOES IT PICK OUT THE PLANTS THE ENGINE GETS WRONG?');
console.log(
  `  screen fires   n=${String(fr.length).padStart(3)}  ` +
    `licence ratio p10 ${quantile(fr, 0.1).toFixed(2)}  median ${quantile(fr, 0.5).toFixed(2)}  p90 ${quantile(fr, 0.9).toFixed(2)}`
);
console.log(
  `  screen passes  n=${String(cr.length).padStart(3)}  ` +
    `licence ratio p10 ${quantile(cr, 0.1).toFixed(2)}  median ${quantile(cr, 0.5).toFixed(2)}  p90 ${quantile(cr, 0.9).toFixed(2)}`
);
console.log('  (above 1 means HydroRecon found a bigger scheme than the licence, which it usually does;');
console.log('   a screen that is diagnostic should push the fired group further above the passing group.)');

const worst = fired.sort((a, b) => b.cShipped - a.cShipped).slice(0, 12);
if (worst.length) {
  console.log('\n  worst offenders:');
  for (const p of worst) {
    console.log(
      `    C ${p.cShipped.toFixed(2).padStart(6)}  ${p.name.slice(0, 30).padEnd(31)}` +
        `${p.km2.toFixed(0).padStart(6)} km2  rain ${p.rainMm.toFixed(0).padStart(5)} mm  ` +
        `${p.usedMeasured ? 'transferred record' : `authority ${p.authority}`}`
    );
  }
}

// ===========================================================================
// PART D — where does the ceiling actually belong?
// ===========================================================================
console.log(`\n${'='.repeat(74)}`);
console.log('PART D — the gauges set the ceiling, because physics does not');
console.log('='.repeat(74));
console.log('Nepal yields roughly 225 km3/yr off 147,181 km2 = about 1,530 mm of runoff against');
console.log('roughly 1,600 mm of rain: a NATIONAL runoff coefficient near 0.95. Steep ground, thin');
console.log('soil, monsoon intensity. So 1.0 is not a comfortable ceiling here — it sits in the');
console.log('middle of the distribution, and high catchments legitimately pass it on snow and ice');
console.log('melt and on orographic rain a coarse climatology cannot see.\n');

const measured = clean.map((x) => x.cMeasured).filter((v) => v != null && Number.isFinite(v));
const shipped = plants.map((x) => x.cShipped).filter((v) => v != null && Number.isFinite(v));
const siteC = (1.6988 * SECONDS_PER_YEAR * 1000) / 5.47e6 / 1589;

console.log('  ceiling   false positives      fires on the fleet     Sindhupalchok');
console.log(`            (measured gauges)     (flow as shipped)      (C = ${siteC.toFixed(2)})`);
for (const t of [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 4.0]) {
  const fp = measured.filter((v) => v > t).length;
  const fl = shipped.filter((v) => v > t).length;
  console.log(
    `  ${t.toFixed(2).padStart(6)}   ${String(fp).padStart(3)}/${measured.length} = ${pct(fp, measured.length).padStart(6)}` +
      `        ${String(fl).padStart(3)}/${shipped.length} = ${pct(fl, shipped.length).padStart(6)}` +
      `          ${siteC > t ? 'still caught' : 'MISSED'}`
  );
}
console.log(
  `\n  measured distribution: median ${quantile(measured, 0.5).toFixed(2)}` +
    `  p90 ${quantile(measured, 0.9).toFixed(2)}` +
    `  p95 ${quantile(measured, 0.95).toFixed(2)}` +
    `  max ${Math.max(...measured).toFixed(2)}`
);

// ===========================================================================
// PART E — is the excess snow and ice, or is it everywhere?
// ===========================================================================
console.log(`\n${'='.repeat(74)}`);
console.log('PART E — do the gauges that pass 1.0 sit under snow and ice?');
console.log('='.repeat(74));
console.log('There is no glacier ice extent in this app. There IS hypsometry: the share of each');
console.log('catchment below 5,000 m, built for WECS/DHM. Above 5,000 m in Nepal is broadly the');
console.log('perennial snow and ice zone, so 1 - below5000Frac is the proxy. If the excess were');
console.log('melt, the coefficient should climb with it — and a ceiling could then be tight for');
console.log('low catchments and loose for high ones, which is a far better screen than one');
console.log('constant.\n');

const withHyp = clean.filter((x) => x.aboveFrac != null && x.cMeasured != null && Number.isFinite(x.cMeasured));

const band = (label, xs) => {
  const cs = xs.map((x) => x.cMeasured);
  if (!cs.length) {
    console.log(`  ${label.padEnd(34)} n=  0`);
    return;
  }
  console.log(
    `  ${label.padEnd(34)} n=${String(cs.length).padStart(3)}  ` +
      `median ${quantile(cs, 0.5).toFixed(2)}  p90 ${quantile(cs, 0.9).toFixed(2)}  ` +
      `max ${Math.max(...cs).toFixed(2)}  over 1.0: ${cs.filter((v) => v > 1).length}`
  );
};

band('no catchment above 5,000 m', withHyp.filter((x) => x.aboveFrac <= 0.001));
band('under 5% above 5,000 m', withHyp.filter((x) => x.aboveFrac > 0.001 && x.aboveFrac <= 0.05));
band('5-20% above 5,000 m', withHyp.filter((x) => x.aboveFrac > 0.05 && x.aboveFrac <= 0.2));
band('over 20% above 5,000 m', withHyp.filter((x) => x.aboveFrac > 0.2));

/** Spearman, because the relationship need not be linear and the tail is long. */
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
  const ma = (n + 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let k = 0; k < n; k++) {
    num += (a[k] - ma) * (b[k] - ma);
    da += (a[k] - ma) ** 2;
    db += (b[k] - ma) ** 2;
  }
  return num / Math.sqrt(da * db);
};

const rhoHyp = spearman(withHyp.map((x) => x.aboveFrac), withHyp.map((x) => x.cMeasured));
const withAlt = clean.filter((x) => x.altitudeM != null && Number.isFinite(x.cMeasured));
const rhoAlt = spearman(withAlt.map((x) => x.altitudeM), withAlt.map((x) => x.cMeasured));
const rhoRain = spearman(clean.map((x) => x.rainMm), clean.map((x) => x.cMeasured));
const rhoArea = spearman(clean.map((x) => x.km2), clean.map((x) => x.cMeasured));

console.log('\n  rank correlation of the MEASURED coefficient with:');
console.log(`    share of catchment above 5,000 m   rho ${rhoHyp.toFixed(2)}  (n=${withHyp.length})`);
console.log(`    mean catchment altitude            rho ${rhoAlt.toFixed(2)}  (n=${withAlt.length})`);
console.log(`    catchment rainfall                 rho ${rhoRain.toFixed(2)}  (n=${clean.length})`);
console.log(`    catchment area                     rho ${rhoArea.toFixed(2)}  (n=${clean.length})`);

const hi = withHyp.filter((x) => x.aboveFrac > 0.05);
const lo = withHyp.filter((x) => x.aboveFrac <= 0.05);
if (lo.length) {
  const loMax = Math.max(...lo.map((x) => x.cMeasured));
  const hiMax = hi.length ? Math.max(...hi.map((x) => x.cMeasured)) : NaN;
  console.log(
    `\n  a two-tier ceiling would need ${loMax.toFixed(2)} for the low catchments ` +
      `and ${Number.isFinite(hiMax) ? hiMax.toFixed(2) : '–'} for the high ones.`
  );
  console.log('  If those are close, altitude is not what is driving the excess and one');
  console.log('  constant is all the evidence supports.');
}

console.log('\n  the gauges that pass 1.0, with their hypsometry:');
for (const f of falsePositives.slice(0, 14)) {
  console.log(
    `    C ${f.cMeasured.toFixed(2)}  ${String(f.river ?? '').slice(0, 22).padEnd(23)}` +
      `${f.km2.toFixed(0).padStart(6)} km2  ` +
      `above 5,000 m ${f.aboveFrac == null ? '   n/a' : `${(f.aboveFrac * 100).toFixed(1).padStart(5)}%`}  ` +
      `mean alt ${f.altitudeM == null ? ' n/a' : `${f.altitudeM.toFixed(0)} m`}`
  );
}
console.log('');

console.log('\nRainfall is CHPclim catchment-mean annual, from the bundled network. Area is the');
console.log('app’s own uplandKm2, which MERIT can inflate at confluences — an inflated area');
console.log('LOWERS the coefficient, so bleed makes this screen quieter, never louder.\n');
