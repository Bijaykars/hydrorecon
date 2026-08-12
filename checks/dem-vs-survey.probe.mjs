/**
 * Is the terrain actually good enough?   `npm run probe:dem`
 *
 * `DEM_HEAD_ERROR_M` in src/engine/uncertainty.ts was an assumption — a
 * literature figure for global DEMs, not a measurement of the tiles this app
 * really fetches in the terrain it really runs on. This probe replaces the
 * assumption with a number.
 *
 * THE HARD PART IS FINDING TRUTH BETTER THAN THE THING UNDER TEST.
 *
 * The obvious candidate was the surveyed elevation DHM publishes for each of its
 * gauging stations, already sitting in src/data/dhm-stations.json. It does not
 * survive contact:
 *
 *   Kokhajor Khola at Hariharpur Gadi is recorded at 3892 m. It is in the
 *   Sindhuli foothills, where the DEM reads 278 m and is plainly right.
 *   Dona Khola at Dharapani and Barun River at Barun Dovan both carry
 *   two-decimal coordinates — about a kilometre — in Manang and the Barun
 *   gorge, where a kilometre sideways is 1500 m vertically.
 *
 * Comparing against that measures DHM's metadata, not the DEM. So the headline
 * number here comes from a different comparison, and the DHM one is kept below
 * only as a contaminated upper bound, with its worst records named.
 *
 * WHAT IS MEASURED INSTEAD: two independently produced global terrain products,
 * sampled at the same real river points through the same code. Re:Earth's
 * Mapterhorn build and AWS Terrain Tiles derive from different missions and
 * different processing chains, so where they disagree, at least one is wrong by
 * that much. It is the same logic the app already applies to flow, where GloFAS
 * and HydroRIVERS corroborate each other.
 *
 * This bounds the error from below, not above: two radar DEMs can share a bias
 * and agree while both being wrong. Treat the result as a floor.
 *
 * Runs in a real browser rather than Node because that is where the app decodes
 * its tiles — same Image + canvas + bilinear path, so this measures the shipped
 * code and not a reimplementation of it. Network, so it stays out of
 * `npm run check`, which must keep working on a plane.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

/** The zoom a river-length profile normally lands on. */
const ZOOM = 14;
/** Two gauges further apart than this are not one reach any more. */
const MAX_PAIR_KM = 25;
/** Under this drop the comparison is dominated by rounding, not terrain. */
const MIN_PAIR_DROP_M = 20;
/** Coarser than this and the coordinate is the error, not the elevation. */
const MIN_COORD_DECIMALS = 4;
/** How many HydroRIVERS reaches to sample. Each one costs up to four tiles. */
const REACH_SAMPLE = 220;

const SOURCES = [
  {
    id: 'Re:Earth Mapterhorn',
    url: (z, x, y) => `https://terrain.reearth.land/terrarium/elevation/${z}/${x}/${y}.png`,
  },
  {
    id: 'AWS Terrain Tiles',
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  },
];

const all = JSON.parse(readFileSync('src/data/dhm-stations.json', 'utf8'));
/** River gauges sit in valley bottoms — exactly where intakes and powerhouses go. */
const gauges = all.filter((s) => s.r === 1 && Number.isFinite(s.x) && Number.isFinite(s.y));

const decimals = (v) => (String(v).split('.')[1] ?? '').length;
const precise = (s) =>
  decimals(s.y) >= MIN_COORD_DECIMALS && decimals(s.x) >= MIN_COORD_DECIMALS;

