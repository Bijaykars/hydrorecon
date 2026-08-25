/**
 * How wrong is the flow, measured against Nepal's own gauges?
 *
 *   node --experimental-strip-types --no-warnings checks/flow-vs-gauges.mjs
 *
 * The app has claimed +/-50% on flow since it was written, on the reasoning
 * that both sources are uncalibrated global models. That was an argument, not a
 * measurement. DHM's records let it become a measurement: snap each gauge to
 * the mapped river network, read what the network thinks the long-term mean is
 * there, and compare with what the gauge actually recorded.
 *
 * This measures the NETWORK's magnitude, which is what src/engine/flowchoice.ts
 * normally trusts for Nepal. It does not measure the day-to-day shape, which
 * comes from the flood model and is a separate question.
 */
import { readFileSync } from 'node:fs';

/**
 * The river network is fetched, because in the browser it is. Node has no
 * server here, so point the loader at the same files the dev server would
 * serve. Nothing about the data changes; only how the bytes arrive.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (path.startsWith('/')) {
    const buf = readFileSync(`public${path}`);
    return new Response(buf, { status: 200 });
  }
  return realFetch(path, init);
};

import { nearestReach, hasReachData } from '../src/rivers.ts';
import records from '../src/data/dhm-records.json' with { type: 'json' };

/** Beyond this the gauge is not on the reach we would have read. */
const SNAP_KM = 1.0;
/** Below this a station is too short to carry a long-term mean. */
const MIN_COMPLETE_YEARS = 5;

const rows = [];
let offNetwork = 0;
let tooShort = 0;

for (const s of records.stations) {
  if (s.lat == null || s.lon == null) continue;
  if (s.completeYears < MIN_COMPLETE_YEARS) {
    tooShort++;
    continue;
  }
  if (!hasReachData(s.lat, s.lon)) {
    offNetwork++;
    continue;
  }
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) {
    offNetwork++;
    continue;
  }
  const modelled = hit.nearest.meanDischargeCms;
  if (!(modelled > 0)) {
    offNetwork++;
    continue;
  }
  rows.push({
    id: s.id,
    river: s.river,
    measured: s.meanCms,
    modelled,
    ratio: modelled / s.meanCms,
    uplandKm2: hit.nearest.uplandKm2,
    snapKm: hit.nearest.distanceKm,
    years: s.completeYears,
  });
}

/**
 * Separate a wrong channel from a wrong flow.
 *
 * A gauge coordinate that lands on the neighbouring stream produces a spectacular
 * ratio that says nothing about the water balance: station 260 reads 296 m3/s
 * against a catchment the network calls 6.6 km2, which no rainfall can deliver.
 * Nepal's rivers run about 0.02-0.10 m3/s per km2 of catchment, so a measured
 * specific discharge far outside that band means the snap missed, and the row
 * measures the app's channel matching rather than its hydrology. Both are worth
 * knowing; they are not the same number.
 */
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;
const snapFailed = rows.filter((r) => {
  const specific = r.measured / r.uplandKm2;
  return specific < SPECIFIC_MIN || specific > SPECIFIC_MAX;
});
const clean = rows.filter((r) => !snapFailed.includes(r));
console.log(`
Of ${rows.length} gauges, ${snapFailed.length} snapped to a channel whose catchment cannot carry the measured flow.`);
console.log(`Those measure channel matching, not hydrology. The remaining ${clean.length} measure the flow model.
`);
const cRatios = clean.map((r) => r.ratio).sort((a, b) => a - b);
const cLogs = clean.map((r) => Math.log(r.ratio));
const cMeanLog = cLogs.reduce((a, b) => a + b, 0) / cLogs.length;
const cSdLog = Math.sqrt(cLogs.reduce((a, b) => a + (b - cMeanLog) ** 2, 0) / cLogs.length);
const cWithin = (f) => clean.filter((r) => r.ratio >= 1 / f && r.ratio <= f).length;
console.log('ON CORRECTLY MATCHED CHANNELS:');
console.log(`  median ratio      ${cRatios[cRatios.length >> 1].toFixed(2)}x`);
console.log(`  geometric mean    ${Math.exp(cMeanLog).toFixed(2)}x`);
console.log(`  1 sigma band      ${(1 / Math.exp(cSdLog)).toFixed(2)}x to ${Math.exp(cSdLog).toFixed(2)}x`);
console.log(`  within +/-25%     ${cWithin(1.25)}/${clean.length}  ${Math.round(100 * cWithin(1.25) / clean.length)}%`);
console.log(`  within +/-50%     ${cWithin(1.5)}/${clean.length}  ${Math.round(100 * cWithin(1.5) / clean.length)}%`);
console.log(`  within a factor 2 ${cWithin(2)}/${clean.length}  ${Math.round(100 * cWithin(2) / clean.length)}%`);

