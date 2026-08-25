/**
 * The site audit — measure this site harder, on request.
 *
 * "Can we interpolate the data to make it more accurate?" is the natural ask,
 * and the honest answer is that interpolation never adds information — it only
 * redraws what is already there, more smoothly. What DOES add information is
 * cross-examination: this app happens to have two independently produced
 * terrain products, nine flood-model cells around any click, up to forty years
 * requested instead of twenty, and a Nepali regression that knows what a seasonal
 * regime here should look like. None of that runs by default because it costs
 * a dozen network requests against shared free services. On a click, all of
 * it does:
 *
 *   HEAD, MEASURED TWICE — the same river path sampled on the second terrain
 *   product. If the two agree to 3 m at this site, the ±15 m global assumption
 *   is too timid here and the band tightens; if they disagree by 30 m, it was
 *   too brave and the band widens. Either direction is the estimate getting
 *   more honest, which is the only sense in which it gets "more accurate".
 *
 *   THE SHAPE AUDIT — every study leans on one ~5 km flood-model cell for its
 *   day-to-day shape, and validation caught that cell belonging to the wrong
 *   river (Chilime's carried the neighbouring Bhote Koshi). All nine cells
 *   around the click are fetched and scored against HYDEST's monthly regime —
 *   shape against shape, magnitudes normalised away — and if a neighbour
 *   matches Nepal's own seasonality decisively better than the cell in use,
 *   the study switches to it and says so.
 *
 *   THE LONG RECORD — request up to forty years for whichever cell wins and
 *   retain only its complete local calendar years, which is the cheapest real
 *   improvement to the FDC's tails.
 */
import {
  CELL_DEG,
  fetchDischarge,
  fetchPathProfile,
  meanOf,
  type DischargeSeries,
} from './api.ts';
import { monthMean } from './engine/hydest.ts';

// ---------------------------------------------------------------------------
// Head, measured twice
// ---------------------------------------------------------------------------

/**
 * Floor on the per-site head error, m. Two radar-derived products can share a
 * bias and agree while both are wrong, so their agreement is a floor on the
 * error, not the error itself — the probe that measured them globally found
 * sigma 6.6 m with no systematic bias, and this floor sits above it.
 */
const HEAD_ERR_FLOOR_M = 10;
/** Above this the "disagreement" is usually a void or gorge artefact, not a slope. */
const HEAD_ERR_CEIL_M = 60;

export type HeadAudit = {
  /** Head between the same two points, on each product, m. */
  primaryM: number;
  secondM: number;
  deltaM: number;
  /** The per-site error the band should use instead of the global assumption. */
  errM: number;
  secondSource: string;
};

export async function auditHead(
  path: { lat: number; lon: number; km: number; elevationM: number }[],
  i: number,
  j: number,
  /**
   * Which product produced the head already on screen.
   *
   * The audit always fetches AWS Terrain Tiles as its "second" opinion, and the
   * primary profile tries Re:Earth first but FALLS BACK to AWS. When it had
   * already fallen back, this compared AWS against AWS — same provider, same
   * coordinates, same sampling — and the near-zero difference then tightened
   * the uncertainty band to its 10 m floor while the page described the head as
   * independently measured twice. Knowing the primary's source is the only way
   * to tell corroboration from an echo.
   */
  primarySource?: string
): Promise<HeadAudit | null> {
  const second = await fetchPathProfile(path, 'AWS Terrain Tiles');
  if (primarySource && second.source === primarySource) {
    // Not a second opinion. Better no evidence than false corroboration.
    return null;
  }
  const zi = second.points[i]?.elevationM;
  const zj = second.points[j]?.elevationM;
  if (!Number.isFinite(zi) || !Number.isFinite(zj)) return null;
  const primaryM = path[i].elevationM - path[j].elevationM;
  const secondM = zi - zj;
  const deltaM = Math.abs(primaryM - secondM);
  return {
    primaryM,
    secondM,
    deltaM,
    // 1.4× the measured disagreement: the second product is evidence about the
    // first, not ground truth, so the band does not collapse onto their gap.
    errM: Math.min(HEAD_ERR_CEIL_M, Math.max(HEAD_ERR_FLOOR_M, deltaM * 1.4)),
    secondSource: second.source,
  };
}

// ---------------------------------------------------------------------------
// The shape audit
// ---------------------------------------------------------------------------

/**
 * How unlike two seasonal regimes are: RMS of log-ratios over the shared
 * months, after normalising each regime to mean 1 — so only SHAPE is compared
 * and magnitude, which the arbitration handles separately, cancels out.
 * 0 is identical; 0.7 is roughly "wet season in the wrong months".
 */
export function shapeScore(
  a: { month: number; cms: number }[],
  b: { month: number; cms: number }[]
): number | null {
  const bByMonth = new Map(b.map((m) => [m.month, m.cms]));
  const pairs: [number, number][] = [];
  for (const m of a) {
    const other = bByMonth.get(m.month);
    if (other !== undefined && m.cms > 0 && other > 0) pairs.push([m.cms, other]);
  }
  if (pairs.length < 4) return null;
  const meanA = meanOf(pairs.map((p) => p[0]));
  const meanB = meanOf(pairs.map((p) => p[1]));
  if (!(meanA > 0) || !(meanB > 0)) return null;
  let sum = 0;
  for (const [va, vb] of pairs) {
    const r = Math.log(va / meanA / (vb / meanB));
    sum += r * r;
  }
  return Math.sqrt(sum / pairs.length);
}

