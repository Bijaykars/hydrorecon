/**
 * HydroRecon against Nepal's whole operating fleet, not ten hand-picked plants.
 *
 *   node pipeline/build-fleet-validation.mjs [count] [seed]
 *
 * WHY THIS EXISTS. The ten-plant set cannot measure a change. With ten samples
 * a single plant moves the median by eleven points, and that happened
 * repeatedly: a correction that looked like "median 17% to 28%, worse" was two
 * plants shuffling. Improvements were being accepted or rejected on noise.
 *
 * There are 210 commissioned, located plants already bundled in
 * src/data/doed-projects.json — licence records with a coordinate and a
 * capacity. That is twenty times the sample, and it was there all along.
 *
 * WHAT IS DIFFERENT ABOUT THIS TEST. DoED publishes ONE coordinate per project,
 * not an intake and a powerhouse. So the engine is not asked to reproduce a
 * known scheme; it is asked to find its own and judged on the capacity that
 * comes out. That is a harder test and a more honest one — it is exactly what a
 * user standing at that point is shown.
 *
 * IT IS ALSO A NOISIER TEST, and the noise is not symmetric. A licensed
 * capacity is an economic decision: the developer chose a design flow and a
 * head from cost, financing and licence terms. HydroRecon chooses the best scheme
 * it can find. Two different objectives will differ even when the hydrology is
 * perfect, so INDIVIDUAL plants here mean little. What the fleet measures is
 * SYSTEMATIC bias and the shape of the distribution, which is precisely what
 * ten plants cannot show.
 *
 * RATE LIMITS. Every plant costs one Open-Meteo request and a handful of
 * terrain tiles, on free shared services. Open-Meteo starts refusing after a
 * few dozen in quick succession, so this samples rather than sweeping, and the
 * sample is stratified by capacity so it is not all micro-hydro. Re-run with a
 * different seed to extend coverage; results append to the same file.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { attachFloodCache } from './flood-cache.mjs';
import { engineSignature } from './engine-signature.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const OUT = 'src/data/fleet-validation.json';
const PORT = 5198;
const COUNT = Number(process.argv[2] ?? 25);
const SEED = Number(process.argv[3] ?? 1);

/** Deterministic shuffle, so a run can be reproduced and extended. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * A coordinate rounded to whole arcminutes cannot be scored.
 *
 * Almost all of DoED's licence records resolve to arcseconds — about 30 m, fine
 * for placing an intake. Three do not: they sit exactly on a whole arcminute,
 * which is a rounded figure carrying up to 1.24 km of placement error. On a
 * Himalayan khola that is the difference between the river and the ridge.
 *
 * Thoppal Khola is one of the three, and it was the ONLY plant in the first
 * fleet sample that under-predicted (0.5 MW against a licensed 1.65). That is
 * not the engine failing; it is being asked about a point a kilometre from the
 * scheme. Scoring it would put a reference-data error into the app's column.
 */
const wholeArcminute = (v) => Math.abs(v * 60 - Math.round(v * 60)) < 0.02;

/**
 * A STORAGE plant is not a run-of-river plant, and this engine only builds the
 * second kind.
 *
 * Kulekhani I and II are Nepal's only commissioned reservoir schemes. They hold
 * monsoon water behind a dam and release it to peak in the dry season, so their
 * installed capacity is set by the reservoir and the market, not by what the
 * river carries on the day. HydroRecon sizes a scheme from a flow-duration curve
 * with no storage at all, so it MUST under-predict them — 11.7 MW against
 * Kulekhani-I's 60 in this sample.
 *
 * That is the engine being right about a question it was not asked. Counting it
 * as an under-prediction failure puts a modelling boundary into the error
 * column and hides whatever real failures sit beside it, which is precisely
 * what it did: Kulekhani was one of four, and the only one of the four whose
 * flow requirement is physically comfortable (0.08 m3/s per km2, well inside
 * Nepal's range). The other three are mis-snaps; this one never was.
 */
const isStorage = (name) => /storage|reservoir|kule\s*khani/i.test(name);

