/**
 * Is GloFAS V5 a better flood model for Nepal than the V4 the app ships?
 *
 *   node --experimental-strip-types --no-warnings checks/glofas-v4-vs-v5.mjs
 *   node --experimental-strip-types --no-warnings checks/glofas-v4-vs-v5.mjs --a <store.bin> --b <store.bin>
 *
 * WHY. The app's worst measured errors are flow on small catchments and a
 * dry-season under-read (CLAUDE.md: dry share reads 4-6 pt low), and V5 claims a
 * low-flow-aware recalibration. Nothing here scored the flood model's own
 * MAGNITUDE against gauges - blend-weights.mjs scores the blend, and
 * dryshare-vs-gauges.mjs scores shape with the mean handed over - and the store
 * reader could only open one store per process. `openGlofasAt` in
 * pipeline/glofas-store.mjs now opens a second.
 *
 * THE EXPERIMENT. Each DHM gauge is read from both stores at the gauge's own
 * coordinates; the reader picks the cell, and it is the same cell for both arms
 * because the two files share one grid. Both arms are scored on the IDENTICAL
 * gauge set, and on identical days: a day counts only if the gauge, V4 and V5
 * all have a value, so neither arm sees weather the other does not.
 *
 *   T1 magnitude, whole record      model mean / meanCms, 10+ complete years
 *   T2 magnitude, overlapping days  model mean / gauge mean on the paired days,
 *                                   3+ years each with 300+ paired days
 *   T3 shape, model rescaled to the gauge's mean on the paired days
 *   T4 head to head on the T2 set, with a paired bootstrap interval
 *   T5 sanity: V5 mean / V4 mean per gauge. A ratio far from 1 is a changed
 *      river routing, not a changed model, and wants looking at on its own.
 *
 * Metrics are the project's: median = middle ratio; bias = exp(mean ln ratio);
 * typical error = exp(mean |ln ratio|); within 2x = share of ratios strictly
 * between 0.5 and 2. (blend-weights.mjs:202-212, gauge-catchment-bands.mjs:209-233.)
 * Bands are gauge-catchment-bands.mjs:76-82, areas are DHM's printed
 * drainage area from sources/dhm-catchments.json, as there.
 *
 * WHAT THIS CANNOT SAY.
 *  - Same-cell pairing. GloFAS V5 may route a river through a different cell
 *    than V4 did; reading both at the gauge's coordinates scores whichever cell
 *    the gauge happens to fall in, not the cell a snapped project site would
 *    use. T5 lists the gauges where the two stores disagree by more than 2x.
 *  - Project sites. The gauges are bigger rivers than where plants sit (median
 *    ~800-2,000 km2 against ~163 km2): the trap CLAUDE.md names on every page.
 *    A win here is evidence about big rivers. The <100 km2 band is read as a
 *    hint, not a verdict, and says TOO FEW below n = 8.
 *  - The flow-choice arbitration. This scores the flood model alone, not the
 *    blend the app ships, so a V5 win here is not a claim about the shipped
 *    accuracy table.
 *
 * Self-check: point --a and --b at the same file. Every A and B row must be
 * identical, T4 all ties and T5 every ratio exactly 1.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openGlofasAt } from '../pipeline/glofas-store.mjs';
import { buildFdc, flowAtExceedance } from '../src/engine/hydro.ts';
import records from '../src/data/dhm-records.json' with { type: 'json' };

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PATH_A = arg('--a', 'pipeline/.cache/glofas-nepal.bin');
const PATH_B = arg('--b', 'pipeline/.cache/glofas-nepal-v5.bin');
const OUT = 'pipeline/.cache/glofas-v4-vs-v5.json';
const SELF_CHECK = resolve(PATH_A) === resolve(PATH_B);

/**
 * T2-T4 eligibility, mirrored from dryshare-vs-gauges.mjs:107-110 and :249-252:
 * a year counts when it carries 300+ paired days, and a station needs 3 such years.
 */
const MIN_DAYS_IN_YEAR = 300;
const MIN_YEARS = 3;
const LONG_RECORD_YEARS = 10;
/** NEA dry season, as in the task: Dec-Apr. */
const DRY_MONTHS = new Set([12, 1, 2, 3, 4]);
const TOO_FEW = 8;

const BANDS = [
  { name: '<100', lo: 0, hi: 100 },
  { name: '100-500', lo: 100, hi: 500 },
  { name: '500-2000', lo: 500, hi: 2000 },
  { name: '>2000', lo: 2000, hi: Infinity },
];
const bandOf = (a) => (a > 0 ? BANDS.findIndex((b) => a >= b.lo && a < b.hi) : -1);

