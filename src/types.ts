/**
 * Core UI types. `Traced<T>` is the seed of the provenance system from plan.md §2.3:
 * every displayed number carries where it came from and how much to trust it.
 * The full evidence graph (inputs as TraceRefs) lands with the real engines; the
 * UI contract — click a value, see its story — starts here.
 */

export type Quality =
  | 'measured' // an instrument recorded it
  | 'modelled' // a model produced it (GloFAS, HydroRIVERS, DEM)
  | 'estimated' // derived here by a stated method
  | 'assumed' // a default someone should eventually replace
  | 'overridden' // a human replaced the computed value
  | 'sample'; // demo data standing in until its engine ships

export type Traced<T> = {
  value: T;
  unit?: string;
  quality: Quality;
  /** Short human sentence: what produced this. */
  method: string;
  /** Dataset / document behind it. */
  source?: string;
  note?: string;
};

export function traced<T>(
  value: T,
  quality: Quality,
  method: string,
  extra?: Partial<Pick<Traced<T>, 'unit' | 'source' | 'note'>>
): Traced<T> {
  return { value, quality, method, ...extra };
}

export type SchemeFamily = 'canal' | 'tunnel' | 'high-head';

export type ProfilePoint = {
  /** Chainage from intake, m. */
  ch: number;
  /** Ground surface elevation, m (sample datum). */
  ground: number;
  /** Waterway invert elevation, m. */
  invert: number;
  /** Hydraulic grade line at design flow, m. */
  hgl: number;
  seg: 'canal' | 'tunnel' | 'penstock';
};

export type Scheme = {
  id: string;
  name: string;
  family: SchemeFamily;
  familyLabel: string;
  grossHeadM: Traced<number>;
  designFlowCms: Traced<number>;
  residualFlowCms: Traced<number>;
  waterwayM: Traced<number>;
  penstockM: Traced<number>;
  capacityMW: Traced<number>;
  energyGwh: Traced<number>;
  wetGwh: Traced<number>;
  dryGwh: Traced<number>;
  plantFactor: Traced<number>;
  capexMnNpr: Traced<number>;
  specificUsdPerKw: Traced<number>;
  paybackYears: Traced<number>;
  /** Constraint flags the discovery engine will compute for real in M2. */
  flags: string[];
  whySurvives: string;
  profile: ProfilePoint[];
};

export type Reach = {
  uplandKm2: number;
  meanDischargeCms: number;
  strahler: number;
  distanceKm: number;
  point: { lat: number; lon: number };
};

export type ReachHit = { nearest: Reach; mainStem: Reach | null };

export type SelectedSite = {
  lat: number;
  lon: number;
  reach: Reach;
  mainStem: Reach | null;
  usedMainStem: boolean;
  /** Synthetic monsoon-shaped daily series scaled to the reach mean — labelled sample. */
  dates: string[];
  valuesCms: number[];
};
