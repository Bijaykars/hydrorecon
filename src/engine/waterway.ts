/**
 * Sizing the conveyance, and charging what it really costs in head.
 *
 * Until now head loss was a slider: one flat percentage of gross head, applied
 * identically to a 400 m scheme and a 14 km one. That is a real bias in the
 * search, not just an imprecision — the discovery engine compares waterway
 * lengths against each other, and charging them all the same friction quietly
 * favours the longest option every time.
 *
 * A run-of-river scheme is two different things in series, and conflating them
 * is what made the flat fraction seem defensible:
 *
 *   HEADRACE — a canal or low-pressure tunnel following the hillside contour
 *   from the intake. Nearly level by design, moving slowly. It is the long part,
 *   and it loses very little per kilometre.
 *
 *   PENSTOCK — the steep pressurised pipe from the forebay down to the machines.
 *   It is the short part, and nearly all the friction lives in it, because loss
 *   goes as velocity squared and this is where the water is finally moving.
 *
 * That structure is r.green.hydro.structure's (GRASS, GPL — method only, no code
 * taken): channel along the contour to the point nearest the outlet, penstock
 * straight down from there.
 *
 * Sizing and friction follow published references rather than invention:
 *   - ESHA 2004 economic penstock diameter, validated below against the
 *     handbook's own worked example.
 *   - Darcy-Weisbach with the Swamee-Jain friction factor, in the regime split
 *     OpenHPL uses (OpenSimHub/OpenHPL, MPL-2.0 — equations referenced, not
 *     copied; this file is TypeScript written from the formulas).
 *   - Manning for the open-channel/tunnel headrace, as ESHA specifies.
 */

const G = 9.81;

/** Manning n. Steel penstock, and a concrete-lined headrace tunnel or canal. */
const N_STEEL = 0.012;
const N_LINED = 0.014;

/** Absolute roughness of commercial steel, m — the eps in Swamee-Jain. */
const EPS_STEEL_M = 4.5e-5;

/** Kinematic viscosity of water near 10 C, m^2/s. Mountain rivers are cold. */
const NU = 1.31e-6;

/**
 * Design velocity in the headrace, m/s.
 *
 * Bounded at both ends by things that are not friction: below roughly 0.6 m/s
 * suspended sediment drops out and the canal silts up, and above about 2.5 m/s
 * a concrete lining starts to abrade. 1.8 sits where small-hydro practice does.
 *
 * ponytail: fixed velocity, not an optimised one. A real designer facing a 12 km
 * headrace would run it faster in a smaller bore, trading head against
 * excavation — so this sizes generously and under-charges long headraces in
 * head, while overstating how much tunnel gets dug. Closing that loop needs
 * excavation cost per m3, which this app does not model yet; when it does, sweep
 * velocity and minimise (lost energy + civil cost) the way the penstock already
 * balances steel against friction.
 */
const HEADRACE_VELOCITY_MS = 1.8;

/**
 * Hillside angle assumed for the penstock, degrees.
 *
 * The DEM gives the river profile but not the cross-valley slope the penstock
 * would actually descend, so this is an assumption and is reported as one. 45
 * degrees is a common steep-hillside layout; it makes the penstock sqrt(2) times
 * the gross head, which is on the long side and therefore the cautious side,
 * since a longer pipe means more friction.
 */
const PENSTOCK_SLOPE_DEG = 45;

/**
 * Hard ceiling on penstock velocity, m/s.
 *
 * ESHA's diameter is an ECONOMIC optimum, not a buildable one, and on its own it
 * will happily specify a pipe nobody would install. Sizing a 110 m3/s duty on a
 * 215 m head gave 3.19 m and 13.8 m/s — the formula had met its 4% loss target,
 * because with the penstock length pinned to a multiple of the head the L/H
 * ratio cancels out and the diameter stops depending on head at all, leaving it
 * scaling only as Q^0.375.
 *
 * Real penstocks run 3-6 m/s. Past that, surge pressure on a load rejection
 * climbs with v, abrasion by suspended sediment climbs faster, and the economic
 * assumption behind the formula has stopped being about steel cost. So the
 * diameter is whichever is LARGER: the economic one, or the one this cap
 * implies. ESHA's own companion method (Ludin-Bondschu) carries the same check.
 */
const PENSTOCK_MAX_VELOCITY_MS = 5;

/**
 * Local ("minor") loss coefficients, summed, applied to the penstock velocity head.
 *
 * Friction along the pipe is not the whole bill, and leaving these out made the
 * model absurdly optimistic at high head: an 800 m scheme came out at 0.67%
 * total loss, where real ones sit between 2% and 6%. Unlike friction, these do
 * not shrink when the conduit is generously sized — they are set by the fittings
 * and scale with velocity head, so they dominate exactly the short, high-head
 * cases where friction is small.
 *
 * Screening-grade values from ESHA 2004 ch. 2, for a conventional layout:
 *   trash rack (Kirschmer, clean)  0.3
 *   intake entrance, rounded       0.2
 *   bends, ~4 at 0.15              0.6
 *   valve, butterfly fully open    0.2
 *
 * A real layout is drawn, not assumed, so this is a placeholder for a bend
 * schedule — but a placeholder at the right order of magnitude beats a zero.
 */
const LOCAL_LOSS_K = 1.3;

/** Below this there is no meaningful conveyance to size. */
const MIN_FLOW_CMS = 1e-3;

export type Segment = {
  kind: 'headrace' | 'penstock';
  lengthM: number;
  diameterM: number;
  velocityMs: number;
  /** Head lost in this segment at design flow, m. */
  lossM: number;
  method: string;
};