const storeA = openGlofasAt(PATH_A);
const storeB = openGlofasAt(PATH_B);
for (const [label, p, s] of [['A', PATH_A, storeA], ['B', PATH_B, storeB]]) {
  if (!s) {
    console.error(`Store ${label} is missing: ${p}`);
    process.exit(1);
  }
}

const CATCH = 'sources/dhm-catchments.json';
const dhmArea = new Map();
if (existsSync(CATCH)) {
  for (const s of JSON.parse(readFileSync(CATCH, 'utf8')).stations) {
    if (s.drainageKm2 > 0) dhmArea.set(s.id, s.drainageKm2);
  }
} else {
  console.error(`${CATCH} not found: catchment bands will be unavailable (python pipeline/build-dhm-catchments.py)`);
}

/** DHM stores 366 slots a year with 29 Feb left null; see dryshare-vs-gauges.mjs:130. */
const CAL = (() => {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const days = new Date(Date.UTC(2000, m, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) out.push([m, d]);
  }
  return out;
})();

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const q = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '  - ');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '  - ');
/** Seeded, so the interval printed is the interval next time (gauge-catchment-bands.mjs:93). */
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const toMap = (series) => {
  const m = new Map();
  const { time, river_discharge } = series.daily;
  for (let i = 0; i < time.length; i++) {
    const v = river_discharge[i];
    if (v != null && Number.isFinite(v)) m.set(time[i], v);
  }
  return m;
};
const wholeMean = (map) => mean([...map.values()]);

const drySharePp = (months, vals) => {
  let dry = 0;
  let all = 0;
  for (let i = 0; i < vals.length; i++) {
    all += vals[i];
    if (DRY_MONTHS.has(months[i])) dry += vals[i];
  }
  return (100 * dry) / all;
};
const exceed = (vals, p) => flowAtExceedance(buildFdc(vals), p);

