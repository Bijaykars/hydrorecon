/**
 * Is the head error a DEM problem or a POSITION problem?
 *
 *   node checks/position-vs-dem-head.probe.mjs
 *   node checks/position-vs-dem-head.probe.mjs --limit 40
 *
 * WHY THIS EXISTS. CLAUDE.md says head carries "no systematic bias, sigma 6.6 m,
 * 3.4% relative", and uses that to argue terrain is the wrong half of
 * P = rho g Q H eta to spend effort on. That number comes from `probe:dem`,
 * which compares THREE TERRAIN PRODUCTS AT IDENTICAL COORDINATES.
 *
 * A three-cornered hat can only see disagreement. If all three products are
 * sampled 135 m off the real channel — on the valley side instead of the bed —
 * they agree with each other beautifully and are wrong together, and the
 * estimator reports a small sigma while the head is badly out. **The published
 * head error does not bound positioning error, and never claimed to.**
 *
 * That matters here because the app HAS two positions for every vertex.
 * `snap-vertices-to-osm.mjs` pulled about three quarters of them onto the
 * OSM-traced channel; `riversGeoJson` draws those, and the engine deliberately
 * samples the modelled ones. `rivers.ts` records that swapping the engine over
 * "changed the head for the worse" — but if that was scored against DEM
 * agreement, a line moved ONTO the river would look worse while being righter.
 *
 * WHAT THIS MEASURES, and it is deliberately narrow: one terrain product, the
 * shipped primary, sampled at both positions of the same vertices. The DEM is
 * held constant so the only thing varying is WHERE it is read. Whatever comes
 * out is attributable to position and to nothing else.
 *
 * WHAT IT CANNOT SAY. Neither position is ground truth. OSM's trace is a
 * volunteer's line on imagery and carries its own error; the modelled vertex is
 * a ~500 m derivation. This measures the DISAGREEMENT between them in metres of
 * head, which bounds how much is at stake — it does not say which is right. If
 * the answer is small, the question is closed either way. If it is large,
 * somebody has to survey a river.
 *
 * Real browser, for the reason `probe:dem` gives: the app decodes tiles through
 * Image + canvas, and a Node reimplementation would measure the copy.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const PORT = 5201;
const flag = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const LIMIT = flag('--limit', Infinity);
/**
 * How far apart to put the two ends.
 *
 * The fleet's median implied waterway is 3.8 km, so a pair that far apart is
 * the head a real scheme would be quoted. Measuring adjacent vertices instead
 * would understate the effect: two points 120 m apart share most of their
 * error and their difference cancels it.
 */
const PAIR_KM = 3.8;

const plants = JSON.parse(readFileSync('src/data/doed-projects.json', 'utf8'))
  .projects.filter(
    (p) => p.commissioned && Number.isFinite(p.lat) && Number.isFinite(p.lon)
  )
  .slice(0, LIMIT);
console.log(`${plants.length} commissioned plants with coordinates`);

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();
const ctx = await chromium.launchPersistentContext('pipeline/.cache/probe-profile', {
  channel: 'chrome',
  headless: true,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => console.log('  page error:', e.message));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

const rows = await page.evaluate(
  async ([sites, pairKm]) => {
    const rivers = await import('/src/rivers.ts');
    const api = await import('/src/api.ts');

    const R = 6371;
    const hav = (a, b) => {
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLon = ((b.lon - a.lon) * Math.PI) / 180;
      const la1 = (a.lat * Math.PI) / 180;
      const la2 = (b.lat * Math.PI) / 180;
      const h =
        Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };

    /** One tiny window per point, centre cell — the app's own bilinear read. */
    const elev = async (p) => {
      try {
        const g = await api.fetchTerrainWindow(p, 0.05, 30, api.PRIMARY_TERRAIN_SOURCE_ID);
        const mid = ((g.rows - 1) / 2) * g.cols + (g.cols - 1) / 2;
        const v = g.elevations[mid];
        return Number.isFinite(v) ? v : null;
      } catch {
        return null;
      }
    };

    const out = [];
    const LANES = 6;
    let done = 0;
    await Promise.all(
      Array.from({ length: LANES }, async (_, lane) => {
        for (let i = lane; i < sites.length; i += LANES) {
          const s = sites[i];
          const rec = { name: s.name, lat: s.lat, lon: s.lon, why: null };
          try {
            const path = await rivers.downstreamPath(s.lat, s.lon, 25, 0.12);
            if (!path || path.length < 3) {
              rec.why = 'no downstream path';
              out.push(rec);
              continue;
            }
            // The intake end is where the plant's own coordinate landed; the
            // other end is the first vertex at least PAIR_KM along the path.
            const a = path[0];
            let b = null;
            let run = 0;
            for (let k = 1; k < path.length; k++) {
              run += hav(path[k - 1], path[k]);
              if (run >= pairKm) {
                b = path[k];
                break;
              }
            }
            if (!b) {
              rec.why = `path shorter than ${pairKm} km`;
              out.push(rec);
              continue;
            }
            rec.pairKm = Number(run.toFixed(3));

            const pa = await rivers.vertexPositions(a.networkIndex, a.networkVertex);
            const pb = await rivers.vertexPositions(b.networkIndex, b.networkVertex);
            if (!pa || !pb) {
              rec.why = 'vertex lookup failed';
              out.push(rec);
              continue;
            }
            rec.tracedA = Boolean(pa.snapped);
            rec.tracedB = Boolean(pb.snapped);
            if (!pa.snapped || !pb.snapped) {
              // Reported, not dropped: how often OSM has no opinion is itself
              // part of the answer.
              rec.why = 'one or both ends untraced by OSM';
              out.push(rec);
              continue;
            }
            rec.offsetAm = Math.round(hav(pa.raw, pa.snapped) * 1000);
            rec.offsetBm = Math.round(hav(pb.raw, pb.snapped) * 1000);

            const [zar, zas, zbr, zbs] = await Promise.all([
              elev(pa.raw),
              elev(pa.snapped),
              elev(pb.raw),
              elev(pb.snapped),
            ]);
            if ([zar, zas, zbr, zbs].some((v) => v === null)) {
              rec.why = 'terrain missing at one of the four points';
              out.push(rec);
              continue;
            }
            rec.dzAm = Number((zas - zar).toFixed(2));
            rec.dzBm = Number((zbs - zbr).toFixed(2));
            rec.headRawM = Number((zar - zbr).toFixed(2));
            rec.headSnappedM = Number((zas - zbs).toFixed(2));
            rec.headDeltaM = Number((rec.headSnappedM - rec.headRawM).toFixed(2));
            out.push(rec);
          } catch (e) {
            rec.why = String(e?.message ?? e);
            out.push(rec);
          } finally {
            done++;
            if (done % 10 === 0) console.log(`[probe] ${done}/${sites.length}`);
          }
        }
      })
    );
    return out;
  },
  [plants.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon })), PAIR_KM]
);

