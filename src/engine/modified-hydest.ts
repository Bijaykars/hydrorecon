/**
 * Modified HYDEST — the regression a Nepali government office actually uses.
 *
 * Transcribed from the "Modified Hydest" sheet of the Q45 Power Calculation
 * Format workbook, which is reported to be the standard screening method in
 * routine office use. It is NOT the WECS/DHM 1990 set in ./hydest.ts, and the
 * difference is not cosmetic: this one regresses on the catchment's AVERAGE
 * ELEVATION and an ANNUAL wetness index, where 1990 uses monsoon precipitation
 * and carries no elevation term at all.
 *
 * Four inputs, and only four:
 *
 *   catchment area below 3000 m      km2
 *   catchment area below 5000 m      km2
 *   average catchment altitude       m
 *   annual wetness index             mm
 *
 * Two functional forms appear, and which one applies is a property of the month
 * rather than a choice:
 *
 *   log form    exp(S + T*ln(elev) + U*ln(rain) + V*ln(A<3000))
 *   root form   (S + W*sqrt(A<5000))^2
 *
 * March, April and May take the root form and depend on area alone — no
 * elevation, no rainfall. That is the pre-monsoon recession, when what is left
 * in the river is drainage from storage rather than anything this year's
 * weather did, and the regression says so by dropping the weather terms.
 *
 * WHY CARRY IT AT ALL, given the app already has a regional method. An engineer
 * whose screening figure disagrees with the office's spreadsheet needs to know
 * whether the river is different or the method is. Carrying the office's own
 * method answers that directly, and carrying it EXACTLY — same coefficients,
 * same interpolation, no improvements — is what makes the comparison mean
 * anything.
 *
 * Verified against the workbook's own cached results (checks/modified-hydest.check.ts).
 *
 * MEASURED against 94 DHM gauges (checks/smallcatchment-flow.mjs), and it is
 * the best regional method available here — the office's practice is sound:
 *
 *                      median   bias   typ.err   within 2x
 *   ALL (n=94)
 *     Modified HYDEST   1.01x   1.08x    1.48x       82%
 *     MHSP 1997         0.99x   1.18x    1.55x       83%
 *     WECS/DHM 1990     1.06x   1.19x    1.61x       81%
 *     mapped network    0.91x   0.84x    1.58x       85%
 *   under 100 km2 (n=10)
 *     Modified HYDEST   1.24x   1.20x    1.84x       80%
 *     MHSP 1997         1.60x   1.63x    2.17x       50%
 *
 * Nationally it is near-unbiased where the other two run 18-19% high, and on
 * the smallest catchments it is the only regression that does not fall apart:
 * 80% within a factor of two where MHSP manages 50%. Weighted by where DoED
 * projects actually sit it returns 1.69x typical error against the mapped
 * network's 1.74x — the first source measured this session to beat the network
 * on the population the tool is aimed at.
 *
 * The elevation term is why. MHSP and WECS/DHM 1990 both scale on area and
 * rainfall alone, so two catchments of equal size and rainfall get equal flow
 * whether one drains a 5,500 m snowfield and the other a 900 m foothill. The
 * small catchments are exactly where that assumption breaks, and it is exactly
 * where the gap in the table is widest.
 */

/** The four inputs the office's sheet asks for, and nothing else. */
export type ModifiedHydestInput = {
  below3000Km2: number;
  below5000Km2: number;
  averageAltitudeM: number;
  annualWetnessMm: number;
};

type Form = 'ln' | 'sqrtArea' | 'sqrtPeak';

type Row = {
  /** Constant term. */
  s: number;
  /** Coefficient on ln(average elevation), or sqrt of it in the peak row. */
  t: number;
  /** Coefficient on ln(annual precipitation), or sqrt of it in the root form. */
  u: number;
  /** Coefficient on ln(area below 3000 m), or sqrt of it in the peak row. */
  v: number;
  /** Coefficient on sqrt(area below 5000 m). */
  w: number;
  form: Form;
  /** Standard error and r2 as published, carried so a panel can show them. */
  stdError: number;
  r2: number;
};

export const MODIFIED_HYDEST_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Mean monthly flow regressions, workbook rows R45:Z56. */
const MONTHLY: readonly Row[] = [
  { s: -16.7, t: 1.36, u: 0.47, v: 0.82, w: 0, form: 'ln', stdError: 16.4, r2: 0.971 },
  { s: -17.2, t: 1.42, u: 0.456, v: 0.814, w: 0, form: 'ln', stdError: 14.7, r2: 0.968 },
  { s: 0.384, t: 0, u: 0, v: 0, w: 0.091, form: 'sqrtArea', stdError: 15.3, r2: 0.966 },
  { s: 0.181, t: 0, u: 0, v: 0, w: 0.104, form: 'sqrtArea', stdError: 21, r2: 0.962 },
  { s: 0.0001, t: 0, u: 0, v: 0, w: 0.136, form: 'sqrtArea', stdError: 42.8, r2: 0.946 },
  { s: -19.5, t: 1.61, u: 0.709, v: 0.872, w: 0, form: 'ln', stdError: 106, r2: 0.941 },
  { s: -16.3, t: 1.26, u: 0.759, v: 0.884, w: 0, form: 'ln', stdError: 195, r2: 0.958 },
  { s: -14.7, t: 1.24, u: 0.622, v: 0.871, w: 0, form: 'ln', stdError: 215, r2: 0.964 },
  { s: -13.7, t: 1.09, u: 0.594, v: 0.872, w: 0, form: 'ln', stdError: 125, r2: 0.977 },
  { s: -15.3, t: 1.21, u: 0.6, v: 0.846, w: 0, form: 'ln', stdError: 74.1, r2: 0.963 },
  { s: -16.7, t: 1.36, u: 0.543, v: 0.826, w: 0, form: 'ln', stdError: 42.5, r2: 0.953 },
  { s: -17, t: 1.39, u: 0.504, v: 0.822, w: 0, form: 'ln', stdError: 23.6, r2: 0.966 },
];

