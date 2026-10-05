/**
 * The pondage screen against a reservoir that exists.
 *
 *   node pipeline/build-pondage-validation.mjs
 *
 * WHY THIS EXISTS. Pondage was the only headline output in this app never
 * scored against reality. checks/pondage.check.ts asserts the arithmetic on an
 * 18-cell synthetic bowl whose answer is true by construction, and after the
 * moving-axis fix it also asserts the stage curve cannot run backwards. Neither
 * says whether a real valley comes out the right size.
 *
 * WHY A BROWSER, same reason as build-validation.mjs: terrain tiles are decoded
 * through a canvas, so the app's own DEM path only runs in one. Re-implementing
 * it in Node would validate the copy.
 *
 * WHAT IT CAN AND CANNOT SHOW. Kulekhani was impounded in 1982, decades before
 * any DEM the app uses, so the raster samples the LAKE SURFACE — a flat plateau
 * at the water level on the capture date. That is a gift and a limit:
 *
 *   it CAN score the connected fill, the dam barrier and the area integration
 *   against a real shoreline with islands, arms and a winding 7 km extent, which
 *   no synthetic fixture reproduces;
 *
 *   it CANNOT score storage, because the drowned valley is not in the raster.
 *   Predicted volume here is a lower bound by construction, not an error, and
 *   the report says so rather than printing a misleading ratio.
 *
 * A tool that has been falsified once on a real site is in a different category
 * from one that has never been asked.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const OUT = 'src/data/pondage-validation.json';
const PORT = 5197;

/**
 * Which terrain source to score:
 *
 *   node pipeline/build-pondage-validation.mjs "GEDTM30 bare earth"
 *
 * No argument scores whatever the app itself screens with, so a bare run always
 * measures the shipped answer. A named source writes to its own file, because a
 * run of a candidate DEM must never be mistaken later for the shipped result —
 * the same reason every accumulated row in this project carries an engine
 * signature.
 */
/**
 * A reference file may also be named:
 *
 *   node pipeline/build-pondage-validation.mjs pipeline/pondage-references-gsw.json
 *
 * The default set is Kulekhani and its published figures. The GSW set is 207
 * waterbodies measured from space. They answer the same question against
 * different evidence and must never land in the same file, for the same reason
 * a candidate DEM never does: a run against a different reference population is
 * not comparable to the shipped one, and a summary cannot tell them apart.
 */
const args = process.argv.slice(2);
const REFS_FILE = args.find((a) => a.endsWith('.json')) ?? 'pipeline/pondage-references.json';
/** Rows to score, for a quick pass over a large set: `--limit 20` or `--limit=20`. */
const limitAt = args.findIndex((a) => a.startsWith('--limit'));
const LIMIT =
  limitAt < 0
    ? Infinity
    : Number(args[limitAt].split('=')[1] ?? args[limitAt + 1]) || Infinity;
// The value of a space-separated flag is not a terrain source.
const flagValue = limitAt >= 0 && !args[limitAt].includes('=') ? args[limitAt + 1] : null;
const SOURCE =
  args.find((a) => !a.endsWith('.json') && !a.startsWith('--') && a !== flagValue) ?? null;

const refsTag = REFS_FILE.split(/[\\/]/).pop()
  .replace(/^pondage-references-?/, '')
  .replace(/[.]json$/, '');
const OUT_FILE = OUT.replace(
  /[.]json$/,
  [refsTag, SOURCE?.replace(/\W+/g, '-').toLowerCase()].filter(Boolean).map((t) => '.' + t).join('') +
    '.json'
);

const refs = JSON.parse(readFileSync(REFS_FILE, 'utf8'));
const reservoirs = refs.reservoirs.slice(0, LIMIT);
console.log(`scoring ${reservoirs.length} of ${refs.reservoirs.length} from ${REFS_FILE}`);
if (reservoirs.length < refs.reservoirs.length) {
  console.log(`  (--limit dropped ${refs.reservoirs.length - reservoirs.length} rows)`);
}

console.log(`starting vite on :${PORT}…`);
const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();

const ctx = await chromium.launchPersistentContext('pipeline/.cache/browser-profile', {
  channel: 'chrome',
  headless: true,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[pondage]')) console.log(' ', t.slice(9));
});
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