const doed = JSON.parse(readFileSync('src/data/doed-projects.json', 'utf8'));
const rounded = [];
const storage = [];
const operating = doed.projects.filter((p) => {
  if (!p.commissioned || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
  if ((p.capacityMW ?? 0) < 1) return false;
  if (wholeArcminute(p.lat) && wholeArcminute(p.lon)) {
    rounded.push(p.name);
    return false;
  }
  if (isStorage(p.name)) {
    storage.push(p.name);
    return false;
  }
  return true;
});
if (storage.length) {
  console.log(`excluded ${storage.length} storage scheme(s), which run-of-river cannot model: ${storage.join(', ')}`);
}
if (rounded.length) {
  console.log(`excluded ${rounded.length} with arcminute-rounded coordinates: ${rounded.join(', ')}`);
}
console.log(`${operating.length} commissioned, located plants of at least 1 MW`);

/**
 * Stratify by capacity. A uniform sample of Nepali licences is nearly all
 * small run-of-river, and a fleet score dominated by 2 MW schemes would say
 * nothing about the 100 MW ones.
 */
const bands = [
  [1, 5],
  [5, 20],
  [20, 60],
  [60, 1e9],
];
const r = rng(SEED);
const picked = [];
const perBand = Math.ceil(COUNT / bands.length);
for (const [lo, hi] of bands) {
  const inBand = operating
    .filter((p) => p.capacityMW >= lo && p.capacityMW < hi)
    .map((p) => ({ p, k: r() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.p);
  picked.push(...inBand.slice(0, perBand));
}
const plants = picked.slice(0, COUNT).map((p) => ({
  name: p.name,
  river: p.river ?? '',
  intake: [p.lat, p.lon],
  powerhouse: null, // let the engine find its own scheme
  actual: {
    capacityMW: p.capacityMW,
    designQ: null,
    head: null,
    headBasis: null,
    energyGwh: 0,
  },
}));
console.log(`sampled ${plants.length} across capacity bands (seed ${SEED})`);

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

/**
 * STAMP EVERY ROW WITH THE ENGINE THAT PRODUCED IT.
 *
 * This file accumulates across runs because the discharge service is rate
 * limited and a sample of a hundred plants can only be built a few at a time.
 * That is necessary and it is also a trap: rows written weeks apart were
 * produced by different code, and a summary over the mixture measures nothing
 * in particular. It bit immediately — bounding the scheme search to the app's
 * own 22 km left a "median waterway" of 29.4 km with a maximum of 42.2, because
 * most rows were carried over unchanged from the 40 km run and nothing said so.
 *
 * The signature covers the modules that decide a result, with comments and
 * whitespace stripped so that documenting a finding does not throw away a
 * sample that took days of rate-limited fetching to collect.
 */
// One signature, shared with build-validation.mjs so the two harnesses can
// never disagree about which engine produced a row. See engine-signature.mjs.
const ENGINE = engineSignature();

const merged = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { plants: [] };
const byName = new Map(merged.plants.map((x) => [x.name, x]));
for (let i = 0; i < plants.length; i++) {
  byName.set(plants[i].name, { ...plants[i], engine: ENGINE, result: results[i] });
}
/**
 * RE-APPLY THE EXCLUSIONS TO EVERYTHING, not just to what was sampled today.
 *
 * This file accumulates across runs, so a plant admitted before an exclusion
 * existed stays admitted forever: the filters above run when candidates are
 * drawn, and a row already in the file is never drawn again. Kulekhani-I was
 * excluded as a storage scheme and went on being scored for it, which is the
 * worst kind of fix — one whose report says it worked.
 *
 * Cheap to re-test, so it is re-tested on every run.
 */
const all = [...byName.values()].filter((x) => {
  if (isStorage(x.name)) return false;
  if (wholeArcminute(x.intake?.[0] ?? 0) && wholeArcminute(x.intake?.[1] ?? 0)) return false;
  return true;
});

const stale = all.filter((x) => x.engine !== ENGINE && x.result?.ok);
const ok = all.filter(
  (x) => x.engine === ENGINE && x.result?.ok && x.result.predicted?.capacityMW > 0
);
const ratios = ok
  .map((x) => x.result.predicted.capacityMW / x.actual.capacityMW)
  .sort((a, b) => a - b);
const pct = (q) => ratios[Math.min(ratios.length - 1, Math.floor(q * ratios.length))] ?? NaN;

/**
 * The shortest waterway at which the engine reaches the capacity that was
 * actually licensed. The headline ratio compares against the BIGGEST scheme in
 * the search window, which always sits at the window's edge; this asks instead
 * whether the built plant lies on the engine's own curve at a buildable length.
 * It is not fitted to anything — the curve is computed without reference to the
 * licence, and the licence only picks a point on it.
 */
const implied = ok
  .map((x) => {
    const c = x.result.predicted?.curve ?? x.result.curve ?? [];
    const hit = [...c].sort((a, b) => a.km - b.km).find((p) => p.capacityMW >= x.actual.capacityMW);
    return hit ? hit.km : null;
  })
  .filter((v) => v != null)
  .sort((a, b) => a - b);

/**
 * WHAT THIS FLEET CAN AND CANNOT MEASURE.
 *
 * The median ratio looks like an accuracy score and is not one. HydroRecon returns
 * the BEST scheme reachable from a coordinate, with no cost constraint at all;
 * a developer built the scheme their financing allowed. HydroRecon should therefore
 * come out larger, and it does — the 10th percentile is above 1.0, so nine
 * plants in ten over-predict. That is a one-directional offset between two
 * different objectives, not error, and quoting it as error would be dishonest.
 *
 * What the fleet measures WELL is failure, in ways no economic argument
 * explains away:
 *
 *   UNDER-PREDICTION. Saying 2 MW where a 40 MW plant demonstrably operates is
 *   wrong however the developer chose their design. This is the Upper Tamakoshi
 *   class of bug — the one that read 0.8 MW against a built 456.
 *
 *   IMPOSSIBLE HYDROLOGY. Q40 cannot exceed a river's own mean flow on a
 *   monsoon regime, and Nepal does not produce specific discharges outside
 *   0.005-0.25 m3/s per km2. Both of these caught real bugs already.
 *
 *   COVERAGE. No scheme at all, somewhere a plant demonstrably exists.
 */
const impossibleQ = ok.filter((x) => {
  const m = x.result.predicted.meanFlowCms ?? 0;
  return m > 0 && x.result.predicted.designFlowCms / m > 1;
});
const impossibleSpecific = ok.filter((x) => {
  const k = x.result.reachKm2 ?? 0;
  const m = x.result.predicted.meanFlowCms ?? 0;
  if (!(k > 0 && m > 0)) return false;
  const s = m / k;
  return s < 0.005 || s > 0.25;
});
/**
 * A coordinate that CANNOT be where its plant is.
 *
 * DoED publishes one point per licence, and it is not always the headworks.
 * Likhu-4's sits on a 14 km2 tributary while the plant it names is 52 MW — that
 * needs about 6 m3/s at the head the engine found, which is 0.43 m3/s per km2,
 * nearly double anything Nepal produces. MERIT read at 93 m agrees the point is
 * on a 14 km2 channel, and finds the 665 km2 river 1.4 km away. So the snap is
 * right and the coordinate is simply somewhere else.
 *
 * Scoring that as under-prediction blames the engine for a licence record. The
 * test is deliberately conservative — it uses the head the ENGINE ITSELF found,
 * so it only fires when the catchment could not produce the licensed capacity
 * even on the engine's own terms. Upper Tamakoshi lands at 0.24 and stays in,
 * which is right: its shortfall is a real partial mis-snap worth seeing.
 */
const SPECIFIC_MAX = 0.25; // m3/s per km2, Nepal's ceiling
const impossibleCoordinate = ok.filter((x) => {
  const k = x.result.reachKm2 ?? 0;
  const h = x.result.predicted.netHeadM ?? x.result.predicted.grossHeadM ?? 0;
  if (!(k > 0 && h > 0)) return false;
  // Flow the licensed capacity would need, at the head the engine found.
  const needCms = (x.actual.capacityMW * 1e6) / (1000 * 9.81 * h * 0.85);
  return needCms / k > SPECIFIC_MAX;
});
const scorable = ok.filter((x) => !impossibleCoordinate.includes(x));
const scorableRatios = scorable
  .map((x) => x.result.predicted.capacityMW / x.actual.capacityMW)
  .sort((a, b) => a - b);
const under = scorableRatios.filter((x) => x < 0.5);
const failed = all.filter((x) => !x.result?.ok);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      _what:
        'HydroRecon run at commissioned DoED-licensed plants from one coordinate each, letting the ' +
        'engine choose its own scheme. Capacity only — DoED publishes no head or design flow.',
      _caveat:
        'A licensed capacity is an economic choice, not a property of the river. Individual ' +
        'rows are weak evidence; the distribution is the measurement.',
      _generated: new Date().toISOString().slice(0, 10),
      _headline:
        'The ratio below is NOT an accuracy score. HydroRecon is asked for the largest scheme in ' +
        'its search window and the largest always sits at the window edge, so the ratio partly ' +
        'measures the window. The measurement is impliedWaterwayKm: the shortest waterway at ' +
        'which the engine reaches the capacity that was actually built. Nepali run-of-river ' +
        'headraces run about 1-10 km; a median inside that range means the built plant lies on ' +
        "the engine's own curve at a buildable length.",
      _summary: {
        impliedWaterwayMedianKm: implied.length ? implied[Math.floor(implied.length / 2)] : null,
        impliedWaterwayReached: implied.length,
        ran: all.length,
        scored: ok.length,
        /** The real tests. All one-sided; any non-zero is a bug to chase. */
        underPredictedBy2x: under.length,
        scorable: scorable.length,
        coordinateCannotHostPlant: impossibleCoordinate.length,
        impossibleQ40AboveMean: impossibleQ.length,
        impossibleSpecificDischarge: impossibleSpecific.length,
        didNotRun: failed.length,
        /** Descriptive only — expected above 1, NOT an error rate. */
        ratioP10: pct(0.1),
        ratioMedian: pct(0.5),
        ratioP90: pct(0.9),
      },
      plants: all,
    },
    null,
    1
  )
);

