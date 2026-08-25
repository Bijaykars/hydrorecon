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
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

/**
 * GEDTM30, when the local extract has been built.
 *
 * The two products above are both radar SURFACE models read through a tile
 * pyramid; GEDTM30 is a bare-earth DTM read out of a local raster. It cannot be
 * added to SOURCES because it is not tiles, and it is optional because the
 * store is a gigabyte that `npm run build:gedtm` produces on request.
 *
 * Sampling goes through the app's own fetchTerrainWindow rather than a
 * reimplementation here, for the reason the header gives for using a browser at
 * all: a check that reimplements the thing under test measures the copy.
 */
const GEDTM_ID = 'GEDTM30 bare earth';
const GEDTM_AVAILABLE = existsSync('sources/gedtm/nepal-gedtm.bin');
const PORT = 5198;

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

// The bundle gained a wrapper object after this probe was written; accept both.
const raw = JSON.parse(readFileSync('src/data/dhm-stations.json', 'utf8'));
const all = Array.isArray(raw) ? raw : (raw.stations ?? []);
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

const server = GEDTM_AVAILABLE
  ? await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' })
  : null;
if (server) await server.listen();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
// The tiles send ACAO:*, so any origin works. The local store does not: it is
// served by the dev server, so that page has to be the origin when it is in use.
await page.goto(server ? `http://localhost:${PORT}/` : 'about:blank', {
  waitUntil: 'domcontentloaded',
});

/**
 * Sample the local bare-earth store at every point, through the shipped reader.
 *
 * One tiny window per point: at a 50 m radius and 30 m spacing that is a 5x5
 * grid whose centre cell sits exactly on the requested coordinate, so the
 * request costs about a hundred bytes and the value is the same bilinear read
 * the app performs. Lanes keep the round trips overlapped; they are local.
 */
async function sampleGedtm(points) {
  return page.evaluate(
    async ([pts, sourceId]) => {
      const api = await import('/src/api.ts');
      const out = new Array(pts.length).fill(null);
      const LANES = 16;
      await Promise.all(
        Array.from({ length: LANES }, async (_, lane) => {
          for (let i = lane; i < pts.length; i += LANES) {
            try {
              const g = await api.fetchTerrainWindow(
                { lat: pts[i].y, lon: pts[i].x },
                0.05,
                30,
                sourceId
              );
              const mid = ((g.rows - 1) / 2) * g.cols + (g.cols - 1) / 2;
              const v = g.elevations[mid];
              out[i] = Number.isFinite(v) ? v : null;
            } catch {
              out[i] = null;
            }
          }
        })
      );
      return out;
    },
    [points.map((q) => ({ x: q.x, y: q.y })), GEDTM_ID]
  );
}

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

/**
 * CROSS-SLOPE, the quantity a waterway alignment actually turns on.
 *
 * A headrace does not run down the river; it benches along the hillside above
 * it. Whether that is a canal or a tunnel is decided by how steeply the ground
 * falls ACROSS the alignment, and the cost per metre between those two answers
 * differs by an order of magnitude.
 *
 * Absolute ground level cannot support that call — it carries a 5-95% spread of
 * -14 to +6 m, several times the depth of any cut. A SLOPE is a difference over
 * a short baseline, and radar DEM errors are strongly correlated at short
 * range, so most of that error should cancel. Should. Measure it before
 * building anything on it.
 *
 * For each reach midpoint, sample 100 m either side along the perpendicular, in
 * both products, and compare the grades they imply.
 */
const CROSS_M = 100;
const crossIdx = pairs.map((p) => {
  const midLat = (p.A.y + p.B.y) / 2;
  const midLon = (p.A.x + p.B.x) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180);
  const dy = (p.B.y - p.A.y) * 111320;
  const dx = (p.B.x - p.A.x) * 111320 * cos;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const off = (sign) => ({
    y: midLat + (sign * CROSS_M * py) / 111320,
    x: midLon + (sign * CROSS_M * px) / (111320 * cos),
    n: p.A.n,
  });
  const c = pts.push({ y: midLat, x: midLon, n: p.A.n }) - 1;
  const a = pts.push(off(-1)) - 1;
  const b = pts.push(off(1)) - 1;
  return [c, a, b];
});

console.log(
  `\nterrain error at z${ZOOM}\n` +
    `  ${gaugePts.length} DHM river gauges (of ${gauges.length}; the rest are coarser than ` +
    `${MIN_COORD_DECIMALS} decimals)\n` +
    `  ${pairs.length} HydroRIVERS reaches, ${MIN_PAIR_DROP_M}m+ drop, 1-${MAX_PAIR_KM}km long\n`
);