/**
 * Score in chunks, not in one call.
 *
 * The first full run over 207 waterbodies died at roughly the two-thirds mark
 * with "Execution context was destroyed" — a renderer that had been handed two
 * hundred 500x500 terrain windows in a single `page.evaluate`. Everything
 * already computed went with it, which is harness rule 3 in a new costume:
 * a run that cannot survive its own last site cannot be trusted to have
 * preserved the ones before it. Chunking bounds the loss to one chunk and lets
 * the page be reloaded in between.
 */
const CHUNK = 10;
const evaluateChunk = (slice) => page.evaluate(async ({ reservoirs, source }) => {
  const api = await import('/src/api.ts');
  const pond = await import('/src/pondage.ts');
  const out = [];

  const NB = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const latLonOf = (g, row, col) => ({
    lat: g.north - (row / (g.rows - 1)) * (g.north - g.south),
    lon: g.west + (col / (g.cols - 1)) * (g.east - g.west),
  });

  /**
   * WHERE DOES THIS LAKE DRAIN?
   *
   * Kulekhani's downstream direction was a hand-measured offset from its
   * published dam coordinate — fine for one site, useless for two hundred, and
   * a magic constant either way. Water leaves a standing waterbody at the
   * LOWEST POINT ON ITS SHORELINE, which is not a heuristic but the definition,
   * and a DEM that already holds the lake as a flat plateau holds that point
   * too.
   *
   * So: flood the plateau outward from the window centre at a tolerance, and
   * track the lowest cell adjacent to it that is not part of it. That cell is
   * the outlet, and the plateau's own centroid gives the direction through it.
   */
  function plateauOutlet(g, level, tolM) {
    const size = g.rows * g.cols;
    const seen = new Uint8Array(size);
    const stack = [((g.rows >> 1) * g.cols) + (g.cols >> 1)];
    seen[stack[0]] = 1;
    let sumR = 0, sumC = 0, n = 0, outlet = null, outletZ = Infinity, maxZ = -Infinity;
    while (stack.length) {
      const i = stack.pop();
      const row = (i / g.cols) | 0;
      const col = i % g.cols;
      sumR += row; sumC += col; n++;
      // The plateau is a BAND, not a level: cells inside the tolerance span up
      // to 2 * tolM. The fill has to clear the top of it or the highest cells of
      // the lake's own surface stay dry and the retained height goes negative.
      const zc = g.elevations[i];
      if (Number.isFinite(zc) && zc > maxZ) maxZ = zc;
      for (const [dr, dc] of NB) {
        const nr = row + dr, nc = col + dc;
        if (nr < 0 || nc < 0 || nr >= g.rows || nc >= g.cols) continue;
        const ni = nr * g.cols + nc;
        if (seen[ni]) continue;
        const z = g.elevations[ni];
        if (!Number.isFinite(z)) continue;
        if (Math.abs(z - level) <= tolM) { seen[ni] = 1; stack.push(ni); }
        /**
         * The lowest cell on the rim, whether or not it is below the plateau's
         * nominal level.
         *
         * Requiring `z < level` looked like the safe reading and it was wrong:
         * Rara's 11,378-cell plateau came out at exactly its published extent and
         * then reported NO OUTLET, because a 30 m DEM smooths a narrow outflow
         * up to or above the water surface. A lake with no outlet is not a
         * finding about the lake, it is a finding about the raster - water still
         * leaves at the lowest point on the rim, and that is what this takes.
         */
        else if (z < outletZ) { outletZ = z; outlet = { row: nr, col: nc }; }
      }
    }
    return { outlet, outletZ, maxZ, cells: n, centroid: { row: sumR / n, col: sumC / n } };
  }

  /**
   * Move the window's centre onto the outlet without fetching anything.
   *
   * `findUpstreamBed` searches within ~210 m of the grid's CENTRE INDEX, and
   * fills are blocked across an axis planted at the bed. Centred on a lake's
   * middle that axis cuts the lake in half and the screen returns half an
   * answer. A TerrainWindow is a plain grid with its own bounds, so the
   * re-centre is a slice, not a second download.
   */
  function recentre(g, row, col) {
    const hr = Math.min(row, g.rows - 1 - row);
    const hc = Math.min(col, g.cols - 1 - col);
    const rows = 2 * hr + 1, cols = 2 * hc + 1;
    const elevations = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const from = (row - hr + r) * g.cols + (col - hc);
      elevations.set(g.elevations.subarray(from, from + cols), r * cols);
    }
    const dLat = (g.north - g.south) / (g.rows - 1);
    const dLon = (g.east - g.west) / (g.cols - 1);
    const north = g.north - (row - hr) * dLat, south = g.north - (row + hr) * dLat;
    const west = g.west + (col - hc) * dLon, east = g.west + (col + hc) * dLon;
    return { ...g, rows, cols, elevations, north, south, east, west,
             center: { lat: (north + south) / 2, lon: (west + east) / 2 } };
  }

  for (const r of reservoirs) {
    const log = (m) => console.log(`[pondage] ${r.name}: ${m}`);
    try {
      log('fetching terrain…');
      /**
       * Wide enough to hold the waterbody AND the banks that close it. Fixed at
       * 8 km for Kulekhani's 7 km reservoir; sized from the reference's own
       * measured extent where one is given, because Rara is 10 km across and an
       * 8 km window would return an edge-limited area that looks like a modelling
       * error rather than a window that was too small.
       */
      const windowKm = r.gsw?.extentKm
        ? Math.min(16, Math.max(8, Math.ceil(Math.max(...r.gsw.extentKm) * 1.6 + 2)))
        : 8;
      const grid0 = await api.fetchTerrainWindow(
        r.dam,
        windowKm,
        30,
        source || api.PRIMARY_TERRAIN_SOURCE_ID
      );
      log(`terrain source: ${grid0.source} @ ~${grid0.resolutionM} m, ${windowKm} km window`);

      /**
       * Find the lake surface in the raster.
       *
       * An impounded valley reads as an unusually flat plateau. Rather than
       * assume the published full-supply level — the lake is drawn down most
       * years — the plateau's own elevation is measured: take cells within a
       * few hundred metres of the dam and above it, and find the most common
       * half-metre elevation band. That is the water level on the capture date.
       */
      /**
       * A published full-supply level anchors the search where one exists. It
       * does not exist for a lake nobody surveyed — so the raster's own
       * elevation at the window centre stands in, and for a waterbody whose
       * centroid was measured from space that value IS the water surface. It is
       * the better anchor of the two: the published level is a design figure and
       * the lake is drawn down most years, while this is what the DEM saw.
       */
      /**
       * The median of a 5x5 box at the window centre, not one cell: a single
       * radar sample over water is noisy and this number anchors everything
       * below it.
       */
      const box = [];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const v = grid0.elevations[((grid0.rows >> 1) + dr) * grid0.cols + (grid0.cols >> 1) + dc];
          if (Number.isFinite(v)) box.push(v);
        }
      }
      box.sort((a, b) => a - b);
      const centreZ = box.length ? box[box.length >> 1] : NaN;

      let level = null;
      let plateauCells = 0;
      if (r.fullSupplyLevelM != null) {
        /**
         * With a published level in hand, take the most common half-metre band
         * near it. This is the original Kulekhani path and it is left alone.
         */
        const z = [...grid0.elevations].filter(Number.isFinite);
        const near = z.filter((v) => Math.abs(v - r.fullSupplyLevelM) < 60);
        const bins = new Map();
        for (const v of near) {
          const b = Math.round(v * 2) / 2;
          bins.set(b, (bins.get(b) ?? 0) + 1);
        }
        let best = 0;
        for (const [b, n] of bins) if (n > best) { best = n; level = b; }
        plateauCells = best;
      } else {
        /**
         * WITHOUT a published level, the histogram is the wrong instrument and
         * it failed loudly before it was replaced: a 16 km window over Rara holds
         * far more mountainside than lake, so the most common half-metre band in
         * it is some valley terrace tens of metres BELOW the water, and every
         * cell near the seed then sits above the supposed water level. Five of
         * the first eight lakes scored died on 'no outlet found', including the
         * two largest in the country.
         *
         * A lake surface is not a mode, it is a CONNECTED FLAT REGION containing
         * the point measured from space. Taking it by connectivity from the seed
         * is both simpler and the actual definition.
         */
        if (!Number.isFinite(centreZ)) throw new Error('no usable elevation at the window centre');
        level = Math.round(centreZ * 2) / 2;
      }
      if (level == null) throw new Error('no water plateau found');
      log(`raster water plateau at ${level} m, anchor ${centreZ.toFixed(1)} m ` +
          `(${r.fullSupplyLevelM == null ? 'raster, at the measured centroid' : 'published FSL'})`);

      /**
       * Point the screen downstream, and put the window centre where a dam would
       * go. An explicit `downstream` in the reference wins — Kulekhani carries
       * one so its shipped result cannot move as a side effect of this code.
       */
      let grid = grid0;
      let downstream = r.downstream ?? null;
      let outletNote = 'from the reference';
      if (!downstream) {
        // Half a metre: the DEM's own vertical quantisation, and the same
        // tolerance the fill uses to put a lake surface unambiguously under water.
        /**
         * Widen the tolerance until the plateau is a lake, and SAY which one it
         * took.
         *
         * Half a metre is the DEM's vertical quantisation and it is right over a
         * calm reservoir. Over Shey Phoksundo at 3,700 m it is not: the surface
         * is noisy enough that connectivity broke at the seed and the plateau
         * came back as ONE CELL, which still produced a plausible-looking
         * 6.1 km2 answer against a measured 4.6. A silently-wrong number is the
         * failure mode this whole project is built against, so the tolerance
         * escalates on a stated floor and the tolerance used is reported.
         */
        let p = null;
        let tolM = 0;
        for (const t of [0.5, 1.5, 3]) {
          tolM = t;
          p = plateauOutlet(grid0, level, t);
          if (p.cells >= 50) break;
        }
        plateauCells = p.cells;
        if (p.cells < 50) {
          throw new Error(`no lake surface at the centroid: ${p.cells} connected cells at ${level} m even at +/-3 m`);
        }
        if (!p.outlet) {
          throw new Error(`no outlet on the margin of a ${p.cells}-cell plateau at ${level} m`);
        }
        const c = latLonOf(grid0, p.centroid.row, p.centroid.col);
        const o = latLonOf(grid0, p.outlet.row, p.outlet.col);
        const dLat = o.lat - c.lat, dLon = o.lon - c.lon;
        if (!(Math.abs(dLat) > 1e-9 || Math.abs(dLon) > 1e-9)) {
          throw new Error('outlet coincides with the plateau centroid');
        }
        downstream = { lat: o.lat + dLat, lon: o.lon + dLon };
        grid = recentre(grid0, p.outlet.row, p.outlet.col);
        /**
         * Fill to the top of the measured plateau, not to its nominal centre.
         *
         * Rara's plateau spans 2965.5-2966.5 m; anchoring on 2966.0 put the bed
         * search on a 2966.5 m cell of the lake's own surface and produced a
         * retained height of MINUS half a metre, which reads as "this lake could
         * not be filled". Three of the first eight, Rara and Phewa among them.
         */
        level = p.maxZ;
        outletNote = `derived: plateau ${p.cells} cells at +/-${tolM} m (top ${p.maxZ.toFixed(1)} m), ` +
          `outlet at ${p.outletZ.toFixed(1)} m`;
        log(`outlet ${outletNote}; window re-centred to ${grid.rows}x${grid.cols}`);
        if (grid.rows < 64 || grid.cols < 64) {
          throw new Error(`re-centred window collapsed to ${grid.rows}x${grid.cols}`);
        }
      }

      /**
       * Seed the fill inside the lake, not at the dam wall.
       *
       * `delineatePondage` takes a downstream direction and searches upstream
       * for the channel floor. Pointing it just downstream of the dam — or of
       * the outlet derived above — gives it the same job it does for a user:
       * find the bed, span the banks, fill.
       */
      // Retained height measured from the plateau the raster actually holds.
      const bedProbe = pond.delineatePondage(grid, downstream, 1);
      const retained = level - bedProbe.bedElevationM;
      log(`detected bed ${bedProbe.bedElevationM.toFixed(1)} m → retained height ${retained.toFixed(1)} m`);

      /**
       * Fill to JUST ABOVE the plateau, not to it.
       *
       * The flooded set is cells strictly below the water level, and a lake
       * surface in a raster is a plateau at one elevation — so a level of
       * exactly 1533 m excludes every cell of a 1533 m lake and returns nothing.
       * That is correct behaviour for a drowned valley, where the ground really
       * is below the water; it is only an artefact of testing against a raster
       * that already contains the lake. Half a metre is well inside the DEM's
       * own vertical quantisation and puts the surface unambiguously under water.
       */
      const EPS_M = 0.5;
      let result = null;
      if (!(retained + EPS_M > 0)) {
        throw new Error(
          `retained height ${retained.toFixed(2)} m: the bed search landed at ` +
            `${bedProbe.bedElevationM.toFixed(2)} m, at or above the water plateau at ${level} m`
        );
      }
      if (retained + EPS_M > 0) {
        result = pond.delineatePondage(grid, downstream, retained + EPS_M);
      }

      /**
       * The shoreline is fuzzy over several metres — radar over water is noisy
       * and the banks are steep — so the answer moves with the assumed level.
       * Reporting a small stage table around the plateau shows the reader how
       * much of the result is terrain and how much is the threshold.
       */
      const around = [];
      for (const d of [-3, -1, 0, 1, 3]) {
        const h = retained + EPS_M + d;
        if (!(h > 0)) continue;
        try {
          const s = pond.delineatePondage(grid, downstream, h, result ? result.axis : undefined);
          around.push({ levelM: bedProbe.bedElevationM + h, areaKm2: s.areaM2 / 1e6 });
        } catch {
          /* unusable at this level */
        }
      }

      out.push({
        name: r.name,
        ok: Boolean(result),
        outlet: outletNote,
        windowKm,
        rasterWaterLevelM: level,
        rasterPlateauCells: plateauCells,
        publishedFullSupplyLevelM: r.fullSupplyLevelM,
        detectedBedM: bedProbe.bedElevationM,
        retainedHeightM: retained,
        areaAroundLevel: around,
        predicted: result
          ? {
              areaKm2: result.areaM2 / 1e6,
              volumeMm3: result.volumeM3 / 1e6,
              floodedCells: result.floodedCells,
              edgeLimited: result.edgeLimited,
              damAxisLimited: result.damAxisLimited,
              damLengthM: result.damLengthM,
              upstreamLengthM: result.upstreamLengthM,
              seedMovedM: result.seedMovedM,
            }
          : null,
        reference: {
          areaKm2: r.surfaceAreaKm2,
          // A satellite-measured shoreline is a BAND, not a point: an operated
          // reservoir is drawn down and the DEM caught it at one unknown level.
          // Scoring against a point would charge the app for the operation.
          areaBandKm2: r.surfaceAreaBandKm2 ?? null,
          grossStorageMm3: r.grossStorageMm3,
          damCrestLengthM: r.damCrestLengthM,
          measured: r.measuredNot === 'published',
          glacialLake: r.glacialLake ?? null,
        },
        source: r.source,
        terrainSource: grid.source,
        test: r.test,
      });
    } catch (e) {
      out.push({ name: r.name, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  return out;
}, { reservoirs: slice, source: SOURCE });

const results = [];
for (let i = 0; i < reservoirs.length; i += CHUNK) {
  const slice = reservoirs.slice(i, i + CHUNK);
  try {
    results.push(...(await evaluateChunk(slice)));
  } catch (e) {
    // A dead renderer is a failure of the harness, not of the screen, and it is
    // recorded as one rather than quietly shortening the scored set.
    const why = `harness: ${e && e.message ? e.message.split('\n')[0] : e}`;
    console.log(`  rows ${i + 1}-${i + slice.length} lost — ${why}`);
    for (const r of slice) results.push({ name: r.name, ok: false, error: why });
  }
  if (i + CHUNK < reservoirs.length) {
    /**
     * The app rewrites the URL to `#map=…` the moment it loads, so a plain
     * `goto` back to the bare URL is "interrupted by another navigation" and
     * rejects — which killed the second full run at row 101 having already
     * scored a hundred sites. The interrupt is benign (the page IS loading), so
     * it is swallowed and the load is then waited for properly. Starting the
     * next chunk against a half-navigated page is what destroys the execution
     * context.
     */
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    console.log(`  ${Math.min(i + CHUNK, reservoirs.length)}/${reservoirs.length}`);
  }
}

await ctx.close();
await server.close();

const ran = results.filter((r) => r.ok);
if (ran.length === 0) {
  // Never overwrite a good result with a failed run.
  console.error('\nNo reservoir produced a result — nothing written.');
  for (const r of results) console.error(`  ${r.name}: ${r.error ?? 'no result'}`);
  process.exit(1);
}

writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      _what: 'HydroRecon pondage screen against reservoirs with published figures.',
      _terrainSource: SOURCE ?? 'app default',
      _caution: refs._caution,
      _generated: new Date().toISOString().slice(0, 10),
      reservoirs: results,
    },
    null,
    2
  )
);

