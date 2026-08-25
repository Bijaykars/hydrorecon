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
 * MEASURED, AND DELIBERATELY NOT CHANGED.
 *
 * The ordering above — network carries the magnitude, the regression only
 * breaks ties — has now been tested against gauges
 * (checks/smallcatchment-flow.mjs), on 94 DHM stations with five or more
 * complete years and a plausible specific discharge. Split by catchment size,
 * because the whole question is size-dependent:
 *
 *                        median   bias   typ.err  within 2x
 *   under 100 km2 (n=10)
 *     mapped network      0.96x   0.80x    1.84x      60%
 *     MHSP 1997           1.60x   1.63x    2.17x      50%
 *   100-500 km2 (n=26)
 *     mapped network      0.80x   0.70x    1.76x      81%
 *     MHSP 1997           0.99x   1.11x    1.55x      85%
 *   500 km2 and up (n=58)
 *     mapped network      0.99x   0.92x    1.47x      91%
 *     MHSP 1997           0.95x   1.15x    1.47x      88%
 *
 * NO SOURCE WINS EVERYWHERE, and that is the finding. The network reads low
 * between 100 and 500 km2, where MHSP is nearly unbiased. But BELOW 100 km2 the
 * ranking inverts hard: MHSP over-predicts by 60% while the network is close to
 * right. Handing magnitude to the regional method on "small catchments" — the
 * change an earlier, smaller run of this same harness appeared to argue for —
 * would have been correct for one band and badly wrong for the one beneath it.
 *
 * That earlier run scored 66 gauges and put MHSP ahead on every headline metric.
 * It was not wrong so much as aggregated: the sub-100 km2 band held five gauges
 * and disappeared into the average. Doubling the sample did not reverse any
 * band's sign — every band ranks the same way at both thresholds — it just made
 * the bands separately visible. A national average over a country whose
 * catchments span four orders of magnitude is the wrong statistic.
 *
 * So the rule stands. The tempting alternative, a size-dependent correction
 * fitted to these bands, is declined too: 26 gauges cannot support a curve, and
 * a fitted offset would be indistinguishable from the sampling noise it was fitted to.
 *
 * RESOLVED, by weighting. The bands above are per-gauge, and gauges sit on
 * rivers an order of magnitude larger than the streams this tool is pointed at
 * (median 804 km2 against 98 km2; two thirds order 4+ against three quarters
 * order 3-). Re-weighting the same bands by where DoED projects actually sit:
 *
 *   mapped network   1.74x typical error
 *   MHSP 1997        1.81x
 *   WECS/DHM 1990    1.79x
 *
 * The network wins once the question is asked about the right rivers, which is
 * the reverse of what the unweighted gauge average said. The rule stands, and
 * the case for changing it is now closed rather than merely deferred.
 *
 * Note also the absolute size of those figures. On the small catchments this
 * tool screens, EVERY available flow source is good to about a factor of 1.8 —
 * not the 1.5x the national headline suggests. That is the honest precision of
 * a screening flow in Nepal without a gauge on the stream.
 *
 * NOTE the quantity: this compares ANNUAL MEAN. An earlier measurement over a
 * similar gauge set found network-times-national-shape better than the regional
 * methods for Q45 specifically (1.35x against 1.49x). Both can be true — mean
 * and design flow are different questions — and the discrepancy is unexplained.
 * Do not treat either as settled for the other.
 *
 * The choice is REPORTED, never silent — the panel says which source is being
 * trusted and why, because an engineer handed a flow figure deserves to know
 * which model produced it.
 */
