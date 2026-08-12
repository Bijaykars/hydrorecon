/**
 * Turbine selection and part-load efficiency curves.
 *
 * Ported from HydroGenerate — Idaho National Laboratory, BSD-3-Clause
 * https://github.com/IdahoLabResearch/HydroGenerate
 * (HydroGenerate/turbine_calculation.py), which in turn implements the
 * correlations published by the CANMET Energy Technology Centre (2004), the
 * RETScreen engineering textbook. Polygon vertices and formulas are reproduced
 * from that source rather than re-derived, with the two exceptions documented
 * at `crossflowEfficiency` and `francisEfficiency` below.
 *
 * This replaces the single constant efficiency the app used before, which the
 * brief rules out explicitly: "Efficiency curves rather than one constant
 * efficiency."
 */

export type TurbineType = 'Kaplan' | 'Francis' | 'Pelton' | 'Turgo' | 'Crossflow' | 'Propeller';

/**
 * Regions of influence in (flow m³/s, head m). Verbatim from
 * `turbine_type_selector`. A point inside several regions goes to whichever
 * polygon centroid is nearest.
 */
const REGIONS: { type: TurbineType; poly: [number, number][] }[] = [
  {
    type: 'Pelton',
    poly: [
      [1, 50],
      [1, 1000],
      [20, 1000],
      [60, 500],
      [50, 400],
      [1, 50],
    ],
  },
  {
    type: 'Turgo',
    poly: [
      [1, 50],
      [1, 260],
      [10, 50],
      [1, 50],
    ],
  },
  {
    type: 'Francis',
    poly: [
      [1, 50],
      [5, 10],
      [200, 10],
      [900, 15],
      [900, 80],
      [100, 700],
      [6, 700],
      [1, 50],
    ],
  },
  {
    type: 'Kaplan',
    poly: [
      [1, 1],
      [1, 20],
      [9, 80],
      [175, 80],
      [1000, 15],
      [60, 1],
      [1, 1],
    ],
  },
  {
    type: 'Crossflow',
    poly: [
      [1, 4],
      [1, 100],
      [10, 10],
      [10, 4],
      [1, 4],
    ],
  },
];

/** Ray casting, standing in for shapely's `Polygon.contains`. */
function contains(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Area centroid, standing in for shapely's `Polygon.centroid`. */
function centroid(poly: [number, number][]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += cross;
    cx += (poly[j][0] + poly[i][0]) * cross;
    cy += (poly[j][1] + poly[i][1]) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-12) return poly[0];
  return [cx / (6 * a), cy / (6 * a)];
}

/**
 * Net-head ranges from the ESHA 2004 Guide, Table 6.3. An independent published
 * source, used as the fallback when the duty point escapes the regions above.
 */
const ESHA_HEAD_RANGE: Record<TurbineType, [number, number]> = {
  Kaplan: [2, 40],
  Propeller: [2, 40],
  Francis: [25, 350],
  // ESHA prints 1300 m as the typical ceiling, not a physical one: Bieudron in
  // Switzerland runs Pelton units at 1883 m. Capping at 1300 left alpine
  // schemes with no machine at all, which is less useful than naming the one
  // that would actually be installed.
  Pelton: [50, 2000],
  Crossflow: [5, 200],
  Turgo: [50, 250],
};

/** Above this, crossflow and Turgo are not the machines anyone installs. */
const SMALL_MACHINE_MAX_CMS = 10;

/**
 * Largest flow an impulse machine is built for, m³/s.
 *
 * Pelton runners take a jet, not a full-bore passage, so they stay in the
 * low-flow/high-head corner. Bieudron, among the largest ever built, passes
 * about 75 m³/s. Twice that is a generous ceiling; beyond it there is no real
 * machine to name and the honest answer is none.
 */
const IMPULSE_MAX_CMS = 150;

/**
 * Pick a turbine for this duty point.
 *
 * HydroGenerate's regions come first. They are screening envelopes drawn for
 * small hydro, though, and they do not reach large Himalayan schemes: Upper
 * Tamakoshi is a built 456 MW Pelton plant running 66 m³/s, and the Pelton
 * region stops at 60. Rather than return "no machine" for a station that
 * demonstrably exists, fall back to the ESHA 2004 head bands — a second
 * published source — and pick the machine whose band most tightly brackets the
 * head, on a log scale so a 50–1300 m band does not win by sheer width.
 */