console.log(`\nwrote ${OUT_FILE}: ${ran.length}/${results.length} reservoirs\n`);
/**
 * Print every row in full for a handful of sites, and only the failures plus an
 * aggregate once the set is a population. The per-site detail is what made the
 * Kulekhani run useful; two hundred copies of it is a wall nobody reads.
 */
const VERBOSE = results.length <= 12;
for (const r of VERBOSE ? results : results.filter((x) => !x.ok)) {
  if (!r.ok) {
    console.log(`  ${r.name}: FAILED — ${r.error}`);
    continue;
  }
  const p = r.predicted;
  const ref = r.reference;
  const ratio = p.areaKm2 / ref.areaKm2;
  console.log(`  ${r.name}`);
  if (r.publishedFullSupplyLevelM != null) {
    console.log(
      `    raster water level ${r.rasterWaterLevelM} m against a published full-supply ${r.publishedFullSupplyLevelM} m ` +
        `(${(r.rasterWaterLevelM - r.publishedFullSupplyLevelM).toFixed(1)} m)`
    );
  } else {
    console.log(
      `    raster water level ${r.rasterWaterLevelM} m, taken from the raster; outlet ${r.outlet}`
    );
  }
  /**
   * Score against the BAND, not against a point.
   *
   * A satellite shoreline is measured over 38 years and a reservoir is operated,
   * so the reference has a lower edge (always wet) and an upper one (wet at
   * least half the time). The DEM caught the water at ONE unknown level inside
   * that range. A screen landing anywhere in the band has not been shown wrong,
   * and printing a single ratio would charge the app for the drawdown.
   */
  const band = ref.areaBandKm2;
  const inBand = band ? p.areaKm2 >= band[0] * 0.9 && p.areaKm2 <= band[1] * 1.1 : null;
  console.log(
    `    AREA      predicted ${p.areaKm2.toFixed(3)} km2   ` +
      (band
        ? `measured band ${band[0].toFixed(3)}–${band[1].toFixed(3)} km2   ` +
          `${ratio.toFixed(2)}x of the upper edge   ${inBand ? 'IN BAND' : 'OUTSIDE BAND'}`
        : `published ${ref.areaKm2} km2   ${ratio.toFixed(2)}x`)
  );
  if (ref.damCrestLengthM != null) {
    console.log(
      `    dam span  predicted ${p.damLengthM == null ? 'axis-limited' : p.damLengthM.toFixed(0) + ' m'}` +
        `   published crest ${ref.damCrestLengthM} m`
    );
  }
  console.log(
    ref.grossStorageMm3 != null
      ? `    storage   predicted ${p.volumeMm3.toFixed(1)} Mm3 — NOT comparable to the published ` +
          `${ref.grossStorageMm3} Mm3: the raster holds the lake surface, not the drowned valley`
      : `    storage   predicted ${p.volumeMm3.toFixed(2)} Mm3 — a LOWER BOUND, not a result: no DEM ` +
          `carries bathymetry under standing water`
  );
  if (ref.glacialLake) {
    console.log(
      `    NOTE      glacial lake at ${ref.glacialLake.elevationM.toFixed(0)} m ` +
        `(${ref.glacialLake.type}) — a geometry test, not a candidate forebay`
    );
  }
  /**
   * The level table is the most useful line in this report.
   *
   * A pondage that doubles for a metre of water level is not an estimate, it is
   * a coin toss on where a saddle sits — and the reader has to be told which
   * kind they have been handed.
   */
  if (r.areaAroundLevel && r.areaAroundLevel.length > 1) {
    console.log(`    level table (area against assumed water level):`);
    for (const a of r.areaAroundLevel) {
      console.log(`      ${a.levelM.toFixed(1)} m  ${a.areaKm2.toFixed(2)} km2`);
    }
    /**
     * Only the levels AT OR ABOVE the water plateau say anything about
     * stability.
     *
     * This test was written when the failure mode was a fill escaping a saddle
     * upward, and it compared the whole table. On a reservoir that already
     * exists that is wrong in one direction: the raster holds the LAKE SURFACE,
     * so a level below the plateau legitimately finds almost nothing, and the
     * collapse is the test setup rather than the method. Scoring it flagged a
     * source as 21x unstable on the very run where its upward behaviour became
     * stable for the first time.
     *
     * A real, undrowned valley has no plateau and no such floor, which is why
     * the app's own screenPondage reports a symmetric +/-3 m sensitivity
     * instead. This harness only gets the upward half.
     */
    const plateau = r.rasterWaterLevelM ?? -Infinity;
    const above = r.areaAroundLevel.filter((a) => a.areaKm2 > 0 && a.levelM >= plateau - 0.25);
    const below = r.areaAroundLevel.filter((a) => a.areaKm2 > 0 && a.levelM < plateau - 0.25);
    if (below.length) {
      console.log(
        `      (${below.length} level${below.length === 1 ? '' : 's'} below the water plateau ` +
          'excluded from the stability test: the raster holds the lake surface, so a lower ' +
          'level finds the plateau and not a valley)'
      );
    }
    const areas = above.map((a) => a.areaKm2);
    const jump = areas.length > 1 ? Math.max(...areas) / Math.min(...areas) : 1;
    if (jump > 3) {
      console.log(
        `    UNSTABLE: above the water plateau the answer still moves ${jump.toFixed(0)}x — the` +
          ' fill escapes a saddle. Treat this site as order-of-magnitude only.'
      );
    } else if (areas.length > 1) {
      console.log(
        `    STABLE: above the water plateau the answer moves ${jump.toFixed(2)}x across ` +
          `${areas.length} levels spanning ${(
            Math.max(...above.map((a) => a.levelM)) - Math.min(...above.map((a) => a.levelM))
          ).toFixed(1)} m.`
      );
    }
  }
  if (p.edgeLimited) console.log('    WARNING: reached the DEM window edge; area is a lower bound');
  if (p.damAxisLimited) console.log('    WARNING: a bank was not found; the axis is approximate');
  console.log(`    source: ${r.source}`);
}

