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
const valid = (r: CatchmentFeatures) => r.area > 0 && r.rain > 0 && r.elevation >= 0 &&
  [r.area, r.rain, r.elevation, r.low, r.high].every(Number.isFinite) &&
  r.low >= 0 && r.high >= 0 && r.low <= 1 && r.high <= 1 && r.low + r.high <= 1 + 1e-9;

export function analogueFlow(target: CatchmentFeatures, stations: readonly FlowDonor[]): AnalogueFlow | null {
  if (!valid(target)) return null;
  const donors = stations.filter((s) => valid(s) && s.truth > 0 && Number.isFinite(s.truth))
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
    transferredCms: d.station.truth * target.area * target.rain / (d.station.area * d.station.rain) }));
  const meanCms = Math.exp(weighted.reduce((sum, d) => sum + d.weight * Math.log(d.transferredCms), 0));
  if (!(meanCms > 0) || !Number.isFinite(meanCms)) return null;
  return { meanCms, donors: weighted, weakMatch: donors[0].distance > 2 ||
    target.area < Math.min(...stations.map((s) => s.area)) || target.area > Math.max(...stations.map((s) => s.area)) };
}
