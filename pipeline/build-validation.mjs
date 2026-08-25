/**
 * Run the validation set and commit the result.
 *
 *   npm run build:validation
 *
 * WHY A BROWSER: the point of the exercise is that the numbers on the
 * validation page come from the SAME code the app runs — same river snapping,
 * same DEM sampling, same flow fetch, same engine. Re-implementing that chain
 * in Node would create a second pipeline that could quietly diverge from the
 * first, and a validation of the copy validates nothing. So a headless Chrome
 * loads the dev server and imports src/validate.ts, which imports the app's
 * own modules.
 *
 * The output is committed (src/data/validation.json) rather than computed live:
 * a validation that silently re-runs is a validation that can silently change.
 * Re-run this script to refresh it; the page shows the date it was produced.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { attachFloodCache } from './flood-cache.mjs';
import { engineSignature } from './engine-signature.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const OUT = 'src/data/validation.json';
const PORT = 5199;

const spec = JSON.parse(readFileSync('pipeline/plants.json', 'utf8'));

console.log(`starting vite on :${PORT}…`);
const server = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'error',
});
await server.listen();

/**
 * A PERSISTENT browser profile, so the discharge cache survives between runs.
 *
 * src/api.ts already caches every fetched series in localStorage for 180 days,
 * keyed by quantised cell. A fresh headless Chrome starts with that empty, so
 * each run re-fetched every plant from scratch — Upper Tamakoshi alone was
 * requested about eight times in one afternoon, always the same coordinate and
 * the same forty-year archive. That is what exhausted the rate limit, not the
 * size of the sample.
 *
 * With the profile kept on disk a plant costs one request EVER rather than one
 * per run, which is both the fix for the limit and the polite thing to do to a
 * free service funded by donations.
 */
const ctx = await chromium.launchPersistentContext('pipeline/.cache/browser-profile', {
  channel: 'chrome',
  headless: true,
});
const browser = ctx.browser() ?? { close: () => ctx.close() };
const page = ctx.pages()[0] ?? (await ctx.newPage());
const floodCache = await attachFloodCache(ctx);

/**
 * Clear the app's own rate-limit cooldown at harness startup.
 *
 * src/api.ts remembers a refusal and declines to try again for fifteen minutes,
 * which is correct behaviour towards a free service and correct for a user. It
 * is checked BEFORE any network call, so with a persistent profile it also
 * blocks coordinates this harness already holds on disk — a run would refuse
 * work it does not need the network for at all.
 *
 * Clearing it does not mean hammering: attachFloodCache answers repeats from
 * disk, so only genuinely new coordinates reach the service, and if it refuses
 * one the app sets the cooldown again immediately.
 */
await page.addInitScript(() => {
  try {
    localStorage.removeItem('hydrorecon:glofas:v2:cooldown');
  } catch {
    /* storage disabled */
  }
});
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[validate]')) console.log(' ', t.slice(10));
});
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

console.log(`running ${spec.plants.length} plants through the app's own engine…`);
const results = await page.evaluate(
  async (plants) => {
    const m = await import('/src/validate.ts');
    return m.validateAll(plants, (name, done, total) =>
      console.log(`[validate] ${done + 1}/${total} ${name}`)
    );
  },
  spec.plants
);

await ctx.close();
await server.close();

// Marry each result back to its plant record so the page is self-contained.
const plants = spec.plants.map((p) => ({
  ...p,
  result: results.find((r) => r.name === p.name) ?? { name: p.name, ok: false, error: 'no result' },
}));

/**
 * A one-sided physics test, the same one the fleet harness applies.
 *
 * Nepal's rivers run between about 0.005 and 0.25 m3/s per square kilometre of
 * catchment. If the design flow the engine returns needs more than the ceiling
 * on the catchment it snapped to, the water is not there and the number is
 * about some other watercourse — the coordinate is off the headworks, or the
 * snap took a side channel.
 *
 * Mistri Khola is why this is here. Its published intake is admitted in
 * plants.json to be village-level accuracy, and it lands on a 29 km2 order-1
 * stream while the plant runs 17.1 m3/s. That is 0.59 m3/s per km2, more than
 * twice anything Nepal produces. Reported as a head or capacity error it looks
 * like the engine is wrong; named as an impossible coordinate it is what it is.
 */
