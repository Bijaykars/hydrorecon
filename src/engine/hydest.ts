/**
 * HYDEST — Nepal's own ungauged-flow method (WECS/DHM 1990).
 *
 * Every flow number in this app so far comes from a global model: GloFAS, whose
 * cell is often not even on the right channel, and HydroRIVERS, whose long-term
 * mean comes from a global water balance. Neither is calibrated to Nepal, which
 * is why the app reports a +/-50% band on flow and says so.
 *
 * HYDEST is different in kind. It is a regression fitted to Nepal's own gauged
 * records, published by the Water and Energy Commission Secretariat with DHM,
 * and it is the method every Nepali feasibility study actually uses for an
 * ungauged site. It is not better than a gauge. It is a genuinely independent
 * third opinion, from data that was measured in these rivers.
 *
 * WHAT IS IMPLEMENTED, AND WHAT IS NOT
 *
 * The monthly equation is
 *
 *   Q_month = C · A_total^A1 · (A_below5000m + 1)^A2 · MMP^A3
 *
 * and MMP — mean monsoon precipitation — is not yet available, so the six months
 * with a non-zero A3 are deliberately absent rather than guessed. What survives
 * is exactly the part that needs no rainfall data at all:
 *
 *   JANUARY TO MAY, where A3 is zero. These are the dry-season months that set
 *   firm power, that Nepal's PPA pays 8.40 NPR/kWh for against 4.80 in the wet
 *   season, and that decide whether a scheme can be financed. It is the half
 *   worth having first.
 *
 *   DESIGN FLOODS, which depend only on the area below 3000 m. Spillway and
 *   diversion sizing, and the single number most likely to be asked for after
 *   capacity.
 *
 * Coefficients are from WECS/DHM 1990 via DoED's "Guidelines for Study of
 * Hydropower Projects" (2006), recovered in docs/research/2026-08-12-data-hunt.md
 * §9 and cross-checked against a second published source.
 */

/** Mean monthly flow coefficients. Index 0 = January. */
type MonthCoef = { C: number; a1: number; a2: number; a3: number };

const MONTHLY: MonthCoef[] = [
  { C: 0.0142, a1: 0, a2: 0.9777, a3: 0 }, // Jan
  { C: 0.0122, a1: 0, a2: 0.9766, a3: 0 }, // Feb
  { C: 0.01, a1: 0, a2: 0.9948, a3: 0 }, // Mar
  { C: 0.008, a1: 0, a2: 1.0435, a3: 0 }, // Apr
  { C: 0.0084, a1: 0, a2: 1.0898, a3: 0 }, // May
  { C: 0.0069, a1: 0.9968, a2: 0, a3: 0.261 }, // Jun
  { C: 0.0212, a1: 0, a2: 1.0093, a3: 0.2523 }, // Jul
  { C: 0.0255, a1: 0, a2: 0.9963, a3: 0.262 }, // Aug
  { C: 0.0168, a1: 0, a2: 0.9894, a3: 0.2878 }, // Sep
  { C: 0.0097, a1: 0, a2: 0.988, a3: 0.2508 }, // Oct
  { C: 0.0018, a1: 0.9605, a2: 0, a3: 0.391 }, // Nov
  { C: 0.0015, a1: 0.9605, a2: 0, a3: 0.3607 }, // Dec
];

export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** The months HYDEST can give without precipitation data — a3 is zero. */
export const RAINFALL_FREE_MONTHS = MONTHLY.map((m, i) => (m.a3 === 0 ? i : -1)).filter(
  (i) => i >= 0
);

export type HydestInput = {
  /** Total upstream catchment, km². */
  totalKm2: number;
  /** Upstream catchment lying below 5000 m, km². */
  below5000Km2: number;
  /** Upstream catchment lying below 3000 m, km². */
  below3000Km2: number;
};

/**
 * Mean monthly flow, m³/s, for the months that need no rainfall input.
 *
 * Returns null for the six monsoon-influenced months rather than substituting a
 * value for MMP. A wrong monsoon flow would be worse than an absent one: it
 * would flow straight into annual energy and make the whole estimate look
 * better founded than it is.
 */
