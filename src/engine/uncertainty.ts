/**
 * How much to trust the number.
 *
 * The physics in this app is validated: it reproduces five built power stations
 * and matches its reference implementation exactly. That is the easy half. The
 * hard half is that P = rho*g*Q*H*eta is only as good as Q and H, and both come
 * from uncalibrated global models. Reporting a single capacity implies a
 * precision the inputs cannot support.
 *
 * So the range is computed the same way the value is — by running the real
 * engine on perturbed inputs — rather than by attaching a made-up percentage.
 */
import { evaluate, type Scheme, type SchemeInput } from './discover.ts';

export type Band = { low: number; best: number; high: number };

export type Uncertainty = {
  capacityMW: Band;
  energyGwh: Band;
  /** What is actually driving the spread, largest first. */
  drivers: { name: string; swingPct: number; note: string }[];
  flowSpreadPct: number;
  headSpreadM: number;
};

/**
 * Vertical error carried by a HEAD — a difference of two DEM samples — in metres.
 *
 * This started as a literature figure: Copernicus GLO-30 and SRTM are both quoted
 * around 10 m RMSE overall and degrade in mountains, and head combines two such
 * errors that are partly correlated over a few kilometres.
 *
 * `npm run probe:dem` now measures it instead of assuming it. Sampling the two
 * independent terrain products the app ships with — Re:Earth's Mapterhorn build
 * and AWS Terrain Tiles — at both ends of 141 real HydroRIVERS reaches, through
 * the app's own decode path:
 *
 *   median disagreement   -0.1 m   (no systematic bias, which the symmetric
 *                                   +/- treatment below had been assuming)
 *   robust sigma           6.6 m
 *   5-95%                 -13 to +15 m
 *   beyond 50 m              2% of reaches — voids and gorge artifacts
 *
 * The value stays at 15 rather than dropping to the measured 6.6, because
 * inter-product agreement is a FLOOR on the error and not the error itself: both
 * products are radar-derived and can share a bias, agreeing with each other while
 * both are wrong. What the measurement establishes is that 15 m is not too small,
 * and that the error has no direction — not that it is the whole story.
 */
const DEM_HEAD_ERROR_M = 15;

/**
 * Flow uncertainty, as a fraction of the value used.
 *
 * Two cases, and the difference matters.
 *
 * CORROBORATED: the flood model's cell and the mapped network agree. Two
 * uncalibrated global models agreeing is weak evidence rather than strong —
 * they share forcing data and assumptions and can be wrong together — but it is
 * evidence.
 *
 * UNCORROBORATED: they disagree badly, which happens when the flood model's
 * ~5 km cell is simply not on this channel. The magnitude then rests on the
 * mapped network alone, with nothing checking it.
 *
 * An earlier version treated the disagreement itself as the range, and on a
 * reach where the two spanned 3.4 to 130.9 m³/s it produced "0–341 MW". That is
 * wrong as well as useless: the off-channel cell was already identified and
 * discarded, so quoting its value as a plausible outcome double-counts an error
 * the app has corrected.
 */
const FLOW_SPREAD_CORROBORATED = 0.3;
const FLOW_SPREAD_ALONE = 0.5;
/** Beyond this ratio the two are not measuring the same river. */
const AGREEMENT_RATIO = 2;

const pct = (band: Band) =>
  band.best > 0 ? ((band.high - band.low) / band.best) * 100 : 0;

/**
 * Range for a scheme, from the uncertainty its own inputs carry.
 *
 * `networkMeanCms` is the mapped river network's independent long-term mean
 * where one exists. Its disagreement with the flood model is a measured signal
 * about this specific site, so it is used directly instead of a generic figure.
 */
