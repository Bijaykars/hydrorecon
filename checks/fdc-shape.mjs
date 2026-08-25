/**
 * Can one river's flow-duration SHAPE be borrowed by another?
 *
 *   node --experimental-strip-types --no-warnings checks/fdc-shape.mjs
 *
 * The app takes its day-to-day shape from a global flood model and only its
 * magnitude from the mapped network. On the Tama Koshi that produces a design
 * flow whose Q40 is 0.31x the annual mean — below the 10th percentile of every
 * gauge in Nepal, which run 0.44-0.76 with a median of 0.59. The magnitude is
 * right and the SHAPE is wrong, and design flow is a shape question.
 *
 * Before borrowing a neighbour's shape, it has to be shown that shape travels.
 * This is a leave-one-out test on DHM's own records: hide a gauge's flow
 * duration curve, predict it from elsewhere, and compare with what it measured.
 *
 * Three predictors, weakest first:
 *   national  - the median Q/mean ratio over all other gauges
 *   nearest   - the single closest long-record gauge's own ratio
 *   blend     - nearest, pulled halfway to national (shrinkage)
 */
import { readFileSync } from 'node:fs';
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

const MIN_YEARS = 10;
const R = 6371;
const km = (a, b) => {
  const p = Math.PI / 180;
  const dLat = (b.lat - a.lat) * p, dLon = (b.lon - a.lon) * p;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const POINTS = ['q40', 'q50', 'q60', 'q80', 'q95'];
const g = [];
for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < MIN_YEARS || !s.monthly || !s.q) continue;
  const mean = s.monthly.reduce((a, b) => a + b, 0) / 12;
  if (!(mean > 0)) continue;
  const ratio = {};
  let ok = true;
  for (const p of POINTS) {
    if (!(s.q[p] > 0)) { ok = false; break; }
    ratio[p] = s.q[p] / mean;
  }
  if (ok) g.push({ id: s.id, river: s.river, lat: s.lat, lon: s.lon, mean, q: s.q, ratio });
}
console.log(`${g.length} gauges with ${MIN_YEARS}+ complete years and a full flow-duration curve\n`);

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const err = { national: [], nearest: [], blend: [] };
for (let i = 0; i < g.length; i++) {
  const me = g[i];
  const others = g.filter((_, j) => j !== i);
  // nearest long-record neighbour, by distance alone — shape is a climate/terrain
  // property, not an area one, so catchment size is deliberately not a criterion.
  let near = others[0];
  for (const o of others) if (km(me, o) < km(me, near)) near = o;

  for (const p of POINTS) {
    const nat = median(others.map((o) => o.ratio[p]));
    const nr = near.ratio[p];
    const bl = Math.exp((Math.log(nat) + Math.log(nr)) / 2);
    // Predict the flow, using the gauge's OWN mean — magnitude is not the test.
    const truth = me.q[p];
    err.national.push(Math.abs(Math.log((nat * me.mean) / truth)));
    err.nearest.push(Math.abs(Math.log((nr * me.mean) / truth)));
    err.blend.push(Math.abs(Math.log((bl * me.mean) / truth)));
  }
}

console.log('predicting each gauge\'s Q40/Q50/Q60/Q80/Q95 from OTHER gauges\' shape:\n');
console.log('predictor   typ.err   within 25%   within 50%');
for (const k of ['national', 'nearest', 'blend']) {
  const e = err[k];
  const typ = Math.exp(e.reduce((a, b) => a + b, 0) / e.length);
  const w = (f) => (e.filter((x) => x <= Math.log(f)).length / e.length * 100).toFixed(0);
  console.log(`${k.padEnd(11)} ${typ.toFixed(3)}x ${w(1.25).padStart(9)}%  ${w(1.5).padStart(9)}%`);
}
console.log(`\nfor comparison, the shape the app currently uses at the Tama Koshi`);
console.log(`gives Q40/mean = 0.307 against a national median of ${median(g.map(x=>x.ratio.q40)).toFixed(3)}`);
console.log(`  -> a factor of ${(median(g.map(x=>x.ratio.q40))/0.307).toFixed(2)}x on design flow.`);
