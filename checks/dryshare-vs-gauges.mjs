/**
 * Does the app get the DRY SEASON right? It had never been asked.
 *
 *   node --experimental-strip-types --no-warnings checks/dryshare-vs-gauges.mjs
 *
 * WHY THIS IS THE GAP WORTH CLOSING. Every gauge harness in this folder scores
 * MAGNITUDE — the annual mean, 1.37x typical error. None scored the seasonal
 * split, and the seasonal split is where the money is. NEA's posted run-of-
 * river rates pay NPR 8.40/kWh dry against 4.80 wet, and a project only reaches
 * the 6+6 option by delivering 30% of its energy in the dry season (15% on
 * 8+4). HydroRecon already prints that verdict, in a report, beside a rupee figure.
 * Nothing had ever checked it.
 *
 * CLAUDE.md says so outright: after the DHM parser repair, "anything seasonal —
 * dry-season energy, the PPA 6+6 and 8+4 splits ... was scored against
 * corrupted ground truth and must be re-measured." The records on disk are now
 * repaired — 0 of 2,096 non-leap station-years still carry a 29 February, down
 * from 98.19% — so the measurement is finally possible.
 *
 * THE EXPERIMENT. At each DHM gauge, take the flood-model series the app would
 * actually read there and the daily record the gauge actually measured, keep
 * only the days BOTH cover, build one plant, and dispatch both series through
 * it. The difference in dry share is then attributable to the model and to
 * nothing else.
 *
 * Five decisions make it attributable:
 *
 *   1. THE MODEL SERIES IS RESCALED TO THE MEASURED MEAN. Dry share is a shape
 *      question, and magnitude error is already measured elsewhere at 1.37x.
 *      Leaving it in would produce a number nobody could attribute. This hands
 *      the app a perfect annual mean — the friendliest case it will ever get.
 *   2. PAIRED DAYS ONLY. Same days, both series. A gauge that stopped in 2009
 *      and a model that runs to 2025 would otherwise be compared across
 *      different weather.
 *   3. ONE PLANT PER ARM, SIZED OFF THAT ARM. Design flow is Q40 of the model
 *      series and the release is Nepal's 10%-of-lowest-monthly-mean floor, both
 *      read from the model — because that is the plant a user of this app would
 *      build. The measured series is then run through that same plant. Head and
 *      efficiency cancel in a ratio, so they are set to anything sane.
 *   4. TWO MACHINES. A Pelton idles down to 10% of design; a Francis trips out
 *      near 40%. Dry-season days sit exactly in that band, so the answer could
 *      have been an artefact of the machine. It is reported at both.
 *   5. A SEASON-BALANCE CONTROL. wetDryEnergy weights each season by its share
 *      of the days present, so a record with monsoon gaps would inflate the dry
 *      share of BOTH series and move the threshold verdict without any model
 *      being wrong. The control prints the wet-day share of the paired days
 *      against what the calendar says it should be. If those two ever diverge,
 *      the confusion matrix below is measuring gauge outages, not the app.
 *
 * THREE ARMS, WHICH ANSWERS A STANDING QUESTION. CLAUDE.md has carried "does
 * the fdcshape correction help or hurt end-to-end" as an open question since it
 * was written. The correction exists because the flood model's low-flow tail is
 * too low over Nepal — which is precisely the defect that would bias a dry
 * share — so the seasonal split is the natural place to settle it:
 *
 *   raw       the model's own shape, which is what ships on the ~84% of sites
 *             the guard does not flag
 *   shipped   corrected only where judgeShape calls the shape implausible —
 *             what the app actually does today
 *   always    corrected everywhere, i.e. what widening the guard would buy
 *   modhydest corrected where flagged, but onto Modified HYDEST's OWN
 *             flow-duration regression instead of one national curve
 *
 * THE FOURTH ARM IS A DEBT THE CODE ADMITS TO. engine/fdcshape.ts carries a
 * standing note — "the site-specific curve wins at every exceedance ... NOT
 * SWITCHED YET ... Owed: an A/B once the service returns" — because Modified
 * HYDEST publishes a flow-duration regression PER CATCHMENT and this app
 * corrects onto a single curve for the whole country. Against 94 gauges the
 * per-catchment curve read Q95 at 1.11x against the national curve's 1.13x, and
 * landed within 1.5x on 56% of gauges against 48%.
 *
 * The blocker was a rate limit on the discharge service, and the local GloFAS
 * store removed it without anyone noticing. So the debt is payable, and the dry
 * share is the right currency: the note itself says "the firm-flow end is where
 * it matters".
 *
 * READ THE ARMS ON BIAS AND ERROR, NOT ON THE COUNTS. Each arm sizes its own
 * plant off its own series, so the gauge is dispatched through a different
 * machine in each — which means the "qualify" column, the TRUTH, moves between
 * rows. That is methodologically right (the question is about a specific plant)
 * and it is exactly harness rule 2 in CLAUDE.md: a one-sided failure count
 * whose denominator can move will lie if it is read as a scoreboard. Bias and
 * typical error are paired site-by-site and do not have that problem.
 *
 * WHAT THE VERDICT TABLE MEANS. Percentage points of dry share are interesting;
 * the confusion matrix is the finding. "False qualify" is the app telling a
 * developer they clear the 30% bar when their own river does not. "False
 * reject" is the opposite, and on a screening tool it is not harmless either:
 * it is the app talking a developer out of the better half of the tariff.
 */
