/**
 * The model knows WHEN it rains. Nepal's gauges know HOW MUCH the flow spreads.
 *
 * The engine has always split its two global sources by job: the mapped network
 * supplies the magnitude, the flood model supplies the day-to-day shape, on the
 * stated reasoning that "its day-to-day shape is sound" (see discover.ts). The
 * magnitude half of that has been validated. The shape half never was.
 *
 * It is measurably not sound. Design flow is Q40 of that shape, and on the Tama
 * Koshi at Lamabagar the model puts Q40 at 0.31x the annual mean. Across 78 DHM
 * gauges with ten or more complete years, Nepali rivers run Q40/mean between
 * 0.44 and 0.76 with a median of 0.59. The model is below the tenth percentile
 * of every river in the country: it dumps too much of the year's water into the
 * monsoon peak, where a run-of-river plant spills it, and leaves too little in
 * the shoulder months that actually fill the turbine. The mean is right and the
 * distribution around it is wrong, which understates design flow by about 2x.
 *
 * WHY A NATIONAL CURVE AND NOT THE NEAREST GAUGE. That was tested, expecting
 * the opposite (checks/fdc-shape.mjs). Leave-one-out across the same 78 gauges,
 * predicting each one's Q40/Q50/Q60/Q80/Q95 from the others: the national
 * median lands within 25% on 60% of points, the single nearest long-record
 * gauge on only 54%. Shape is a national property of Nepal's monsoon regime,
 * not a local one, and a neighbour's curve carries that neighbour's noise
 * without carrying any extra signal. The simplest predictor is also the best
 * one available, so this uses it.
 *
 * WHAT THIS DOES NOT TOUCH. The mean is preserved exactly — magnitude stays the
 * network's job. The day ORDER is preserved exactly — the wettest day stays the
 * wettest day, so seasonality, monthly minima and the residual-flow calculation
 * all still come from the model. Only the spread around the mean is replaced.
 *
 * WHEN IT FIRES. Only where the modelled shape falls outside the range Nepali
 * rivers actually exhibit. Inside that range the model is left alone, because
 * there is no evidence it is wrong there and a correction would be noise.
 *
 * THE TRADE-OFF THIS ACCEPTS. The gate is the 10th-90th percentile of gauged
 * rivers, so if the model were perfect it would still "correct" about a fifth of
 * sites — a genuinely unusual river gets pulled towards the median it does not
 * belong at. Two things make that the right side to err on. A river outside the
 * envelope costs roughly 34% on design flow if it is real and wrongly corrected
 * (p10 to median at Q40 is 0.44 to 0.59), against 74% if the model is wrong and
 * left alone, which is the case actually observed. And the median is not a
 * guess: leave-one-out across the 81 gauges predicts a held-out river's own
 * flow-duration points to a typical 1.27x, well inside the 1.96x error it
 * replaces. Correcting to the band EDGE instead of the median was considered
 * and rejected — the edge is no less arbitrary and has no such evidence behind
 * it. A real gauge record for the river overrides all of this and should.
 */
import records from '../data/dhm-records.json' with { type: 'json' };

/** Exceedance points DHM's yearbooks publish, and this app therefore has. */
const POINTS = [0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.95] as const;
const KEYS = ['q5', 'q20', 'q40', 'q50', 'q60', 'q80', 'q95'] as const;

/** A station is only allowed to describe the national shape with a real record. */
const MIN_COMPLETE_YEARS = 10;

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

/**
 * Q/mean at each exceedance, and the range Nepali rivers actually occupy.
 * Built once from the bundled DHM record summaries.
 */
