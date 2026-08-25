/**
 * Is Q40 the right size of machine for THIS river?
 *
 * The app sizes every scheme at a single exceedance — Q40 by default, Q45 in
 * Nepali office practice — and then reports one capacity, one energy and one
 * dry-season share as though the choice had been made. It has not been made; it
 * has been assumed. Design flow is the one parameter a developer actually
 * controls at screening, and the app was silent on it.
 *
 * WHAT THIS SWEEPS. The same `evaluate` the app and the search use, called
 * again at each candidate exceedance. Nothing is reimplemented: every point
 * re-sizes its own headrace and penstock, re-picks its own turbine, and runs
 * the whole daily record through that machine's own part-load curve. A sweep
 * that duplicated the arithmetic would eventually disagree with the panel
 * beside it, and the reader would have no way to tell which was wrong.
 *
 * THREE THINGS IT CAN SAY WITHOUT INVENTING A COST.
 *
 * 1. WHERE ENERGY ACTUALLY PEAKS. Energy is NOT monotonic in design flow, which
 *    is the part people get wrong. A bigger machine catches more of the curve,
 *    but it also spends more days below its own minimum gate and shuts down
 *    altogether — `turbineFlow` returns zero there. Past some size the second
 *    effect wins and a larger, more expensive plant generates LESS. That
 *    turning point is physical, needs no economics, and is worth knowing.
 *
 * 2. WHAT THE LAST MEGAWATT EARNS. Between adjacent points, the extra energy
 *    divided by the extra capacity is equivalent full-load hours per year for
 *    the increment alone. It falls steeply, and it is the number a capital cost
 *    multiplies against. The app supplies the hours; the analyst supplies the
 *    NPR/kW, and the decision closes.
 *
 * 3. THE LARGEST MACHINE THAT STILL CLEARS THE DRY-SEASON BAR. NEA's 6+6 option
 *    needs 30% of energy in the dry season and 8+4 needs 15%. Shrinking the
 *    machine RAISES that share — the wet season spills instead of generating —
 *    so there is a largest design flow at which a scheme still qualifies. The
 *    report already told readers "pondage or a lower design flow are the two
 *    levers" and could not say how much lower. Now it can, and the threshold is
 *    published rather than assumed.
 *
 * WHAT IT IS NOT. It is not an economic optimisation. No capital cost, no
 * discount rate, no NPV: this app has none of those and inventing them would be
 * the worst kind of false precision, on top of a flow that already carries 1.6x.
 * It is the physical trade-off surface, with the published thresholds marked.
 *
 * AND THE DRY-SHARE COLUMN CARRIES A MEASURED BIAS. checks/dryshare-vs-gauges
 * scores that number 4 to 6 percentage points LOW against 74 DHM gauges, so the
 * qualifying design flows below are conservative — a real scheme will more often
 * clear the bar at a larger machine than at a smaller one. Callers should say so
 * rather than reading the crossing as exact.
 */
import { evaluate, type SchemeInput } from './discover.ts';
import { buildFdc, flowAtExceedance } from './hydro.ts';

export type DesignPoint = {
  /** Exceedance the machine was sized at, as a fraction. */
  exceedance: number;
  designFlowCms: number;
  capacityMW: number;
  energyGwh: number;
  netHeadM: number;
  /** Energy over nameplate: the plant's own average, in hours per year. */
  fullLoadHours: number;
  /** Dry-season energy share on each NEA split, where the record supports it. */
  dryShareSixSix: number | null;
  dryShareEightFour: number | null;
  /**
   * Equivalent full-load hours per year earned by the capacity added since the
   * next smaller point. Null at the smallest point, which has no increment.
   */
  marginalHours: number | null;
};

export type DesignFlowSweep = {
  /** Ascending by design flow, so "marginal" means "the step up to here". */
  points: DesignPoint[];
  /** The point the app is currently sizing on, if the sweep reached it. */
  chosen: DesignPoint | null;
  /** Where energy peaks. Often the largest point; sometimes not, which is the finding. */
  maxEnergy: DesignPoint;
  /** Largest machine still clearing NEA's 30% dry-season bar, if any point does. */
  dryLimitSixSix: DesignPoint | null;
  /** Same for the 15% bar on the 8+4 split. */
  dryLimitEightFour: DesignPoint | null;
};

/**
 * Exceedances to try, wettest machine first.
 *
 * Q10 is about as large as a run-of-river intake is ever built and Q90 is below
 * anything that would be financed; the interesting ground is the middle and the
 * step is fine enough to see the curve bend. Seventeen evaluations is the same
 * order the search already spends on its retained alternatives.
 */
const EXCEEDANCES = [
  0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9,
];

const NEA_SIX_SIX_DRY = 0.3;
const NEA_EIGHT_FOUR_DRY = 0.15;

/**
 * Sweep design flow for one fixed intake and powerhouse.
 *
 * `i` and `j` are the same indices the panel is showing, so the sweep describes
 * the layout on screen and not some other one. Returns null where fewer than
 * three sizes produce a buildable machine — two points cannot show a curve, and
 * a straight line drawn through them would imply one.
 */
export function sweepDesignFlow(
  input: SchemeInput,
  i: number,
  j: number
): DesignFlowSweep | null {
  const fdc = buildFdc(input.series);
  if (!fdc.length) return null;

  const points: DesignPoint[] = [];
  for (const exceedance of EXCEEDANCES) {
    const q = flowAtExceedance(fdc, exceedance);
    if (!Number.isFinite(q) || q <= 0) continue;
    const scheme = evaluate(input, i, j, q, true);
    if (!scheme || !(scheme.capacityMW > 0) || !(scheme.energyGwh > 0)) continue;
    const rel = scheme.reliability;
    points.push({
      exceedance,
      designFlowCms: scheme.designFlowCms,
      capacityMW: scheme.capacityMW,
      energyGwh: scheme.energyGwh,
      netHeadM: scheme.netHeadM,
      fullLoadHours: (scheme.energyGwh * 1000) / scheme.capacityMW,
      dryShareSixSix: rel?.ppaSixSix.dryShare ?? null,
      dryShareEightFour: rel?.ppaEightFour.dryShare ?? null,
      marginalHours: null,
    });
  }
  if (points.length < 3) return null;

  // Ascending capacity, which for a fixed layout is ascending design flow.
  points.sort((a, b) => a.designFlowCms - b.designFlowCms);

  for (let k = 1; k < points.length; k++) {
    const dP = points[k].capacityMW - points[k - 1].capacityMW;
    const dE = points[k].energyGwh - points[k - 1].energyGwh;
    // Two sizes that select the same machine give dP ~ 0, and the ratio would
    // be an arbitrarily large number rather than a meaningful one.
    points[k].marginalHours = dP > 1e-9 ? (dE * 1000) / dP : null;
  }

  const maxEnergy = points.reduce((a, b) => (b.energyGwh > a.energyGwh ? b : a));
  const largestMeeting = (pick: (p: DesignPoint) => number | null, bar: number) => {
    let best: DesignPoint | null = null;
    for (const p of points) {
      const v = pick(p);
      if (v !== null && v >= bar) best = best === null || p.designFlowCms > best.designFlowCms ? p : best;
    }
    return best;
  };

  return {
    points,
    chosen: points.find((p) => Math.abs(p.exceedance - input.exceedance) < 1e-9) ?? null,
    maxEnergy,
    dryLimitSixSix: largestMeeting((p) => p.dryShareSixSix, NEA_SIX_SIX_DRY),
    dryLimitEightFour: largestMeeting((p) => p.dryShareEightFour, NEA_EIGHT_FOUR_DRY),
  };
}

