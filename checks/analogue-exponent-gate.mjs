/**
 * Do the two implicit constants in `analogueFlow` hold up against the gauges?
 *
 *   node --experimental-strip-types --no-warnings checks/analogue-exponent-gate.mjs
 *
 * THE QUESTION. `src/engine/flow-analogue.ts` transfers measured mean flow from
 * the five most similar gauged catchments with precipitation-weighted
 * catchment-area ratio (PCAR). Two constants in that line were never measured:
 * the exponent on the area ratio (silently 1.0; USGS work reports 0.47-0.7 and
 * seasonal values 0.85-1.02) and an applicability window on donor:target area
 * (absent; USGS SIR 2008-5126 says 0.5-1.5, SIR 2016-5149 found 0.33-3 as good).
 * There is no published error bound for PCAR itself, so this measures one.
 *
 * MEASUREMENT ONLY. This file reports; it does not change `AREA_RATIO_EXPONENT`
 * or `AREA_RATIO_WINDOW`. Adopting a value is an engine change and the owner's
 * call -- see the closing lines for what it would re-stale.
 *
 * HOW IT IS SCORED.
 *   - The population is the app's own donor set: DHM gauges with 10+ complete
 *     years that snap to a HydroRIVERS reach, with the same features and the
 *     same 0.005-0.25 m3/s/km2 specific-runoff sanity bound that
 *     `analogue-flow.probe.mjs` used to build `flow-analogues.json`. (That bound
 *     reads the measured flow, so it is a selection on the outcome; it is kept
 *     so the target set equals the shipped donor set, and the unfiltered
 *     population is scored once as a sensitivity.)
 *   - Leave-one-out BY STATION ID, and then audited -- see "LEAKAGE" below.
 *     `analogueFlow` has no self-exclusion of its own.
 *   - Gates are scored PAIRED, on the sites every arm can answer (harness rule
 *     2), with each gate's own n and dropped count printed beside it. A gate
 *     that wins by discarding the hard sites has improved nothing.
 *   - "Project-weighted" re-weights the three catchment-size bands by where
 *     commissioned intakes actually sit (fleet-validation.json), because the
 *     gauges' median catchment is ~1,957 km2 and the intakes' is ~163 km2.
 */
import { readFileSync } from 'node:fs';

globalThis.fetch = async (url) => {
  try { return new Response(readFileSync(`public/${String(url).replace(/^undefined/, '').replace(/^\//, '')}`)); }
  catch { return new Response(null, { status: 404 }); }
};

const { nearestReach, hasReachData, SNAP_KM } = await import('../src/rivers.ts');
const { analogueFlow, AREA_RATIO_EXPONENT, AREA_RATIO_WINDOW } = await import('../src/engine/flow-analogue.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

const MIN_YEARS = 10;
const BANDS = ['<100 km2', '100-500 km2', '>=500 km2'];
const bandOf = (km2) => (km2 < 100 ? 0 : km2 < 500 ? 1 : 2);

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '  - ');

// ---- population -----------------------------------------------------------
const all = [];
let setAside = 0;
for (const s of records.stations) {
  if (s.lat == null || !(s.completeYears >= MIN_YEARS) || !(s.meanCms > 0) || !hasReachData(s.lat, s.lon)) { setAside++; continue; }
  const r = (await nearestReach(s.lat, s.lon).catch(() => null))?.nearest;
  if (!r || r.distanceKm > SNAP_KM || !(r.uplandKm2 > 0) || !(r.annualPrecipMm > 0) || !Number.isFinite(r.averageAltitudeM)) { setAside++; continue; }
  all.push({
    id: s.id, river: s.river, lat: s.lat, lon: s.lon, years: s.completeYears, from: s.from, to: s.to,
    area: r.uplandKm2, rain: r.annualPrecipMm, elevation: r.averageAltitudeM, low: r.below3000Frac, high: 1 - r.below5000Frac,
    truth: s.meanCms, spec: s.meanCms / r.uplandKm2,
  });
}
const sites = all.filter((x) => x.spec >= 0.005 && x.spec <= 0.25);

// Fleet weights for the band mix where projects sit.
const fleet = JSON.parse(readFileSync('src/data/fleet-validation.json', 'utf8'));
const fleetCount = [0, 0, 0];
for (const pl of fleet.plants) {
  const res = pl.result;
  if (!res?.ok || !res.snappedIntake) continue;
  const [la, lo] = res.snappedIntake;
  if (!hasReachData(la, lo)) continue;
  const r = (await nearestReach(la, lo).catch(() => null))?.nearest;
  if (r && r.uplandKm2 > 0) fleetCount[bandOf(r.uplandKm2)]++;
}
const fleetN = fleetCount.reduce((a, b) => a + b, 0);
const W = fleetCount.map((c) => c / fleetN);

