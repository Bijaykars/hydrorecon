/**
 * Sediment — the thing that actually kills Himalayan hydropower.
 *
 * Every other constraint in this app decides whether a scheme gets built.
 * Sediment decides whether it survives being built. Jhimruk lost runner material
 * to abrasion inside a single monsoon; Khimti fights the same battle every year.
 * A screening tool that sizes a penstock for a river carrying glacial rock flour
 * and never mentions the fact is describing a machine that will not last.
 *
 * There are two questions here and only one of them is arithmetic.
 *
 *   HOW BIG A DESANDING BASIN — settling physics, and answerable. A basin is a
 *   place where the water slows down enough for sand to fall out before it
 *   reaches the runner, so its size is set by how fast the target grain sinks.
 *
 *   IS THERE ROOM FOR IT — terrain, and the reason this belongs in a screening
 *   tool at all. The basin is the largest flat structure in a run-of-river
 *   scheme, and it has to sit beside the intake at roughly intake level. On a
 *   gorge reach there is no bench that size, and that changes the layout, the
 *   cost, and sometimes the answer. The DEM already loaded to find the head
 *   knows the shape of that valley, so this costs one more cross-section.
 *
 * WHAT THIS IS NOT: a sediment yield estimate. Nepal has no openly published
 * suspended-sediment record — DHM measures it and does not release the series —
 * so no honest tonnes-per-year figure can be produced here, and one is not
 * invented. What the catchment's altitude distribution CAN say is whether the
 * sediment arriving is glacial, which is the part that matters for wear: glacial
 * grinding makes fresh angular quartz, and quartz is harder than turbine steel.
 */

const G = 9.81;

/** Kinematic viscosity of water near 10 C. Matches waterway.ts — same cold rivers. */
const NU = 1.31e-6;

/** Relative density of quartz. The abrasive fraction is quartz and feldspar. */
const S_QUARTZ = 2.65;

/**
 * Horizontal velocity through the basin, m/s.
 *
 * Bounded below by scour — too slow and the basin silts solid between flushes —
 * and above by the settling itself, since sand that has landed re-entrains once
 * the flow over the floor gets quick. 0.2 to 0.4 is the practical window for the
 * grain sizes below.
 *
 * It matters less than it looks. Plan area is Q/w by the overflow-rate criterion
 * and does not depend on velocity at all: raising v makes the basin narrower and
 * longer in exact proportion. 0.3 sits mid-window and gives the narrower shape,
 * which is what actually gets built in a Nepali valley.
 */
const BASIN_VELOCITY_MS = 0.3;

/**
 * Turbulence factor on the ideal settling length.
 *
 * The textbook basin has every particle falling through still water. A real one
 * is turbulent, short-circuits along its own inlet jet, and re-suspends what it
 * has already caught, so it must be longer than the ideal by 1.5 to 2. Taking 2
 * is the conservative end, and conservative here means a bigger footprint to
 * find room for, which is the direction a screening tool should err in.
 */
const TURBULENCE_K = 2.0;

/** Flushing needs depth; excavation and wall cost put a ceiling on it. */
const MIN_DEPTH_M = 1.5;
const MAX_DEPTH_M = 8;

/**
 * Settling velocity of a sand grain in still water, m/s. Zanke (1977).
 *
 *   w = (10 nu / d) * [ sqrt(1 + 0.01 (s-1) g d^3 / nu^2) - 1 ]
 *
 * Stokes' law is the familiar one and is wrong here: it holds below about 0.1 mm
 * and over-predicts everywhere above, which is the entire range that damages
 * turbines. Zanke spans 0.05 to 2 mm in one closed form with no regime switch,
 * so there is no discontinuity for the sizing to trip over. Against published
 * quartz values it lands at 6.0 mm/s for 0.1 mm and 21 mm/s for 0.2 mm.
 */
export function settlingVelocity(diameterMm: number, nu = NU): number {
  const d = diameterMm / 1000;
  if (!(d > 0)) return NaN;
  return ((10 * nu) / d) * (Math.sqrt(1 + (0.01 * (S_QUARTZ - 1) * G * d ** 3) / nu ** 2) - 1);
}

/**
 * The grain size worth removing, mm, by head.
 *
 * Damage rises steeply with head because it rises with the cube of the velocity
 * the particle hits at, so a high-head Pelton needs water an order of magnitude
 * cleaner than a low-head Kaplan tolerates. These are the bands small-hydro
 * practice uses. Very-high-head plants sometimes chase 0.15 mm or finer and pay
 * for it with a basin half again as long; going below that stops being settling
 * and starts being a different machine.
 */
export function targetParticleMm(netHeadM: number): number {
  if (netHeadM >= 150) return 0.2;
  if (netHeadM >= 50) return 0.3;
  return 0.5;
}

