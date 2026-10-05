/**
 * Which river geometry gets closer to a head somebody actually built?
 *
 *   node checks/head-vs-published.probe.mjs
 *
 * WHY THIS EXISTS. `position-vs-dem-head.probe.mjs` established that moving a
 * vertex onto the OSM-traced channel changes the head by a median 33.7 m across
 * 210 commissioned plants — five times the 6.6 m the DEM probe reports, and on
 * 81% of them. What it could NOT say is which position is right: OSM is a
 * volunteer's trace and the model is a ~500 m derivation, and disagreement is
 * not error.
 *
 * `src/data/validation.json` is the only ground truth this repo has: ten plants
 * with surveyed structure coordinates and a published head. Small, and the only
 * truth there is — this project has settled a question on n=1 before.
 *
 * THREE CANDIDATES, one DEM, held constant so geometry is the only variable:
 *
 *   A  published structures   the DEM read at the real weir and powerhouse.
 *                             This is the FLOOR: perfect position, so whatever
 *                             error remains is the DEM plus the head basis.
 *   B  modelled line          nearest HydroRIVERS vertex to each structure —
 *                             what the engine samples today.
 *   C  OSM-snapped line       the same two vertices at their traced positions —
 *                             what the app already DRAWS.
 *
 * B against C is the question. A is what says whether either could ever be right.
 *
 * FOUR CONFOUNDS, none of which can be averaged away, so all four are carried
 * per row and the headline is computed on the clean subset only:
 *
 *   NET vs GROSS. A DEM samples two ground surfaces, which approximates GROSS
 *   head. Scoring that against a NET figure charges the geometry for the
 *   penstock's friction losses. Three of the ten publish net.
 *
 *   UNDERGROUND POWERHOUSES. Upper Tamakoshi, Middle Marsyangdi and Chilime put
 *   the machine hall inside the mountain; the DEM reads the hillside above it,
 *   so the head comes out too large by however deep the cavern is. The
 *   published coordinate for Upper Tamakoshi is a VILLAGE.
 *
 *   DERIVED COORDINATES. Khimti I's intake was obtained by walking 9.3 km up an
 *   OSM channel, and Mistri Khola's is "approx". Those are inferences, not
 *   surveys, and a wrong structure position corrupts all three candidates alike.
 *
 *   NO PUBLISHED HEAD. Upper Marsyangdi A has none and is reported, not scored.
 *
 * WHAT A RESULT HERE CAN AND CANNOT DO. If C beats B on the clean rows, the
 * engine is sampling the wrong line and `rivers.ts`'s "changed the head for the
 * worse" was scored against the wrong reference. If they are level, the 33.7 m
 * is real scatter between two equally-poor lines and the fix is a better
 * channel than either — not a swap. Either way n is single digits and this
 * decides what to build next, not what to ship.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const PORT = 5202;

const raw = JSON.parse(readFileSync('src/data/validation.json', 'utf8'));
const plants = (raw.plants ?? Object.values(raw).find(Array.isArray)).map((p) => ({
  name: p.name,
  intake: { lat: p.intake[0], lon: p.intake[1] },
  powerhouse: { lat: p.powerhouse[0], lon: p.powerhouse[1] },
  headM: p.actual?.head ?? null,
  basis: p.actual?.headBasis ?? null,
  intakeSource: p.intakeSource ?? '',
  powerhouseSource: p.powerhouseSource ?? '',
}));
console.log(`${plants.length} curated plants, ${plants.filter((p) => p.headM).length} with a published head`);

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();
const ctx = await chromium.launchPersistentContext('pipeline/.cache/probe-profile', {
  channel: 'chrome',
  headless: true,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => console.log('  page error:', e.message));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

const rows = await page.evaluate(async (sites) => {
  const rivers = await import('/src/rivers.ts');
  const api = await import('/src/api.ts');

  const elev = async (p) => {
    if (!p) return null;
    try {
      const g = await api.fetchTerrainWindow(p, 0.05, 30, api.PRIMARY_TERRAIN_SOURCE_ID);
      const mid = ((g.rows - 1) / 2) * g.cols + (g.cols - 1) / 2;
      const v = g.elevations[mid];
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  const R = 6371;
  const hav = (a, b) => {
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  /** The modelled and traced positions of the vertex nearest a real structure. */
  const at = async (p) => {
    // nearestReach returns the CHOICE, not a reach — reading its fields
    // directly is the bug CLAUDE.md records from the dry-share harness.
    const hit = await rivers.nearestReach(p.lat, p.lon);
    if (!hit?.nearest) return null;
    const v = await rivers.vertexPositions(hit.nearest.networkIndex, hit.nearest.networkVertex);
    if (!v) return null;
    return { ...v, snapKm: hit.nearest.distanceKm };
  };

  const out = [];
  for (const s of sites) {
    const rec = { name: s.name };
    try {
      const [ia, pa] = await Promise.all([at(s.intake), at(s.powerhouse)]);
      if (!ia || !pa) {
        rec.why = 'no reach near one of the structures';
        out.push(rec);
        continue;
      }
      rec.tracedIntake = Boolean(ia.snapped);
      rec.tracedPowerhouse = Boolean(pa.snapped);
      rec.lineOffsetIntakeM = Math.round(hav(s.intake, ia.raw) * 1000);
      rec.lineOffsetPowerhouseM = Math.round(hav(s.powerhouse, pa.raw) * 1000);
      rec.osmMovedIntakeM = ia.snapped ? Math.round(hav(ia.raw, ia.snapped) * 1000) : null;
      rec.osmMovedPowerhouseM = pa.snapped ? Math.round(hav(pa.raw, pa.snapped) * 1000) : null;

      const [zPubI, zPubP, zRawI, zRawP, zSnapI, zSnapP] = await Promise.all([
        elev(s.intake),
        elev(s.powerhouse),
        elev(ia.raw),
        elev(pa.raw),
        elev(ia.snapped),
        elev(pa.snapped),
      ]);
      const diff = (a, b) => (a === null || b === null ? null : Number((a - b).toFixed(1)));
      rec.headPublishedStructures = diff(zPubI, zPubP);
      rec.headModelledLine = diff(zRawI, zRawP);
      rec.headSnappedLine = diff(zSnapI, zSnapP);
      out.push(rec);
    } catch (e) {
      rec.why = String(e?.message ?? e);
      out.push(rec);
    }
    console.log(`[probe] ${out.length}/${sites.length} ${rec.name}`);
  }
  return out;
}, plants);

