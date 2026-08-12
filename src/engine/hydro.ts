/**
 * Hydropower math. Pure functions, no I/O, no DOM — so `hydro.check.ts` can assert on them.
 *
 * Conventions frozen here on purpose (see PHASE1-REPORT.md §6):
 *   rho = 1000 kg/m3, g = 9.81 m/s2  — the ESHA 2004 engineering convention.
 *   Choosing rho=999.7 / g=9.80665 instead moves any result by 0.064%, so any
 *   cross-convention comparison needs a 0.1% tolerance, not bit equality.
 */

export const RHO = 1000.0; // kg/m3, fresh water, engineering value
export const G = 9.81; // m/s2, ESHA convention
export const HOURS_PER_YEAR = 8760; // 365 d. Leap year is +0.274% — deliberately not switched on.

/** ft3/s -> m3/s. Exactly 0.3048^3 = 0.028316846592. USGS reports discharge in ft3/s. */
export const CFS_TO_CMS = 0.0283168466;

/** USGS no-data sentinel. Feeding this into an FDC sort destroys the low-flow tail. */
export const USGS_NO_DATA = -999999;

/**
 * Real published run-of-river plant, used as the sanity-check benchmark.
 * Chilime, Nepal — operator-published figures. Back-calculating from these gives
 * eta = 0.890 and plant factor 71.2%, both squarely in the expected range.
 * https://www.chilime.com.np/
 */
export const BENCHMARK = {
  name: 'Chilime, Nepal',
  capacityMW: 22.1,
  netHeadM: 337.46,
  designFlowCms: 7.5,
  annualEnergyGWh: 137.9,
} as const;

/**
 * Nepal-specific constants, from the Nepal Electricity Authority Annual Report
 * FY2024/25 unless noted. These are static published figures, so they are
 * hard-coded rather than fetched.
 *
 * The household figure matters: a generic 3,500 kWh/yr default (a European number)
 * overstates Nepali household consumption by ~3.8x and therefore understates
 * "homes powered" by the same factor.
 *   domestic sales     = 11,288 GWh x 42.02%  = 4,743.2 GWh
 *   domestic consumers = 5,707,528 x 91.08%   = 5,198,417
 *   per connection     = 4,743.2e6 / 5,198,417 = 912 kWh/yr  (76 kWh/month)
 * Cross-checks: FY2023/24 gives 862 kWh/yr by the same method (+5.8% YoY), and
 * 76 kWh/month sits in NEA's 51-100 unit retail slab.
 */
export const NEPAL = {
  /** kWh per domestic connection per year, FY2024/25. */
  householdKwhPerYear: 912,
  /** Installed hydro capacity, MW. */
  installedHydroMW: 3389.9,
  /** National hydro generation, GWh/yr. */
  annualHydroGwh: 13959,
  /** NEA run-of-river PPA rate, wet season (mid-Apr to mid-Dec), NPR/kWh. */
  ppaWetNpr: 4.8,
  /** NEA run-of-river PPA rate, dry season (mid-Dec to mid-Apr), NPR/kWh. */
  ppaDryNpr: 8.4,
  /** Typical share of annual energy generated in the dry season for a Nepali ROR. */
  dryEnergyShare: 0.33,
} as const;

/** Fallback household consumption outside Nepal, kWh/yr. Roughly a European figure. */
export const DEFAULT_HOUSEHOLD_KWH = 3500;

export type FdcPoint = {
  /** Discharge, m3/s. Sorted descending. */
  q: number;
  /** Exceedance probability, 0..1. Weibull plotting position m/(n+1). */
  p: number;
};

export type PlantParams = {
  /** Gross head between intake and powerhouse, m. */
  grossHeadM: number;
  /** Hydraulic losses as a fraction of gross head (penstock friction etc). */
  headLossFrac: number;
  /** Overall efficiency: turbine x gearbox x generator x transformer. */
  efficiency: number;
  /** Turbine design (maximum) flow, m3/s. */
  designFlowCms: number;
  /** Environmental / residual flow left in the river, m3/s. Subtracted first. */
  residualFlowCms: number;
  /** Turbine minimum operating flow, as a fraction of design flow. Below this the unit stops. */
  minFlowFrac: number;
};

/** Net head after hydraulic losses. */
export function netHead(p: Pick<PlantParams, 'grossHeadM' | 'headLossFrac'>): number {
  return p.grossHeadM * (1 - p.headLossFrac);
}

/**
 * P = rho * g * Q * H * eta, in watts.
 * Q in m3/s, H is NET head in m, eta dimensionless.
 * (kg/m3)(m/s2)(m3/s)(m) = kg*m2/s3 = W.
 */
export function powerW(qCms: number, netHeadM: number, efficiency: number): number {
  if (!(qCms > 0) || !(netHeadM > 0)) return 0;
  return RHO * G * qCms * netHeadM * efficiency;
}

/**
 * Flow actually passing through the turbine, given the three constraints that
 * separate a real plant from `rho*g*Q*H`. Order of operations is not negotiable:
 * residual flow comes out of the river first, then the turbine cap, then the
 * minimum-flow shutdown.
 */