await ctx.close();
await server.close();

const scored = rows.filter((r) => r.headDeltaM !== undefined);
const q = (arr, p) => {
  const s = [...arr].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const absHead = scored.map((r) => Math.abs(r.headDeltaM));
const offsets = scored.flatMap((r) => [r.offsetAm, r.offsetBm]);
const absDz = scored.flatMap((r) => [Math.abs(r.dzAm), Math.abs(r.dzBm)]);
const heads = scored.map((r) => Math.abs(r.headRawM)).filter((h) => h > 5);
const rel = scored
  .filter((r) => Math.abs(r.headRawM) > 5)
  .map((r) => (100 * Math.abs(r.headDeltaM)) / Math.abs(r.headRawM));

console.log(`\n${scored.length} of ${rows.length} plants scored at both ends\n`);
const why = {};
for (const r of rows) if (r.why) why[r.why] = (why[r.why] ?? 0) + 1;
for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
  console.log(`  not scored — ${k}: ${v}`);
}
if (!scored.length) {
  console.log('\nnothing scored; no conclusion available');
  process.exit(1);
}

console.log(`\nHORIZONTAL: how far OSM moved the vertex (${offsets.length} vertex positions)`);
console.log(
  `  median ${q(offsets, 0.5)} m   p90 ${q(offsets, 0.9)} m   max ${Math.max(...offsets)} m`
);
console.log(`\nPOINT ELEVATION: |z(snapped) - z(raw)|, same DEM`);
console.log(
  `  median ${q(absDz, 0.5).toFixed(1)} m   p90 ${q(absDz, 0.9).toFixed(1)} m   ` +
    `max ${Math.max(...absDz).toFixed(1)} m`
);
console.log(`\nHEAD over ~${PAIR_KM} km: |head(snapped) - head(raw)|   <- THE ANSWER`);
console.log(
  `  median ${q(absHead, 0.5).toFixed(1)} m   p90 ${q(absHead, 0.9).toFixed(1)} m   ` +
    `max ${Math.max(...absHead).toFixed(1)} m`
);
if (rel.length) {
  console.log(
    `  as a share of the head itself (${rel.length} pairs over 5 m): ` +
      `median ${q(rel, 0.5).toFixed(1)}%   p90 ${q(rel, 0.9).toFixed(1)}%`
  );
}
const bias = scored.reduce((a, r) => a + r.headDeltaM, 0) / scored.length;
console.log(`  signed mean ${bias.toFixed(2)} m — near zero means scatter, not a correction`);

/**
 * The comparison that decides it. CLAUDE.md's head sigma is 6.6 m from
 * DEM-against-DEM; if moving the sample point costs less than that, position is
 * inside the error already quoted and there is nothing to fix.
 */
const DEM_SIGMA_M = 6.6;
const over = absHead.filter((v) => v > DEM_SIGMA_M).length;
console.log(
  `\n  ${over} of ${scored.length} plants (${Math.round((100 * over) / scored.length)}%) move the ` +
    `head by more than the ${DEM_SIGMA_M} m the DEM probe reports.`
);
console.log(
  q(absHead, 0.5) > DEM_SIGMA_M
    ? '  VERDICT: position dominates. The published head error does not cover this.'
    : '  VERDICT: position is inside the DEM error already quoted. Not the thing to fix.'
);

const worst = scored.sort((a, b) => Math.abs(b.headDeltaM) - Math.abs(a.headDeltaM)).slice(0, 8);
console.log('\n  worst eight:');
for (const r of worst) {
  console.log(
    `    ${r.name.slice(0, 34).padEnd(34)} head ${r.headRawM.toFixed(0).padStart(5)} m -> ` +
      `${r.headSnappedM.toFixed(0).padStart(5)} m  (${r.headDeltaM > 0 ? '+' : ''}${r.headDeltaM.toFixed(1)} m)` +
      `  offsets ${r.offsetAm}/${r.offsetBm} m`
  );
}
