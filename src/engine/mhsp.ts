/**
 * MHSP (NEA 1997) — Nepal's second regional method for ungauged catchments.
 *
 * WHY A SECOND ONE. The app already carries WECS/DHM 1990 (see hydest.ts).
 * Nepali feasibility practice does not pick one regional regression and trust
 * it; DoED's study guidelines expect a site to be estimated by more than one
 * applicable method, and the design flow is then argued from the spread. A
 * licensing-stage workbook for a real 7.4 km² scheme (Dorje Khola) runs
 * Modified HYDEST and MHSP side by side and adopts the mean of the two — and
 * those two disagree on Q45 by a factor of 2.4. That spread IS the answer at
 * an ungauged site, and an app that shows one number is hiding it.
 *
 *   Q_month = C × A^a1 × MMP^a2
 *
 * A is the total catchment in km² and MMP the mean MONSOON precipitation in
 * mm. Note a2 is zero for January through May: like WECS/DHM, the dry season
 * falls out of catchment area alone, needing no rainfall layer at all.
 *
 * WHAT THIS IS NOT. A regional regression is not a gauge record. Where a DHM
 * station transfers cleanly (see dhm.ts) the measured record governs and this
 * stays a cross-check.
 *
 * SOURCE: Medium Hydropower Study Project, Nepal Electricity Authority, 1997.
 * Coefficients transcribed from a licensing-stage feasibility workbook and
 * verified by reproducing that workbook's own twelve monthly flows to 1e-6
 * (checks/mhsp.check.ts).
 */

export const MHSP_PROVENANCE = {
  method: 'Medium Hydropower Study Project (MHSP), Nepal Electricity Authority, 1997',
  equations: {
    monthly: 'Qmonth = C × A^a1 × MMP^a2',
    q45: 'Q45 = 0.0089146 × A^0.9239 × MMP^0.2018  (NEA daily flow-duration regression)',
  },
  interpretation:
    'Regional regression for ungauged Nepali catchments, used alongside WECS/DHM as a second opinion. Not a gauge record and not a project flow series.',
  verified: 'Reproduces the Dorje Khola HPP licensing workbook to 1e-6.',
} as const;

/** C, a1 (area), a2 (monsoon rainfall). Index 0 = January. */
const MONTHLY: readonly (readonly [number, number, number])[] = [
  [0.03117, 0.8644, 0], // Jan
  [0.02417, 0.8752, 0], // Feb
  [0.02053, 0.8902, 0], // Mar
  [0.01783, 0.9558, 0], // Apr
  [0.01193, 0.9657, 0], // May
  [0.01135, 0.9466, 0.2402], // Jun
  [0.01641, 0.9216, 0.3534], // Jul
  [0.02592, 0.9095, 0.3242], // Aug
  [0.02206, 0.8963, 0.3217], // Sep
  [0.01504, 0.8772, 0.2848], // Oct
  [0.00792, 0.8804, 0.2707], // Nov
  [0.00538, 0.889, 0.258], // Dec
];

/**
 * Daily flow-duration regressions, NEA. Keyed by exceedance fraction:
 * Q = c × A^b × MMP^a.
 *
 * The workbook this came from does NOT use these. It derives design Q45 by
 * taking a PERCENTILE of the twelve MONTHLY MEANS — a statistic over twelve
 * numbers, not a flow-duration curve — while carrying this proper daily
 * regression on the same sheet, unused. On that project the two differ by 37%.
 *
 * Scored against 64 gauges (checks/design-flow-vs-gauges.mjs) the two are more
 * evenly matched than that criticism suggests: both land at a 1.49x typical
 * error. The regression is the less biased of the pair (1.08x against 1.18x)
 * and lands inside a factor of two more often (84% against 80%), but the
 * percentile is actually the more precise near the centre (39% within +/-25%
 * against 33%). The honest verdict is that the sheet's shortcut is defensible
 * and its bias is the part worth fixing, not that it is wrong.
 */
const FDC: readonly (readonly [number, number, number, number])[] = [
  // [exceedance, b (area), a (MMP), c]
  [0.0, 0.812, 0.5337, 0.0614105],
  [0.25, 0.9279, 0.2986, 0.0124336],
  [0.45, 0.9239, 0.2018, 0.0089146],
  [0.65, 0.9044, 0, 0.0248313],
  [0.85, 0.9256, 0, 0.0144905],
  [0.95, 0.9531, 0, 0.0086449],
];

export type MhspScreen = {
  /** Twelve mean monthly flows, m³/s. Index 0 = January. */
  months: number[];
  /** Mean of the twelve monthly means, m³/s. */
  annualMeanCms: number;
  driest: { month: number; cms: number };
  /** Daily flow-duration points, ascending exceedance. */
  fdc: { p: number; cms: number }[];
  provenance: typeof MHSP_PROVENANCE;
};

/**
 * Run MHSP for a catchment.
 *
 * `mmpMm` is mean monsoon (Jun–Sep) precipitation. Without it the seven
 * monsoon-dependent months are absent rather than guessed — the same honesty
 * rule hydest.ts follows — and so are the two wettest FDC points.
 */
export function mhspScreen(totalKm2: number, mmpMm?: number): MhspScreen | null {
  if (!(totalKm2 > 0)) return null;

  const months: number[] = [];
  for (const [c, a1, a2] of MONTHLY) {
    if (a2 !== 0 && !(mmpMm && mmpMm > 0)) continue;
    months.push(c * Math.pow(totalKm2, a1) * (a2 === 0 ? 1 : Math.pow(mmpMm as number, a2)));
  }
  if (!months.length) return null;

  // Only complete when all twelve are present; a five-month mean is not annual.
  const annualMeanCms =
    months.length === 12 ? months.reduce((a, b) => a + b, 0) / 12 : Number.NaN;

  let driestIndex = 0;
  for (let i = 1; i < months.length; i++) if (months[i] < months[driestIndex]) driestIndex = i;

  const fdc: { p: number; cms: number }[] = [];
  for (const [p, b, a, c] of FDC) {
    if (a !== 0 && !(mmpMm && mmpMm > 0)) continue;
    fdc.push({
      p,
      cms: c * Math.pow(totalKm2, b) * (a === 0 ? 1 : Math.pow(mmpMm as number, a)),
    });
  }

  return {
    months,
    annualMeanCms,
    driest: { month: driestIndex, cms: months[driestIndex] },
    fdc,
    provenance: MHSP_PROVENANCE,
  };
}

/**
 * Design discharge at a given exceedance, from the NEA daily flow-duration
 * regressions, log-interpolated between the published points.
 *
 * Log space, not linear: a flow-duration curve is close to log-linear over a
 * span like 25%–65%, and interpolating a discharge linearly across a 20-point
 * gap systematically overstates it.
 */
export function mhspFlowAtExceedance(
  totalKm2: number,
  exceedance: number,
  mmpMm?: number
): number | null {
  const screen = mhspScreen(totalKm2, mmpMm);
  if (!screen || screen.fdc.length < 2) return null;
  const f = screen.fdc;
  if (exceedance <= f[0].p) return f[0].cms;
  const last = f[f.length - 1];
  if (exceedance >= last.p) return last.cms;
  for (let i = 0; i + 1 < f.length; i++) {
    const a = f[i];
    const b = f[i + 1];
    if (exceedance >= a.p && exceedance <= b.p) {
      const t = (exceedance - a.p) / (b.p - a.p);
      return Math.exp(Math.log(a.cms) + t * (Math.log(b.cms) - Math.log(a.cms)));
    }
  }
  return null;
}