const SPECIFIC_MAX = 0.25;
const impossible = plants.filter((p) => {
  const r = p.result;
  if (!r?.ok || !(r.reachKm2 > 0)) return false;
  const need = p.actual?.designQ ?? r.predicted?.designFlowCms;
  return need > 0 && need / r.reachKm2 > SPECIFIC_MAX;
});
if (impossible.length) {
  console.log(`
  COORDINATE CANNOT HOST ITS PLANT (physics, not engine error)`);
  for (const p of impossible) {
    const need = p.actual?.designQ ?? p.result.predicted.designFlowCms;
    console.log(
      `    ${p.name.padEnd(20)} ${need.toFixed(1)} m3/s on ${p.result.reachKm2.toFixed(0)} km2 = ` +
        `${(need / p.result.reachKm2).toFixed(2)} m3/s per km2, ceiling ${SPECIFIC_MAX}`
    );
  }
}

const failures = plants.filter((p) => !p.result.ok);
for (const f of failures) console.log(`  FAILED ${f.name}: ${f.result.error}`);

const out = {
  _what:
    'HydroRecon run at ten built Nepali plants with its shipped defaults — same engine and data ' +
    'sources as the app, coordinates from public records, no per-plant tuning.',
  _generated: new Date().toISOString().slice(0, 10),
  /**
   * The engine these numbers came out of. The page asserts they cannot drift
   * from the app without a rerun; without a signature that was a promise
   * nothing kept, and the committed file was four days behind flowchoice.ts,
   * modified-hydest.ts, discover.ts and rivers.ts while still saying so.
   */
  _engine: engineSignature(),
  /**
   * Read the head errors below with this in mind.
   *
   * Several of these plants are UNDERGROUND, and their published powerhouse
   * coordinate is a surface marker — a village centroid for Upper Tamakoshi
   * (Gongar), a station point for Middle Marsyangdi (Siundibar). The machine
   * hall and its tailrace outlet sit hundreds of metres below that marker.
   *
   * Sampling terrain at the published intake and powerhouse and differencing
   * them was tried as a way to separate "our DEM is wrong" from "the search
   * found a different scheme". It cannot do that here: it returns 311 m for
   * Upper Tamakoshi against a published 822 m, which is not a DEM error but the
   * drop from a hillside village to a tailrace it cannot see. The reference
   * coordinates are not precise enough to test terrain against.
   *
   * So a head error in this file is a comparison between the scheme the app
   * CHOSE and the scheme that was BUILT. That is a fair thing to report and a
   * poor thing to attribute: it does not, on its own, argue for a better DEM.
   */
  _headCaveat:
    'Underground powerhouses publish surface markers, not tailrace outlets. Head errors here ' +
    'compare the chosen scheme against the built one; they are not a measurement of DEM error.',
  _appDefaults: { exceedance: 'Q40', efficiency: 0.96, residualFrac: 0.1 },
  plants,
};
/**
 * REFUSE TO CLOBBER A GOOD RESULT WITH A FAILED RUN.
 *
 * Every plant here needs one discharge request, and when the free service is
 * paused all ten fail at once. This script used to write that outcome straight
 * over the committed file, turning a 10/10 validation into a 0/10 one — a
 * silent, total loss of the thing the page reports, caused by a rate limit
 * rather than by anything being wrong with the engine.
 *
 * The fleet harness merges into what it already has; this one replaces, which
 * is right for a fixed ten-plant set and lethal on a bad day. So a run that
 * produced nothing leaves the previous file alone and says so. A partial run
 * still writes: a plant that stops working is news, and hiding it would be the
 * opposite failure.
 */
const ran = plants.filter((p) => p.result?.ok).length;
if (ran === 0 && existsSync(OUT)) {
  console.log(
    `
NOT WRITING ${OUT}: every plant failed, which is a service outage rather than a result. ` +
      `The committed validation is left as it was.`
  );
  for (const f of failures.slice(0, 1)) console.log(`  first error: ${f.result.error}`);
  process.exit(1);
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nwrote ${OUT}: ${plants.length - failures.length}/${plants.length} plants ran`);

for (const p of plants) {
  if (!p.result.ok) continue;
  const r = p.result.predicted;
  const head = p.actual.head
    ? `head ${r.grossHeadM.toFixed(0)}/${p.actual.head} (${p.actual.headBasis})`
    : 'head n/p';
  console.log(
    `  ${p.name.padEnd(20)} ${head.padEnd(26)} Q ${r.designFlowCms.toFixed(1)}/${p.actual.designQ ?? '—'}  ` +
      `cap ${r.capacityMW.toFixed(1)}/${p.actual.capacityMW} MW  energy ${r.energyGwh.toFixed(0)}/${p.actual.energyGwh} GWh`
  );
}

console.log(
  `
flow: ${floodCache.local} from the local GloFAS store, ${floodCache.hits} from disk cache, ${floodCache.misses} fetched, ${floodCache.errors} refused`
);