import { annualMeanCms, driestMonthFlow, monthMean, type HydestInput } from './hydest.ts';
import {
  modifiedHydestAnnualMean,
  modifiedHydestMonthly,
  type ModifiedHydestInput,
} from './modified-hydest.ts';

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
  /**
   * Multiply the mapped network's magnitude by this before use. 1 means leave
   * it alone, which is what every path did before blending existed.
   *
   * A FACTOR rather than a replacement value, deliberately. The path carries a
   * mean at every vertex and those means GROW downstream as tributaries come
   * in; substituting one scalar everywhere — which is what authority 'hydest'
   * does, for want of anything better — throws that away and makes a 20 km
   * trace look like a canal. Scaling preserves the shape and changes only the
   * level, which is the only thing being disputed.
   */
  magnitudeFactor?: number;
  note: string;
};

/**
 * A winner still this far off the judge has not won, it has merely lost less.
 * Log-space factor: e^1 ≈ 2.7×. Beyond it, if HYDEST can state an annual mean
 * of its own, the regression becomes a provisional screening fallback. It does
 * not become an observation or a project flow record.
 */
const BOTH_LOST = 1;

/**
 * The blend reads 13% low, and this is the constant that recentres it.
 *
 * Measured on 69 DHM gauges with ten or more complete years
 * (checks/blend-weights.mjs): the geometric mean of the mapped network and
 * Modified HYDEST has a bias of 0.8727×, so it systematically UNDER-reads. For
 * a screening tool that is the dangerous direction — an under-read discards a
 * viable site, which is the one-sided failure the fleet harness exists to
 * chase — and it is a constant offset, not scatter, so it can simply be removed.
 *
 * Leave-one-out, every rule fitting its parameters without seeing the gauge it
 * predicts:
 *
 *                              median   bias   typ.err   within 2x   weighted
 *   shipped, uncorrected        0.90x   0.87x    1.39x       90%       1.667x
 *   shipped + this constant     1.03x   1.00x    1.38x       90%       1.637x
 *
 * The typical error barely moves — the bias is small beside the scatter — but
 * the median goes from 10% low to 3% high and the project-weighted figure, the
 * one that counts, improves by 1.8%.
 *
 * AND THE FLEET AGREES, which is the test that matters. Re-run over the same
 * seven seeds and compared plant by plant on the 101 scored under both engines:
 *
 *   40 plants moved up, 0 moved down, 61 unchanged
 *   under-predictions below half of licence   8 -> 8   (unchanged)
 *   licence ratio p10                      0.69x -> 0.79x
 *   implied waterway, median                4.1 km -> 3.8 km
 *
 * Less tunnel needed to reach a licensed capacity means the engine's flow moved
 * TOWARDS what the developers found, which is the only thing the ratio cannot
 * say by itself.
 *
 * READ THE HARNESS SUMMARY WITH CARE HERE. Its headline said under-predictions
 * went 2/95 to 4/98 — worse — and that was the denominator moving, not the
 * engine. Three additional plants scored under the new engine and brought their
 * own tail with them. Paired on identical plants the count does not move at all.
 * This is the second time that trap has been walked into; the pairing above is
 * the answer to it.
 *
 * TWO THINGS THAT WERE TRIED HERE AND MEASURED WORSE, so do not re-derive them:
 *
 * INVERSE-VARIANCE WEIGHTING. An equal geometric mean is optimal only if both
 * sources carry equal error variance, and they do not (network 1.53×, Modified
 * HYDEST 1.40×). Weighting each by 1/σ² is the textbook combination and it is
 * worth exactly nothing here: 1.38× against 1.39×, project-weighted 1.664×
 * against 1.667×. Adding MHSP as a third weighted source changes nothing
 * either. The sources' errors are correlated enough that reweighting them
 * cannot buy what independence would.
 *
 * PER-BAND CONSTANTS. The bias is not uniform by catchment size — 1.156× under
 * 100 km², 0.709× from 100-500, 0.899× above — and fitting a constant per band
 * is WORSE out of sample (project-weighted 1.679× against 1.637×). Fourteen
 * gauges cannot support a per-band parameter, and the leave-one-out says so
 * plainly. One constant for everything.
 */