import { existsSync, readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (path.startsWith('/')) return new Response(readFileSync(`public${path}`), { status: 200 });
  return realFetch(path, init);
};

import { glofasCoverage, glofasSeries, hasGlofasStore } from '../pipeline/glofas-store.mjs';
import { correctShape, judgeShape } from '../src/engine/fdcshape.ts';
import { modifiedHydestFdc } from '../src/engine/modified-hydest.ts';
import { nearestReach, reachToRead } from '../src/rivers.ts';
import { buildFdc, flowAtExceedance, isWetPpaDay, mean, wetDryEnergy } from '../src/engine/hydro.ts';
import records from '../src/data/dhm-records.json' with { type: 'json' };

/** A year needs this many paired days before it counts as covering a season. */
const MIN_DAYS_IN_YEAR = 300;
/** And a station needs this many such years. Reported at two tiers. */
const TIERS = [3, 5];
/** Nepal's policy floor: 10% of the lowest monthly mean. */
const RESIDUAL_FRAC = 0.1;
/** Q40 is what the app sizes on by default. */
const DESIGN_EXCEEDANCE = 0.4;
const MACHINES = [
  { name: 'Pelton-like, unit idles to 10% of design', minFlowFrac: 0.1 },
  { name: 'Francis-like, unit trips below 40% of design', minFlowFrac: 0.4 },
];
const PLANS = [
  { id: 'nea-6-6', label: 'NEA 6+6', threshold: 0.3 },
  { id: 'nea-8-4', label: 'NEA 8+4', threshold: 0.15 },
];
const ARMS = ['raw', 'shipped', 'always', 'modhydest'];

if (!hasGlofasStore()) {
  console.error('No local GloFAS store — run pipeline/build-glofas-store.py first.');
  process.exit(1);
}

/**
 * DHM stores 366 slots every year, with the 29 February slot left null outside
 * a leap year. That is not padding for its own sake: it means ONE leap-year
 * calendar converts an index to a month and day correctly for every year, leap
 * or not, because the dead slot absorbs the offset. Using a real calendar per
 * year instead shifts every reading after February by a day in three years out
 * of four — a smaller cousin of the parser bug this file exists to measure the
 * repair of.
 */
const CAL = (() => {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const days = new Date(Date.UTC(2000, m, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) out.push([m, d]);
  }
  return out;
})();

/** Lowest of the twelve monthly means, which is what the e-flow floor is 10% of. */
function lowestMonthlyMean(months, values) {
  const sum = new Array(12).fill(0);
  const cnt = new Array(12).fill(0);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    sum[months[i] - 1] += values[i];
    cnt[months[i] - 1] += 1;
  }
  let lo = Infinity;
  for (let m = 0; m < 12; m++) if (cnt[m] > 0) lo = Math.min(lo, sum[m] / cnt[m]);
  return Number.isFinite(lo) ? lo : 0;
}

/**
 * Quantile-map a series onto a target SHAPE, holding its mean.
 *
 * The same operation engine/fdcshape.ts performs, with the target curve made an
 * argument instead of a constant, so the national curve and Modified HYDEST's
 * per-catchment curve can be compared on identical machinery. The target is
 * used as a shape only — divided by its own mean and rescaled to the series' —
 * because the network owns the magnitude and a correction must never move it.
 */
