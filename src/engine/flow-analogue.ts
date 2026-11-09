/** Experimental transfer of observed specific runoff between similar catchments.
 * Not GR4J: no rainfall-runoff simulation or calibration is implied.
 */
export type CatchmentFeatures = { area: number; rain: number; elevation: number; low: number; high: number };
export type FlowDonor = CatchmentFeatures & { id: string; river: string; lat: number; lon: number; truth: number; years: number; from: number; to: number };
export type AnalogueFlow = {
  meanCms: number;
  weakMatch: boolean;
  donors: { station: FlowDonor; distance: number; weight: number; transferredCms: number }[];
};
/**
 * THE AREA-RATIO EXPONENT, which was an unmeasured 1.0.
 *
 * The transfer line is precipitation-weighted catchment-area ratio (PCAR),
 * the rule Nepali design-discharge practice adopts: donor mean flow scaled by
 * (target area / donor area)^b and by the rainfall ratio. It shipped with b
 * silently equal to 1, i.e. flow strictly proportional to area.
 *
 * The literature does not establish that. USGS regionalisation work reports
 * exponents from roughly 0.47 for very large basins to about 0.7 below
 * 20,000 km2, and seasonal values near 0.85 (winter), 0.91 (spring) and 1.02
 * (summer). Unity is "often assumed", not demonstrated. There is NO published
 * error bound for PCAR itself, so nothing here can be cited: the value has to
 * be measured against this project's own gauges.
 *
 * THE SHIPPED VALUE IS 1.0 BECAUSE THAT IS WHAT THE CODE ALWAYS DID, not
 * because it was measured. `checks/analogue-exponent-gate.mjs` sweeps it
 * leave-one-out and reports; changing it moves the analogue column of
 * HydrologyComparison and is the owner's call.
 */
export const AREA_RATIO_EXPONENT = 1;

/**
 * THE DONOR:TARGET AREA-RATIO WINDOW, which was absent.
 *
 * A donor is kept only if donor.area / target.area lies inside [min, max].
 * The similarity metric already puts area in its distance, but softly, so a
 * donor ten times the target's size can still win on rainfall and elevation.
 * USGS SIR 2008-5126 recommends 0.5-1.5; SIR 2016-5149 found 0.33-3 performed
 * as well or better for streamflow statistics.
 *
 * SHIPPED UNBOUNDED (0 to Infinity), i.e. no gate, which is what the code did.
 * The gate is applied BEFORE the nearest five are taken, so a narrow window
 * can leave fewer than five donors and the function returns null. That is not
 * a free improvement: a gate that scores better by discarding the hard sites
 * has improved nothing, and the harness scores gates paired on sites every arm
 * can answer, reporting the dropped count beside it.
 */
export const AREA_RATIO_WINDOW = { min: 0, max: Infinity } as const;

export type AnalogueOptions = { areaExponent?: number; areaRatioWindow?: { readonly min: number; readonly max: number } };

const valid = (r: CatchmentFeatures) => r.area > 0 && r.rain > 0 && r.elevation >= 0 &&
  [r.area, r.rain, r.elevation, r.low, r.high].every(Number.isFinite) &&
  r.low >= 0 && r.high >= 0 && r.low <= 1 && r.high <= 1 && r.low + r.high <= 1 + 1e-9;

export function analogueFlow(target: CatchmentFeatures, stations: readonly FlowDonor[], options: AnalogueOptions = {}): AnalogueFlow | null {
  if (!valid(target)) return null;
  const { areaExponent = AREA_RATIO_EXPONENT, areaRatioWindow = AREA_RATIO_WINDOW } = options;
  const donors = stations.filter((s) => valid(s) && s.truth > 0 && Number.isFinite(s.truth) &&
      s.area / target.area >= areaRatioWindow.min && s.area / target.area <= areaRatioWindow.max)
    .map((station) => ({ station, distance: Math.hypot(
      Math.log(target.area / station.area) / Math.log(4),
      Math.log(target.rain / station.rain) / Math.log(2),
      (target.elevation - station.elevation) / 1500,
      (target.low - station.low) / 0.3,
      (target.high - station.high) / 0.3,
    ) })).sort((a, b) => a.distance - b.distance || a.station.id.localeCompare(b.station.id)).slice(0, 5);
  if (donors.length < 5) return null;
  const total = donors.reduce((sum, d) => sum + 1 / (1 + d.distance ** 2), 0);
  const weighted = donors.map((d) => ({ ...d, weight: 1 / (1 + d.distance ** 2) / total,
    // ponytail: the trailing power is exactly 1 at the shipped exponent, so the default stays bit-for-bit PCAR.
    transferredCms: d.station.truth * target.area * target.rain / (d.station.area * d.station.rain) *
      (target.area / d.station.area) ** (areaExponent - 1) }));
  const meanCms = Math.exp(weighted.reduce((sum, d) => sum + d.weight * Math.log(d.transferredCms), 0));
  if (!(meanCms > 0) || !Number.isFinite(meanCms)) return null;
  return { meanCms, donors: weighted, weakMatch: donors[0].distance > 2 ||
    target.area < Math.min(...stations.map((s) => s.area)) || target.area > Math.max(...stations.map((s) => s.area)) };
}