export type Desander = {
  /** Smallest grain the basin is sized to catch, mm. */
  particleMm: number;
  /** How fast that grain sinks, mm/s. */
  settlingMmS: number;
  /** Settling zone alone, m. */
  settlingLengthM: number;
  /** Settling zone plus the inlet flare and outlet contraction — what gets built. */
  totalLengthM: number;
  /** Across the valley, including dividing and outer walls. */
  totalWidthM: number;
  depthM: number;
  /** Parallel chambers, so one can be flushed while the other keeps running. */
  bays: number;
  /** Flat ground the structure needs across the valley, including working room. */
  benchNeededM: number;
  excavationM3: number;
};

/** Room to stand, batch concrete and drive a truck along one side. */
const ACCESS_WIDTH_M = 6;

/**
 * Size the desanding basin for a duty point.
 *
 * The chain is the classic one. Cross-section comes from the design flow and the
 * through-velocity; depth and width split that section at roughly 1:2, clamped
 * to what can be flushed and what can be walled; and the length is the distance
 * the target grain needs to fall the full depth while drifting through, scaled
 * up for turbulence. The transitions are real structure, not a fudge — an inlet
 * that flares faster than about 1:5 separates off the walls and ruins the
 * quiescence the whole basin exists to provide.
 */
export function desander(opts: { designFlowCms: number; netHeadM: number }): Desander | null {
  const { designFlowCms: q, netHeadM } = opts;
  if (!(q > 0) || !(netHeadM > 0)) return null;

  const particleMm = targetParticleMm(netHeadM);
  const w = settlingVelocity(particleMm);
  if (!(w > 0)) return null;

  const sectionM2 = q / BASIN_VELOCITY_MS;
  const depthM = Math.min(MAX_DEPTH_M, Math.max(MIN_DEPTH_M, Math.sqrt(sectionM2 / 2)));
  const waterWidthM = sectionM2 / depthM;

  // Two chambers above the size where a shutdown to flush stops being acceptable.
  const bays = q > 0.5 ? 2 : 1;
  const totalWidthM = waterWidthM + 0.5 * (bays + 1);

  const settlingLengthM = (TURBULENCE_K * BASIN_VELOCITY_MS * depthM) / w;

  // Approach conduit diameter, at the headrace velocity waterway.ts sizes for.
  const approachM = Math.sqrt((4 * q) / (Math.PI * 1.8));
  const inletM = Math.max(0, 2.5 * (waterWidthM - approachM)); // 1:5 flare
  const outletM = Math.max(0, 1.5 * (waterWidthM - approachM)); // contraction may be sharper

  return {
    particleMm,
    settlingMmS: w * 1000,
    settlingLengthM,
    totalLengthM: settlingLengthM + inletM + outletM,
    totalWidthM,
    depthM,
    bays,
    benchNeededM: totalWidthM + ACCESS_WIDTH_M,
    excavationM3: settlingLengthM * totalWidthM * depthM,
  };
}

// ---------------------------------------------------------------------------
// Is there anywhere to put it?
// ---------------------------------------------------------------------------

export type CrossSample = { offsetM: number; elevationM: number };

export type BenchFit = {
  /** Widest usable flat run found on either bank, m. */
  widestM: number;
  /** Which bank it is on, in the direction the cross-section was sampled. */
  side: 'left' | 'right' | null;
  /** Height of that bench above the river, m. */
  liftM: number;
  /**
   * `marginal` means the answer is inside the DEM's own error, not that the
   * valley is borderline. See the reasoning on `benchFit`.
   */
  verdict: 'fits' | 'no-room' | 'marginal';
  resolutionM: number;
};

/** Steeper than this and the cut-and-fill stops being a screening-scale detail. */
const MAX_CROSS_SLOPE = 0.25;

/**
 * Highest a gravity-fed basin can sit above the river, m.
 *
 * The intake sits a few metres up on a weir, and the basin sits just below the
 * intake water level so that the flow reaches it without pumping. A terrace 60 m
 * up the valley side is real flat ground and completely useless here.
 */
const MAX_LIFT_M = 20;

/**
 * Look for a bench wide enough to hold the basin, in a cross-section of the
 * valley at the intake.
 *
 * The basin's long axis runs down the valley, where the ground is comparatively
 * gentle; its width runs across, into the hillside. So width is what the terrain
 * denies, and a cross-section is the right cut to take.
 *
 * The DEM's posting bounds what this can say, but it bounds the COMPARISON, not
 * the requirement. An earlier version refused to answer whenever the basin was
 * narrower than a couple of postings, which sounded careful and was useless — a
 * 233 MW scheme on the Marsyangdi needs a 22 m bench against 30 m terrain, so
 * the honest-looking rule silently declined to answer for almost every real
 * scheme.
 *
 * The fix is to notice there are two different findings in here. Whether any
 * ground within reach is flatter than 25% is a SLOPE question, and a 30 m DEM
 * answers it well; a valley with no such ground anywhere in 500 m is a gorge,
 * and that is worth saying at any basin size. How WIDE a bench is, once one
 * exists, is resolution-limited to about one posting. So a clear gorge and a
 * clear terrace both get answered, and only the genuinely close calls come back
 * `marginal`.
 */