export const BLEND_BIAS_CORRECTION = 1.1458;

/** The regression's annual mean, when all four of its inputs are present. */
const modAnnualFor = (m: ModifiedHydestInput | null | undefined) =>
  m ? modifiedHydestAnnualMean(m) : null;

export function chooseFlowMagnitude(opts: {
  dates: readonly string[];
  series: readonly number[];
  /** The mapped network's long-term mean at the intake; 0 or less = none. */
  networkMeanCms: number;
  /** Catchment area and hypsometry for HYDEST, when inside Nepal. */
  hydest: HydestInput | null;
  /**
   * The office's own regression, when its four inputs are all available.
   *
   * Preferred as the judge where present. Measured on 94 DHM gauges
   * (checks/smallcatchment-flow.mjs, checks/judge-quality.mjs) it is the better
   * instrument on every axis that matters here: 1.48x typical error against
   * WECS/DHM 1990's 1.61x, and as a detector of a wrong network reading it
   * catches 3 of 8 at 75% precision where 1990 catches 2 at 67%.
   *
   * The detector margin is one gauge and is not on its own decisive. The
   * estimator margin is measured over 94 and is. Nothing measured favours 1990,
   * so the better instrument judges and 1990 remains the fallback for the 18%
   * of reaches with no elevation or annual-rainfall layer.
   */
  modified?: ModifiedHydestInput | null;
}): FlowChoice {
  const { dates, series, networkMeanCms, hydest, modified } = opts;
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
    /**
     * BLEND, rather than take the network's word for it.
     *
     * This is the common case — the two global sources agree, nothing is in
     * dispute, and until now the regression was never consulted at all. But
     * "not in dispute" is not the same as "right": measured against 94 DHM
     * gauges (checks/smallcatchment-flow.mjs) the network alone runs 16% low at
     * the median and 1.74x typical error weighted to where Nepali projects
     * actually sit.
     *
     * The mapped network and Modified HYDEST share no input data and fail for
     * unrelated reasons — one mis-snaps onto the wrong channel, the other is
     * blind to anything its four terms do not carry. Their geometric mean is
     * the standard way to exploit that, and it measures better than either
     * parent:
     *
     *                        median   bias   typ.err   within 2x   weighted
     *   mapped network        0.91x   0.84x    1.58x       85%       1.74x
     *   Modified HYDEST       1.01x   1.08x    1.48x       82%       1.69x
     *   geometric mean        0.93x   0.95x    1.48x       86%       1.62x
     *
     * Best bias, best share within a factor of two, and the best weighted
     * error measured for any source. There is no fitted parameter here: a
     * geometric mean of two estimates is not a tuning knob.
     *
     * END-TO-END, CONFIRMED on 96 plants once the local GloFAS store made a run
     * repeatable. Blend off against blend on, whole fleet re-run under each:
     *
     *                       implied waterway median   licence reached
     *   blend on                    4.0 km                 74/96
     *   blend off                   4.5 km                 71/96
     *
     * Three more plants land on the engine's own curve at a buildable waterway,
     * and the median tunnel needed to reach a licensed capacity falls half a
     * kilometre — the engine's flow is closer to what the developers found.
     * Under-predictions (6/90) and p90 are unchanged, so nothing was traded for
     * it.
     *
     * An earlier attempt at this comparison ran on eight cached plants and was
     * inconclusive, because four of them used a transferred gauge record where
     * this branch is bypassed by design and a fifth took the judge instead —
     * an effective sample of three. The measurement did not change; the sample
     * did.
     *
     * The harness now reports how many rows a flow-choice change can even
     * touch, because "no effect" and "not applicable" read identically in a
     * summary and I mistook one for the other for a full iteration.
     */
    const blendMean = modAnnualFor(modified);
    /**
     * The blend is a refinement, not a third opinion that can outvote two.
     *
     * A geometric mean has no outlier resistance: where the regression sits far
     * from both agreeing sources it drags the answer with it, and the panel
     * still reports the disagreement as 1.0 because that figure describes the
     * two GLOBAL sources. At one bundled reach the network and flood model both
     * read 52.218 m³/s, Modified HYDEST read 3.100, and the chooser returned
     * 12.723 — a 75.6% cut, more than 4× below both sources that agreed, with
     * nothing on screen suggesting anything unusual had happened. 114 of 23,789
     * reaches carry a regional/network ratio past 9, which is enough for the
     * square root alone to move the answer by more than 3×.
     *
     * Inside the bound the blend does what it measured well at. Outside it the
     * regression is the outlier and the two agreeing sources stand.
     */
    const BLEND_MAX_RATIO = 9;
    const blendRatio =
      blendMean != null && blendMean > 0
        ? Math.max(networkMeanCms / blendMean, blendMean / networkMeanCms)
        : Infinity;
    if (blendMean != null && blendMean > 0 && blendRatio > BLEND_MAX_RATIO) {
      return {
        authority: 'network',
        disagreement,
        judgeCms: blendMean,
        judgeKind: 'annual',
        networkCms: networkMeanCms,
        modelCms: seriesMean,
        note:
          `the two flow sources agree to within rescaling range, and the Modified HYDEST ` +
          `estimate (${blendMean.toFixed(2)} m³/s) sits ${blendRatio.toFixed(0)}× from both — ` +
          'too far to blend with, so the two agreeing sources carry the magnitude and the ' +
          'regression is reported beside them rather than folded in',
      };
    }
    if (blendMean != null && blendMean > 0) {
      const blended = Math.sqrt(networkMeanCms * blendMean) * BLEND_BIAS_CORRECTION;
      return {
        authority: 'network',
        disagreement,
        judgeCms: blendMean,
        judgeKind: 'annual',
        networkCms: networkMeanCms,
        modelCms: seriesMean,
        magnitudeFactor: blended / networkMeanCms,
        note:
          `the two flow sources agree to within rescaling range; magnitude is their ` +
          `geometric mean with the Modified HYDEST regional estimate (${networkMeanCms.toFixed(2)} ` +
          `and ${blendMean.toFixed(2)} m³/s blended to ${blended.toFixed(2)})`,
      };
    }
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
  const modAnnual = modified ? modifiedHydestAnnualMean(modified) : null;
  const modMonthly = modified ? modifiedHydestMonthly(modified) : null;
  const modDriest =
    modMonthly && modMonthly.length === 12
      ? modMonthly.reduce(
          (lo, cms, i) => (cms < lo.cms ? { month: i, cms } : lo),
          { month: 0, cms: modMonthly[0] }
        )
      : null;

  const usingModified = modAnnual != null && modAnnual > 0;
  const annual = usingModified ? modAnnual : hydest ? annualMeanCms(hydest) : null;
  const driest = usingModified ? modDriest : hydest ? driestMonthFlow(hydest) : null;
  const judgeName = usingModified ? 'Modified HYDEST' : 'WECS/DHM';
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
        `both global sources sit far from the ${judgeName} regional estimate here (network ${networkCms.toFixed(1)}, ` +
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
    // `judgeName`, not a hardcoded method: Modified HYDEST referees whenever it
    // has its inputs, which is the common case. Naming WECS/DHM here stated a
    // provenance the decision did not have.
    note:
      authority === 'network'
        ? `The ${judgeName} regional comparison is closer to the mapped network (${networkCms.toFixed(1)} vs its ${judge.toFixed(1)} m³/s ${kindWord} figure)`
        : `The ${judgeName} regional comparison is closer to the flood model (${modelCms.toFixed(1)} vs its ${judge.toFixed(1)} m³/s ${kindWord} figure) — ` +
          'the network\'s discharge is broken on this reach, a known failure of its global water model in high Himalayan valleys',
  };
}
