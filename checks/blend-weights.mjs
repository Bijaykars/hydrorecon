/**
 * How should the flow sources be combined? Measured, not assumed.
 *
 *   node --experimental-strip-types --no-warnings checks/blend-weights.mjs
 *
 * The engine ships `sqrt(network x ModHYDEST)` — an unweighted geometric mean
 * of two of the four sources it has. Two things about that are worth testing.
 *
 * FIRST, equal weights are optimal only when both sources carry equal error
 * variance, and they do not: measured on these gauges the network runs 1.53x
 * typical error against Modified HYDEST's 1.40x, and on 100-500 km2 catchments
 * the gap widens to 1.90x against 1.61x. In log space the minimum-variance
 * combination weights each source by 1/sigma^2. That is not a tuning knob; it
 * is what a weighted mean IS.
 *
 * SECOND, MHSP is not consulted for magnitude at all, and on the 100-500 km2
 * band — where Nepali projects actually sit — it is the best single source
 * available.
 *
 * WHY WEIGHTS ARE FITTED LEAVE-ONE-OUT. With 69 gauges and four sources it is
 * trivially easy to fit weights that look wonderful on the gauges they were fitted
 * to and carry nothing to a new site. Every weighted rule below therefore
 * derives its weights from the OTHER gauges and is scored on the one held out,
 * so the number printed is a prediction, not a fit.
 *
 * WHY THE PROJECT-WEIGHTED COLUMN IS THE ONE THAT MATTERS. DHM gauges sit on a
 * median catchment near 800 km2; DoED projects sit near 100. A rule that wins
 * the raw gauge average by helping big catchments has improved the population
 * this tool is not used on. This project has been caught by that three times,
 * so the band-weighted figure is printed beside the raw one and disagreements
 * between them are the point.
 */
import { readFileSync } from 'node:fs';

// The engine modules fetch their data over HTTP. Same shim the other gauge
// harnesses use, so this reads exactly the bundle the app ships.
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u).replace(/^undefined/, '');
  if (p.startsWith('/') || /^[\w.-]+\.(json|dat|bin)$/.test(p)) {
    try {
      return new Response(readFileSync(`public/${p.replace(/^\//, '')}`), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return realFetch(p, i);
};

const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));
const { hasReachData, nearestReach, SNAP_KM } = await import('../src/rivers.ts');
const { mhspScreen } = await import('../src/engine/mhsp.ts');
const { allMonthlyFlows } = await import('../src/engine/hydest.ts');
const { modifiedHydestAnnualMean } = await import('../src/engine/modified-hydest.ts');

const MIN_YEARS = Number(process.argv[2] ?? 10);
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;

/**
 * Where Nepali projects sit, by catchment. Used to reweight the gauge bands so
 * a rule is scored on the population it will be used on.
 * Bands: under 100, 100-500, 500+ km2.
 */
const PROJECT_WEIGHTS = [0.45, 0.35, 0.2];
const bandOf = (a) => (a < 100 ? 0 : a < 500 ? 1 : 2);

const rows = [];
for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < MIN_YEARS || !(s.meanCms > 0)) continue;
  if (!hasReachData(s.lat, s.lon)) continue;
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) continue;
  const r = hit.nearest;
  const A = r.uplandKm2;
  if (!(A > 0) || !Number.isFinite(r.below5000Frac)) continue;
  const spec = s.meanCms / A;
  if (spec < SPECIFIC_MIN || spec > SPECIFIC_MAX) continue;

  const mmp = Number.isFinite(r.monsoonMm) ? r.monsoonMm : undefined;
  const m = mhspScreen(A, mmp);
  const hy = allMonthlyFlows({
    totalKm2: A,
    below5000Km2: A * r.below5000Frac,
    below3000Km2: A * r.below3000Frac,
    ...(mmp ? { monsoonMm: mmp } : {}),
  });
  if (!m || m.months.length < 12 || hy.length < 12) continue;
  const mod = modifiedHydestAnnualMean({
    below3000Km2: A * r.below3000Frac,
    below5000Km2: A * r.below5000Frac,
    averageAltitudeM: r.averageAltitudeM,
    annualWetnessMm: r.annualPrecipMm,
  });
  if (!(mod > 0) || !(r.meanDischargeCms > 0) || !(m.annualMeanCms > 0)) continue;

  rows.push({
    river: s.river,
    A,
    band: bandOf(A),
    measured: s.meanCms,
    sources: {
      network: r.meanDischargeCms,
      modified: mod,
      mhsp: m.annualMeanCms,
      hydest: hy.reduce((t, x) => t + x.cms, 0) / 12,
    },
  });
}