/**
 * MEASURED, AND A BETTER REFERENCE EXISTS (checks/lowflow-route.mjs).
 *
 * The national curve below is one shape for the whole country. Modified HYDEST
 * publishes a flow-duration regression at each exceedance, which gives a curve
 * per catchment instead. Against 94 gauges with measured daily quantiles:
 *
 *                                        median   typ.err   within 1.5x
 *   Q60  office route (monthly percentile)  1.02x   1.68x        54%
 *        Modified HYDEST flow-duration      1.00x   1.55x        62%
 *        this national shape                1.09x   1.57x        55%
 *   Q95  office route                       1.55x   2.23x        46%
 *        Modified HYDEST flow-duration      1.11x   1.84x        56%
 *        this national shape                1.13x   1.86x        48%
 *
 * The site-specific curve wins at every exceedance, by little on typical error
 * and by seven or eight points on the share landing within 1.5x. The firm-flow
 * end is where it matters: reading Q95 off twelve monthly means overstates
 * dry-season flow by 55%, and dry-season energy is the expensive half of a
 * Nepali scheme's revenue.
 *
 * END-TO-END, MEASURED AND KEPT. 93 fleet plants scored with the correction on
 * and off:
 *
 *                 licence reached   implied median   under 0.5x   over 5x
 *   correction on     77/93              4.0 km           7          16
 *   correction off    77/93              3.2 km           7          17
 *
 * It fires on 15 of 93 sites — 16%, a number nobody had before — and where it
 * fires it LOWERS the design flow, which is the conservative direction for a
 * screening tool. One fewer wild over-prediction, no change in failures or in
 * how many plants land on the curve.
 *
 * So: approximately neutral, faintly positive, and cheap. It stays because the
 * gauge-level justification for it is independent and still holds, and because
 * a measured "no harm" is the bar a guard has to clear — not a measured gain.
 * If it had cost anything it would have gone.
 *
 * NOT SWITCHED. THE A/B WAS OWED, IT HAS NOW BEEN RUN, AND THE ANSWER IS NO.
 *
 * The blocker was the rate-limited discharge service; the local GloFAS store
 * removed it. checks/dryshare-vs-gauges.mjs scores both references at 74 DHM
 * gauges on the dry-season energy share — "the firm-flow end is where it
 * matters", by this comment's own argument — correcting where judgeShape flags,
 * exactly as the app does:
 *
 *                          national curve      Modified HYDEST per catchment
 *   Pelton  6+6         bias -3.7pt  err 5.1     bias -4.0pt  err 5.1
 *   Pelton  8+4              -3.1        4.3          -4.0        4.6
 *   Francis 6+6              -5.6        8.8          -6.7        8.8
 *   Francis 8+4              -3.9        6.8          -5.0        7.1
 *
 * The national curve is better or level on bias in all four and never worse on
 * typical error. The per-catchment curve does produce slightly fewer false
 * qualifications, but that is its extra pessimism showing up as caution, not
 * better discrimination — it moves every site the same way.
 *
 * WHY THIS DOES NOT CONTRADICT THE TABLE ABOVE, which had the site-specific
 * curve winning at every exceedance. That table asks a different question: how
 * well does a regression PREDICT AN ABSOLUTE FLOW at an ungauged site. Here the
 * curve is used only as a SHAPE TEMPLATE, remapping a series whose mean is
 * already correct because the network supplied it. A curve can be the better
 * predictor and the worse template, and those are separate jobs — the note used
 * to conflate them. For anything that reads a flow straight off a regression,
 * the table above still stands.
 */
export const NATIONAL_SHAPE = (() => {
  const cols: number[][] = POINTS.map(() => []);
  let stations = 0;
  for (const s of records.stations as {
    completeYears?: number;
    monthly?: number[];
    q?: Record<string, number>;
  }[]) {
    if ((s.completeYears ?? 0) < MIN_COMPLETE_YEARS || !s.monthly || !s.q) continue;
    const mean = s.monthly.reduce((a, b) => a + b, 0) / 12;
    if (!(mean > 0)) continue;
    const vals = KEYS.map((k) => s.q![k]);
    if (vals.some((v) => !(v > 0))) continue;
    vals.forEach((v, i) => cols[i].push(v / mean));
    stations++;
  }
  const ratio: number[] = [];
  const low: number[] = [];
  const high: number[] = [];
  cols.forEach((c) => {
    const s = [...c].sort((a, b) => a - b);
    ratio.push(percentile(s, 0.5));
    low.push(percentile(s, 0.1));
    high.push(percentile(s, 0.9));
  });
  return { points: POINTS, ratio, low, high, stations } as const;
})();

/** Log-linear interpolation of a Q/mean ratio at an arbitrary exceedance. */
function ratioAt(table: readonly number[], p: number): number {
  const pts = NATIONAL_SHAPE.points;
  if (p <= pts[0]) return table[0];
  if (p >= pts[pts.length - 1]) return table[table.length - 1];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (p >= pts[i] && p <= pts[i + 1]) {
      const t = (p - pts[i]) / (pts[i + 1] - pts[i]);
      return Math.exp(Math.log(table[i]) + t * (Math.log(table[i + 1]) - Math.log(table[i])));
    }
  }
  return table[table.length - 1];
}

export type ShapeVerdict = {
  /** The design exceedance this verdict was formed at, as a fraction. */
  exceedance: number;
  /** The series' own Q/mean at the design exceedance. */
  ratio: number;
  /** What Nepali gauges do at that exceedance: [p10, median, p90]. */
  band: [number, number, number];
  /** True when the modelled shape sits outside the measured range. */
  implausible: boolean;
  /** Factor the correction applies to design flow. 1 when it does not fire. */
  designFactor: number;
  stations: number;
};