rows.sort((a, b) => a.ratio - b.ratio);
const ratios = rows.map((r) => r.ratio);
const logs = ratios.map(Math.log);
const median = ratios[ratios.length >> 1];
const within = (f) => rows.filter((r) => r.ratio >= 1 / f && r.ratio <= f).length;
const pct = (n) => `${Math.round((100 * n) / rows.length)}%`;

// Spread in log space, because a 2x over-read and a 2x under-read are the same
// size of error and must not cancel.
const meanLog = logs.reduce((a, b) => a + b, 0) / logs.length;
const sdLog = Math.sqrt(logs.reduce((a, b) => a + (b - meanLog) ** 2, 0) / logs.length);

console.log(`Gauges compared: ${rows.length}`);
console.log(`  skipped: ${offNetwork} off the mapped network or beyond ${SNAP_KM} km, ${tooShort} under ${MIN_COMPLETE_YEARS} complete years\n`);
console.log('NETWORK MEAN vs MEASURED MEAN (ratio > 1 means the model reads high)');
console.log(`  median ratio      ${median.toFixed(2)}x`);
console.log(`  geometric mean    ${Math.exp(meanLog).toFixed(2)}x`);
console.log(`  log-space spread  ${(Math.exp(sdLog) * 100 - 100).toFixed(0)}% (1 sigma)`);
console.log(`  within +/-25%     ${within(1.25)} of ${rows.length}  ${pct(within(1.25))}`);
console.log(`  within +/-50%     ${within(1.5)} of ${rows.length}  ${pct(within(1.5))}`);
console.log(`  within a factor 2 ${within(2)} of ${rows.length}  ${pct(within(2))}`);
console.log(`  beyond a factor 3 ${rows.length - within(3)} of ${rows.length}\n`);

const show = (r) =>
  `  ${r.id.padEnd(7)} ${(r.river || '?').slice(0, 22).padEnd(23)} measured ${String(r.measured).padStart(9)}  model ${String(Math.round(r.modelled * 100) / 100).padStart(9)}  ${r.ratio.toFixed(2)}x  ${String(r.uplandKm2).padStart(7)} km2`;
console.log('WORST UNDER-READS (model too low):');
for (const r of rows.slice(0, 5)) console.log(show(r));
console.log('\nWORST OVER-READS (model too high):');
for (const r of rows.slice(-5).reverse()) console.log(show(r));

// Does the error depend on catchment size? A screening tool is used on small
// tributaries far more often than on the Karnali.
const small = rows.filter((r) => r.uplandKm2 < 500);
const large = rows.filter((r) => r.uplandKm2 >= 500);
const med = (a) => (a.length ? a.map((r) => r.ratio).sort((x, y) => x - y)[a.length >> 1] : null);
console.log(`\nBY CATCHMENT SIZE`);
console.log(`  under 500 km2  n=${small.length}  median ${med(small)?.toFixed(2)}x  within 2x ${small.filter((r) => r.ratio > 0.5 && r.ratio < 2).length}/${small.length}`);
console.log(`  500 km2 and up n=${large.length}  median ${med(large)?.toFixed(2)}x  within 2x ${large.filter((r) => r.ratio > 0.5 && r.ratio < 2).length}/${large.length}`);