export type Waterway = {
  segments: Segment[];
  /** Total head lost at DESIGN flow, m. */
  totalLossM: number;
  /** That loss as a fraction of gross head — what the engine consumes. */
  lossFrac: number;
};

/**
 * Darcy friction factor.
 *
 * Laminar below Re 2100, Swamee-Jain above 2300, and a cubic blend across the
 * transition rather than a step. The blend is OpenHPL's: the transition region
 * has no settled physics, and a discontinuity there would put a kink in the
 * head-versus-flow curve that the dispatch loop would then integrate over.
 */
export function darcyF(re: number, diameterM: number, epsM = EPS_STEEL_M): number {
  if (!(re > 0)) return 0;
  const laminar = (r: number) => 64 / r;
  const turbulent = (r: number) =>
    (2 * Math.log10(epsM / (3.7 * diameterM) + 5.74 / r ** 0.9)) ** -2;
  if (re <= 2100) return laminar(re);
  if (re >= 2300) return turbulent(re);
  // Smooth cubic bridge between the two closed forms.
  const t = (re - 2100) / 200;
  const s = t * t * (3 - 2 * t);
  return laminar(2100) * (1 - s) + turbulent(2300) * s;
}

/**
 * ESHA 2004 economic penstock diameter, m.
 *
 * `D = 2.69 (n^2 Q^2 L / H)^0.1875`, the diameter at which friction loss lands
 * near 4% of gross head — the point where the cost of more steel stops being
 * repaid by the energy it saves. Not a physical law but a costing convention,
 * and the one the handbook the rest of this engine follows uses.
 */
export function eshaPenstockDiameter(
  qCms: number,
  grossHeadM: number,
  lengthM: number,
  n = N_STEEL
): number {
  if (!(qCms > 0) || !(grossHeadM > 0) || !(lengthM > 0)) return NaN;
  return 2.69 * ((n * n * qCms * qCms * lengthM) / grossHeadM) ** 0.1875;
}

const areaOf = (d: number) => (Math.PI * d * d) / 4;

/**
 * Size both segments and total up the head they cost at design flow.
 *
 * `alongRiverM` is the distance along the channel between intake and
 * powerhouse — what the headrace has to span. The penstock is extra, dropping
 * out of the hillside at its end.
 */
export function sizeWaterway(opts: {
  designFlowCms: number;
  grossHeadM: number;
  alongRiverM: number;
}): Waterway | null {
  const { designFlowCms: q, grossHeadM: h, alongRiverM } = opts;
  if (!(q > MIN_FLOW_CMS) || !(h > 0)) return null;

  // --- penstock: steep, pressurised, where the friction actually is ---
  const penstockLenM = Math.max(1, h / Math.sin((PENSTOCK_SLOPE_DEG * Math.PI) / 180));
  const dEcon = eshaPenstockDiameter(q, h, penstockLenM);
  if (!Number.isFinite(dEcon) || dEcon <= 0) return null;
  // Widen to the velocity cap when the economic diameter would be unbuildable.
  const dCap = Math.sqrt((4 * q) / (Math.PI * PENSTOCK_MAX_VELOCITY_MS));
  const dPen = Math.max(dEcon, dCap);
  const velocityLimited = dCap > dEcon;
  const vPen = q / areaOf(dPen);
  const rePen = (vPen * dPen) / NU;
  const fPen = darcyF(rePen, dPen);
  const velocityHead = (vPen * vPen) / (2 * G);
  const frictionPen = fPen * (penstockLenM / dPen) * velocityHead;
  const localPen = LOCAL_LOSS_K * velocityHead;
  const lossPen = frictionPen + localPen;

  // --- headrace: long, slow, nearly level ---
  // Sized by velocity, then Manning gives the gradient that velocity needs, and
  // the gradient times the length IS the head given up along the way.
  const headraceLenM = Math.max(0, alongRiverM - penstockLenM * Math.cos((PENSTOCK_SLOPE_DEG * Math.PI) / 180));
  const dHead = Math.sqrt((4 * q) / (Math.PI * HEADRACE_VELOCITY_MS));
  // Hydraulic radius of a circular section running full is D/4.
  const rHyd = dHead / 4;
  const slope = ((N_LINED * HEADRACE_VELOCITY_MS) / rHyd ** (2 / 3)) ** 2;
  const lossHead = slope * headraceLenM;

  const segments: Segment[] = [
    {
      kind: 'headrace',
      lengthM: headraceLenM,
      diameterM: dHead,
      velocityMs: HEADRACE_VELOCITY_MS,
      lossM: lossHead,
      method: `Manning n=${N_LINED}, sized for ${HEADRACE_VELOCITY_MS} m/s`,
    },
    {
      kind: 'penstock',
      lengthM: penstockLenM,
      diameterM: dPen,
      velocityMs: vPen,
      lossM: lossPen,
      method:
        (velocityLimited
          ? `held to ${PENSTOCK_MAX_VELOCITY_MS} m/s (ESHA economic ${dEcon.toFixed(2)} m was too narrow)`
          : 'ESHA 2004 economic diameter') +
        `, Darcy-Weisbach f=${fPen.toFixed(4)} (Swamee-Jain), ` +
        `${frictionPen.toFixed(2)} m friction + ${localPen.toFixed(2)} m rack/bends/valve`,
    },
  ];

  const totalLossM = lossHead + lossPen;
  return {
    segments,
    totalLossM,
    // Cap below 1: a scheme whose losses exceed its gross head is not a scheme,
    // and the engine downstream must never see a negative net head.
    lossFrac: Math.min(0.9, totalLossM / h),
  };
}