const samples = [];
for (const src of SOURCES) samples.push(await sampleSource(src.url, pts));
const labels = SOURCES.map((src) => src.id);
if (GEDTM_AVAILABLE) {
  samples.push(await sampleGedtm(pts));
  labels.push(GEDTM_ID);
} else {
  console.log('  (no local GEDTM30 store — run `npm run build:gedtm` to include it)\n');
}
await browser.close();
if (server) await server.close();

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

{
  /**
   * MEASURE FROM THE CHANNEL OUTWARD, not bank to bank.
   *
   * The first version of this differenced the two offset points and divided by
   * the full baseline, which measures how far the valley TILTS, not how steeply
   * it rises. A symmetric V-valley scores near zero however steep its sides
   * are, and the whole country came out at a 6% grade — the tell that the
   * statistic was wrong, since Nepal is not flat.
   *
   * The gradient that matters is from the channel up each side. A canal is
   * benched on ONE side, so the gentler of the two is what decides whether it
   * can be built at all.
   */
  /**
   * NEPAL ONLY, and it changes the answer completely.
   *
   * The bundled network reaches past the border onto the Tibetan plateau, and
   * the reach sample is ordered by file position, so the first version of this
   * measured cross-slopes at 31.1N and 4,900 m — genuinely flat ground, nowhere
   * anyone builds a khola scheme. It reported a 5% typical hillside for the
   * whole country, which is the second wrong number this check produced before
   * it produced a right one.
   */
  const inNepal = (q) => q.y >= 26.2 && q.y <= 30.6 && q.x >= 79.9 && q.x <= 88.4;
  const grade = (z0, z1) => (Math.abs(z1 - z0) / CROSS_M) * 100;
  const slopes = crossIdx
    .filter(([c]) => inNepal(pts[c]))
    .map(([c, i, j]) => ({
      a: Math.min(grade(samples[0][c], samples[0][i]), grade(samples[0][c], samples[0][j])),
      b: Math.min(grade(samples[1][c], samples[1][i]), grade(samples[1][c], samples[1][j])),
    }))
    .filter((d) => Number.isFinite(d.a) && Number.isFinite(d.b));
  if (slopes.length) {
    const diff = stats(slopes.map((x) => x.a - x.b));
    const mean = slopes.map((x) => (x.a + x.b) / 2).sort((p, q) => p - q);
    const med = mean[mean.length >> 1];
    // A canal can be benched below about 35 degrees, which is a 70% grade.
    const CANAL_MAX_PCT = 70;
    const disagree = slopes.filter((x) => x.a > CANAL_MAX_PCT !== x.b > CANAL_MAX_PCT).length;
    console.log(
      `
cross-slope, channel to ${CROSS_M} m up the gentler bank, ${slopes.length} reaches` +
        `
  the two products differ by  median ${diff.median.toFixed(1)}%  sigma ${diff.sigma.toFixed(1)}%` +
        `  5-95% ${diff.p05.toFixed(1)} to ${diff.p95.toFixed(1)}%` +
        `
  gentler-bank grade  p25 ${mean[Math.floor(mean.length * 0.25)].toFixed(0)}%  ` +
        `median ${med.toFixed(0)}%  p75 ${mean[Math.floor(mean.length * 0.75)].toFixed(0)}%  ` +
        `p90 ${mean[Math.floor(mean.length * 0.9)].toFixed(0)}%` +
        `
  they disagree on canal-vs-tunnel (${CANAL_MAX_PCT}% grade) for ` +
        `${disagree}/${slopes.length} reaches (${((disagree / slopes.length) * 100).toFixed(0)}%)`
    );
  }
}

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

/**
 * THREE PRODUCTS MAKE EACH ONE'S ERROR SOLVABLE.
 *
 * With two sources all you can measure is how far apart they are; nothing says
 * which one is wrong. With three, and if their errors are independent, the
 * pairwise spreads are
 *
 *     s2(A-B) = s2A + s2B      s2(A-C) = s2A + s2C      s2(B-C) = s2B + s2C
 *
 * three equations in three unknowns, so
 *
 *     s2A = ( s2(A-B) + s2(A-C) - s2(B-C) ) / 2
 *
 * and likewise for B and C. This is the three-cornered-hat estimator, standard
 * in clock metrology and in satellite validation, and it is the only way to
 * rank these products without truth data — which for Nepali river vertices does
 * not exist. DHM's own station elevations were tried and rejected; the header
 * says why.
 *
 * THE ASSUMPTION IS THE WHOLE RISK, and here it is known to be imperfect.
 * Mapterhorn is a Copernicus build and GEDTM30 fuses Copernicus among its
 * inputs, so those two share a parent and their errors are correlated. That
 * makes their measured disagreement smaller than independence would predict,
 * which pushes their solved variances DOWN and the odd one out UP. Read the
 * ranking, not the absolute metres, and treat a negative variance as the
 * estimator announcing that the independence it needs was not there.
 *
 * Robust sigma throughout, for the reason `stats` already gives: these
 * distributions are heavy-tailed and RMSE would describe a rare gorge artifact
 * rather than the typical reach.
 */