// ---- scoring ----------------------------------------------------------------
const kmApart = (a, b) => 111.32 * Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat + b.lat) * Math.PI / 360));
/**
 * The same physical gauge filed under a second id (DHM 220 and 225, Tila Nala, are one point and one area).
 * Excluding by id alone leaves the twin in as a donor at distance zero carrying the target's own measurement.
 */
const twin = (a, b) => kmApart(a, b) < 1 && Math.abs(Math.log(a.area / b.area)) < 0.01;
/**
 * Leave-one-out: the target AND any twin record of it are withheld. Returns one row per site:
 * ln(prediction / measured), or null if it cannot answer. `idOnly` reproduces the naive id-only version.
 */
function loo(pop, opts, idOnly = false) {
  return pop.map((target) => {
    const res = analogueFlow(target, pop.filter((d) => d.id !== target.id && (idOnly || !twin(target, d))), opts);
    return { id: target.id, band: bandOf(target.area), e: res ? Math.log(res.meanCms / target.truth) : null };
  });
}
function summary(rows) {
  const es = rows.map((x) => x.e);
  const abs = es.map(Math.abs);
  const perBand = [0, 1, 2].map((b) => rows.filter((x) => x.band === b).map((x) => x.e));
  const bandAbs = perBand.map((b) => mean(b.map(Math.abs)));
  return {
    n: rows.length,
    typ: Math.exp(q(abs, 0.5)),
    meanAbs: Math.exp(mean(abs)),
    bias: Math.exp(mean(es)),
    within2: abs.filter((v) => v < Math.log(2)).length / rows.length,
    // project-weighted: only bands that have rows contribute; weights renormalised over those.
    weighted: Math.exp(bandAbs.reduce((t, v, b) => (Number.isFinite(v) ? t + W[b] * v : t), 0) /
      W.reduce((t, w, b) => (Number.isFinite(bandAbs[b]) ? t + w : t), 0)),
    perBand: perBand.map((b) => ({ n: b.length, typ: Math.exp(q(b.map(Math.abs), 0.5)), bias: Math.exp(mean(b)) })),
  };
}
const line = (label, s, extra = '') =>
  `  ${label.padEnd(20)} n=${String(s.n).padStart(3)}  typ.err ${f(s.typ)}x  mean|err| ${f(s.meanAbs)}x  bias ${f(s.bias)}x  ` +
  `within 2x ${(s.within2 * 100).toFixed(0).padStart(3)}%  project-weighted ${f(s.weighted)}x${extra}`;

// ---- header -------------------------------------------------------------------
console.log(`\n${'='.repeat(78)}`);
console.log('ANALOGUE FLOW (PCAR) -- exponent and area-ratio window, leave-one-out, DHM gauges');
console.log('='.repeat(78));
console.log(`${all.length} snapped gauges with ${MIN_YEARS}+ years (${setAside} set aside); ${sites.length} inside the shipped donor set's specific-runoff bound.`);
console.log(`shipped constants: exponent ${AREA_RATIO_EXPONENT}, window ${AREA_RATIO_WINDOW.min}..${AREA_RATIO_WINDOW.max}`);
console.log(`band mix  gauges: ${[0, 1, 2].map((b) => `${BANDS[b]} ${sites.filter((x) => bandOf(x.area) === b).length}`).join(', ')}`);
console.log(`          plants: ${[0, 1, 2].map((b) => `${BANDS[b]} ${fleetCount[b]}`).join(', ')}  -> project weights ${W.map((w) => w.toFixed(2)).join(' / ')} (n=${fleetN})`);
console.log(`median catchment: gauges ${q(sites.map((x) => x.area), 0.5).toFixed(0)} km2`);

// ---- LEAKAGE ------------------------------------------------------------------
console.log('\nLEAKAGE AUDIT');
const ids = new Set(sites.map((x) => x.id));
console.log(`  unique station ids: ${ids.size}/${sites.length}${ids.size === sites.length ? '' : '   *** DUPLICATE IDS: id-exclusion cannot protect a duplicate ***'}`);
const selfInclusive = sites.map((t) => analogueFlow(t, sites)).map((r, i) => r?.donors.some((d) => d.station.id === sites[i].id));
console.log(`  analogueFlow(target, ALL sites) lets the target donate to itself on ${selfInclusive.filter(Boolean).length}/${sites.length} sites` +
  ' -- the function has no self-exclusion; leave-one-out is the CALLER\'s job.');