console.log(`
wrote ${OUT}: ${ok.length} scored of ${all.length} run (engine ${ENGINE})${
    stale.length ? `, ${stale.length} row(s) from an older engine excluded — re-run to refresh` : ''
  }
`);
console.log('  FAILURE TESTS (one-sided — any non-zero is a bug to chase)');
console.log(`    under-predicts by >2x            ${under.length}/${scorable.length}`);
console.log(`    Q40 above the river's own mean   ${impossibleQ.length}/${ok.length}`);
console.log(`    specific discharge out of range  ${impossibleSpecific.length}/${ok.length}`);
console.log(`    produced no scheme at all        ${failed.length}/${all.length}`);
console.log(
  `    coordinate cannot host its plant ${impossibleCoordinate.length}/${ok.length} (excluded from scoring)` +
    (impossibleCoordinate.length
      ? `
      ${impossibleCoordinate.map((x) => x.name).join(', ')}`
      : '')
);
console.log('\n  DISTRIBUTION (expected above 1x — HydroRecon returns the best scheme, not the funded one)');
console.log(`    p10 ${pct(0.1).toFixed(2)}x   median ${pct(0.5).toFixed(2)}x   p90 ${pct(0.9).toFixed(2)}x
  FLOW-CHOICE REACH — how many rows an arbitration change can even touch
    ${ok.filter((x) => x.result.usedMeasured).length}/${ok.length} ran on a transferred DHM gauge record, where the flow
    choice is bypassed by design: a measurement beats both models, so there is
    nothing to arbitrate. Exclude them before reading any flow-choice A/B.

  IMPLIED WATERWAY — the measurement the ratio above cannot make
    median ${implied.length ? implied[Math.floor(implied.length / 2)].toFixed(1) : '—'} km   range ${
      implied.length ? `${implied[0].toFixed(1)}-${implied[implied.length - 1].toFixed(1)}` : '—'
    } km   reached for ${implied.length}/${ok.length}
    Nepali run-of-river headraces run about 1-10 km, so a figure in that range
    means the engine agrees with the developer and the ratio above is measuring
    the search window rather than an error.`);
if (failed.length) {
  const why = new Map();
  for (const f of failed) {
    const e = (f.result?.error ?? 'unknown').slice(0, 60);
    why.set(e, (why.get(e) ?? 0) + 1);
  }
  console.log('\n  did not run:');
  for (const [e, n] of [...why.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${e}`);
  }
}

console.log(
  `
flow: ${floodCache.local} from the local GloFAS store, ${floodCache.hits} from disk cache, ${floodCache.misses} fetched, ${floodCache.errors} refused`
);