/**
 * The aggregate, which is the whole point of scoring a population.
 *
 * Reported on the BAND, not on a ratio to one number: a satellite shoreline
 * measured over 38 years has a lower and an upper edge, and a screen landing
 * between them has not been shown wrong. Rows whose band is tight enough for
 * the verdict to mean something are counted apart from the seasonal floodplain,
 * which is reported rather than dropped.
 */
if (!VERBOSE) {
  const scored = ran.filter((r) => r.reference?.areaBandKm2);
  const isSharp = (r) => {
    const [lo, hi] = r.reference.areaBandKm2;
    return hi > 0 && lo / hi >= 0.8;
  };
  const line = (label, rows) => {
    if (!rows.length) return;
    const ratios = rows
      .map((r) => r.predicted.areaKm2 / r.reference.areaBandKm2[1])
      .sort((a, b) => a - b);
    const at = (q) => ratios[Math.min(ratios.length - 1, Math.floor(q * ratios.length))];
    const inBand = rows.filter((r) => {
      const [lo, hi] = r.reference.areaBandKm2;
      return r.predicted.areaKm2 >= lo * 0.9 && r.predicted.areaKm2 <= hi * 1.1;
    }).length;
    const edge = rows.filter((r) => r.predicted.edgeLimited).length;
    console.log(
      `  ${label.padEnd(24)} n=${String(rows.length).padStart(3)}   ` +
        `in band ${String(inBand).padStart(3)} (${Math.round((100 * inBand) / rows.length)}%)   ` +
        `area/upper edge  p10 ${at(0.1).toFixed(2)}x  median ${at(0.5).toFixed(2)}x  p90 ${at(0.9).toFixed(2)}x` +
        (edge ? `   [${edge} window-edge limited]` : '')
    );
  };
  console.log('SUMMARY — predicted surface area against the satellite band\n');
  line('all scored', scored);
  line('tight band only', scored.filter(isSharp));
  line('not glacial', scored.filter((r) => !r.reference.glacialLake));
  line('tight, not glacial', scored.filter((r) => isSharp(r) && !r.reference.glacialLake));
  const failed = results.length - ran.length;
  if (failed) console.log(`\n  ${failed} of ${results.length} produced no result at all.`);
  const unstable = ran.filter((r) => {
    const above = (r.areaAroundLevel ?? []).filter(
      (a) => a.areaKm2 > 0 && a.levelM >= (r.rasterWaterLevelM ?? -Infinity) - 0.25
    );
    const areas = above.map((a) => a.areaKm2);
    return areas.length > 1 && Math.max(...areas) / Math.min(...areas) > 3;
  }).length;
  console.log(
    `  ${unstable} of ${ran.length} move more than 3x across the levels above their own water ` +
      'plateau — the saddle-escape failure Kulekhani exposed, now counted on a population.'
  );
}
