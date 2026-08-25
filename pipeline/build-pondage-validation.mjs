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
const SOURCE = process.argv[2] || null;
const OUT_FILE = SOURCE
  ? OUT.replace(/[.]json$/, '.' + SOURCE.replace(/\W+/g, '-').toLowerCase() + '.json')
  : OUT;

const refs = JSON.parse(readFileSync('pipeline/pondage-references.json', 'utf8'));

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

const results = await page.evaluate(async ({ reservoirs, source }) => {
  const api = await import('/src/api.ts');
  const pond = await import('/src/pondage.ts');
  const out = [];

  for (const r of reservoirs) {
    const log = (m) => console.log(`[pondage] ${r.name}: ${m}`);
    try {
      log('fetching terrain…');
      // Wide enough to hold a 7 km reservoir and its banks.
      const grid = await api.fetchTerrainWindow(
        r.dam,
        8,
        30,
        source || api.PRIMARY_TERRAIN_SOURCE_ID
      );
      log(`terrain source: ${grid.source} @ ~${grid.resolutionM} m`);

      /**
       * Find the lake surface in the raster.
       *
       * An impounded valley reads as an unusually flat plateau. Rather than
       * assume the published full-supply level — the lake is drawn down most
       * years — the plateau's own elevation is measured: take cells within a
       * few hundred metres of the dam and above it, and find the most common
       * half-metre elevation band. That is the water level on the capture date.
       */
      const z = [...grid.elevations].filter(Number.isFinite);
      const near = z.filter((v) => Math.abs(v - r.fullSupplyLevelM) < 60);
      const bins = new Map();
      for (const v of near) {
        const b = Math.round(v * 2) / 2;
        bins.set(b, (bins.get(b) ?? 0) + 1);
      }
      let level = null;
      let best = 0;
      for (const [b, n] of bins) if (n > best) { best = n; level = b; }
      const plateauCells = best;
      log(`raster water plateau at ${level} m (${plateauCells} cells), published FSL ${r.fullSupplyLevelM} m`);

      /**
       * Seed the fill inside the lake, not at the dam wall.
       *
       * `delineatePondage` takes a downstream direction and searches upstream
       * for the channel floor. Pointing it just downstream of the dam gives it
       * the same job it does for a user: find the bed, span the banks, fill.
       */
      const downstream = { lat: r.dam.lat - 0.01, lon: r.dam.lon - 0.004 };
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
        published: {
          areaKm2: r.surfaceAreaKm2,
          grossStorageMm3: r.grossStorageMm3,
          damCrestLengthM: r.damCrestLengthM,
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
}, { reservoirs: refs.reservoirs, source: SOURCE });

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
for (const r of results) {
  if (!r.ok) {
    console.log(`  ${r.name}: FAILED — ${r.error}`);
    continue;
  }
  const p = r.predicted;
  const ratio = p.areaKm2 / r.published.areaKm2;
  console.log(`  ${r.name}`);
  console.log(
    `    raster water level ${r.rasterWaterLevelM} m against a published full-supply ${r.publishedFullSupplyLevelM} m ` +
      `(${(r.rasterWaterLevelM - r.publishedFullSupplyLevelM).toFixed(1)} m)`
  );
  console.log(
    `    AREA      predicted ${p.areaKm2.toFixed(2)} km2   published ${r.published.areaKm2} km2   ${ratio.toFixed(2)}x`
  );
  console.log(
    `    dam span  predicted ${p.damLengthM == null ? 'axis-limited' : p.damLengthM.toFixed(0) + ' m'}` +
      `   published crest ${r.published.damCrestLengthM} m`
  );
  console.log(
    `    storage   predicted ${p.volumeMm3.toFixed(1)} Mm3 — NOT comparable to the published ` +
      `${r.published.grossStorageMm3} Mm3: the raster holds the lake surface, not the drowned valley`
  );
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