await ctx.close();
await server.close();

const merged = plants.map((p) => ({ ...p, ...rows.find((r) => r.name === p.name) }));
const UNDERGROUND = /underground/i;
for (const m of merged) {
  m.flags = [
    m.basis === 'net' ? 'net head' : null,
    UNDERGROUND.test(m.powerhouseSource) ? 'underground PH' : null,
    /derived|approx/i.test(m.intakeSource + m.powerhouseSource) ? 'derived coords' : null,
    m.headM ? null : 'no published head',
  ].filter(Boolean);
}

const fmt = (v) => (v === null || v === undefined ? '   —' : String(Math.round(v)).padStart(4));
console.log('\n  plant                       published    A pub.struct   B modelled   C snapped   flags');
for (const m of merged) {
  const err = (v) => (v === null || v === undefined || !m.headM ? '     ' : `${(v - m.headM >= 0 ? '+' : '')}${Math.round(v - m.headM)}`.padStart(5));
  console.log(
    `  ${m.name.slice(0, 26).padEnd(26)} ${fmt(m.headM)} ${(m.basis ?? '').padEnd(6)}` +
      ` ${fmt(m.headPublishedStructures)}${err(m.headPublishedStructures)}` +
      ` ${fmt(m.headModelledLine)}${err(m.headModelledLine)}` +
      ` ${fmt(m.headSnappedLine)}${err(m.headSnappedLine)}` +
      `  ${m.flags.join(', ')}`
  );
}

/**
 * The headline is computed on GROSS-head rows with a surface powerhouse and
 * surveyed coordinates. Everything else is printed above and excluded here,
 * because averaging a net head or a cavern into the same number is how a
 * confound becomes a conclusion.
 */
const clean = merged.filter(
  (m) => m.headM && m.basis === 'gross' && !m.flags.includes('underground PH') && !m.flags.includes('derived coords')
);
const score = (key, set) => {
  const e = set.map((m) => m[key]).filter((v) => v !== null && v !== undefined);
  if (!e.length) return null;
  const errs = set
    .filter((m) => m[key] !== null && m[key] !== undefined)
    .map((m) => Math.abs(m[key] - m.headM));
  const sorted = [...errs].sort((a, b) => a - b);
  return {
    n: errs.length,
    median: sorted[Math.floor(sorted.length / 2)],
    mean: errs.reduce((a, b) => a + b, 0) / errs.length,
  };
};
const report = (label, set) => {
  if (!set.length) {
    console.log(`\n${label}: no rows`);
    return;
  }
  console.log(`\n${label} (n=${set.length}: ${set.map((m) => m.name).join(', ')})`);
  for (const [k, name] of [
    ['headPublishedStructures', 'A  published structures'],
    ['headModelledLine', 'B  modelled line (shipped)'],
    ['headSnappedLine', 'C  OSM-snapped line'],
  ]) {
    const s = score(k, set);
    console.log(
      s
        ? `  ${name.padEnd(28)} median |error| ${s.median.toFixed(1)} m   mean ${s.mean.toFixed(1)} m`
        : `  ${name.padEnd(28)} no data`
    );
  }
};
report('CLEAN SUBSET — gross head, surface powerhouse, surveyed coordinates', clean);
report('ALL rows with a published head (confounded, read with the flags)', merged.filter((m) => m.headM));

const b = score('headModelledLine', clean);
const c = score('headSnappedLine', clean);
if (b && c) {
  const better = c.median < b.median ? 'C, the OSM-snapped line' : 'B, the modelled line the engine ships';
  console.log(
    `\n  On the clean subset the closer geometry is ${better} ` +
      `(${Math.min(b.median, c.median).toFixed(1)} m against ${Math.max(b.median, c.median).toFixed(1)} m).`
  );
  console.log(
    `  n=${clean.length}. That is a direction to test, not a result to ship — the next step is the ` +
      'same comparison against more surveyed heads, not a swap.'
  );
}