export function turbineFlow(riverQCms: number, p: PlantParams): number {
  const available = Math.max(0, riverQCms - p.residualFlowCms);
  const throughTurbine = Math.min(available, p.designFlowCms);
  if (throughTurbine < p.minFlowFrac * p.designFlowCms) return 0; // unit off
  return throughTurbine;
}

/**
 * Build a flow-duration curve from a daily discharge series.
 * Non-finite values and the USGS -999999 sentinel are dropped. Negative discharge
 * (real at tidally influenced gauges) is kept in the series but yields zero power.
 */
export function buildFdc(valuesCms: readonly number[]): FdcPoint[] {
  const clean = valuesCms.filter((v) => Number.isFinite(v) && v > USGS_NO_DATA + 1);
  if (clean.length === 0) return [];
  const sorted = Float64Array.from(clean).sort(); // ascending
  const n = sorted.length;
  const out: FdcPoint[] = new Array(n);
  // Rank 1 = largest. Weibull plotting position p = m / (n + 1).
  for (let m = 1; m <= n; m++) {
    out[m - 1] = { q: sorted[n - m], p: m / (n + 1) };
  }
  return out;
}

/**
 * Discharge at a given exceedance probability, linearly interpolated.
 * `exceedance` is a fraction (0.5 = Q50, the median flow).
 */
export function flowAtExceedance(fdc: readonly FdcPoint[], exceedance: number): number {
  if (fdc.length === 0) return NaN;
  if (exceedance <= fdc[0].p) return fdc[0].q;
  const last = fdc[fdc.length - 1];
  if (exceedance >= last.p) return last.q;
  // fdc.p is strictly increasing, so binary search.
  let lo = 0;
  let hi = fdc.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fdc[mid].p <= exceedance) lo = mid;
    else hi = mid;
  }
  const a = fdc[lo];
  const b = fdc[hi];
  const t = (exceedance - a.p) / (b.p - a.p);
  return a.q + t * (b.q - a.q);
}

export type EnergyResult = {
  /** Annual energy, GWh/yr. */
  gwhPerYear: number;
  /** Mean power over the year, W. */
  meanPowerW: number;
  /** Rated power at design flow, W. */
  ratedPowerW: number;
  /**
   * Gross hydrologic plant factor: energy / (rated * 8760).
   * Contains hydrology ONLY — no outages, no curtailment, no station service.
   * Real capacity factor = this x availability (0.90-0.97 for hydro).
   */
  grossPlantFactor: number;
  /** Fraction of the record on which the turbine produced anything. */
  utilisationFrac: number;
  /** Net head used, m. */
  netHeadM: number;
};

/**
 * Annual energy by averaging power over every day in the record.
 *
 * Each daily value represents an equal slice of time, so the arithmetic mean of
 * per-day power IS the integral of power over the 0..1 exceedance axis — computed
 * exactly rather than approximated. `energyFromFdcTrapezoid` does the same integral
 * the textbook way; hydro.check.ts asserts the two agree.
 */
export function annualEnergy(seriesCms: readonly number[], p: PlantParams): EnergyResult {
  const h = netHead(p);
  const clean = seriesCms.filter((v) => Number.isFinite(v) && v > USGS_NO_DATA + 1);
  const ratedPowerW = powerW(p.designFlowCms, h, p.efficiency);
  if (clean.length === 0) {
    return {
      gwhPerYear: 0,
      meanPowerW: 0,
      ratedPowerW,
      grossPlantFactor: 0,
      utilisationFrac: 0,
      netHeadM: h,
    };
  }
  let sumW = 0;
  let running = 0;
  for (const q of clean) {
    const qt = turbineFlow(q, p);
    if (qt > 0) running++;
    sumW += powerW(qt, h, p.efficiency);
  }
  const meanPowerW = sumW / clean.length;
  return {
    gwhPerYear: (meanPowerW * HOURS_PER_YEAR) / 1e9,
    meanPowerW,
    ratedPowerW,
    grossPlantFactor: ratedPowerW > 0 ? meanPowerW / ratedPowerW : 0,
    utilisationFrac: running / clean.length,
    netHeadM: h,
  };
}

/**
 * The same annual energy, integrated over the exceedance axis by the trapezoidal
 * rule — the form the hydrology textbooks state. Endpoints are extended flat to
 * p=0 and p=1 because the Weibull positions never reach either bound.
 */
export function energyFromFdcTrapezoid(fdc: readonly FdcPoint[], p: PlantParams): number {
  if (fdc.length === 0) return 0;
  const h = netHead(p);
  const pw = (pt: FdcPoint) => powerW(turbineFlow(pt.q, p), h, p.efficiency);
  let integral = 0;
  // [0, p_1] flat at the first point.
  integral += fdc[0].p * pw(fdc[0]);
  for (let i = 1; i < fdc.length; i++) {
    integral += (fdc[i].p - fdc[i - 1].p) * 0.5 * (pw(fdc[i - 1]) + pw(fdc[i]));
  }
  // [p_n, 1] flat at the last point.
  const last = fdc[fdc.length - 1];
  integral += (1 - last.p) * pw(last);
  return (integral * HOURS_PER_YEAR) / 1e9; // GWh/yr
}

