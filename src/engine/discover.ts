/**
 * Scheme discovery — the capability the whole product is for.
 *
 * Given one click on a river, walk downstream and search intake × powerhouse
 * pairs along the real channel, then keep the alternatives that represent
 * genuine trade-offs rather than forcing one artificial optimum.
 *
 * The search shape follows GRASS r.green.hydro.optimal (a grid search over
 * intake position × plant length, maximising drop × flow), with two corrections
 * that module does not make: residual flow is removed before the turbine, and
 * the objective is annual energy through a real flow-duration curve rather than
 * head × mean flow. See docs/research/2026-08-12-algorithms.md §1.
 */
import { annualEnergy, buildFdc, flowAtExceedance, type FdcPoint, type PlantParams } from './hydro.ts';
import { turbineCurve, type TurbineType } from './turbine.ts';

export type SchemeInput = {
  /** Evenly spaced points down the river, with elevation attached. */
  path: { km: number; lat: number; lon: number; elevationM: number; meanCms: number }[];
  /** Daily discharge at the clicked point, m³/s. */
  series: number[];
  /** HydroRIVERS mean at the clicked point, used to rescale the series along the river. */
  clickMeanCms: number;
  /** Residual flow at the clicked point, m³/s. */
  residualCms: number;
  exceedance: number;
  efficiency: number;
  headLossFrac: number;
  minFlowFrac: number;
};

export type Scheme = {
  /** Index into `path` for the intake and the powerhouse. */
  i: number;
  j: number;
  intake: { lat: number; lon: number };
  power: { lat: number; lon: number };
  grossHeadM: number;
  netHeadM: number;
  /** Distance along the river between the two — what a canal or tunnel must span. */
  waterwayKm: number;
  designFlowCms: number;
  residualCms: number;
  capacityMW: number;
  energyGwh: number;
  plantFactor: number;
  /** Average slope of the diverted reach, m per km — how concentrated the drop is. */
  slopeMPerKm: number;
  /** Energy per km of waterway. The efficiency of the civil works. */
  gwhPerKm: number;
  /** Machine chosen for this duty point, null when it falls outside every region. */
  turbine: TurbineType | null;
  /** Best-point turbine efficiency, before the generator. */
  turbinePeak: number;
  /** Why this one is on the list at all. */
  reasons: string[];
};

/** Below this a scheme is not worth listing at screening scale. */
const MIN_HEAD_M = 15;
const MIN_CAPACITY_MW = 0.1;
/** Plausible run-of-river waterway lengths. */
const MIN_LEN_KM = 0.4;
const MAX_LEN_KM = 14;

/**
 * Rank by more than one thing, then keep only what nothing else beats outright.
 *
 * A scheme survives when no other scheme is at least as good on every axis and
 * better on one. That is what stops the list collapsing to a single "best"
 * answer that hides the real choice: more energy nearly always costs more
 * tunnel, and the engineer is the one who should weigh that.
 */
function nonDominated(all: Scheme[]): Scheme[] {
  return all.filter(
    (a) =>
      !all.some(
        (b) =>
          b !== a &&
          b.energyGwh >= a.energyGwh &&
          b.waterwayKm <= a.waterwayKm &&
          b.grossHeadM >= a.grossHeadM &&
          (b.energyGwh > a.energyGwh || b.waterwayKm < a.waterwayKm)
      )
  );
}

/**
 * One intake/powerhouse pair, fully evaluated. Used both by the search and by
 * the panel when a marker is dragged, so a hand-placed scheme and a discovered
 * one are never computed two different ways.
 */
