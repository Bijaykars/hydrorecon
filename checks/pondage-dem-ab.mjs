/**
 * Two terrain products against the same 207 measured shorelines.
 *
 *   node checks/pondage-dem-ab.mjs
 *   node checks/pondage-dem-ab.mjs src/data/pondage-validation.gsw.json \
 *                                  src/data/pondage-validation.gsw.gedtm30-bare-earth.json
 *
 * WHY THIS EXISTS. The GEDTM30-over-Mapterhorn swap for pondage was decided on
 * Kulekhani — one reservoir, three measures, two of them better. CLAUDE.md said
 * plainly that n=1 could not close it. The GSW reference set is the population
 * that can, and this is the file that reads the two runs against each other.
 *
 * WHY IT PAIRS. Each product fails on its own subset: a lake Mapterhorn cannot
 * resolve as a plateau is not necessarily one GEDTM30 cannot, and a summary
 * comparing 183 rows against 171 different rows is comparing two populations,
 * not two DEMs. That is harness rule 2 — "a one-sided failure test still lies if
 * the denominator can move" — and this project has walked into it twice. So
 * every headline below is computed on the INTERSECTION, and the rows only one
 * arm could score are counted separately, because "no effect" and "not
 * applicable" must never look alike.
 *
 * WHAT IT SCORES. Predicted surface area against the satellite band, and the
 * saddle-escape rate: how often the answer moves more than 3x across the three
 * metres above the waterbody's own plateau. The second is the one that matters.
 * Kulekhani exposed it at 20x and the population put it at 26% of sites, so a
 * terrain product that lowers it is worth more here than one that shaves the
 * median.
 */
import { readFileSync } from 'node:fs';

const [aPath = 'src/data/pondage-validation.gsw.json',
       bPath = 'src/data/pondage-validation.gsw.gedtm30-bare-earth.json'] = process.argv.slice(2);

const load = (p) => {
  const d = JSON.parse(readFileSync(p, 'utf8'));
  return { label: d._terrainSource ?? p, rows: new Map(d.reservoirs.map((r) => [r.name, r])) };
};
const A = load(aPath);
const B = load(bPath);

const scored = (r) => Boolean(r && r.ok && r.reference?.areaBandKm2);
/** Distance outside the band, in multiples of its upper edge. Zero inside. */
const missBy = (r) => {
  const [lo, hi] = r.reference.areaBandKm2;
  const a = r.predicted.areaKm2;
  if (a < lo) return (lo - a) / hi;
  if (a > hi) return (a - hi) / hi;
  return 0;
};
const unstable = (r) => {
  const above = (r.areaAroundLevel ?? []).filter(
    (x) => x.areaKm2 > 0 && x.levelM >= (r.rasterWaterLevelM ?? -Infinity) - 0.25
  );
  const areas = above.map((x) => x.areaKm2);
  return areas.length > 1 && Math.max(...areas) / Math.min(...areas) > 3;
};

const names = [...new Set([...A.rows.keys(), ...B.rows.keys()])];
const both = names.filter((n) => scored(A.rows.get(n)) && scored(B.rows.get(n)));
const onlyA = names.filter((n) => scored(A.rows.get(n)) && !scored(B.rows.get(n)));
const onlyB = names.filter((n) => !scored(A.rows.get(n)) && scored(B.rows.get(n)));
const neither = names.filter((n) => !scored(A.rows.get(n)) && !scored(B.rows.get(n)));

console.log(`A = ${A.label}\nB = ${B.label}\n`);
console.log(
  `${names.length} waterbodies: ${both.length} scored by both, ` +
    `${onlyA.length} only by A, ${onlyB.length} only by B, ${neither.length} by neither.\n` +
    'Every number below is on the paired set only.\n'
);

const report = (label, rows, pick) => {
  if (!rows.length) return;
  const rs = rows.map(pick);
  const ratios = rs
    .map((r) => r.predicted.areaKm2 / r.reference.areaBandKm2[1])
    .sort((a, b) => a - b);
  const q = (p) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
  const inBand = rs.filter((r) => missBy(r) === 0).length;
  const uns = rs.filter(unstable).length;
  const edge = rs.filter((r) => r.predicted.edgeLimited).length;
  console.log(
    `  ${label.padEnd(28)} in band ${String(inBand).padStart(3)}/${rs.length} ` +
      `(${String(Math.round((100 * inBand) / rs.length)).padStart(2)}%)   ` +
      `median ${q(0.5).toFixed(2)}x   p10 ${q(0.1).toFixed(2)}x   p90 ${q(0.9).toFixed(2)}x   ` +
      `moves >3x ${String(uns).padStart(3)} (${String(Math.round((100 * uns) / rs.length)).padStart(2)}%)` +
      (edge ? `   [${edge} edge-limited]` : '')
  );
};

const glacial = (n) => Boolean(A.rows.get(n).reference.glacialLake);
for (const [tag, subset] of [
  ['all paired', both],
  ['glacial only', both.filter(glacial)],
  ['not glacial', both.filter((n) => !glacial(n))],
]) {
  if (!subset.length) continue;
  console.log(tag);
  report('A ' + A.label, subset, (n) => A.rows.get(n));
  report('B ' + B.label, subset, (n) => B.rows.get(n));
  console.log('');
}

/**
 * Site by site, which arm is closer to the measured band.
 *
 * The medians above can move because one arm shifts a handful of sites a long
 * way; this counts how many sites each arm actually wins, which is the question
 * "should the primary change" is really asking.
 */
let aCloser = 0, bCloser = 0, tied = 0;
let aOnlyStable = 0, bOnlyStable = 0;
for (const n of both) {
  const a = A.rows.get(n), b = B.rows.get(n);
  const da = missBy(a), db = missBy(b);
  if (Math.abs(da - db) < 1e-9) tied++;
  else if (da < db) aCloser++;
  else bCloser++;
  const ua = unstable(a), ub = unstable(b);
  if (ua && !ub) bOnlyStable++;
  if (ub && !ua) aOnlyStable++;
}
console.log('paired, site by site');
console.log(`  closer to the band:  A ${aCloser}   B ${bCloser}   tied ${tied}`);
console.log(
  `  saddle escape:       B fixes ${bOnlyStable} that A loses, ` +
    `A fixes ${aOnlyStable} that B loses`
);

if (onlyA.length || onlyB.length) {
  console.log(
    `\nUnpaired rows are NOT evidence either way, and are listed so they cannot be\n` +
      `mistaken for one: ${onlyA.length} only A, ${onlyB.length} only B. A product that\n` +
      `scores more sites has answered more questions, not answered them better.`
  );
}