let leaked = 0;
let dupSites = 0;
for (const t of sites) {
  const res = analogueFlow(t, sites.filter((d) => d.id !== t.id));
  if (res?.donors.some((d) => d.station.id === t.id)) leaked++;
  // The same physical gauge filed under a second id would be a donor that IS the target.
  if (sites.some((d) => d.id !== t.id && twin(t, d))) dupSites++;
}
console.log(`  leave-one-out (by id) donor sets containing the target itself: ${leaked}/${sites.length}`);
console.log(`  stations with a second record within 1 km and 1% area (same gauge, another id): ${dupSites}/${sites.length}`);
const zeroDist = sites.filter((t) => analogueFlow(t, sites.filter((d) => d.id !== t.id))?.donors.some((d) => d.distance < 1e-9)).length;
console.log(`  LOO sites with a donor at distance ~0 (a twin): ${zeroDist}`);
const twins = [];
for (const t of sites) for (const d of sites) if (t.id < d.id && kmApart(t, d) < 5) twins.push(`${t.id}/${d.id} ${t.river ?? ''} ${kmApart(t, d).toFixed(1)}km ${t.area.toFixed(0)}/${d.area.toFixed(0)}km2`);
console.log(`  gauge pairs within 5 km of each other (same river, nested catchments): ${twins.length}${twins.length ? '\n    ' + twins.slice(0, 8).join('\n    ') : ''}`);
console.log('  Nested pairs are NOT a leak (different gauges, different truth) but they make a donor');
console.log('  unusually close to the target, which flatters leave-one-out against a truly ungauged site.');
if (dupSites) {
  console.log(`  *** LEAK BY TWIN: id-only leave-one-out lets ${dupSites} sites donate their own measurement to each other at distance 0. ***`);
  console.log('  *** Every table below withholds twins as well as the target. Effect of the twin leak at b = 1.0, window unbounded: ***');
  const naive = summary(loo(sites, {}, true)), strict = summary(loo(sites, {}));
  console.log(line('id-only LOO', naive));
  console.log(line('twin-excluded LOO', strict));
}
if (leaked || ids.size !== sites.length) console.log('  *** LEAK FOUND -- every number below is invalid ***');

// ---- exponent sweep -------------------------------------------------------------
const exps = [];
for (let b = 0.5; b < 1.1001; b += 0.05) exps.push(+b.toFixed(2));
console.log(`\nEXPONENT SWEEP (window unbounded, every site answers)`);
const sweep = exps.map((b) => ({ b, rows: loo(sites, { areaExponent: b }) }));
for (const { b, rows } of sweep) {
  const dropped = rows.filter((x) => x.e == null).length;
  const s = summary(rows.filter((x) => x.e != null));
  console.log(line(`b = ${b.toFixed(2)}${b === AREA_RATIO_EXPONENT ? ' (shipped)' : ''}`, s, dropped ? `  dropped ${dropped}` : ''));
}
console.log('\n  by catchment size (typ.err / bias), same sweep:');
console.log(`  ${'b'.padEnd(6)}${BANDS.map((b, i) => `${b} n=${sweep[0].rows.filter((x) => x.band === i).length}`.padEnd(30)).join('')}`);
for (const { b, rows } of sweep) {
  const s = summary(rows);
  console.log(`  ${b.toFixed(2).padEnd(6)}${s.perBand.map((p) => `${f(p.typ)}x / ${f(p.bias)}x`.padEnd(30)).join('')}`);
}

// Paired bootstrap on the best mean|ln err| against shipped b=1.0 (deterministic).
const base = sweep.find((x) => x.b === 1).rows;
const bestArm = sweep.reduce((a, c) => (mean(c.rows.map((x) => Math.abs(x.e))) < mean(a.rows.map((x) => Math.abs(x.e))) ? c : a));
{
  const d = base.map((x, i) => Math.abs(x.e) - Math.abs(bestArm.rows[i].e));
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const boots = [];
  for (let k = 0; k < 4000; k++) boots.push(mean(d.map(() => d[Math.floor(rnd() * d.length)])));
  const closer = d.filter((v) => v > 1e-12).length, further = d.filter((v) => v < -1e-12).length;
  console.log(`\n  best by mean|err|: b = ${bestArm.b.toFixed(2)}. Paired against b = 1.00 on ${d.length} identical sites: closer on ${closer}, further on ${further}.`);
  console.log(`  mean|ln err| gain ${f(mean(d), 4)} (factor ${f(Math.exp(mean(d)), 3)}x), 95% paired bootstrap [${f(q(boots, 0.025), 4)}, ${f(q(boots, 0.975), 4)}]` +
    `${q(boots, 0.025) <= 0 ? '  -- interval includes zero: not distinguishable from 1.0' : ''}`);
}

