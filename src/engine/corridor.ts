/**
 * Can the waterway be benched, or does it have to be tunnelled?
 *
 * A headrace does not run down the river. It contours the hillside above it, so
 * what decides its cost is not the river's profile but how steeply the ground
 * falls ACROSS the alignment. Below roughly 35 degrees a canal can be cut into
 * the slope; above it the bench collapses and the answer is a tunnel, at an
 * order of magnitude more per metre.
 *
 * WHY A CLASSIFICATION AND NOT A QUANTITY. Excavation volume was the obvious
 * thing to want and it is not supportable here. A headrace sits two to four
 * metres in cut, while the terrain's absolute error spans -14 to +6 m
 * (npm run probe:dem) — the uncertainty is larger than the thing being
 * measured, and any cubic-metre figure would be invented precision.
 *
 * A SLOPE survives where an elevation does not, because it is a difference over
 * a short baseline and radar DEM errors are strongly correlated at short range.
 * Measured on 179 Nepali reaches, two independently produced terrain products
 * agree on cross-slope to a 2.9% sigma and disagree about which side of the
 * canal/tunnel threshold a reach falls on for 2% of them. That is what makes
 * this honest to report and a volume dishonest.
 */

/** Grade at which a benched canal stops being buildable, as a percentage. */
export const CANAL_MAX_GRADE_PCT = 70; // ~35 degrees

/** How far out from the channel the slope is read. Shorter is noisier. */
const OFFSET_M = 100;

/** Spacing of cross-sections along the waterway. */
const STATION_KM = 0.25;

const M_PER_DEG = 111320;

export type CorridorPoint = { lat: number; lon: number; km: number };

export type CorridorTerrain = {
  stations: number;
  /** Share of the corridor a canal could be benched along, 0-1. */
  canalFrac: number;
  /** Grade of the gentler bank at the median station, percent. */
  medianGradePct: number;
  /** The worst station, percent — one cliff can force a tunnel by itself. */
  steepestGradePct: number;
  /** Metres of waterway that would have to be tunnelled, at this spacing. */
  tunnelKm: number;
};

/**
 * Three points per station: the channel, and OFFSET_M either side of it along
 * the perpendicular to the local path direction.
 *
 * Returned as one flat list so the caller can sample it in a single pass — the
 * terrain fetcher is tile-based, and asking for scattered points one at a time
 * would refetch the same tiles repeatedly.
 */
export function crossSectionPoints(
  path: readonly CorridorPoint[],
  i: number,
  j: number
): CorridorPoint[] {
  if (!(j > i) || i < 0 || j >= path.length) return [];
  const out: CorridorPoint[] = [];
  let nextKm = path[i].km;
  for (let k = i; k <= j; k++) {
    if (path[k].km < nextKm && k !== j) continue;
    nextKm = path[k].km + STATION_KM;

    // Local direction from the neighbours, so a single kinked vertex does not
    // swing the perpendicular by ninety degrees.
    const a = path[Math.max(i, k - 1)];
    const b = path[Math.min(j, k + 1)];
    const cos = Math.cos((path[k].lat * Math.PI) / 180) || 1e-6;
    const dy = (b.lat - a.lat) * M_PER_DEG;
    const dx = (b.lon - a.lon) * M_PER_DEG * cos;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    const px = -dy / len;
    const py = dx / len;

    out.push({ lat: path[k].lat, lon: path[k].lon, km: path[k].km });
    for (const sign of [-1, 1]) {
      out.push({
        lat: path[k].lat + (sign * OFFSET_M * py) / M_PER_DEG,
        lon: path[k].lon + (sign * OFFSET_M * px) / (M_PER_DEG * cos),
        km: path[k].km,
      });
    }
  }
  return out;
}

/**
 * Read the sampled elevations back as a canal/tunnel verdict.
 *
 * `elevations` must be the values for `crossSectionPoints` in the same order.
 * The GENTLER bank decides each station: a canal is benched on one side, so a
 * gorge with a terrace on one wall is buildable even though its other wall is
 * vertical.
 */
export function readCrossSlopes(
  elevations: readonly number[],
  /**
   * Station chainages, one per triple, so tunnelled length can be a share of
   * the REAL corridor rather than a count of samples. Optional: the synthetic
   * fixtures in the check exercise the arithmetic without a path.
   */
  stationKm?: readonly number[]
): CorridorTerrain | null {
  const grades: number[] = [];
  const kms: number[] = [];
  for (let k = 0; k + 2 < elevations.length; k += 3) {
    const [c, l, r] = [elevations[k], elevations[k + 1], elevations[k + 2]];
    if (![c, l, r].every((v) => Number.isFinite(v))) continue;
    const gentler = Math.min(Math.abs(l - c), Math.abs(r - c));
    grades.push((gentler / OFFSET_M) * 100);
    kms.push(stationKm?.[k / 3] ?? (k / 3) * STATION_KM);
  }
  if (!grades.length) return null;

  const sorted = [...grades].sort((a, b) => a - b);
  const steepCount = grades.filter((g) => g > CANAL_MAX_GRADE_PCT).length;

  /**
   * Each station owns the corridor halfway to its neighbours, so the lengths
   * PARTITION the route and can never sum past it.
   *
   * Multiplying a station count by the nominal spacing did exceed it: terminal
   * and irregularly spaced samples are not a full interval each, and a 0.4 km
   * corridor sampled at 0, 0.12, 0.24, 0.36 and 0.4 km reported 0.75 km of
   * tunnel — 187% of the whole waterway.
   */
  const first = kms[0];
  const last = kms[kms.length - 1];
  let tunnelKm = 0;
  let totalKm = 0;
  for (let i = 0; i < grades.length; i++) {
    const lo = i === 0 ? first : (kms[i - 1] + kms[i]) / 2;
    const hi = i === grades.length - 1 ? last : (kms[i] + kms[i + 1]) / 2;
    const span = Math.max(0, hi - lo);
    totalKm += span;
    if (grades[i] > CANAL_MAX_GRADE_PCT) tunnelKm += span;
  }

  return {
    stations: grades.length,
    // By length where the corridor has any, by station count for a degenerate
    // zero-length one, so the share is always defined.
    canalFrac: totalKm > 0 ? 1 - tunnelKm / totalKm : 1 - steepCount / grades.length,
    medianGradePct: sorted[sorted.length >> 1],
    steepestGradePct: sorted[sorted.length - 1],
    tunnelKm,
  };
}