if (samples.length === 3) {
  const drop = (k, [i, j]) => samples[k][i] - samples[k][j];
  const usable = pairIdx.filter((ij, k) => {
    const all = [0, 1, 2].flatMap((m) => [samples[m][ij[0]], samples[m][ij[1]]]);
    return all.every(ok2) && Math.abs(drop(0, ij)) >= MIN_PAIR_DROP_M;
  });

  const pairSigma = (m, n) => {
    const st = stats(usable.map((ij) => drop(m, ij) - drop(n, ij)));
    return st ? st.sigma : NaN;
  };
  const sAB = pairSigma(0, 1);
  const sAC = pairSigma(0, 2);
  const sBC = pairSigma(1, 2);

  /**
   * THE MEDIAN IS THE ONE THAT SAYS WHETHER THIS IS A BARE-EARTH EFFECT.
   *
   * A wider sigma against both surface models has two completely different
   * explanations and they demand opposite conclusions: GEDTM30 is noisier, or
   * GEDTM30 is correctly stripping a canopy that both DSMs carry and both
   * therefore agree about. Sigma alone cannot separate them.
   *
   * The MEDIAN can. Removing tree height is a systematic, one-signed
   * correction, so if that is what is happening the point-level median against
   * each surface model is clearly positive and roughly canopy-sized. If instead
   * it is scatter, the median sits near zero and only the spread moves.
   *
   * Points first, because that is where a canopy offset lives. Head is a
   * difference between two valley-bottom points, so a bias common to both ends
   * cancels out of it — which is the whole reason head is the engine's number
   * and absolute ground level is not.
   */
  const pointStat = (m, n) => {
    const v = [];
    for (let i = 0; i < pts.length; i++) {
      if (ok2(samples[m][i]) && ok2(samples[n][i])) v.push(samples[m][i] - samples[n][i]);
    }
    return stats(v);
  };
  console.log(`\nPOINT disagreement between all three — a canopy offset would show up here`);
  console.log(line(`${labels[0]} - ${labels[2]}`, pointStat(0, 2)));
  console.log(line(`${labels[1]} - ${labels[2]}`, pointStat(1, 2)));
  console.log(line(`${labels[0]} - ${labels[1]}`, pointStat(0, 1)));

  const headStat = (m, n) => stats(usable.map((ij) => drop(m, ij) - drop(n, ij)));
  console.log(`\nHEAD disagreement between all three, ${usable.length} shared reaches`);
  console.log(line(`${labels[0]} - ${labels[1]}`, headStat(0, 1)));
  console.log(line(`${labels[0]} - ${labels[2]}`, headStat(0, 2)));
  console.log(line(`${labels[1]} - ${labels[2]}`, headStat(1, 2)));

  const solve = (x, y, z) => (x * x + y * y - z * z) / 2;
  const own = [
    solve(sAB, sAC, sBC),
    solve(sAB, sBC, sAC),
    solve(sAC, sBC, sAB),
  ];
  console.log(`\nthree-cornered hat: each product's OWN head error, if their errors are independent`);
  own.forEach((v, i) => {
    console.log(
      `  ${labels[i].padEnd(46)} ${
        v >= 0 ? 'sigma ' + Math.sqrt(v).toFixed(1) + ' m' : 'NEGATIVE variance — errors are not independent'
      }`
    );
  });
  const ranked = own
    .map((v, i) => ({ v, i }))
    .filter((r) => r.v >= 0)
    .sort((a, b) => a.v - b.v);
  if (ranked.length === 3) {
    console.log(
      `  -> ranked best to worst: ${ranked.map((r) => labels[r.i]).join(', ')}.`
    );
    /**
     * One comparison here is stronger than the rest and it is worth naming.
     * Subtracting the two solutions, s2A - s2C = ( d2(A,B) - d2(B,C) ) / 2:
     * the shared-parent covariance between A and C cancels exactly. So the
     * Mapterhorn-vs-GEDTM30 ORDER is decided purely by which of them disagrees
     * more with the independent third product, and it survives the correlation
     * caveat that the absolute metres do not.
     */
    console.log(
      `     Mapterhorn vs GEDTM30 is the robust half of that: their shared Copernicus\n` +
        `     parent cancels when the two solutions are subtracted, leaving only how far\n` +
        `     each sits from AWS (${sAB.toFixed(1)} m vs ${sBC.toFixed(1)} m).`
    );
  } else if (ranked.length < 3) {
    console.log(
      '  -> a negative variance means the shared-parent correlation above is real and large.' +
        ' The pairwise rows are still valid; the decomposition is not.'
    );
  }
}
console.log();