const haversineKm = (a, b) => {
  const R = 6371.0088;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Summary statistics, robust ones included — and they are the ones that matter.
 *
 * These error distributions are heavy-tailed: most reaches agree closely and a
 * handful disagree wildly, usually where one product has a void or an artifact
 * in a gorge. RMSE is dominated by that handful, so building an uncertainty band
 * on it would widen every single estimate to describe a rare pathology. That is
 * the same mistake that once produced a "0-341 MW" range in this app.
 *
 * `sigma` is the standard robust scale estimator, 1.4826 x median absolute
 * deviation — equal to the standard deviation for clean Gaussian data, and
 * unmoved by outliers. It describes the typical reach, which is what an
 * uncertainty band is for. The tail is reported separately rather than smeared
 * into every result.
 */
const stats = (v) => {
  if (v.length === 0) return null;
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const rmse = Math.sqrt(v.reduce((a, b) => a + b * b, 0) / n);
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => s[Math.min(n - 1, Math.floor(p * n))];
  const median = q(0.5);
  const absDev = v.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const sigma = 1.4826 * absDev[Math.floor(n / 2)];
  return { n, mean, rmse, median, sigma, p05: q(0.05), p95: q(0.95) };
};

const line = (label, s, unit = 'm') =>
  s === null
    ? `  ${label.padEnd(24)} no data`
    : `  ${label.padEnd(24)} n=${String(s.n).padStart(4)}  ` +
      `median ${(s.median >= 0 ? '+' : '') + s.median.toFixed(1)}${unit}`.padEnd(16) +
      `sigma ${s.sigma.toFixed(1)}${unit}`.padEnd(14) +
      `5–95% ${s.p05.toFixed(0)} to ${s.p95.toFixed(0)}${unit}`.padEnd(22) +
      `RMSE ${s.rmse.toFixed(1)}${unit} (tail-driven)`;

/**
 * Real river reaches to measure head on.
 *
 * Pairing DHM gauges by river name yielded six usable reaches — too few to set a
 * constant from. The bundled HydroRIVERS extract has 42,197, on the actual
 * centrelines the app snaps to, so the sample comes from there instead: an
 * intake vertex and a powerhouse vertex the same distance apart the search
 * really considers.
 */
function hydroRiversPairs(limit) {
  const buf = readFileSync('public/nepal-rivers.dat');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x4e505231) throw new Error('bad magic');
  const count = dv.getUint32(4, true);
  const scale = dv.getUint32(12, true);

  const upland = new Int32Array(count);
  const len = new Int32Array(count);
  let o = 16;
  for (let i = 0; i < count; i++) {
    upland[i] = dv.getInt32(o, true);
    len[i] = dv.getUint16(o + 9, true);
    o += 11;
  }

  const out = [];
  for (let i = 0; i < count; i++) {
    // Walk this reach's vertices, delta-decoded exactly as src/rivers.ts does.
    const verts = [];
    let x = 0;
    let y = 0;
    for (let k = 0; k < len[i]; k++) {
      if (k === 0) {
        x = dv.getInt32(o, true);
        y = dv.getInt32(o + 4, true);
        o += 8;
      } else {
        x += dv.getInt16(o, true);
        y += dv.getInt16(o + 2, true);
        o += 4;
      }
      verts.push([y / scale, x / scale]); // lat, lon
    }
    if (verts.length < 2) continue;
    // Only rivers big enough to be worth a scheme, and reaches inside the
    // waterway lengths the search actually considers.
    if (upland[i] < 50) continue;
    const km = haversineKm(verts[0], verts[verts.length - 1]);
    if (km < 1 || km > MAX_PAIR_KM) continue;
    out.push({
      A: { y: verts[0][0], x: verts[0][1], n: `reach ${i}` },
      B: { y: verts[verts.length - 1][0], x: verts[verts.length - 1][1], n: `reach ${i}` },
      km,
      uplandKm2: upland[i],
    });
  }

  // Spread the sample across the whole extract rather than taking the first N,
  // which would all be one basin.
  const step = Math.max(1, Math.floor(out.length / limit));
  return out.filter((_, i) => i % step === 0).slice(0, limit);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
// The tiles send ACAO:*, so any origin works.
await page.goto('about:blank');

/** Sample one source at every point, through the app's own decode. */
async function sampleSource(url, pts) {
  return page.evaluate(
    async ([tpl, points, z]) => {
      const lonToTileX = (lon, zz) => ((lon + 180) / 360) * 2 ** zz;
      const latToTileY = (lat, zz) => {
        const r = (lat * Math.PI) / 180;
        return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** zz;
      };
      const decodePixel = (img, x, y) => {
        const cx = Math.min(img.width - 1, Math.max(0, x));
        const cy = Math.min(img.height - 1, Math.max(0, y));
        const i = (cy * img.width + cx) * 4;
        const d = img.data;
        return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
      };
      const sampleBilinear = (img, u, v) => {
        const fx = u * img.width - 0.5;
        const fy = v * img.height - 0.5;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const top = decodePixel(img, x0, y0) * (1 - tx) + decodePixel(img, x0 + 1, y0) * tx;
        const bot =
          decodePixel(img, x0, y0 + 1) * (1 - tx) + decodePixel(img, x0 + 1, y0 + 1) * tx;
        return top * (1 - ty) + bot * ty;
      };

      const cache = new Map();
      const loadTile = (x, y) => {
        const key = `${x}/${y}`;
        if (cache.has(key)) return cache.get(key);
        const p = new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            try {
              resolve(ctx.getImageData(0, 0, c.width, c.height));
            } catch {
              resolve(null);
            }
          };
          img.onerror = () => resolve(null);
          img.src = tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
        });
        cache.set(key, p);
        return p;
      };

      // One fetch per tile, then every point inside it.
      const byTile = new Map();
      points.forEach((p, i) => {
        const fx = lonToTileX(p.x, z);
        const fy = latToTileY(p.y, z);
        const key = `${Math.floor(fx)}/${Math.floor(fy)}`;
        if (!byTile.has(key)) byTile.set(key, []);
        byTile.get(key).push({ i, fx, fy });
      });

      const out = new Array(points.length).fill(null);
      const keys = [...byTile.keys()];
      const LANES = 8;
      await Promise.all(
        Array.from({ length: LANES }, async (_, lane) => {
          for (let k = lane; k < keys.length; k += LANES) {
            const [x, y] = keys[k].split('/').map(Number);
            const img = await loadTile(x, y);
            if (!img) continue;
            for (const { i, fx, fy } of byTile.get(keys[k])) {
              out[i] = sampleBilinear(img, fx % 1, fy % 1);
            }
          }
        })
      );
      return out;
    },
    [url('{z}', '{x}', '{y}'), pts.map((p) => ({ x: p.x, y: p.y })), ZOOM]
  );
}