export function selectTurbine(designFlowCms: number, headM: number): TurbineType | null {
  let best: TurbineType | null = null;
  let bestDist = Infinity;
  for (const { type, poly } of REGIONS) {
    if (!contains(poly, designFlowCms, headM)) continue;
    const [cx, cy] = centroid(poly);
    const d = Math.hypot(designFlowCms - cx, headM - cy);
    if (d < bestDist) {
      bestDist = d;
      best = type;
    }
  }
  if (best) return best;
  if (!(headM > 0) || !(designFlowCms > 0)) return null;

  let fallback: TurbineType | null = null;
  let bestFit = Infinity;
  for (const type of Object.keys(ESHA_HEAD_RANGE) as TurbineType[]) {
    const [lo, hi] = ESHA_HEAD_RANGE[type];
    if (headM < lo || headM > hi) continue;
    // Propeller is a fixed-blade Kaplan; never select it over Kaplan here.
    if (type === 'Propeller') continue;
    if (designFlowCms > SMALL_MACHINE_MAX_CMS && (type === 'Crossflow' || type === 'Turgo')) {
      continue;
    }
    if (designFlowCms > IMPULSE_MAX_CMS && (type === 'Pelton' || type === 'Turgo')) continue;
    const fit = Math.abs(Math.log(headM / Math.sqrt(lo * hi)));
    if (fit < bestFit) {
      bestFit = fit;
      fallback = type;
    }
  }
  return fallback;
}

/** Turbine manufacture / design coefficient. HydroGenerate's default. */
const RM = 4.5;
/** Pelton jets. HydroGenerate's default. */
const N_JETS = 3;

/** Runner throat diameter, m. `ReactionTurbines.runnersize_calculator`. */
function runnerSize(designFlowCms: number): number {
  // k changes above 23 m³/s to avoid a region the source correlation leaves undefined.
  const k = designFlowCms > 23 ? 0.41 : 0.46;
  return k * designFlowCms ** 0.473;
}

function francisEfficiency(q: number, qd: number, headM: number): number {
  const d = runnerSize(qd);
  const nq = 600 * headM ** -0.5;
  const enq = ((nq - 56) / 256) ** 2;
  const ed = (0.081 + enq) * (1 - 0.789 * d ** -0.2);
  const ep = 0.919 - enq + ed - 0.0305 + 0.005 * RM;
  const qp = 0.65 * qd * nq ** 0.05;
  const epDrop = 0.0072 * nq ** 0.4;
  const er = (1 - epDrop) * ep;
  if (q < qp) {
    return Math.max(0, (1 - 1.25 * ((qp - q) / qp) ** (3.94 - 0.0195 * nq)) * ep);
  }
  // DEVIATION FROM THE PORTED SOURCE, deliberate.
  //   HydroGenerate:  ep - ((q - qp) / (qd - qp)**2) * (ep - er)
  // squares only the denominator, which is dimensionally inconsistent (the term
  // carries units of 1/flow) and does not return `er` at full load. The
  // published RETScreen form squares the whole ratio, which does. HydroGenerate
  // only ever evaluates 60-120% of design flow so the difference stays small
  // there; this app dispatches the entire flow-duration curve, so it matters.
  return Math.max(0, ep - ((q - qp) / (qd - qp)) ** 2 * (ep - er));
}

function kaplanEfficiency(q: number, qd: number, headM: number): number {
  const d = runnerSize(qd);
  const nq = 800 * headM ** -0.5;
  const enq = ((nq - 170) / 700) ** 2;
  const ed = (0.095 + enq) * (1 - 0.789 * d ** -0.2);
  const ep = 0.905 - enq + ed - 0.0305 + 0.005 * RM;
  const qp = 0.75 * qd;
  return Math.max(0, (1 - 3.5 * ((qp - q) / qp) ** 6) * ep);
}

