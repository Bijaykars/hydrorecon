/**
 * When the two flow sources disagree badly, which one is lying?
 *
 * The engine leans on two global datasets: the flood model supplies the
 * day-to-day shape, and the mapped river network supplies the long-term
 * magnitude. Until now the network's magnitude always won, because its failure
 * mode — a ~5 km model cell sitting on the wrong channel — was the one this app
 * had actually met (a cell reading 1.15 m³/s beside a river carrying a
 * hundred).
 *
 * Validation against built plants found the OPPOSITE failure. The network's
 * discharge comes from a global water model, and in the high valleys along the
 * Tibetan border it collapses: 0.3 m³/s on the Tamakoshi at Lamabagar — a
 * 1,754 km² catchment where Nepal built a 456 MW plant around a measured
 * 66 m³/s design flow. Trusting the network there understates a major river
 * two-hundred-fold. So neither source is always right, and the choice has to
 * be made per reach, not by policy.
 *
 * The comparison is the legacy WECS/DHM regional regression, fitted to Nepali
 * gauge records and computed from catchment area, hypsometry and rainfall. Its
 * discharge relation is independent of both global discharge models, although
 * the screening inputs share mapped catchment geography. Where the candidates
 * disagree beyond what rescaling is meant to correct, each one's dry-season
 * flow is compared against HYDEST's, and the closer wins. Outside Nepal (no
 * hypsometry, no HYDEST) the network keeps winning, which is the long-standing
 * behaviour.
 *
 * The choice is REPORTED, never silent — the panel says which source is being
 * trusted and why, because an engineer handed a flow figure deserves to know
 * which model produced it.
 */
import { annualMeanCms, driestMonthFlow, monthMean, type HydestInput } from './hydest.ts';

/**
 * Disagreement beyond this is no longer "the model cell is slightly off this
 * channel" — it is one of the two sources being wrong. Within it, the network
 * keeps its magnitude role unchallenged, which is the app's original rule.
 */
export const DISAGREE_RATIO = 3;

export type FlowChoice = {
  /**
   * Which source supplies the magnitude. 'hydest' means both global sources
   * sit far from the regional comparison and it carries the screening figure.
   */
  authority: 'network' | 'model' | 'hydest';
  /** How far apart the two candidates were, as a ratio ≥ 1. */
  disagreement: number;
  /** The judged quantity — annual mean where MMP allows it, else driest month. */
  judgeCms: number | null;
  judgeKind: 'annual' | 'dry-season' | null;
  /** Each candidate rendered as that same quantity, for the panel to show. */
  networkCms: number | null;
  modelCms: number | null;
  /** With authority 'hydest': the long-term mean the series is rescaled onto. */
  targetMeanCms?: number;
  note: string;
};

/**
 * A winner still this far off the judge has not won, it has merely lost less.
 * Log-space factor: e^1 ≈ 2.7×. Beyond it, if HYDEST can state an annual mean
 * of its own, the regression becomes a provisional screening fallback. It does
 * not become an observation or a project flow record.
 */
const BOTH_LOST = 1;

export function chooseFlowMagnitude(opts: {
  dates: readonly string[];
  series: readonly number[];
  /** The mapped network's long-term mean at the intake; 0 or less = none. */
  networkMeanCms: number;
  /** Catchment area and hypsometry for HYDEST, when inside Nepal. */
  hydest: HydestInput | null;
}): FlowChoice {
  const { dates, series, networkMeanCms, hydest } = opts;
  const seriesMean = series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0;

  if (!(networkMeanCms > 0) || !(seriesMean > 0)) {
    return {
      authority: 'model',
      disagreement: 1,
      judgeCms: null,
      judgeKind: null,
      networkCms: null,
      modelCms: null,
      note: 'no mapped network magnitude here — the flood model is used as-is',
    };
  }

  const disagreement = Math.max(networkMeanCms / seriesMean, seriesMean / networkMeanCms);
  if (disagreement <= DISAGREE_RATIO) {
    return {
      authority: 'network',
      disagreement,
      judgeCms: null,
      judgeKind: null,
      networkCms: null,
      modelCms: null,
      note: 'the two flow sources agree to within rescaling range',
    };
  }

  /**
   * The judged quantity. With MMP the regression states a full ANNUAL mean —
   * the same quantity the two candidates disagree about, which makes the
   * comparison direct. Without it, each candidate's dry-season flow is
   * compared instead: the shape comes from the flood model either way, so the
   * dry season still isolates exactly the disputed magnitude.
   */
  const annual = hydest ? annualMeanCms(hydest) : null;
  const driest = hydest ? driestMonthFlow(hydest) : null;
  const judgeKind: FlowChoice['judgeKind'] = annual ? 'annual' : driest ? 'dry-season' : null;
  const judge = annual ?? driest?.cms ?? null;
  if (judge === null || !(judge > 0)) {
    return {
      authority: 'network',
      disagreement,
      judgeCms: null,
      judgeKind: null,
      networkCms: null,
      modelCms: null,
      note:
        `the sources disagree ${disagreement.toFixed(0)}× and no independent judge exists here — ` +
        'keeping the mapped network, which is usually the safer magnitude',
    };
  }

  let networkCms: number;
  let modelCms: number;
  if (annual) {
    networkCms = networkMeanCms;
    modelCms = seriesMean;
  } else {
    const shapeCms = monthMean(dates as string[], series as number[], driest!.month);
    if (!Number.isFinite(shapeCms) || !(shapeCms > 0)) {
      return {
        authority: 'network',
        disagreement,
        judgeCms: judge,
        judgeKind,
        networkCms: null,
        modelCms: null,
        note: 'the record has no usable dry-season months to judge with — keeping the mapped network',
      };
    }
    networkCms = shapeCms * (networkMeanCms / seriesMean);
    modelCms = shapeCms;
  }

  const offNetwork = Math.abs(Math.log(networkCms / judge));
  const offModel = Math.abs(Math.log(modelCms / judge));
  const kindWord = judgeKind === 'annual' ? 'annual-mean' : 'dry-season';

  // Both candidates far off a judge that can state a full annual mean: the
  // regression carries the magnitude itself, and says so.
  if (annual && Math.min(offNetwork, offModel) > BOTH_LOST) {
    return {
      authority: 'hydest',
      disagreement,
      judgeCms: judge,
      judgeKind,
      networkCms,
      modelCms,
      targetMeanCms: annual,
      note:
        `both global sources sit far from the WECS/DHM regional estimate here (network ${networkCms.toFixed(1)}, ` +
        `flood model ${modelCms.toFixed(1)}, against its ${judge.toFixed(1)} m³/s annual mean) — ` +
        'the record keeps its day-to-day shape, provisionally rescaled onto the regression; this remains screening and needs a gauge record',
    };
  }

  const authority = offNetwork <= offModel ? 'network' : 'model';
  return {
    authority,
    disagreement,
    judgeCms: judge,
    judgeKind,
    networkCms,
    modelCms,
    note:
      authority === 'network'
        ? `The WECS/DHM regional comparison is closer to the mapped network (${networkCms.toFixed(1)} vs its ${judge.toFixed(1)} m³/s ${kindWord} figure)`
        : `The WECS/DHM regional comparison is closer to the flood model (${modelCms.toFixed(1)} vs its ${judge.toFixed(1)} m³/s ${kindWord} figure) — ` +
          'the network\'s discharge is broken on this reach, a known failure of its global water model in high Himalayan valleys',
  };
}