function mapOntoCurve(series, curve) {
  const n = series.length;
  const m = series.reduce((a, b) => a + b, 0) / n;
  if (!(m > 0) || curve.length < 2) return [...series];
  const pts = [...curve].sort((a, b) => a.p - b.p);
  // The regression's own mean, by the trapezium rule over exceedance.
  let area = 0;
  for (let i = 1; i < pts.length; i++) {
    area += ((pts[i].cms + pts[i - 1].cms) / 2) * (pts[i].p - pts[i - 1].p);
  }
  const span = pts[pts.length - 1].p - pts[0].p;
  const curveMean = span > 0 ? area / span : NaN;
  if (!(curveMean > 0)) return [...series];

  const ratioAt = (p) => {
    if (p <= pts[0].p) return pts[0].cms / curveMean;
    if (p >= pts[pts.length - 1].p) return pts[pts.length - 1].cms / curveMean;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (p >= pts[i].p && p <= pts[i + 1].p) {
        const t = (p - pts[i].p) / (pts[i + 1].p - pts[i].p);
        return (
          Math.exp(
            Math.log(pts[i].cms) + t * (Math.log(pts[i + 1].cms) - Math.log(pts[i].cms))
          ) / curveMean
        );
      }
    }
    return pts[pts.length - 1].cms / curveMean;
  };

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => series[b] - series[a]);
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[order[k]] = ratioAt(n > 1 ? k / (n - 1) : 0) * m;
  const got = out.reduce((a, b) => a + b, 0) / n;
  if (got > 0) for (let i = 0; i < n; i++) out[i] *= m / got;
  return out;
}

const sites = [];
let noStore = 0;
let tooShort = 0;
let flagged = 0;
let noReach = 0;