/** A neighbour must beat the incumbent by this much before the study moves. */
const DECISIVE_MARGIN = 0.12;

/**
 * How far a neighbour's MAGNITUDE may sit from the incumbent's and still be a
 * candidate to replace it.
 *
 * Shape scoring deliberately normalises magnitude away, which is right for
 * judging seasonal timing and catastrophic on its own: every Nepali river
 * shares one monsoon, so the scores cluster and the winner is close to noise.
 * Swept over 131 gauge anchors the rule switched cell at 45 of them, and in 43
 * of those the chosen cell's raw mean differed by more than 2× — Rapti Jalkundi
 * moved from 159 m³/s to 0.28, Kali Gandaki from 486 to 1.33. Those are not the
 * same river.
 *
 * A neighbouring 0.05° cell on the same channel carries a similar mean; one
 * that is 3× away is a different watercourse, and no shape score should be
 * allowed to adopt it. This bounds the rule to what it was meant to fix — a
 * cell offset onto the far bank — rather than letting it re-pick the river.
 */
const MAX_MAGNITUDE_RATIO = 3;

export type ShapeAudit = {
  /** Cells scored, best first. The one in use is flagged. */
  ranked: { lat: number; lon: number; score: number; inUse: boolean }[];
  /** Set when a neighbour won decisively — the series the study should adopt. */
  better: DischargeSeries | null;
  note: string;
};

export async function auditShape(
  current: DischargeSeries,
  hydestMonths: { month: number; cms: number }[]
): Promise<ShapeAudit | null> {
  if (hydestMonths.length < 4) return null;

  const monthly = (s: DischargeSeries) =>
    Array.from({ length: 12 }, (_, m) => ({ month: m, cms: monthMean(s.dates, s.values, m) })).filter(
      (m) => Number.isFinite(m.cms) && m.cms > 0
    );

  const cells: { s: DischargeSeries; score: number }[] = [];
  const own = shapeScore(hydestMonths, monthly(current));
  if (own !== null) cells.push({ s: current, score: own });

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      try {
        const s = await fetchDischarge(
          current.cell.lat + dy * CELL_DEG,
          current.cell.lon + dx * CELL_DEG,
          undefined,
          true // a probe, not a study: must not evict the engineer's own sites
        );
        // The API snaps to its own grid; two probes can land on one cell.
        if (cells.some((c) => c.s.cell.lat === s.cell.lat && c.s.cell.lon === s.cell.lon)) continue;
        const score = shapeScore(hydestMonths, monthly(s));
        if (score !== null) cells.push({ s, score });
      } catch {
        // A dry or rate-limited neighbour tells us nothing; skip it.
      }
    }
  }
  if (cells.length === 0 || own === null) return null;

  cells.sort((a, b) => a.score - b.score);
  const best = cells[0];
  const inUse = (s: DischargeSeries) =>
    s.cell.lat === current.cell.lat && s.cell.lon === current.cell.lon;
  const ranked = cells.map((c) => ({
    lat: c.s.cell.lat,
    lon: c.s.cell.lon,
    score: c.score,
    inUse: inUse(c.s),
  }));

  const meanOfSeries = (s: DischargeSeries) =>
    s.values.length ? s.values.reduce((a, b) => a + b, 0) / s.values.length : NaN;
  const ownMean = meanOfSeries(current);
  const bestMean = meanOfSeries(best.s);
  const magnitudeRatio =
    ownMean > 0 && bestMean > 0 ? Math.max(ownMean / bestMean, bestMean / ownMean) : Infinity;

  if (
    !inUse(best.s) &&
    own - best.score > DECISIVE_MARGIN &&
    magnitudeRatio <= MAX_MAGNITUDE_RATIO
  ) {
    return {
      ranked,
      better: best.s,
      note:
        `the cell in use ranked ${ranked.findIndex((r) => r.inUse) + 1} of ${ranked.length} against ` +
        `Nepal's seasonal regime — switched to the best-matching cell ` +
        `(score ${best.score.toFixed(2)} vs ${own.toFixed(2)})`,
    };
  }
  return {
    ranked,
    better: null,
    note:
      ranked[0]?.inUse === true
        ? `the cell in use matches Nepal's seasonal regime best of all ${ranked.length} cells here`
        : !inUse(best.s) &&
            own - best.score > DECISIVE_MARGIN &&
            magnitudeRatio > MAX_MAGNITUDE_RATIO
          ? `a neighbouring cell matches the seasonal regime better, but carries ` +
            `${magnitudeRatio.toFixed(0)}× the flow — that is a different watercourse, ` +
            `not a better reading of this one, so the cell in use was kept`
          : `no neighbouring cell beats the one in use decisively — kept it`,
  };
}