export function uncertaintyFor(
  input: SchemeInput,
  scheme: Scheme,
  seriesMeanCms: number,
  networkMeanCms: number | null,
  /**
   * Spread of a MEASURED record, when the user has supplied one.
   *
   * A gauged series is a different category of input from a global model, and
   * the band must show that or the import was pointless. Supplied by
   * measured.ts, which sets it from rating-curve error plus whatever
   * catchment-area transfer was applied.
   */
  measuredSpreadFrac?: number,
  /** Which flow source won the magnitude (engine/flowchoice.ts) — wording only. */
  authority?: 'network' | 'model' | 'hydest',
  /**
   * Per-site head error, m, when the site audit has measured one by comparing
   * the two terrain products at this exact reach. Replaces the global ±15 m
   * assumption in whichever direction the measurement points.
   */
  headErrM: number = DEM_HEAD_ERROR_M
): Uncertainty | null {
  const best = evaluate(input, scheme.i, scheme.j);
  if (!best || best.capacityMW <= 0) return null;

  // --- how wrong might the flow be? ---
  const haveBoth = Boolean(networkMeanCms && networkMeanCms > 0 && seriesMeanCms > 0);
  const ratio = haveBoth
    ? Math.max(networkMeanCms! / seriesMeanCms, seriesMeanCms / networkMeanCms!)
    : Infinity;
  const corroborated = haveBoth && ratio <= AGREEMENT_RATIO;
  const measured = measuredSpreadFrac !== undefined && measuredSpreadFrac > 0;
  const flowSpread = measured
    ? measuredSpreadFrac!
    : corroborated
      ? FLOW_SPREAD_CORROBORATED
      : FLOW_SPREAD_ALONE;

  const withFlow = (mult: number) =>
    evaluate({ ...input, series: input.series.map((v) => v * mult) }, scheme.i, scheme.j);

  const withHead = (deltaM: number) =>
    evaluate(
      {
        ...input,
        path: input.path.map((p, k) =>
          // Move the intake and powerhouse ends apart or together.
          k <= scheme.i ? { ...p, elevationM: p.elevationM + deltaM } : p
        ),
      },
      scheme.i,
      scheme.j
    );

  const flowLow = withFlow(1 - Math.min(0.95, flowSpread));
  const flowHigh = withFlow(1 + flowSpread);
  const headLow = withHead(-headErrM);
  const headHigh = withHead(+headErrM);

  const swing = (a: Scheme | null, b: Scheme | null, key: 'capacityMW' | 'energyGwh') =>
    a && b ? Math.abs(a[key] - b[key]) : 0;

  // Combine in quadrature: flow and terrain error are independent, so taking
  // the arithmetic sum would overstate the band.
  const combine = (key: 'capacityMW' | 'energyGwh'): Band => {
    const f = swing(flowLow, flowHigh, key) / 2;
    const h = swing(headLow, headHigh, key) / 2;
    const half = Math.hypot(f, h);
    return { low: Math.max(0, best[key] - half), best: best[key], high: best[key] + half };
  };

  const capacityMW = combine('capacityMW');
  const flowSwing = swing(flowLow, flowHigh, 'capacityMW');
  const headSwing = swing(headLow, headHigh, 'capacityMW');

  const drivers = [
    {
      name: 'River flow',
      swingPct: best.capacityMW > 0 ? (flowSwing / best.capacityMW) * 100 : 0,
      note: measured
        ? 'a measured record, carrying rating-curve error and any catchment transfer — not a model'
        : corroborated
          ? 'two global models agree here, but neither is gauged at this site'
          : haveBoth
            ? authority === 'hydest'
              ? `both global sources fail here (${ratio.toFixed(0)}× apart), so Nepal's own regression is carrying the magnitude — a fitted method with real scatter, not a measurement`
              : authority === 'model'
                ? `the network's discharge is broken on this reach (${ratio.toFixed(0)}× off), so the flood model is carrying this alone`
                : `the flood model's cell is off this channel (${ratio.toFixed(0)}× out), so the mapped network is carrying this alone`
            : 'a single global model, with nothing checking it',
    },
    {
      name: 'Head from terrain',
      swingPct: best.capacityMW > 0 ? (headSwing / best.capacityMW) * 100 : 0,
      note:
        headErrM !== DEM_HEAD_ERROR_M
          ? `±${headErrM.toFixed(0)} m, measured at this site by comparing two terrain products`
          : `±${DEM_HEAD_ERROR_M} m of DEM error on a ${scheme.grossHeadM.toFixed(0)} m drop`,
    },
  ].sort((a, b) => b.swingPct - a.swingPct);

  return {
    capacityMW,
    energyGwh: combine('energyGwh'),
    drivers,
    flowSpreadPct: flowSpread * 100,
    headSpreadM: headErrM,
  };
}

export { pct as bandWidthPct };