export function monthlyFlow(input: HydestInput, month: number): number | null {
  const c = MONTHLY[month];
  if (!c || c.a3 !== 0) return null;
  if (!(input.totalKm2 > 0) || !(input.below5000Km2 >= 0)) return null;
  return (
    c.C * input.totalKm2 ** c.a1 * (input.below5000Km2 + 1) ** c.a2
  );
}

/** Every month HYDEST can answer for, in order. */
export function drySeasonFlows(input: HydestInput): { month: number; cms: number }[] {
  const out: { month: number; cms: number }[] = [];
  for (const m of RAINFALL_FREE_MONTHS) {
    const q = monthlyFlow(input, m);
    if (q !== null && Number.isFinite(q)) out.push({ month: m, cms: q });
  }
  return out;
}

/**
 * The lowest mean monthly flow HYDEST predicts — the dry-season floor.
 *
 * This is the number that decides firm power and residual-flow compliance, and
 * it is the one an uncalibrated global model is least likely to get right, since
 * low flows are where model error is proportionally largest.
 */
export function driestMonthFlow(input: HydestInput): { month: number; cms: number } | null {
  const all = drySeasonFlows(input);
  if (all.length === 0) return null;
  return all.reduce((a, b) => (b.cms < a.cms ? b : a));
}

// ---------------------------------------------------------------------------
// Design floods — WECS/DHM 1990, on the area below 3000 m
// ---------------------------------------------------------------------------

/**
 * Standard normal deviates for the return periods WECS tabulates.
 * Q_T = exp(ln Q2 + S·sigma), with sigma = ln(Q100/Q2)/2.326 — a two-point
 * log-normal fit, which is what makes Q2 and Q100 sufficient for all of them.
 */
const FLOOD_S: Record<number, number> = {
  2: 0,
  10: 1.282,
  20: 1.645,
  50: 2.054,
  100: 2.326,
  200: 2.576,
  500: 2.787,
};

export const RETURN_PERIODS = [2, 10, 20, 50, 100, 200, 500] as const;

/**
 * Design flood peak, m³/s, for a return period in years.
 *
 * Sizing a spillway or a diversion needs this, and it depends only on the
 * catchment below 3000 m — no rainfall term at all. Above that elevation the
 * catchment is snow and ice, and contributes to the annual volume without
 * contributing much to a rainfall flood peak, which is why WECS excludes it.
 */
export function designFlood(input: HydestInput, returnPeriodYears: number): number | null {
  const s = FLOOD_S[returnPeriodYears];
  if (s === undefined || !(input.below3000Km2 >= 0)) return null;
  const a = input.below3000Km2;
  const q2 = 1.8767 * (a + 1) ** 0.8737;
  const q100 = 14.63 * (a + 1) ** 0.7342;
  if (!(q2 > 0) || !(q100 > q2)) return null;
  const sigma = Math.log(q100 / q2) / 2.326;
  return Math.exp(Math.log(q2) + s * sigma);
}

/** Mean of a daily series over one calendar month, for a like-for-like compare. */
export function monthMean(
  dates: readonly string[],
  values: readonly number[],
  month: number
): number {
  const want = String(month + 1).padStart(2, '0');
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    if (dates[i]?.slice(5, 7) !== want) continue;
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : NaN;
}

/**
 * How far the app's own flow figure sits from Nepal's national method.
 *
 * Returned as a ratio rather than a verdict. HYDEST is a regression with real
 * scatter and is not ground truth either — but when a global model and a
 * nationally fitted regression disagree by more than a factor of two about the
 * dry season, that is worth putting in front of the engineer rather than
 * averaging away.
 */
export function drySeasonAgreement(
  hydestCms: number,
  modelledCms: number
): { ratio: number; agree: boolean } | null {
  if (!(hydestCms > 0) || !(modelledCms > 0)) return null;
  const ratio = Math.max(hydestCms / modelledCms, modelledCms / hydestCms);
  return { ratio, agree: ratio <= 2 };
}