// ---- gate sweep -------------------------------------------------------------------
const GATES = [
  { name: 'unbounded (today)', w: { min: 0, max: Infinity } },
  { name: '0.33 - 3', w: { min: 1 / 3, max: 3 } },
  { name: '0.5 - 1.5', w: { min: 0.5, max: 1.5 } },
];
console.log('\nGATE SWEEP (exponent 1.0, as shipped)');
const gated = GATES.map((g) => ({ ...g, rows: loo(sites, { areaRatioWindow: g.w }) }));
console.log('  each gate on every site it can answer (n differs -- NOT comparable across rows):');
for (const g of gated) {
  const ok = g.rows.filter((x) => x.e != null);
  console.log(line(g.name, summary(ok), `  dropped ${g.rows.length - ok.length}`));
}
const common = sites.map((_, i) => gated.every((g) => g.rows[i].e != null));
const nCommon = common.filter(Boolean).length;
console.log(`\n  PAIRED on the ${nCommon} sites all three gates can answer (${sites.length - nCommon} dropped by at least one):`);
for (const g of gated) console.log(line(g.name, summary(g.rows.filter((_, i) => common[i]))));
console.log(`  *** the common set holds ${[0, 1, 2].map((b) => `${sites.filter((x, i) => common[i] && bandOf(x.area) === b).length}`).join(' / ')} sites per band (<100 / 100-500 / >=500 km2). A band with no sites drops out of the`);
console.log('  *** project-weighted column and its weight is renormalised onto the big catchments, so that column is no longer');
console.log('  *** project-weighted at all: 1.33x here against 1.58x on all 69 is the small band LEAVING, not the engine improving. ***');
const dropRows = sites.filter((_, i) => !common[i]);
const kept = sites.filter((_, i) => common[i]);
console.log(`  the dropped sites are the hard ones? measured against unbounded: median |err| on dropped ${f(Math.exp(q(gated[0].rows.filter((_, i) => !common[i]).map((x) => Math.abs(x.e)), 0.5)))}x` +
  ` vs kept ${f(Math.exp(q(gated[0].rows.filter((_, i) => common[i]).map((x) => Math.abs(x.e)), 0.5)))}x; median catchment dropped ${dropRows.length ? q(dropRows.map((x) => x.area), 0.5).toFixed(0) : '-'} km2 vs kept ${q(kept.map((x) => x.area), 0.5).toFixed(0)} km2.`);
console.log(`  dropped by band: ${[0, 1, 2].map((b) => `${BANDS[b]} ${dropRows.filter((x) => bandOf(x.area) === b).length}/${sites.filter((x) => bandOf(x.area) === b).length}`).join(', ')}`);

console.log('\n  how many donors a gate leaves per site (of 68 candidates), median / min:');
for (const g of GATES) {
  const counts = sites.map((t) => sites.filter((d) => d.id !== t.id && d.area / t.area >= g.w.min && d.area / t.area <= g.w.max).length);
  console.log(`    ${g.name.padEnd(20)} ${q(counts, 0.5)} / ${Math.min(...counts)}`);
}

// ---- exponent x gate on common sites --------------------------------------------------
console.log(`\nEXPONENT x GATE, paired on the ${nCommon} common sites (typ.err / bias / mean|err|)`);
console.log(`  ${'b'.padEnd(6)}${GATES.map((g) => g.name.padEnd(34)).join('')}`);
for (const b of [0.6, 0.7, 0.8, 0.9, 1.0]) {
  const cells = GATES.map((g) => {
    const s = summary(loo(sites, { areaExponent: b, areaRatioWindow: g.w }).filter((_, i) => common[i]).filter((x) => x.e != null));
    return `${f(s.typ)}x / ${f(s.bias)}x / ${f(s.meanAbs)}x`.padEnd(34);
  });
  console.log(`  ${b.toFixed(2).padEnd(6)}${cells.join('')}`);
}

// ---- sensitivity: unfiltered population ------------------------------------------------
console.log(`\nSENSITIVITY: the specific-runoff bound removed (${all.length} sites instead of ${sites.length}; the shipped donor set is the bounded one)`);
for (const b of [0.7, 0.85, 1.0]) console.log(line(`b = ${b.toFixed(2)}`, summary(loo(all, { areaExponent: b }).filter((x) => x.e != null))));

console.log('\nREAD THIS BEFORE QUOTING ANYTHING ABOVE');
console.log('  - n is a few dozen gauges. Differences of a few percent between rows are inside the noise;');
console.log('    the paired bootstrap line is the only place a difference is tested.');
console.log('  - These are gauges, not intakes. The project-weighted column re-weights three bands, but the');
console.log('    smallest band has few gauges to carry its weight -- see its n.');
console.log('  - Leave-one-out here is against the other gauges, not a held-out region; neighbouring gauges on one');
console.log('    river are donors to each other. A 50 km / region hold-out (analogue-flow.probe.mjs) is harder.');
console.log('  - flow-analogue.ts is NOT in engine-signature.mjs. Adopting a new exponent or window changes the');
console.log('    analogue column of HydrologyComparison and this harness, and re-stales no fleet or gauge');
console.log('    table, because the shipped blend never calls it. The checks that pin it are');
console.log('    checks/flow-comparison.check.ts and the scores stored by analogue-flow.probe.mjs --build.\n');