/**
 * Split annual energy into NEA's PPA seasons.
 * Wet = mid-April to mid-December, dry = mid-December to mid-April, per the tariff
 * wording in Nepali run-of-river PPAs. Day-level, not month-level, because the
 * boundaries fall mid-month.
 */
export function wetDryEnergy(
  dates: readonly string[],
  valuesCms: readonly number[],
  p: PlantParams
): { wetGwh: number; dryGwh: number; wetDays: number; dryDays: number } {
  const h = netHead(p);
  let wetW = 0;
  let dryW = 0;
  let wetDays = 0;
  let dryDays = 0;
  for (let i = 0; i < valuesCms.length; i++) {
    const v = valuesCms[i];
    if (!Number.isFinite(v) || v <= USGS_NO_DATA + 1) continue;
    const d = dates[i] ?? '';
    const m = Number(d.slice(5, 7));
    const day = Number(d.slice(8, 10));
    if (!m) continue;
    const isWet = (m > 4 || (m === 4 && day >= 15)) && (m < 12 || (m === 12 && day < 15));
    const w = powerW(turbineFlow(v, p), h, p.efficiency);
    if (isWet) {
      wetW += w;
      wetDays++;
    } else {
      dryW += w;
      dryDays++;
    }
  }
  const total = wetDays + dryDays;
  if (total === 0) return { wetGwh: 0, dryGwh: 0, wetDays: 0, dryDays: 0 };
  // Mean power in each season, scaled by that season's share of a year.
  const wetGwh = wetDays > 0 ? ((wetW / wetDays) * HOURS_PER_YEAR * (wetDays / total)) / 1e9 : 0;
  const dryGwh = dryDays > 0 ? ((dryW / dryDays) * HOURS_PER_YEAR * (dryDays / total)) / 1e9 : 0;
  return { wetGwh, dryGwh, wetDays, dryDays };
}

/** Mean of a series, ignoring non-finite values and the USGS sentinel. */
export function mean(values: readonly number[]): number {
  const clean = values.filter((v) => Number.isFinite(v) && v > USGS_NO_DATA + 1);
  if (clean.length === 0) return NaN;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

/**
 * Seasonality: ratio of the wettest to the driest calendar month, by mean flow.
 * `dates` must be parallel to `values`. Returns NaN if fewer than 2 months present.
 */
export function seasonalRatio(
  dates: readonly string[],
  values: readonly number[]
): { ratio: number; wettestMonth: number; driestMonth: number; monthlyMeans: number[] } {
  const sums = new Array(12).fill(0);
  const counts = new Array(12).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || v <= USGS_NO_DATA + 1) continue;
    const m = Number(dates[i]?.slice(5, 7)) - 1;
    if (m < 0 || m > 11) continue;
    sums[m] += v;
    counts[m]++;
  }
  const monthlyMeans = sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : NaN));
  const present = monthlyMeans.filter(Number.isFinite);
  if (present.length < 2) {
    return { ratio: NaN, wettestMonth: -1, driestMonth: -1, monthlyMeans };
  }
  const hi = Math.max(...present);
  const lo = Math.min(...present);
  return {
    ratio: lo > 0 ? hi / lo : Infinity,
    wettestMonth: monthlyMeans.indexOf(hi),
    driestMonth: monthlyMeans.indexOf(lo),
    monthlyMeans,
  };
}

/**
 * Residual (environmental) flow bases.
 *
 * `meanAnnual` — 10% of mean annual flow. A common temperate default, and a BAD one
 * for monsoon rivers: the mean is dominated by the flood season, so 10% of it can
 * exceed the entire dry-season flow and zero out firm power.
 * `minMonth`   — 10% of the lowest monthly mean. This is the basis Nepal's hydropower
 * licensing uses, and it behaves sensibly on strongly seasonal rivers.
 */
export type ResidualBasis = 'meanAnnual' | 'minMonth' | 'manual';

/** Lowest monthly mean flow in the record. NaN when fewer than one month is present. */
export function minMonthlyMean(dates: readonly string[], values: readonly number[]): number {
  const { monthlyMeans } = seasonalRatio(dates, values);
  const present = monthlyMeans.filter(Number.isFinite);
  return present.length === 0 ? NaN : Math.min(...present);
}

/** Residual flow implied by a basis, m3/s. Returns NaN when it cannot be derived. */
export function residualForBasis(
  basis: ResidualBasis,
  dates: readonly string[],
  values: readonly number[]
): number {
  if (basis === 'meanAnnual') return mean(values) * 0.1;
  if (basis === 'minMonth') return minMonthlyMean(dates, values) * 0.1;
  return NaN;
}

/** Great-circle distance in km. Used for "nearest gauge, N km away". */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