const NAMES = ['network', 'modified', 'mhsp', 'hydest'];

/** Log-space error of one prediction. */
const err = (pred, truth) => Math.log(pred / truth);

/** Inverse-variance weights in log space, from a set of training rows. */
function fitWeights(train, names) {
  const w = names.map((n) => {
    const e = train.map((r) => err(r.sources[n], r.measured)).filter(Number.isFinite);
    if (e.length < 4) return 0;
    const mean = e.reduce((a, b) => a + b, 0) / e.length;
    const varr = e.reduce((a, b) => a + (b - mean) ** 2, 0) / e.length;
    return varr > 0 ? 1 / varr : 0;
  });
  const total = w.reduce((a, b) => a + b, 0);
  return total > 0 ? w.map((x) => x / total) : names.map(() => 1 / names.length);
}

/** Mean log-bias of a rule over training rows — the constant that recentres it. */
function fitBias(train, predict) {
  const e = train.map((r) => err(predict(r, train), r.measured)).filter(Number.isFinite);
  return e.length ? e.reduce((a, b) => a + b, 0) / e.length : 0;
}

/**
 * SHRINKAGE toward equal weights.
 *
 * Fitted weights on 14 small-catchment gauges are mostly noise. Pulling them a
 * fixed fraction of the way back to equal keeps the direction the data shows
 * while refusing to believe its magnitude, which is what a small sample earns.
 */
const SHRINK = 0.5;
const shrunk = (w) => w.map((x) => x * (1 - SHRINK) + SHRINK / w.length);

const geo = (vals, weights) =>
  Math.exp(vals.reduce((sum, v, i) => sum + weights[i] * Math.log(v), 0));

/** Every rule under test. Each gets the training rows so it can fit in-fold. */
const RULES = {
  'network alone': (r) => r.sources.network,
  'ModHYDEST alone': (r) => r.sources.modified,
  'MHSP alone': (r) => r.sources.mhsp,
  'SHIPPED sqrt(net x mod)': (r) => Math.sqrt(r.sources.network * r.sources.modified),
  'shipped + bias correction': (r, train) => {
    const f = (x) => Math.sqrt(x.sources.network * x.sources.modified);
    return f(r) / Math.exp(fitBias(train, f));
  },
  'inv-var 2 source': (r, train) => {
    const w = shrunk(fitWeights(train, ['network', 'modified']));
    return geo([r.sources.network, r.sources.modified], w);
  },
  'inv-var 3 source': (r, train) => {
    const w = shrunk(fitWeights(train, ['network', 'modified', 'mhsp']));
    return geo([r.sources.network, r.sources.modified, r.sources.mhsp], w);
  },
  'inv-var 3 source + bias': (r, train) => {
    const names = ['network', 'modified', 'mhsp'];
    const w = shrunk(fitWeights(train, names));
    const f = (x) => geo(names.map((n) => x.sources[n]), w);
    return f(r) / Math.exp(fitBias(train, f));
  },
  'inv-var 3, weights per band': (r, train) => {
    const names = ['network', 'modified', 'mhsp'];
    const sameBand = train.filter((t) => t.band === r.band);
    const w = shrunk(fitWeights(sameBand.length >= 8 ? sameBand : train, names));
    return geo(names.map((n) => r.sources[n]), w);
  },
  'inv-var 3 per band + bias': (r, train) => {
    const names = ['network', 'modified', 'mhsp'];
    const sameBand = train.filter((t) => t.band === r.band);
    const w = shrunk(fitWeights(sameBand.length >= 8 ? sameBand : train, names));
    const f = (x) => geo(names.map((n) => x.sources[n]), w);
    const band = train.filter((t) => t.band === r.band);
    return f(r) / Math.exp(fitBias(band.length >= 8 ? band : train, f));
  },
};

/** Leave-one-out: every rule predicts each gauge from the other 68. */
const scored = {};
for (const [name, rule] of Object.entries(RULES)) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, k) => k !== i);
    const pred = rule(rows[i], train);
    if (Number.isFinite(pred) && pred > 0) {
      out.push({ band: rows[i].band, e: err(pred, rows[i].measured) });
    }
  }
  scored[name] = out;
}

