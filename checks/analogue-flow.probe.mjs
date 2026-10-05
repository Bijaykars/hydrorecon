/** Independent gauge analogue experiment. No runtime algorithm is changed. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
globalThis.fetch = async (url) => {
  try { return new Response(readFileSync(`public/${String(url).replace(/^undefined/, '').replace(/^\//, '')}`)); }
  catch { return new Response(null, { status: 404 }); }
};
const { nearestReach, SNAP_KM } = await import('../src/rivers.ts');
const { modifiedHydestAnnualMean } = await import('../src/engine/modified-hydest.ts');
const { analogueFlow } = await import('../src/engine/flow-analogue.ts');
const stations = JSON.parse(readFileSync('src/data/dhm-records.json')).stations;
const rows = [];
for (const s of stations) {
  if (s.lat == null || s.completeYears < 10 || !(s.meanCms > 0)) continue;
  const r = (await nearestReach(s.lat, s.lon))?.nearest;
  if (!r || r.distanceKm > SNAP_KM || !(r.uplandKm2 > 0) || !(r.annualPrecipMm > 0) || !Number.isFinite(r.averageAltitudeM)) continue;
  const spec = s.meanCms / r.uplandKm2;
  if (spec < 0.005 || spec > 0.25) continue;
  const modified = modifiedHydestAnnualMean({ below3000Km2: r.uplandKm2 * r.below3000Frac, below5000Km2: r.uplandKm2 * r.below5000Frac, averageAltitudeM: r.averageAltitudeM, annualWetnessMm: r.annualPrecipMm });
  if (!(modified > 0) || !(r.meanDischargeCms > 0)) continue;
  rows.push({ id: s.id, lat: s.lat, lon: s.lon, river: s.river, years: s.completeYears, from: s.from, to: s.to, area: r.uplandKm2, rain: r.annualPrecipMm, elevation: r.averageAltitudeM, low: r.below3000Frac, high: 1 - r.below5000Frac, truth: s.meanCms, modified, blend: Math.sqrt(modified * r.meanDischargeCms), band: r.uplandKm2 < 100 ? 0 : r.uplandKm2 < 500 ? 1 : 2 });
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const km = (a, b) => 111.32 * Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat + b.lat) * Math.PI / 360));
function donors(r, train) {
  // Prespecified scales and k; not tuned on held-out scores.
  return train.map((t) => ({ t, d: Math.hypot(Math.log(r.area / t.area) / Math.log(4), Math.log(r.rain / t.rain) / Math.log(2), (r.elevation - t.elevation) / 1500, (r.low - t.low) / 0.3, (r.high - t.high) / 0.3) }))
    .sort((a, b) => a.d - b.d).slice(0, 5);
}
function analogue(r, train, correction) {
  const near = donors(r, train);
  const weights = near.map(({ d }) => 1 / (1 + d * d));
  const sum = weights.reduce((a, b) => a + b, 0);
  const value = Math.exp(near.reduce((acc, { t }, k) => acc + weights[k] * Math.log(correction ? t.truth / t.blend : t.truth / (t.area * t.rain)), 0) / sum);
  return value * (correction ? r.blend : r.area * r.rain);
}
const rules = {
  'Modified HYDEST': (r) => r.modified,
  'Blend, bias fitted in fold': (r, t) => r.blend * Math.exp(mean(t.map((s) => Math.log(s.truth / s.blend)))),
  'Physical analogue runoff': (r, t) => analogueFlow(r, t)?.meanCms ?? NaN,
  'Physical analogue blend correction': (r, t) => analogue(r, t, true),
};
const scores = [];
for (const holdout of ['one station', '50 km buffer', 'one longitude region']) {
  const scored = [];
  for (const r of rows) {
    const train = rows.filter((t) => t.id !== r.id && (holdout === 'one station' || (holdout === '50 km buffer' ? km(r, t) > 50 : Math.floor(t.lon / 2) !== Math.floor(r.lon / 2))));
    if (train.length < 5) throw new Error('Insufficient training data; do not silently shrink denominator');
    scored.push({ r, predictions: Object.fromEntries(Object.entries(rules).map(([name, fn]) => [name, fn(r, train)])) });
  }
  for (const name of Object.keys(rules)) {
    const es = scored.map(({ r, predictions }) => ({ band: r.band, e: Math.log(predictions[name] / r.truth) }));
    if (es.some(({ e }) => !Number.isFinite(e))) throw new Error('Failed prediction');
    const bands = [0, 1, 2].map((b) => es.filter((s) => s.band === b).map((s) => Math.abs(s.e)));
    scores.push({ holdout, method: name, n: es.length, typical: Math.exp(mean(es.map((s) => Math.abs(s.e)))), weighted: Math.exp(bands.reduce((sum, es, b) => sum + [0.45, 0.35, 0.2][b] * mean(es), 0)), beyond2x: es.filter((s) => Math.abs(s.e) > Math.log(2)).length, worst: Math.exp(Math.max(...es.map((s) => Math.abs(s.e)))) });
  }
}
console.table(scores.map((s) => ({ ...s, typical: s.typical.toFixed(3), weighted: s.weighted.toFixed(3), worst: s.worst.toFixed(2) })));
mkdirSync('.codex-dev.accuracy', { recursive: true });
writeFileSync('.codex-dev.accuracy/analogue-benchmark.json', JSON.stringify({ bands: [0, 1, 2].map((b) => rows.filter((r) => r.band === b).length), scores }, null, 2));
if (process.argv.includes('--build')) {
  writeFileSync('src/data/flow-analogues.json', JSON.stringify({
    source: 'DHM published discharge summaries in dhm-records.json; catchment features from bundled river data',
    method: 'Five physically similar catchments; inverse-distance weighted geometric mean of rainfall-normalized specific runoff. Experimental comparison only.',
    built: '2026-09-11', scores,
    stations: rows.map(({ modified, blend, band, ...r }) => r),
  }, null, 2) + '\n');
}