function propellerEfficiency(q: number, qd: number, headM: number): number {
  const d = runnerSize(qd);
  const nq = 800 * headM ** -0.5;
  const enq = ((nq - 170) / 700) ** 2;
  const ed = (0.095 + enq) * (1 - 0.789 * d ** -0.2);
  const ep = 0.905 - enq + ed - 0.0305 + 0.005 * RM;
  const qp = qd; // peak at design flow
  return Math.max(0, (1 - 1.25 * ((qp - q) / qp) ** 1.13) * ep);
}

function peltonEfficiency(q: number, qd: number, headM: number): number {
  const j = N_JETS;
  const n = 31 * ((headM * qd) / j) ** 0.5;
  const d = (49.4 * headM ** 0.5 * j ** 0.02) / n;
  const ep = 0.864 * d ** 0.04;
  const qp = (0.662 + 0.001 * j) * qd;
  return Math.max(0, (1 - (1.31 + 0.025 * j) * (Math.abs(qp - q) / qp) ** (5.6 + 0.4 * j)) * ep);
}

function crossflowEfficiency(q: number, qd: number): number {
  // DEVIATION FROM THE PORTED SOURCE, deliberate.
  //   HydroGenerate:  0.79 - 0.15*((qd-q)/qd) - 1.37*((qd-q)/q)**14
  // divides the last term by q rather than qd. At half design flow that term
  // becomes 1.0 and drives the efficiency negative, so a crossflow turbine —
  // the machine specifically chosen for good part-load behaviour — would read
  // as producing nothing at half flow. The published RETScreen form divides by
  // qd throughout. Above ~0.6*qd the two agree, which is the only range
  // HydroGenerate evaluates.
  const r = (qd - q) / qd;
  return Math.max(0, 0.79 - 0.15 * r - 1.37 * r ** 14);
}

export type TurbineCurve = {
  type: TurbineType;
  /** Turbine efficiency at a given flow, 0..1. Excludes the generator. */
  at: (q: number) => number;
  /** Best efficiency this machine reaches over its operating range. */
  peak: number;
  /** Flow at which that peak occurs, m³/s. */
  peakFlowCms: number;
  /** Below this share of design flow the machine is shut down. */
  minFlowFrac: number;
};

/**
 * Minimum practical flow as a share of design, by machine. Impulse turbines and
 * crossflows regulate down far better than a fixed-blade reaction runner, which
 * is a large part of why they are chosen for small hydro.
 */
const MIN_FLOW_FRAC: Record<TurbineType, number> = {
  Pelton: 0.1,
  Turgo: 0.1,
  Crossflow: 0.12,
  Francis: 0.4,
  Kaplan: 0.2,
  Propeller: 0.65,
};

/** Build the part-load curve for a duty point. */
export function turbineCurve(designFlowCms: number, headM: number): TurbineCurve | null {
  const type = selectTurbine(designFlowCms, headM);
  if (!type || !(designFlowCms > 0) || !(headM > 0)) return null;

  const raw = (q: number): number => {
    switch (type) {
      case 'Francis':
        return francisEfficiency(q, designFlowCms, headM);
      case 'Kaplan':
        return kaplanEfficiency(q, designFlowCms, headM);
      case 'Propeller':
        return propellerEfficiency(q, designFlowCms, headM);
      case 'Pelton':
        return peltonEfficiency(q, designFlowCms, headM);
      case 'Turgo':
        // HydroGenerate derives Turgo as Pelton less three points.
        return Math.max(0, peltonEfficiency(q, designFlowCms, headM) - 0.03);
      case 'Crossflow':
        return crossflowEfficiency(q, designFlowCms);
    }
  };

  const minFlowFrac = MIN_FLOW_FRAC[type];
  let peak = 0;
  let peakFlowCms = designFlowCms;
  for (let f = minFlowFrac; f <= 1.0001; f += 0.01) {
    const e = raw(f * designFlowCms);
    if (e > peak) {
      peak = e;
      peakFlowCms = f * designFlowCms;
    }
  }

  return {
    type,
    at: (q: number) => {
      if (!(q > 0) || q < minFlowFrac * designFlowCms) return 0;
      return raw(Math.min(q, designFlowCms));
    },
    peak,
    peakFlowCms,
    minFlowFrac,
  };
}