const stat = (es) => {
  if (!es.length) return null;
  const sorted = [...es].sort((a, b) => a - b);
  return {
    n: es.length,
    median: Math.exp(sorted[sorted.length >> 1]),
    bias: Math.exp(es.reduce((a, b) => a + b, 0) / es.length),
    typ: Math.exp(es.reduce((a, b) => a + Math.abs(b), 0) / es.length),
    w2: (100 * es.filter((x) => Math.abs(x) <= Math.log(2)).length) / es.length,
  };
};

/** Typical error reweighted so the bands carry their project shares. */
function projectWeighted(out) {
  let sum = 0;
  let wsum = 0;
  for (let b = 0; b < 3; b++) {
    const es = out.filter((x) => x.band === b).map((x) => x.e);
    if (!es.length) continue;
    sum += PROJECT_WEIGHTS[b] * (es.reduce((a, x) => a + Math.abs(x), 0) / es.length);
    wsum += PROJECT_WEIGHTS[b];
  }
  return wsum > 0 ? Math.exp(sum / wsum) : NaN;
}

const counts = [0, 1, 2].map((b) => rows.filter((r) => r.band === b).length);
console.log(
  `\n${rows.length} gauges, ${MIN_YEARS}+ complete years — leave-one-out, so every weight is fitted without seeing the gauge it predicts`
);
console.log(`bands: <100 km2 n=${counts[0]}, 100-500 n=${counts[1]}, 500+ n=${counts[2]}\n`);
console.log(
  `  ${'rule'.padEnd(28)}${'median'.padStart(8)}${'bias'.padStart(8)}${'typ.err'.padStart(9)}${'w/in 2x'.padStart(9)}${'PROJECT-WEIGHTED'.padStart(18)}`
);
for (const [name, out] of Object.entries(scored)) {
  const s = stat(out.map((x) => x.e));
  if (!s) continue;
  console.log(
    `  ${name.padEnd(28)}${s.median.toFixed(2).padStart(7)}x${s.bias.toFixed(2).padStart(7)}x` +
      `${s.typ.toFixed(2).padStart(8)}x${(s.w2.toFixed(0) + '%').padStart(9)}` +
      `${(projectWeighted(out).toFixed(3) + 'x').padStart(18)}`
  );
}

// What the weights actually come out as, fitted on everything, for reference.
console.log('\nweights fitted on all gauges (after shrinkage), for reference:');
for (const [label, subset] of [
  ['all', rows],
  ['<100 km2', rows.filter((r) => r.band === 0)],
  ['100-500 km2', rows.filter((r) => r.band === 1)],
  ['500+ km2', rows.filter((r) => r.band === 2)],
]) {
  if (subset.length < 8) {
    console.log(`  ${label.padEnd(14)} n=${subset.length} — too few to fit`);
    continue;
  }
  const w = shrunk(fitWeights(subset, ['network', 'modified', 'mhsp']));
  console.log(
    `  ${label.padEnd(14)} n=${String(subset.length).padStart(2)}  ` +
      `network ${w[0].toFixed(2)}  ModHYDEST ${w[1].toFixed(2)}  MHSP ${w[2].toFixed(2)}`
  );
}
console.log(
  '\nA rule only ships if it wins the PROJECT-WEIGHTED column and then survives the fleet.\n' +
    'The gauge population is systematically easier than the project population;\n' +
    'three separate changes have looked good here and failed on built plants.\n'
);

/**
 * The bias constant, printed so it can be transcribed rather than guessed.
 * Fitted on every gauge; the leave-one-out column above is what says whether
 * applying it generalises.
 */
{
  const f = (x) => Math.sqrt(x.sources.network * x.sources.modified);
  const e = rows.map((r) => Math.log(f(r) / r.measured));
  const mean = e.reduce((a, b) => a + b, 0) / e.length;
  console.log(
    `blend bias over ${rows.length} gauges: ${Math.exp(mean).toFixed(4)}x  ` +
      `=> correction factor ${(1 / Math.exp(mean)).toFixed(4)}`
  );
  for (const b of [0, 1, 2]) {
    const sub = rows.filter((r) => r.band === b);
    if (sub.length < 5) continue;
    const eb = sub.map((r) => Math.log(f(r) / r.measured));
    const mb = eb.reduce((a, x) => a + x, 0) / eb.length;
    const label = ['<100', '100-500', '500+'][b];
    console.log(`  ${label.padEnd(8)} n=${String(sub.length).padStart(2)}  bias ${Math.exp(mb).toFixed(3)}x  => ${(1 / Math.exp(mb)).toFixed(3)}`);
  }
}