/**
 * Is this series' spread one a Nepali river actually exhibits?
 *
 * `exceedance` is the design exceedance the scheme is being sized at, because
 * that is the point on the curve the answer depends on.
 */
export function judgeShape(series: readonly number[], exceedance: number): ShapeVerdict | null {
  if (series.length < 365) return null;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  if (!(mean > 0)) return null;
  // Descending: index k is the flow exceeded on (k+1)/n of days.
  const sorted = [...series].sort((a, b) => b - a);
  const q = sorted[Math.min(sorted.length - 1, Math.floor(exceedance * (sorted.length - 1)))];
  if (!(q > 0)) return null;

  const ratio = q / mean;
  const band: [number, number, number] = [
    ratioAt(NATIONAL_SHAPE.low, exceedance),
    ratioAt(NATIONAL_SHAPE.ratio, exceedance),
    ratioAt(NATIONAL_SHAPE.high, exceedance),
  ];
  const implausible = ratio < band[0] || ratio > band[2];
  return {
    exceedance,
    ratio,
    band,
    implausible,
    designFactor: implausible ? band[1] / ratio : 1,
    stations: NATIONAL_SHAPE.stations,
  };
}

/**
 * Remap a series onto Nepal's measured flow-duration shape, preserving both the
 * mean and the day order.
 *
 * Quantile mapping: each day keeps its RANK in the record and is given the flow
 * a Nepali river of this mean actually shows at that rank. Outside 5%-95% the
 * published curve stops, so the tail keeps the model's own relative shape scaled
 * by the boundary correction — floods above Q5 are spilled by a run-of-river
 * plant anyway, and flows below Q95 are under the turbine's minimum, so neither
 * tail earns an invented number.
 */
export function correctShape(
  series: readonly number[],
  /** The design exceedance the result is judged at — the same one that flagged it. */
  exceedance: number
): number[] {
  const n = series.length;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  if (!(mean > 0)) return [...series];

  // Rank each day: order[0] is the index of the wettest day.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => series[b] - series[a]);

  const LO = NATIONAL_SHAPE.points[0];
  const HI = NATIONAL_SHAPE.points[NATIONAL_SHAPE.points.length - 1];
  // Scale at the two anchors, used to carry the tails without inventing them.
  const at = (p: number) => {
    const k = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))));
    return series[order[k]];
  };
  const loSrc = at(LO);
  const hiSrc = at(HI);
  const loScale = loSrc > 0 ? (ratioAt(NATIONAL_SHAPE.ratio, LO) * mean) / loSrc : 1;
  const hiScale = hiSrc > 0 ? (ratioAt(NATIONAL_SHAPE.ratio, HI) * mean) / hiSrc : 1;

  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    const p = n > 1 ? k / (n - 1) : 0;
    const day = order[k];
    if (p < LO) out[day] = series[day] * loScale;
    else if (p > HI) out[day] = series[day] * hiScale;
    else out[day] = ratioAt(NATIONAL_SHAPE.ratio, p) * mean;
  }

  // The network owns the magnitude; the correction must not move it.
  const got = out.reduce((a, b) => a + b, 0) / n;
  if (got > 0) for (let i = 0; i < n; i++) out[i] *= mean / got;

  /**
   * A CORRECTION THAT DID NOT CORRECT IS NOT APPLIED.
   *
   * The middle of the curve is mapped onto the national shape, but the tails
   * keep the record's own relative form and the whole series is then rescaled
   * to hold the mean. Where the top 5% of days carry most of the volume — a
   * spike record — that untouched tail dominates the rescale and drags the
   * newly-correct middle DOWN with it. Measured on a 3,650-day spike series,
   * Q40/mean began at 0.1545 against a national median of 0.5930, was reported
   * as corrected by 3.839×, and ended at 0.02985: five times further from
   * plausible than it started. In randomized probes 25 of 40 flagged series
   * were still outside the band afterwards.
   *
   * So the result is checked against the same band that flagged the input, and
   * a correction that did not move the curve closer is discarded. The caller
   * then runs the record as it stands, which is honest: the shape is doubtful
   * and this method could not fix it.
   */
  const closeness = (candidate: readonly number[]) => {
    const v = judgeShape(candidate, exceedance);
    // No verdict means no evidence of improvement, so it does not count as one.
    return v ? Math.abs(Math.log(v.ratio / v.band[1])) : Infinity;
  };
  return closeness(out) < closeness(series) ? out : [...series];
}