/* ------------------------------------------------------------------ gather */
const skipped = { noCoord: 0, noStoreValue: 0 };
const rows = [];
for (const s of records.stations) {
  if (s.lat == null || s.lon == null) {
    skipped.noCoord++;
    continue;
  }
  const sa = storeA.series(s.lat, s.lon);
  const sb = storeB.series(s.lat, s.lon);
  if (!sa || !sb) {
    skipped.noStoreValue++;
    continue;
  }
  const ma = toMap(sa);
  const mb = toMap(sb);
  const area = dhmArea.get(s.id) ?? null;
  const row = {
    id: s.id,
    river: s.river,
    areaKm2: area,
    band: bandOf(area),
    completeYears: s.completeYears ?? 0,
    meanCms: s.meanCms ?? null,
    cell: { A: [sa.latitude, sa.longitude], B: [sb.latitude, sb.longitude] },
    wholeMean: { A: wholeMean(ma), B: wholeMean(mb) },
    pairedDays: 0,
  };

  const file = `sources/dhm/${s.id}.json`;
  if (existsSync(file)) {
    const daily = JSON.parse(readFileSync(file, 'utf8'));
    const months = [];
    const perYear = new Map();
    const gauged = [];
    const A = [];
    const B = [];
    for (const [ys, arr] of Object.entries(daily.years)) {
      for (let i = 0; i < arr.length && i < CAL.length; i++) {
        const g = arr[i];
        if (g == null || !Number.isFinite(g)) continue;
        const [m, d] = CAL[i];
        const iso = `${ys}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const a = ma.get(iso);
        const b = mb.get(iso);
        if (a === undefined || b === undefined) continue;
        months.push(m);
        perYear.set(ys, (perYear.get(ys) ?? 0) + 1);
        gauged.push(g);
        A.push(a);
        B.push(b);
      }
    }
    row.pairedDays = gauged.length;
    row.pairedYears = [...perYear.values()].filter((n) => n >= MIN_DAYS_IN_YEAR).length;
    if (row.pairedYears >= MIN_YEARS) {
      const gm = mean(gauged);
      const arms = {};
      for (const [k, v] of [['A', A], ['B', B]]) {
        const mm = mean(v);
        const scaled = v.map((x) => (x * gm) / mm);
        arms[k] = {
          pairedMean: mm,
          ratio: mm / gm,
          dryPp: drySharePp(months, scaled),
          q90: exceed(scaled, 0.9),
          q40: exceed(scaled, 0.4),
        };
      }
      row.overlap = {
        gaugeMean: gm,
        gaugeDryPp: drySharePp(months, gauged),
        gaugeQ90: exceed(gauged, 0.9),
        gaugeQ40: exceed(gauged, 0.4),
        ...arms,
      };
      for (const k of ['A', 'B']) {
        const o = row.overlap;
        o[k].dryErrPp = o[k].dryPp - o.gaugeDryPp;
        o[k].q90Ratio = o[k].q90 / o.gaugeQ90;
        o[k].q40Ratio = o[k].q40 / o.gaugeQ40;
      }
    }
  }
  rows.push(row);
}

const t1 = rows.filter((r) => r.completeYears >= LONG_RECORD_YEARS && r.meanCms > 0);
const t2 = rows.filter((r) => r.overlap);

/* ------------------------------------------------------------------ print */
const rule = '='.repeat(86);
const covA = storeA.coverage();
const covB = storeB.coverage();
console.log(rule);
console.log('GloFAS A vs B against DHM gauges, paired gauge by gauge');
console.log(rule);
console.log(`A = V4  ${PATH_A}   ${covA.from} .. ${covA.to} (${covA.days} days)`);
console.log(`B = V5  ${PATH_B}   ${covB.from} .. ${covB.to} (${covB.days} days)`);
if (SELF_CHECK) console.log('\nSELF-CHECK: --a and --b are the same file. Every A and B row below must be identical.');
console.log(
  `\n${records.stations.length} DHM records. Scored in at least one table (both stores returned a series): ${rows.length}.` +
    `\nNot scored: ${skipped.noCoord} without coordinates, ${skipped.noStoreValue} where A or B carries no value at the coordinates.` +
    `\nT1 set: ${t1.length} (${LONG_RECORD_YEARS}+ complete years, meanCms > 0).` +
    `\nT2-T4 set: ${t2.length}; unpaired: ${rows.filter((r) => !r.overlap && r.pairedDays === 0).length} with no gauge file or no overlapping day, ` +
    `${rows.filter((r) => !r.overlap && r.pairedDays > 0).length} with under ${MIN_YEARS} years of ${MIN_DAYS_IN_YEAR}+ paired days.` +
    `
T2-T4 rule: at least ${MIN_YEARS} years each carrying at least ${MIN_DAYS_IN_YEAR} paired days (the rule of dryshare-vs-gauges.mjs); it admits ${t2.length} gauges.` +
    `\nNo DHM catchment area for ${rows.filter((r) => r.band < 0).length} scored gauges: they appear under "no area" and ALL only.`
);

function stat(ratios) {
  if (!ratios.length) return null;
  const e = ratios.map(Math.log);
  return {
    n: ratios.length,
    median: q(ratios, 0.5),
    bias: Math.exp(mean(e)),
    typ: Math.exp(mean(e.map(Math.abs))),
    w2: (100 * ratios.filter((x) => x > 0.5 && x < 2).length) / ratios.length,
  };
}
const statLine = (label, ratios) => {
  const s = stat(ratios);
  if (!s) return `    ${label.padEnd(10)} n=  0`;
  return (
    `    ${label.padEnd(10)} n=${String(s.n).padStart(3)}  median ${f2(s.median)}x  bias ${f2(s.bias)}x  ` +
    `typ.err ${f2(s.typ)}x  within 2x ${s.w2.toFixed(0).padStart(3)}%` +
    (s.n < TOO_FEW ? '  TOO FEW' : '')
  );
};
function magnitudeTable(title, set, ratioOf) {
  console.log(`\n${rule}\n${title}   (n = ${set.length})\n${rule}`);
  console.log('ratio = model / gauge; >1 reads high. Same gauges in both arms.');
  for (const arm of ['A', 'B']) {
    console.log(`  arm ${arm}`);
    console.log(statLine('ALL', set.map((r) => ratioOf(r, arm))));
    BANDS.forEach((b, i) => console.log(statLine(b.name, set.filter((r) => r.band === i).map((r) => ratioOf(r, arm)))));
    const none = set.filter((r) => r.band < 0);
    if (none.length) console.log(statLine('no area', none.map((r) => ratioOf(r, arm))));
  }
}

magnitudeTable('T1  MAGNITUDE, long-term: model mean over its whole record / gauge meanCms', t1, (r, a) => r.wholeMean[a] / r.meanCms);
magnitudeTable(`T2  MAGNITUDE, overlapping days only (${MIN_YEARS}+ years of ${MIN_DAYS_IN_YEAR}+ paired days)`, t2, (r, a) => r.overlap[a].ratio);

/* T3 */
console.log(`\n${rule}\nT3  SHAPE, model rescaled to the gauge's mean on the paired days   (n = ${t2.length})\n${rule}`);
console.log('dry share = Dec-Apr flow / all flow on paired days; error = model - gauge, percentage points.');
console.log('low-flow ratios = model / gauge flow at the stated exceedance (Q90 = exceeded 90% of days).');
console.log(`  ${'arm'.padEnd(5)}${'dry bias'.padStart(10)}${'dry |err| med'.padStart(15)}${'Q90 median'.padStart(13)}${'Q90 typ.err'.padStart(13)}${'Q40 median'.padStart(13)}${'Q40 typ.err'.padStart(13)}`);
for (const arm of ['A', 'B']) {
  const dry = t2.map((r) => r.overlap[arm].dryErrPp);
  const s90 = stat(t2.map((r) => r.overlap[arm].q90Ratio).filter((x) => x > 0));
  const s40 = stat(t2.map((r) => r.overlap[arm].q40Ratio).filter((x) => x > 0));
  console.log(
    `  ${arm.padEnd(5)}${(f1(mean(dry)) + ' pt').padStart(10)}${(f1(q(dry.map(Math.abs), 0.5)) + ' pt').padStart(15)}` +
      `${(f2(s90?.median) + 'x').padStart(13)}${(f2(s90?.typ) + 'x').padStart(13)}${(f2(s40?.median) + 'x').padStart(13)}${(f2(s40?.typ) + 'x').padStart(13)}`
  );
}
console.log(`  gauge's own mean dry share on these days: ${f1(mean(t2.map((r) => r.overlap.gaugeDryPp)))}%`);

/* T4 */
console.log(`\n${rule}\nT4  HEAD TO HEAD on the T2 set   (n = ${t2.length})\n${rule}`);
const EPS = 1e-9;
const headToHead = (label, errA, errB) => {
  let b = 0;
  let a = 0;
  let tie = 0;
  errA.forEach((x, i) => {
    const d = errB[i] - x;
    if (Math.abs(d) <= EPS) tie++;
    else if (d < 0) b++;
    else a++;
  });
  console.log(`  ${label.padEnd(28)} B closer ${String(b).padStart(3)}   A closer ${String(a).padStart(3)}   tied ${String(tie).padStart(3)}`);
};
const magA = t2.map((r) => Math.abs(Math.log(r.overlap.A.ratio)));
const magB = t2.map((r) => Math.abs(Math.log(r.overlap.B.ratio)));
headToHead('magnitude (|ln ratio|)', magA, magB);
headToHead('dry share (|pp error|)', t2.map((r) => Math.abs(r.overlap.A.dryErrPp)), t2.map((r) => Math.abs(r.overlap.B.dryErrPp)));
const med = (xs) => q(xs, 0.5);
const rand = rng(20261116);
const diffs = [];
for (let k = 0; k < 2000; k++) {
  const idx = Array.from({ length: t2.length }, () => (rand() * t2.length) | 0);
  diffs.push(med(idx.map((i) => magB[i])) - med(idx.map((i) => magA[i])));
}
const dPoint = med(magB) - med(magA);
console.log(
  `\n  median |ln ratio|, B minus A: ${dPoint.toFixed(4)}   95% paired bootstrap [${q(diffs, 0.025).toFixed(4)}, ${q(diffs, 0.975).toFixed(4)}]` +
    `   (2000 resamples, seeded; negative = B closer, interval excluding 0 = a real difference)`
);
console.log(`  median |ln ratio|: A ${med(magA).toFixed(4)} (${f2(Math.exp(med(magA)))}x)   B ${med(magB).toFixed(4)} (${f2(Math.exp(med(magB)))}x)`);

/* T5 */
console.log(`\n${rule}\nT5  SANITY: B mean / A mean over each store's whole record   (n = ${rows.length})\n${rule}`);
const rel = rows.map((r) => ({ ...r, rel: r.wholeMean.B / r.wholeMean.A }));
const rels = rel.map((r) => r.rel);
console.log(`  p10 ${f2(q(rels, 0.1))}   median ${f2(q(rels, 0.5))}   p90 ${f2(q(rels, 0.9))}   min ${f2(Math.min(...rels))}   max ${f2(Math.max(...rels))}`);
if (SELF_CHECK) console.log(`  exactly 1 at every gauge: ${rels.every((x) => x === 1) ? 'YES' : 'NO'}`);
const odd = rel.filter((r) => r.rel < 0.5 || r.rel > 2).sort((a, b) => Math.abs(Math.log(b.rel)) - Math.abs(Math.log(a.rel)));
console.log(`\n  Outside 0.5-2.0 (candidates for a changed river routing rather than a changed model): ${odd.length}`);
for (const r of odd) {
  console.log(
    `    id ${String(r.id).padEnd(5)} ${String(r.river ?? '').padEnd(24)} B/A ${r.rel.toFixed(2).padStart(6)}x  catchment ${r.areaKm2 ? r.areaKm2.toFixed(0) + ' km2' : 'unknown'}`
  );
}

mkdirSync('pipeline/.cache', { recursive: true });
writeFileSync(OUT, JSON.stringify({ a: PATH_A, b: PATH_B, selfCheck: SELF_CHECK, skipped, rows }, null, 1));
console.log(`\nPer-gauge rows written to ${OUT}`);
