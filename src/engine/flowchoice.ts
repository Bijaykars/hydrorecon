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
 * The judge is HYDEST — Nepal's own regional regression, fitted to Nepali
 * gauge records, computed from the catchment's area and hypsometry, and
 * entirely independent of both global models. Where the two candidates
 * disagree beyond what rescaling is meant to correct, each one's dry-season
 * flow is compared against HYDEST's, and the closer wins. Outside Nepal (no
 * hypsometry, no HYDEST) the network keeps winning, which is the long-standing
 * behaviour.
 *
 * The choice is REPORTED, never silent — the panel says which source is being
 * trusted and why, because an engineer handed a flow figure deserves to know
 * which model produced it.
 */
import { driestMonthFlow, monthMean, type HydestInput } from './hydest.ts';

/**
 * Disagreement beyond this is no longer "the model cell is slightly off this
 * channel" — it is one of the two sources being wrong. Within it, the network
 * keeps its magnitude role unchallenged, which is the app's original rule.
 */
export const DISAGREE_RATIO = 3;

export type FlowChoice = {
  /** Which source supplies the magnitude. */
  authority: 'network' | 'model';
  /** How far apart the two candidates were, as a ratio ≥ 1. */
  disagreement: number;
  /** HYDEST's driest-month flow, when it could judge. */
  judgeCms: number | null;
  /** Each candidate's flow for that same month, for the panel to show. */
  networkCms: number | null;
  modelCms: number | null;
  note: string;
};

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
      networkCms: null,
      modelCms: null,
      note: 'the two flow sources agree to within rescaling range',
    };
  }

  const driest = hydest ? driestMonthFlow(hydest) : null;
  if (!driest || !(driest.cms > 0)) {
    return {
      authority: 'network',
      disagreement,
      judgeCms: null,
      networkCms: null,
      modelCms: null,
      note:
        `the sources disagree ${disagreement.toFixed(0)}× and no independent judge exists here — ` +
        'keeping the mapped network, which is usually the safer magnitude',
    };
  }

  /**
   * Both candidates rendered as the same quantity HYDEST predicts: the mean
   * flow of the driest month. The shape comes from the flood model either way;
   * only the magnitude differs, so this isolates exactly the disputed part.
   */
  const shapeCms = monthMean(dates as string[], series as number[], driest.month);
  if (!Number.isFinite(shapeCms) || !(shapeCms > 0)) {
    return {
      authority: 'network',
      disagreement,
      judgeCms: driest.cms,
      networkCms: null,
      modelCms: null,
      note: 'the record has no usable dry-season months to judge with — keeping the mapped network',
    };
  }
  const networkCms = shapeCms * (networkMeanCms / seriesMean);
  const modelCms = shapeCms;

  const offNetwork = Math.abs(Math.log(networkCms / driest.cms));
  const offModel = Math.abs(Math.log(modelCms / driest.cms));
  const authority = offNetwork <= offModel ? 'network' : 'model';

  return {
    authority,
    disagreement,
    judgeCms: driest.cms,
    networkCms,
    modelCms,
    note:
      authority === 'network'
        ? `Nepal's own regression sides with the mapped network (${networkCms.toFixed(1)} vs its ${driest.cms.toFixed(1)} m³/s dry-season figure)`
        : `Nepal's own regression sides with the flood model (${modelCms.toFixed(1)} vs its ${driest.cms.toFixed(1)} m³/s dry-season figure) — ` +
          'the network\'s discharge is broken on this reach, a known failure of its global water model in high Himalayan valleys',
  };
}