export function benchFit(
  section: readonly CrossSample[],
  neededWidthM: number,
  resolutionM: number
): BenchFit | null {
  const pts = section.filter((p) => Number.isFinite(p.elevationM));
  if (pts.length < 5 || !(neededWidthM > 0)) return null;

  // The river is the low point of the section, not necessarily its centre — the
  // cross-section is drawn perpendicular to a traced channel, and the trace has
  // its own metre-scale wander.
  const riverZ = Math.min(...pts.map((p) => p.elevationM));

  // Steepest of the two ONE-SIDED slopes, never the central difference. A
  // central difference reads zero at the bottom of a symmetric V, so a gorge
  // floor — the exact case this is here to catch — would come back flat.
  const usable = pts.map((p, i) => {
    let slope = 0;
    for (const n of [pts[i - 1], pts[i + 1]]) {
      if (!n) continue;
      const run = Math.abs(n.offsetM - p.offsetM);
      slope = Math.max(slope, run > 0 ? Math.abs(n.elevationM - p.elevationM) / run : Infinity);
    }
    const lift = p.elevationM - riverZ;
    return slope <= MAX_CROSS_SLOPE && lift <= MAX_LIFT_M;
  });

  let widestM = 0;
  let side: 'left' | 'right' | null = null;
  let liftM = 0;
  let runStart = -1;
  for (let i = 0; i <= usable.length; i++) {
    if (i < usable.length && usable[i]) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const from = pts[runStart];
      const to = pts[i - 1];
      const width = Math.abs(to.offsetM - from.offsetM);
      if (width > widestM) {
        widestM = width;
        side = (from.offsetM + to.offsetM) / 2 < 0 ? 'left' : 'right';
        liftM = (from.elevationM + to.elevationM) / 2 - riverZ;
      }
      runStart = -1;
    }
  }

  const verdict: BenchFit['verdict'] =
    // No ground under the slope limit anywhere in the section. A slope finding,
    // and one the terrain resolves regardless of how wide the basin is.
    widestM === 0
      ? 'no-room'
      : // Both bounds strict: a gap of exactly one posting is the edge of what
        // the terrain can see, and the edge belongs to `marginal`.
        widestM > neededWidthM + resolutionM
        ? 'fits'
        : widestM + resolutionM < neededWidthM
          ? 'no-room'
          : 'marginal';

  return { widestM, side, liftM, verdict, resolutionM };
}

// ---------------------------------------------------------------------------
// How hard this catchment works the basin
// ---------------------------------------------------------------------------

export type SedimentSource = {
  /** Share of the catchment above 3000 m — the glacial and periglacial part. */
  highFrac: number;
  label: string;
  note: string;
};

/**
 * What the catchment's altitude says about the sediment it delivers.
 *
 * This is a proxy and is labelled as one. It is a defensible proxy because the
 * mechanism is direct: ice grinds bedrock into fresh angular silt and fine sand
 * with the quartz still sharp, and it does so continuously rather than only in
 * storms. A catchment that is largely above 3000 m is fed by that process. A
 * middle-hills catchment erodes hard too, in monsoon landslides, but delivers
 * more weathered and more seasonal material.
 *
 * The hypsometry comes free: HYDEST already needs the area above and below fixed
 * contours, so pipeline/build-hypsometry.mjs has already measured it per reach.
 */
export function sedimentSource(below3000Frac: number): SedimentSource | null {
  if (!Number.isFinite(below3000Frac)) return null;
  const highFrac = Math.min(1, Math.max(0, 1 - below3000Frac));
  if (highFrac >= 0.4) {
    return {
      highFrac,
      label: 'glacier-fed — the hardest case',
      note:
        'Most of this catchment is above 3000 m, so the load is glacial: fresh, angular, ' +
        'quartz-rich, and arriving all year rather than only in storms. This is the regime ' +
        'that wore out Jhimruk. Size the basin for it and plan for runner replacement.',
    };
  }
  if (highFrac >= 0.1) {
    return {
      highFrac,
      label: 'mixed high and middle catchment',
      note:
        'Part of the catchment reaches above 3000 m, so some of the load is glacial and ' +
        'abrasive on top of the monsoon supply from the hills below.',
    };
  }
  return {
    highFrac,
    label: 'middle hills — monsoon-driven',
    note:
      'Little of this catchment is glaciated. The load is monsoon erosion and landslide ' +
      'debris: heavily seasonal, and concentrated in a few days of the year rather than spread ' +
      'through it. A desander is still needed — Nepali hill rivers are not clean.',
  };
}