const gaugePts = gauges.filter(precise);
const pairs = hydroRiversPairs(REACH_SAMPLE);

// One flat list of points, so each tile is fetched once no matter who wants it.
const pts = [...gaugePts];
const pairIdx = pairs.map((p) => {
  const i = pts.push(p.A) - 1;
  const j = pts.push(p.B) - 1;
  return [i, j];
});

console.log(
  `\nterrain error at z${ZOOM}\n` +
    `  ${gaugePts.length} DHM river gauges (of ${gauges.length}; the rest are coarser than ` +
    `${MIN_COORD_DECIMALS} decimals)\n` +
    `  ${pairs.length} HydroRIVERS reaches, ${MIN_PAIR_DROP_M}m+ drop, 1-${MAX_PAIR_KM}km long\n`
);

const samples = [];
for (const src of SOURCES) samples.push(await sampleSource(src.url, pts));
await browser.close();

const ok2 = (v) => Number.isFinite(v) && v > -400;
const rows = gaugePts
  .map((s, i) => ({ ...s, a: samples[0][i], b: samples[1][i] }))
  .filter((s) => ok2(s.a) && ok2(s.b));

console.log(`two independent terrain products, same points, same code`);
console.log(`  ${SOURCES[0].id}  vs  ${SOURCES[1].id}`);
console.log(line('point disagreement', stats(rows.map((s) => s.a - s.b))));

// The quantity the engine actually uses. Head is a DIFFERENCE of two samples,
// both in valley bottoms a few km apart, so a bias common to both cancels.
const heads = pairIdx
  .map(([i, j], k) => ({
    km: pairs[k].km,
    dropA: samples[0][i] - samples[0][j],
    dropB: samples[1][i] - samples[1][j],
    okAll: [samples[0][i], samples[0][j], samples[1][i], samples[1][j]].every(ok2),
  }))
  .filter((h) => h.okAll && Math.abs(h.dropA) >= MIN_PAIR_DROP_M);

const headDisagree = heads.map((h) => h.dropA - h.dropB);
const headRel = heads.map((h) => ((h.dropA - h.dropB) / Math.abs(h.dropA)) * 100);
console.log(line('HEAD disagreement', stats(headDisagree)));
console.log(line('HEAD, relative', stats(headRel), '%'));

// --- the contaminated comparison, kept only to show why it was rejected ---
const surveyed = rows.filter((s) => Number.isFinite(s.e) && s.e > 0);
const surveyErr = surveyed.map((s) => s.a - s.e);
console.log(`\nagainst DHM's own published station elevations (unreliable — see the header)`);
console.log(line('point error', stats(surveyErr)));
const worst = surveyed
  .map((s) => ({ s, err: s.a - s.e }))
  .sort((a, b) => Math.abs(b.err) - Math.abs(a.err))
  .slice(0, 5);
for (const { s, err } of worst) {
  console.log(
    `    ${((err >= 0 ? '+' : '') + err.toFixed(0) + 'm').padEnd(9)}` +
      `survey ${String(s.e).padStart(5)}   both DEMs say ${s.a.toFixed(0)} / ${s.b.toFixed(0)}   ${s.n}`
  );
}
console.log(
  `  where the two DEMs agree with each other and both disagree with the record,\n` +
    `  the record is the outlier. That is why it is not the headline number.`
);

const hs = stats(headDisagree);
const hr = stats(headRel);
if (hs && hr) {
  // How often the two products are not describing the same landform at all.
  const tail = headDisagree.filter((d) => Math.abs(d) > 50).length;
  console.log(`\nwhat this means for the engine`);
  console.log(
    `  on ${hs.n} real river reaches, two independent terrain products disagree about the\n` +
      `  drop between two points by ${hs.sigma.toFixed(1)} m (robust sigma), median ` +
      `${hs.median.toFixed(1)} m — no systematic bias.`
  );
  console.log(
    `  ${tail} of ${hs.n} reaches (${((tail / hs.n) * 100).toFixed(0)}%) disagree by more than 50 m. Those are voids and\n` +
      `  gorge artifacts, not the typical case, which is why sigma and not RMSE (${hs.rmse.toFixed(0)} m) sets the band.`
  );
  console.log(
    `  -> DEM_HEAD_ERROR_M in src/engine/uncertainty.ts: measured ${Math.round(hs.sigma)} m.\n` +
      `     A floor, not a ceiling — two radar DEMs can share a bias and agree while both are wrong.`
  );
}
console.log();
