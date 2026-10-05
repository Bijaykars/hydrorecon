import { evaluate, type Scheme, type SchemeInput } from './discover.ts';

export type FlowComparisonRow = { id: string; name: string; meanCms: number; scheme: Scheme | null; note: string };
export const comparisonSeriesMean = (input: SchemeInput) => input.series.length
  ? input.series.reduce((sum, q) => sum + q, 0) / input.series.length : NaN;

/** Compare magnitude alternatives at the identical layout and daily flow shape.
 * Keep the release rule proportional to flow. Resizing/losses use evaluate(),
 * never the misleading shortcut of scaling MW by the flow ratio.
 */
export function compareFlowMagnitudes(input: SchemeInput, selected: Scheme,
  alternatives: { id: string; name: string; meanCms: number; note: string }[]): FlowComparisonRow[] {
  // seriesMeanCms may deliberately be a NETWORK transport reference when the
  // active series is measured. Normalize the actual record, not that reference.
  const seriesMeanCms = comparisonSeriesMean(input);
  if (!(seriesMeanCms > 0) || !Number.isFinite(seriesMeanCms)) return [];
  return alternatives.filter((a) => Number.isFinite(a.meanCms) && a.meanCms > 0).map((a) => ({
    ...a,
    scheme: evaluate({ ...input, seriesMeanCms, path: input.path.map((p) => ({ ...p, meanCms: a.meanCms })) }, selected.i, selected.j, undefined, false),
  }));
}

export function comparisonCsv(rows: FlowComparisonRow[], selected: Scheme): string {
  const quote = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;
  const header = ['Method', 'Mean flow m3/s', 'Design flow after release m3/s', 'Capacity MW', 'Annual energy GWh', 'Gross head m', 'Net head m', 'Along-river length km', 'Intake latitude', 'Intake longitude', 'Powerhouse latitude', 'Powerhouse longitude', 'Status', 'Scope'];
  return [header, ...rows.map((r) => [r.name, r.meanCms, r.scheme?.designFlowCms ?? '', r.scheme?.capacityMW ?? '', r.scheme?.energyGwh ?? '', selected.grossHeadM, r.scheme?.netHeadM ?? '', selected.waterwayKm, selected.intake.lat, selected.intake.lon, selected.power.lat, selected.power.lon,
    r.scheme ? 'Evaluated' : 'No feasible hydraulic design', `${r.note}; same layout and flow pattern; comparison only`])].map((r) => r.map(quote).join(',')).join('\r\n');
}
