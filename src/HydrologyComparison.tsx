import { useMemo } from 'react';
import type { Scheme, SchemeInput } from './engine/discover.ts';
import type { Reach } from './rivers.ts';
import type { FlowChoice } from './engine/flowchoice.ts';
import type { HeadAudit } from './audit.ts';
import { modifiedHydestAnnualMean } from './engine/modified-hydest.ts';
import { mhspScreen } from './engine/mhsp.ts';
import { analogueFlow } from './engine/flow-analogue.ts';
import { compareFlowMagnitudes, comparisonCsv, comparisonSeriesMean, type FlowComparisonRow } from './engine/flow-comparison.ts';
import data from './data/flow-analogues.json';

const number = (v: number) => Number.isFinite(v) ? v.toLocaleString('en', { maximumSignificantDigits: 3 }) : 'Unavailable';

export function HydrologyComparison({ input, scheme, reach, networkMeanCms, flowChoice, measured, head, auditBusy, auditCompleted, auditError, auditYears, onAudit, terrainSource }: {
  input: SchemeInput; scheme: Scheme; reach: Reach | null; networkMeanCms: number;
  flowChoice: FlowChoice | null; measured: boolean; head: HeadAudit | null;
  auditBusy: string | null; onAudit: () => void; terrainSource: string;
  auditCompleted: boolean; auditError: string | null; auditYears: number | null;
}) {
  const result = useMemo(() => {
    const r = reach;
    const analogue = r ? analogueFlow({ area: r.uplandKm2, rain: r.annualPrecipMm, elevation: r.averageAltitudeM, low: r.below3000Frac, high: 1 - r.below5000Frac }, data.stations) : null;
    const modified = r ? modifiedHydestAnnualMean({ below3000Km2: r.uplandKm2 * r.below3000Frac, below5000Km2: r.uplandKm2 * r.below5000Frac, averageAltitudeM: r.averageAltitudeM, annualWetnessMm: r.annualPrecipMm }) : NaN;
    const mhsp = r ? mhspScreen(r.uplandKm2, Number.isFinite(r.monsoonMm) ? r.monsoonMm : undefined) : null;
    const name = measured ? 'Supplied / borrowed record' : flowChoice?.magnitudeFactor ? 'Network + Modified HYDEST' : flowChoice?.authority === 'hydest' ? 'Regional fallback' : flowChoice?.authority === 'model' ? 'Flood model' : 'Mapped network';
    const current: FlowComparisonRow = { id: 'active', name: `In use · ${name}`, meanCms: comparisonSeriesMean(input) * scheme.flowScale, scheme, note: measured ? 'Active supplied or borrowed measurements' : flowChoice?.note ?? 'Active screening estimate' };
    const alternatives = [
      { id: 'analogue', name: 'DHM catchment analogues', meanCms: analogue?.meanCms ?? NaN, note: 'Experimental; five similar catchments; historical mean-flow transfer' },
      { id: 'modified', name: 'Modified HYDEST alone', meanCms: modified ?? NaN, note: 'Regional empirical regression' },
      { id: 'mhsp', name: 'MHSP', meanCms: mhsp?.annualMeanCms ?? NaN, note: 'Regional small-hydro regression' },
      { id: 'network', name: 'Mapped network alone', meanCms: networkMeanCms, note: 'Unblended HydroRIVERS mean flow' },
    ];
    return { analogue, rows: [current, ...compareFlowMagnitudes(input, scheme, alternatives)] };
  }, [input, scheme, reach, networkMeanCms, flowChoice, measured]);
  const capacities = result.rows.flatMap((r) => r.scheme ? [r.scheme.capacityMW] : []);
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([comparisonCsv(result.rows, scheme)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'hydrorecon-flow-comparison.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details open className="border-b border-line px-4 py-3 text-[11px] leading-relaxed text-muted" aria-label="Hydrology method comparison">
    <summary className="cursor-pointer text-[12px] font-semibold text-ink">Compare flow methods & capacity</summary>
    <p className="mt-2">Same intake, powerhouse and flow pattern. Each estimate recalculates turbine sizing, hydraulic losses and energy. Alternatives do not replace the estimate in use.</p>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-right text-[10px]" aria-label="Flow method results">
        <thead className="text-faint"><tr><th className="pb-2 text-left font-normal">Method</th><th className="px-1 font-normal">Mean<br/>m³/s</th><th className="px-1 font-normal">MW</th><th className="pl-1 font-normal">GWh/yr</th></tr></thead>
        <tbody>{result.rows.map((r) => <tr key={r.id} data-method={r.id} className={`border-t border-line ${r.id === 'active' ? 'text-river' : ''}`}>
          <th scope="row" className="max-w-[160px] py-2 text-left font-normal">{r.name}{r.id === 'analogue' && <span className="block text-[9px] text-amber">Experimental{result.analogue?.weakMatch ? ' · weak catchment match' : ''}</span>}</th>
          <td className="px-1 tabular-nums">{number(r.meanCms)}</td><td className="px-1 tabular-nums">{r.scheme ? number(r.scheme.capacityMW) : '—'}</td><td className="pl-1 tabular-nums">{r.scheme ? number(r.scheme.energyGwh) : '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {result.rows.some((r) => !r.scheme) && <p className="mt-1">— No feasible hydraulic design at that flow.</p>}
    {capacities.length > 1 && <p className="mt-2 text-ink">Methods span {number(Math.min(...capacities))}–{number(Math.max(...capacities))} MW. This is a comparison spread, not a confidence interval.</p>}
    <p className="mt-2 text-faint">This tests mean-flow uncertainty. It does not independently validate daily flows or annual generation.</p>
    <button type="button" onClick={exportCsv} className="mt-2 rounded border border-line px-2 py-1 text-river">Export method comparison</button>
    <details className="mt-3"><summary className="cursor-pointer text-river">DHM analogue evidence</summary>
      <p className="mt-2">Transfers observed runoff from five catchments matched on size, rainfall, elevation and altitude bands. This is a statistical comparison, not a calibrated rainfall–runoff model.</p>
      {result.analogue ? <ul className="mt-2 space-y-1">{result.analogue.donors.map(({ station: s, weight }) => <li key={s.id}>{s.river} · DHM {s.id}: {number(s.area)} km², {s.from}–{s.to} ({s.years} complete years), {Math.round(weight * 100)}% weight</li>)}</ul> : <p className="mt-2">Insufficient catchment inputs for an analogue estimate.</p>}
      <p className="mt-2">Tested on 69 gauges: typical mean-flow error 1.31× versus 1.40× for Modified HYDEST. With gauges within 50 km excluded, its project-weighted error was 1.73× versus 1.65× for the current blend. Only five test catchments were below 100 km². These are error factors, not confidence limits.</p>
      <p className="mt-2">Historical donor periods differ and do not establish today's flow. Similarity does not confirm a connected river or shared operating conditions.</p>
      <a href="https://doi.org/10.1016/j.ejrh.2023.101359" target="_blank" rel="noopener noreferrer" className="text-river">Nepal research on catchment similarity ↗</a>
    </details>
    <details className="mt-3"><summary className="cursor-pointer text-river">Head & catchment evidence</summary>
      <p className="mt-2">Gross head {number(scheme.grossHeadM)} m · hydraulic loss {number(scheme.grossHeadM - scheme.netHeadM)} m · net head {number(scheme.netHeadM)} m.</p>
      <p className="mt-1">Terrain: {terrainSource}. Elevations are at model coordinates; moving a display line does not provide surveyed water levels.</p>
      {reach && <p className="mt-1">Catchment {number(reach.uplandKm2)} km² ({reach.areaSource}); mean elevation {number(reach.averageAltitudeM)} m; annual rainfall input {number(reach.annualPrecipMm)} mm.</p>}
      {head && <p className="mt-2">Second terrain: {head.secondSource}, gross head {number(head.secondM)} m; difference {number(head.deltaM)} m. Agreement between terrain products does not prove survey accuracy.</p>}
      {auditCompleted && !head && <p className="mt-2">No independent second terrain result was available.</p>}
      {auditYears != null && <p className="mt-1">Flow audit loaded {auditYears} complete years.</p>}
      {auditError && <p className="mt-1 text-amber" role="status">{auditError}</p>}
      <button type="button" disabled={!!auditBusy} onClick={onAudit} className="mt-2 rounded border border-line px-2 py-1 text-river disabled:opacity-50">{auditBusy ?? 'Run detailed site audit'}</button>
      <p className="mt-1 text-faint">Checks a second terrain source and, for modelled flows, nearby flow cells and a longer record. The audit may update the active flow estimate.</p>
    </details>
  </details>;
}
