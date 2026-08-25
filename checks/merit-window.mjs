/**
 * How wide should the MERIT read window be?
 *
 *   node --experimental-strip-types --no-warnings checks/merit-window.mjs <upa.dat>
 *
 * pipeline/build_merit_upa.py samples a flow-accumulation raster in a window
 * around each traced vertex and takes the MAXIMUM. The window absorbs residual
 * snapping error; the maximum is what makes it dangerous, because next to a
 * confluence the biggest value in reach is the trunk river's. Mistri Khola shows
 * the result: a 321 km2 tributary and the 3,969 km2 Kali Gandaki reporting the
 * same 3,638 km2.
 *
 * Two things have to be weighed and they pull opposite ways. A wider window
 * finds the channel more often on a vertex that snapped imperfectly. A narrower
 * one cannot steal a neighbour. This measures both ends against the gauges,
 * which are the only independent flows available offline.
 */
import { readFileSync } from 'node:fs';

const CAND = process.argv[2];
if (!CAND) throw new Error('usage: merit-window.mjs <path to upa .dat>');

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  let p = String(u).replace(/^undefined/, '').replace(/^\//, '');
  if (p === 'nepal-upa.dat') return new Response(readFileSync(CAND), { status: 200 });
  if (/^[\w.-]+\.(json|dat|bin)$/.test(p)) {
    try { return new Response(readFileSync(`public/${p}`), { status: 200 }); }
    catch { return new Response(null, { status: 404 }); }
  }
  return realFetch(String(u), i);
};

const { nearestReach, hasReachData, coverageBox } = await import('../src/rivers.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

// 1. Bleed: MERIT far above the reach's own area, by stream order. A small
//    headwater cannot legitimately carry a trunk river's catchment.
const byOrd = new Map();
const B = coverageBox;
for (let i = 0; i < 140; i++) {
  for (let j = 0; j < 140; j++) {
    const lat = B.south + ((i + 0.5) / 140) * (B.north - B.south);
    const lon = B.west + ((j + 0.5) / 140) * (B.east - B.west);
    const h = await nearestReach(lat, lon).catch(() => null);
    if (!h || h.nearest.distanceKm > 0.5) continue;
    const r = h.nearest;
    if (!(r.uplandKm2 > 0) || !(r.reachUplandKm2 > 0)) continue;
    if (!byOrd.has(r.strahler)) byOrd.set(r.strahler, []);
    byOrd.get(r.strahler).push(r.uplandKm2 / r.reachUplandKm2);
  }
}

// 2. Accuracy: measured flow over MERIT area, against the band Nepal runs at.
//    This is the test that has an independent referee in it.
const spec = [];
for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < 5 || !(s.meanCms > 0)) continue;
  if (!hasReachData(s.lat, s.lon)) continue;
  const h = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!h || h.nearest.distanceKm > 1) continue;
  if (!(h.nearest.uplandKm2 > 0)) continue;
  spec.push({ merit: s.meanCms / h.nearest.uplandKm2, reach: s.meanCms / h.nearest.reachUplandKm2 });
}
const inBand = (v) => v.filter((x) => x >= 0.005 && x <= 0.25).length;
const q = (v, p) => { const a = [...v].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };

const all = [...byOrd.values()].flat();
console.log(`\n${CAND}\n`);
console.log(`MERIT / reach area, ${all.length} points on mapped channels`);
console.log(`  median ${q(all, 0.5).toFixed(2)}x   p90 ${q(all, 0.9).toFixed(2)}x   over 2x: ${((all.filter((x) => x > 2).length / all.length) * 100).toFixed(1)}%`);
console.log(`${'ord'.padStart(6)}${'n'.padStart(7)}${'p50'.padStart(8)}${'p99'.padStart(9)}${'max'.padStart(9)}${'>2x'.padStart(8)}`);
for (const [o, v] of [...byOrd.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`${String(o).padStart(6)}${String(v.length).padStart(7)}${q(v, 0.5).toFixed(2).padStart(8)}${q(v, 0.99).toFixed(2).padStart(9)}${Math.max(...v).toFixed(0).padStart(9)}${((v.filter((x) => x > 2).length / v.length) * 100).toFixed(1).padStart(7)}%`);
}
console.log(`\nmeasured flow / area against the 0.005-0.25 band, ${spec.length} gauges`);
console.log(`  with MERIT area  ${inBand(spec.map((x) => x.merit))}/${spec.length}`);
console.log(`  with reach area  ${inBand(spec.map((x) => x.reach))}/${spec.length}   (unchanged baseline)`);
