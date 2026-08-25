/**
 * Ratio rule versus physics arbiter, on the plants that actually discriminate.
 *
 *   node pipeline/ab-snap-rule.mjs
 *
 * Random fleet seeds keep missing the four plants this question turns on, and
 * every plant costs a rate-limited request. So this runs those four and nothing
 * else. Whichever rule is in src/rivers.ts at the time is what gets measured;
 * run it once per configuration and compare.
 *
 * THE FOUR, and what each one is for:
 *
 *   Upper Tamakoshi  the ratio rule's justification. Snaps to an 8 km2
 *                    tributary beside the 1,754 km2 Tamakoshi. Without a
 *                    promotion it reads 0.8 MW against a built 456.
 *   Upper Syange     the ratio rule's false positive. A 2.4 MW khola scheme on
 *                    15.7 km2, promoted onto the 2,483 km2 Marsyangdi and
 *                    reported at 301 MW. The khola can host it: 0.475 m3/s
 *                    needed, 0.030 m3/s per km2 — ordinary.
 *   Seti Khola       what the ratio rule misses. 25 MW; candidates differ by
 *                    only 8.3x, so no threshold that spares Upper Syange can
 *                    reach it.
 *   Likhu-4          candidates differ by 47x, and the coordinate is known to
 *                    be off the headworks — a promotion here would be wrong for
 *                    a different reason.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { attachFloodCache } from './flood-cache.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const PORT = 5197;
const LABEL = process.argv[2] ?? 'run';

/**
 * Pinned by capacity as well as name: DoED lists TWO operating plants called
 * "Seti Khola HPP" (3.5 MW near Pokhara and 25 MW on the Seti Gandaki), and
 * matching on name alone silently picked the wrong one.
 */
const WANTED = [
  ['Upper Tamakoshi HPP', 456],
  ['Upper Syange Khola SHP', 2.4],
  ['Seti Khola HPP', 25],
  ['Likhu-4', 52.4],
];
const doed = JSON.parse(readFileSync('src/data/doed-projects.json', 'utf8'));
const plants = WANTED.map(([n, mw]) => {
  const p = doed.projects.find(
    (x) => x.name === n && x.lat && Math.abs((x.capacityMW ?? 0) - mw) < 0.6
  );
  if (!p) throw new Error(`not found in doed-projects.json: ${n} at ${mw} MW`);
  return {
    name: p.name,
    river: p.river ?? '',
    intake: [p.lat, p.lon],
    powerhouse: null,
    actual: { capacityMW: p.capacityMW, designQ: null, head: null, headBasis: null, energyGwh: 0 },
  };
});

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
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
const results = await page.evaluate(async (list) => {
  const m = await import('/src/validate.ts');
  return m.validateAll(list, (name, done, total) =>
    console.log(`[validate] ${done + 1}/${total} ${name}`)
  );
}, plants);
await ctx.close();
await server.close();

const out = plants.map((p, i) => ({ ...p, result: results[i] }));
writeFileSync(`pipeline/.cache/ab-${LABEL}.json`, JSON.stringify(out, null, 1));

console.log(`\n${LABEL}\n`);
console.log(`${'plant'.padEnd(24)}${'act'.padStart(7)}${'pred'.padStart(9)}${'ratio'.padStart(8)}${'read km2'.padStart(10)}`);
console.log('-'.repeat(58));
for (const p of out) {
  const r = p.result;
  if (!r?.ok) {
    console.log(`${p.name.slice(0, 23).padEnd(24)}${p.actual.capacityMW.toFixed(1).padStart(7)}   ${r?.error?.slice(0, 30) ?? 'failed'}`);
    continue;
  }
  const ratio = r.predicted.capacityMW / p.actual.capacityMW;
  console.log(
    `${p.name.slice(0, 23).padEnd(24)}${p.actual.capacityMW.toFixed(1).padStart(7)}` +
      `${r.predicted.capacityMW.toFixed(1).padStart(9)}${ratio.toFixed(2).padStart(7)}x` +
      `${(r.reachKm2 ?? 0).toFixed(0).padStart(10)}`
  );
}

console.log(
  `
flow: ${floodCache.local} from the local GloFAS store, ${floodCache.hits} from disk cache, ${floodCache.misses} fetched, ${floodCache.errors} refused`
);