export function evaluate(
  input: SchemeInput,
  i: number,
  j: number,
  qAtClickPre?: number
): Scheme | null {
  const { path, series, clickMeanCms, residualCms, exceedance, efficiency } = input;
  if (i < 0 || j >= path.length || j <= i) return null;
  const zi = path[i].elevationM;
  const zj = path[j].elevationM;
  if (!Number.isFinite(zi) || !Number.isFinite(zj)) return null;

  const qAtClick = qAtClickPre ?? flowAtExceedance(buildFdc(series), exceedance);
  // Only what the intake diverts reaches the turbine, so the record is rescaled
  // to this intake's catchment; tributaries joining below it never arrive.
  const ratio = clickMeanCms > 0 && path[i].meanCms > 0 ? path[i].meanCms / clickMeanCms : 1;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const qDesign = Math.max(0, (qAtClick - residualCms) * ratio);
  if (qDesign <= 0) return null;

  const gross = zi - zj;
  const netForSelection = Math.max(0, gross) * (1 - input.headLossFrac);
  // Pick the machine for this duty point, then let its part-load curve drive
  // every day of the record. `efficiency` is the generator/transformer train
  // that sits behind the runner.
  const curve = turbineCurve(qDesign, netForSelection);

  const params: PlantParams = {
    grossHeadM: Math.max(0, gross),
    headLossFrac: input.headLossFrac,
    // Rated power uses the machine's own best-point efficiency when known.
    efficiency: curve ? curve.peak * efficiency : efficiency,
    designFlowCms: qDesign,
    residualFlowCms: residualCms * ratio,
    minFlowFrac: curve ? curve.minFlowFrac : input.minFlowFrac,
    ...(curve ? { efficiencyAt: (q: number) => curve.at(q) * efficiency } : {}),
  };
  const scaled = ratio === 1 ? series : series.map((v) => v * ratio);
  const e = annualEnergy(scaled, params);
  const waterwayKm = Math.max(1e-6, path[j].km - path[i].km);

  return {
    i,
    j,
    intake: { lat: path[i].lat, lon: path[i].lon },
    power: { lat: path[j].lat, lon: path[j].lon },
    grossHeadM: gross,
    netHeadM: e.netHeadM,
    waterwayKm,
    designFlowCms: qDesign,
    residualCms: residualCms * ratio,
    capacityMW: e.ratedPowerW / 1e6,
    energyGwh: e.gwhPerYear,
    plantFactor: e.grossPlantFactor,
    slopeMPerKm: gross / waterwayKm,
    gwhPerKm: e.gwhPerYear / waterwayKm,
    turbine: curve?.type ?? null,
    turbinePeak: curve?.peak ?? efficiency,
    reasons: [],
  };
}

export type DiscoverResult = {
  schemes: Scheme[];
  /** How many intake × powerhouse pairs were actually evaluated. */
  evaluated: number;
  fdcAtClick: FdcPoint[];
};

export function discover(input: SchemeInput): DiscoverResult {
  const { path, series, exceedance } = input;
  const fdcAtClick = buildFdc(series);
  const qAtClick = flowAtExceedance(fdcAtClick, exceedance);

  const n = path.length;
  if (n < 8) return { schemes: [], evaluated: 0, fdcAtClick };

  const spacingKm = path[1].km - path[0].km || 0.12;
  const minSteps = Math.max(2, Math.round(MIN_LEN_KM / spacingKm));
  const maxSteps = Math.max(minSteps + 1, Math.round(MAX_LEN_KM / spacingKm));
  // Coarse stride keeps this interactive: ~every 500 m rather than every sample.
  const stride = Math.max(1, Math.round(0.5 / spacingKm));

  const candidates: Scheme[] = [];
  let evaluated = 0;

  for (let i = 0; i < n - minSteps; i += stride) {
    if (!Number.isFinite(path[i].elevationM)) continue;
    for (let j = i + minSteps; j < Math.min(n, i + maxSteps); j += stride) {
      const s = evaluate(input, i, j, qAtClick);
      if (!s) continue;
      evaluated++;
      if (s.grossHeadM < MIN_HEAD_M || s.capacityMW < MIN_CAPACITY_MW) continue;
      candidates.push(s);
    }
  }

  const survivors = nonDominated(candidates).sort((a, b) => b.energyGwh - a.energyGwh);

  // Thin out near-duplicates: alternatives only mean something if they differ.
  const kept: Scheme[] = [];
  for (const s of survivors) {
    if (
      kept.some(
        (k) =>
          Math.abs(k.energyGwh - s.energyGwh) / Math.max(k.energyGwh, s.energyGwh) < 0.06 &&
          Math.abs(k.waterwayKm - s.waterwayKm) < 0.8
      )
    ) {
      continue;
    }
    kept.push(s);
    if (kept.length >= 8) break;
  }

  return { schemes: label(kept), evaluated, fdcAtClick };
}

/** Say what each surviving alternative is actually best at. */
function label(schemes: Scheme[]): Scheme[] {
  if (schemes.length === 0) return schemes;
  const best = <K extends keyof Scheme>(k: K, dir: 1 | -1) =>
    schemes.reduce((a, b) => ((b[k] as number) * dir > (a[k] as number) * dir ? b : a));

  const mostEnergy = best('energyGwh', 1);
  const shortest = best('waterwayKm', -1);
  const leanest = best('gwhPerKm', 1);
  const steepest = best('slopeMPerKm', 1);
  const highestFactor = best('plantFactor', 1);

  for (const s of schemes) {
    const r: string[] = [];
    if (s === mostEnergy) r.push('most energy');
    if (s === shortest) r.push('shortest waterway');
    if (s === leanest) r.push('most energy per km of waterway');
    if (s === steepest && s !== leanest) r.push('steepest drop');
    if (s === highestFactor && s !== mostEnergy) r.push('steadiest output');
    if (r.length === 0) r.push('a middle trade-off between energy and civil length');
    s.reasons = r;
  }
  return schemes;
}