for (const s of records.stations) {
  if (s.lat == null || s.lon == null) continue;
  const file = `sources/dhm/${s.id}.json`;
  if (!existsSync(file)) continue;
  const model = glofasSeries(s.lat, s.lon);
  if (!model) {
    noStore++;
    continue;
  }
  const modelAt = new Map();
  for (let i = 0; i < model.daily.time.length; i++) {
    const v = model.daily.river_discharge[i];
    if (v != null && Number.isFinite(v)) modelAt.set(model.daily.time[i], v);
  }

  const daily = JSON.parse(readFileSync(file, 'utf8'));
  const dates = [];
  const gauged = [];
  const modelled = [];
  const perYear = new Map();
  for (const [ys, arr] of Object.entries(daily.years)) {
    for (let i = 0; i < arr.length && i < CAL.length; i++) {
      const q = arr[i];
      if (q == null || !Number.isFinite(q)) continue;
      const [m, d] = CAL[i];
      const iso = `${ys}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const mv = modelAt.get(iso);
      if (mv === undefined) continue;
      dates.push(iso);
      gauged.push(q);
      modelled.push(mv);
      perYear.set(ys, (perYear.get(ys) ?? 0) + 1);
    }
  }
  const years = [...perYear.values()].filter((n) => n >= MIN_DAYS_IN_YEAR).length;
  if (years < TIERS[0]) {
    tooShort++;
    continue;
  }

  const mm = mean(modelled);
  const gm = mean(gauged);
  if (!(mm > 0) || !(gm > 0)) continue;
  // Rescale the model to the measured mean: this is a shape test.
  const raw = modelled.map((v) => (v * gm) / mm);
  const verdict = judgeShape(raw, DESIGN_EXCEEDANCE);
  const always = correctShape(raw, DESIGN_EXCEEDANCE);
  if (verdict?.implausible) flagged++;

  // Modified HYDEST needs the catchment the app would read at this point, so
  // the gauge is snapped to the same network a click is, and read through the
  // same main-stem chooser. nearestReach returns the CHOICE — {nearest,
  // mainStem} — not a reach; reading its fields directly gives undefined, every
  // guard below fails, and the arm silently becomes a copy of `raw`. It did,
  // for all 74 sites, and only the count printed above caught it.
  let modhydest = raw;
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  const reach = hit ? reachToRead(hit).reach : null;
  const fdc =
    reach &&
    reach.uplandKm2 > 0 &&
    Number.isFinite(reach.averageAltitudeM) &&
    Number.isFinite(reach.annualPrecipMm) &&
    Number.isFinite(reach.below3000Frac) &&
    Number.isFinite(reach.below5000Frac)
      ? modifiedHydestFdc({
          below3000Km2: reach.below3000Frac * reach.uplandKm2,
          below5000Km2: reach.below5000Frac * reach.uplandKm2,
          averageAltitudeM: reach.averageAltitudeM,
          annualWetnessMm: reach.annualPrecipMm,
        })
      : null;
  if (!fdc) noReach++;
  else if (verdict?.implausible) modhydest = mapOntoCurve(raw, fdc);
  sites.push({
    id: s.id,
    river: s.river,
    years,
    dates,
    months: dates.map((d) => Number(d.slice(5, 7))),
    gauged,
    series: { raw, shipped: verdict?.implausible ? always : raw, always, modhydest },
  });
}

/** Dispatch a series through a given plant and return its dry share on a plan. */
const dryShare = (dates, values, plant, plan) => {
  const x = wetDryEnergy(dates, values, plant, plan);
  const total = x.wetGwh + x.dryGwh;
  return total > 0 ? x.dryGwh / total : 0;
};

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

const cov = glofasCoverage();
console.log(
  `${sites.length} gauges with at least ${TIERS[0]} years of daily record inside the ` +
    `flood model's own window (${cov.from} to ${cov.to}).`
);
console.log(
  `${noStore} outside the store, ${tooShort} too short. ` +
    `judgeShape flags ${flagged}/${sites.length} = ${((100 * flagged) / sites.length).toFixed(0)}%. ` +
    `${noReach} carry no catchment for Modified HYDEST and fall back to the raw shape.`
);

// The control. If these two numbers part company, nothing below is about the app.
{
  const shares = sites.map((s) => {
    let wet = 0;
    for (let i = 0; i < s.dates.length; i++) {
      if (isWetPpaDay(s.months[i], Number(s.dates[i].slice(8, 10)), 'nea-6-6')) wet++;
    }
    return wet / s.dates.length;
  });
  let cal = 0;
  for (const [m, d] of CAL) if (isWetPpaDay(m, d, 'nea-6-6')) cal++;
  console.log(
    `Season-balance control: wet days are ${(median(shares) * 100).toFixed(1)}% of the ` +
      `paired record against ${((100 * cal) / CAL.length).toFixed(1)}% of the calendar — ` +
      `${Math.abs(median(shares) * 100 - (100 * cal) / CAL.length) < 2 ? 'no monsoon-gap bias' : 'GAPPED, results below are suspect'}.\n`
  );
}

for (const machine of MACHINES) {
  console.log(`=== ${machine.name} ===`);
  console.log(
    `${'plan'.padEnd(8)}${'yrs'.padEnd(6)}${'arm'.padEnd(9)}${'n'.padStart(4)}` +
      `${'bias'.padStart(9)}${'typ.err'.padStart(9)}${'qualify'.padStart(10)}` +
      `${'FALSE QUAL'.padStart(12)}${'false rej'.padStart(11)}`
  );
  for (const plan of PLANS) {
    for (const tier of TIERS) {
      for (const arm of ARMS) {
        const rows = [];
        for (const site of sites) {
          if (site.years < tier) continue;
          const modelSeries = site.series[arm];
          const designFlowCms = flowAtExceedance(buildFdc(modelSeries), DESIGN_EXCEEDANCE);
          if (!(designFlowCms > 0)) continue;
          const plant = {
            grossHeadM: 100,
            headLossFrac: 0,
            efficiency: 0.85,
            designFlowCms,
            residualFlowCms: RESIDUAL_FRAC * lowestMonthlyMean(site.months, modelSeries),
            minFlowFrac: machine.minFlowFrac,
          };
          rows.push({
            site,
            model: dryShare(site.dates, modelSeries, plant, plan.id),
            gauge: dryShare(site.dates, site.gauged, plant, plan.id),
          });
        }
        if (!rows.length) continue;
        const errs = rows.map((r) => (r.model - r.gauge) * 100);
        const bias = median(errs);
        console.log(
          `${plan.label.padEnd(8)}${`>=${tier}`.padEnd(6)}${arm.padEnd(9)}` +
            `${String(rows.length).padStart(4)}` +
            `${`${bias >= 0 ? '+' : ''}${bias.toFixed(1)}pt`.padStart(9)}` +
            `${`${median(errs.map(Math.abs)).toFixed(1)}pt`.padStart(9)}` +
            `${`${rows.filter((r) => r.gauge >= plan.threshold).length}/${rows.length}`.padStart(10)}` +
            `${String(rows.filter((r) => r.model >= plan.threshold && r.gauge < plan.threshold).length).padStart(12)}` +
            `${String(rows.filter((r) => r.model < plan.threshold && r.gauge >= plan.threshold).length).padStart(11)}`
        );
      }
    }
  }
  console.log();
}

console.log(
  'Bias is the app minus the gauge, in percentage points of dry-season energy share.\n' +
    'A positive bias means the app credits the dry season with more energy than the\n' +
    'river delivered. "qualify" is how many of these rivers actually clear the\n' +
    'threshold; FALSE QUAL and false rej are the app disagreeing with them.\n' +
    "The model is handed the gauge's own annual mean, so this is the app at its\n" +
    'best, not at its typical.'
);