/**
 * Flow-duration regressions, workbook rows R63:Z70.
 *
 * The two ends do not follow the pattern of the middle and are given their own
 * forms in the source: 0% exceedance takes sqrt(elevation) and sqrt(area below
 * 3000 m), and 100% takes sqrt(rainfall) and sqrt(area below 5000 m). They are
 * transcribed as published rather than forced into the common shape.
 */
const FDC: readonly { p: number; row: Row }[] = [
  {
    p: 0,
    row: { s: -12.8, t: 0.366, u: 0, v: 0.529, w: 0, form: 'sqrtPeak', stdError: 527, r2: 0.906 },
  },
  {
    p: 0.05,
    row: { s: -13.6, t: 1.108, u: 0.607, v: 0.874, w: 0, form: 'ln', stdError: 221, r2: 0.963 },
  },
  {
    p: 0.2,
    row: { s: -17, t: 1.3593, u: 0.716, v: 0.883, w: 0, form: 'ln', stdError: 142, r2: 0.967 },
  },
  {
    p: 0.4,
    row: { s: -19, t: 1.554, u: 0.656, v: 0.859, w: 0, form: 'ln', stdError: 68, r2: 0.95 },
  },
  {
    p: 0.6,
    row: { s: -18.3, t: 1.535, u: 0.513, v: 0.832, w: 0, form: 'ln', stdError: 27, r2: 0.96 },
  },
  {
    p: 0.8,
    row: { s: -19.4, t: 1.589, u: 0.559, v: 0.834, w: 0, form: 'ln', stdError: 18, r2: 0.963 },
  },
  {
    p: 0.95,
    row: { s: -21.2, t: 1.732, u: 0.598, v: 0.842, w: 0, form: 'ln', stdError: 14, r2: 0.965 },
  },
  {
    p: 1,
    row: { s: -2.18, t: 0, u: 0.048, v: 0, w: 0.077, form: 'sqrtArea', stdError: 13, r2: 0.945 },
  },
];

const usable = (i: ModifiedHydestInput) =>
  i.below3000Km2 > 0 && i.below5000Km2 > 0 && i.averageAltitudeM > 0 && i.annualWetnessMm > 0;

function apply(row: Row, i: ModifiedHydestInput): number {
  if (row.form === 'sqrtPeak') {
    return (row.s + row.t * Math.sqrt(i.averageAltitudeM) + row.v * Math.sqrt(i.below3000Km2)) ** 2;
  }
  if (row.form === 'sqrtArea') {
    return (row.s + row.u * Math.sqrt(i.annualWetnessMm) + row.w * Math.sqrt(i.below5000Km2)) ** 2;
  }
  return Math.exp(
    row.s +
      row.t * Math.log(i.averageAltitudeM) +
      row.u * Math.log(i.annualWetnessMm) +
      row.v * Math.log(i.below3000Km2)
  );
}

/** Mean monthly flows, m3/s, January first. Null when an input is missing. */
export function modifiedHydestMonthly(i: ModifiedHydestInput): number[] | null {
  if (!usable(i)) return null;
  return MONTHLY.map((row) => apply(row, i));
}

/** Annual mean, m3/s — the twelve monthly means averaged, as the sheet does. */
export function modifiedHydestAnnualMean(i: ModifiedHydestInput): number | null {
  const m = modifiedHydestMonthly(i);
  return m ? m.reduce((a, b) => a + b, 0) / 12 : null;
}

/** The published flow-duration points, as exceedance fraction and flow. */
export function modifiedHydestFdc(i: ModifiedHydestInput): { p: number; cms: number }[] | null {
  if (!usable(i)) return null;
  return FDC.map(({ p, row }) => ({ p, cms: apply(row, i) }));
}

/**
 * Flow at an arbitrary exceedance, m3/s.
 *
 * Linear between the published points, which is what the workbook does for its
 * own headline figure: Q45 is read as Q60 + (Q60 - Q40)/20 * (45 - 60). That is
 * straight-line interpolation in exceedance, not in log flow, and it is
 * reproduced rather than improved on. The point of carrying this method is to
 * reproduce the office's answer; a better interpolation would produce a
 * different number and quietly destroy the comparison this module exists for.
 */
export function modifiedHydestFlowAt(i: ModifiedHydestInput, exceedance: number): number | null {
  const pts = modifiedHydestFdc(i);
  if (!pts) return null;
  if (exceedance <= pts[0].p) return pts[0].cms;
  const last = pts[pts.length - 1];
  if (exceedance >= last.p) return last.cms;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    if (exceedance <= b.p) return a.cms + ((b.cms - a.cms) * (exceedance - a.p)) / (b.p - a.p);
  }
  return last.cms;
}

/** The workbook's headline design flow, Q45. */
export const modifiedHydestQ45 = (i: ModifiedHydestInput) => modifiedHydestFlowAt(i, 0.45);

export const MODIFIED_HYDEST_PROVENANCE = {
  method: 'Modified HYDEST',
  inputs:
    'catchment area below 3000 m and below 5000 m, average catchment altitude, annual wetness index',
  note: 'Transcribed from the Q45 Power Calculation Format workbook, reported to be in routine Nepali office use.',
} as const;
