import type { DischargeSeries } from './api.ts';
import type { Assumptions, Pt, Study } from './App.tsx';
import type { DiscoverResult, Scheme } from './engine/discover.ts';
import { UNIT_SENSITIVITY_GUIDANCE } from './engine/units.ts';
import type { Uncertainty } from './engine/uncertainty.ts';
import {
  DOED_REGISTER_URL,
  DOED_RETRIEVED,
  DOED_UPDATED,
  type Licence,
} from './context.ts';
import { MONTH_NAMES, type HydestScreen } from './engine/hydest.ts';
import { connectionVerdict, GRID_RETRIEVED, type GridLink } from './grid.ts';
import type { BenchFit, Desander, SedimentSource } from './engine/sediment.ts';
import type { FlowChoice } from './engine/flowchoice.ts';
import type { HeadAudit, ShapeAudit } from './audit.ts';
import { PROTECTED_RETRIEVED, type ProtectedHit } from './protected.ts';
import type { LocalContext } from './local-gis.ts';
import type { MeasuredSeries } from './measured.ts';
import {
  DISCHARGE_GAUGE_COUNT,
  DHM_STATIONS_RETRIEVED,
  RIVER_GAUGE_COUNT,
  recordKind,
  transferAdvice,
  type Gauge,
} from './gauges.ts';
import { Fdc, RiverProfile } from './charts.tsx';
import {
  buildFdc,
  NEA_ROR_PPA,
  NEPAL_EFLOW_POLICY,
  POWER_DURATION_GUIDANCE,
} from './engine/hydro.ts';
import { explainTurbineSelection } from './engine/turbine.ts';
import type { EngineeringReadiness, EvidenceLevel } from './readiness.ts';
import { HAZARD_COLORS, type HazardScreen } from './hazards.ts';
import { FAULT_COLOR, type FaultScreen } from './faults.ts';
import type { GeologyScreen } from './geology.ts';
import type { RegionMode } from './region.ts';
import {
  ICIMOD_GLOF_DATABASE,
  ICIMOD_KOSHI_LANDSLIDES,
  ICIMOD_POTENTIALLY_DANGEROUS_LAKES,
  inKoshiLandslideInventory,
  type UpstreamConnectivityScreen,
} from './connectivity.ts';
import {
  isAdvancedDoedStage,
  type CascadeProject,
  type CascadeScreen,
} from './cascade.ts';

const n = (v: number, d = 1) =>
  !Number.isFinite(v)
    ? '—'
    : Math.abs(v) >= 1000
      ? Math.round(v).toLocaleString('en-US')
      : v.toLocaleString('en-US', { maximumFractionDigits: d });

/** Section heading — one style for the whole panel, so hierarchy comes free. */
function H({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">
        {children}
      </span>
      {right && <span className="text-[10.5px] text-faint">{right}</span>}
    </div>
  );
}

/** The small print. Legible small, not decorative small. */
function Fine({ children }: { children: React.ReactNode }) {
  return (
    <details className="group mt-2 text-[10.5px] leading-relaxed text-faint">
      <summary className="cursor-pointer list-none text-muted hover:text-ink">
        <span className="mr-1 inline-block transition-transform group-open:rotate-45">+</span>
        method &amp; limits
      </summary>
      <div className="mt-1.5 border-l border-line pl-2.5">{children}</div>
    </details>
  );
}

function CascadeProjectList({
  direction,
  projects,
}: {
  direction: 'upstream' | 'downstream';
  projects: CascadeProject[];
}) {
  const color = direction === 'upstream' ? '#c58af9' : '#65c8a3';
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
        {direction} · {projects.length}
      </div>
      {projects.length > 0 ? (
        <div className="space-y-1.5">
          {projects.slice(0, 5).map((project) => (
            <div key={`${direction}-${project.licenceNo}-${project.name}`} className="flex gap-2 text-[11.5px]">
              <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: color }} />
              <span className="min-w-0 leading-snug text-ink">
                {project.name}
                {project.capacityMW != null ? (
                  <span className="num text-muted"> · {n(project.capacityMW, 1)} MW</span>
                ) : null}
                <span className="block text-[10.5px] leading-relaxed text-faint">
                  {project.stage} · {n(project.routeKm, 1)} km directed route · {n(project.snapKm, 2)} km midpoint snap
                  {project.publishedRangeDiagonalKm > 10
                    ? ` · wide ${n(project.publishedRangeDiagonalKm, 1)} km published range`
                    : ''}
                </span>
              </span>
            </div>
          ))}
          {projects.length > 5 ? (
            <div className="pl-4 text-[10.5px] text-faint">+ {projects.length - 5} more in the export</div>
          ) : null}
        </div>
      ) : (
        <div className="text-[11px] leading-relaxed text-muted">
          No project midpoint passed this direction's guarded snap and route thresholds. This is not cascade clearance.
        </div>
      )}
    </div>
  );
}

const evidenceTone = (level: EvidenceLevel): string => {
  if (level === 'stop') return 'border-red/30 bg-[color-mix(in_srgb,var(--color-red)_9%,transparent)] text-red';
  if (level === 'measured' || level === 'corroborated')
    return 'border-green/30 bg-[color-mix(in_srgb,var(--color-green)_9%,transparent)] text-green';
  if (level === 'screened')
    return 'border-river/30 bg-[color-mix(in_srgb,var(--color-river)_8%,transparent)] text-river';
  return 'border-amber/30 bg-[color-mix(in_srgb,var(--color-amber)_8%,transparent)] text-amber';
};

/** A value with its provenance stated underneath, always visible. */
function Fact({
  label,
  value,
  unit,
  from,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  from: string;
  tone?: 'good' | 'warn';
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.1em] text-faint">{label}</div>
      <div
        className={`num mt-0.5 text-[16.5px] leading-tight ${tone === 'good' ? 'text-green' : tone === 'warn' ? 'text-amber' : 'text-ink'}`}
      >
        {value}
        {unit && <span className="ml-1 font-sans text-[10.5px] tracking-normal text-muted">{unit}</span>}
      </div>
      <div className="mt-0.5 text-[10px] leading-snug text-faint">{from}</div>
    </div>
  );
}

/** Dense operating numbers used below the flow-duration curve. */
function FlowMetric({
  label,
  value,
  unit,
  short,
  detail,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  short: string;
  detail: string;
  tone?: 'good' | 'warn';
}) {
  return (
    <div className="min-w-0 border-t border-line pt-2" title={detail}>
      <div className="truncate text-[9px] font-semibold uppercase tracking-[0.09em] text-faint">
        {label}
      </div>
      <div
        className={`num mt-0.5 truncate text-[15px] leading-tight ${
          tone === 'good' ? 'text-green' : tone === 'warn' ? 'text-amber' : 'text-ink'
        }`}
      >
        {value}
        <span className="ml-1 font-sans text-[9px] text-muted">{unit}</span>
      </div>
      <div className="mt-0.5 truncate text-[9px] text-faint">{short}</div>
    </div>
  );
}

/** The plausible range drawn as a range, with the reported figure ticked on it. */
function Band({ low, mid, high, unit, d }: { low: number; mid: number; high: number; unit: string; d: number }) {
  const t = high > low ? Math.min(1, Math.max(0, (mid - low) / (high - low))) : 0.5;
  return (
    <div>
      <div className="relative h-1.5 rounded-full bg-[color-mix(in_srgb,var(--color-amber)_28%,transparent)]">
        <div
          className="absolute top-1/2 h-3 w-[3px] -translate-y-1/2 rounded-full bg-ink"
          style={{ left: `calc(${(t * 100).toFixed(1)}% - 1px)` }}
        />
      </div>
      <div className="num mt-1 flex items-baseline justify-between text-[11px] text-amber">
        <span>{n(low, d)}</span>
        <span className="font-sans text-[10px] tracking-normal text-faint">{unit}</span>
        <span>{n(high, d)}</span>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  note,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
  note?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-muted">{label}</span>
        <span className="num text-[12px] text-ink">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-0.5 w-full"
      />
      {note && <span className="block text-[10.5px] leading-snug text-faint">{note}</span>}
    </label>
  );
}

export function Reading(props: {
  at: Pt | null;
  region: RegionMode;
  borderKm: number | null;
  readiness: EngineeringReadiness;
  hazards: HazardScreen | null;
  upstreamConnectivity: UpstreamConnectivityScreen | null;
  connectivityBusy: boolean;
  connectivityError: string | null;
  cascade: CascadeScreen | null;
  cascadeBusy: boolean;
  cascadeError: string | null;
  faults: FaultScreen | null;
  geology: GeologyScreen | null;
  study: Study | null;
  flowOnly: DischargeSeries | null;
  found: DiscoverResult | null;
  scheme: Scheme | null;
  uncertainty: Uncertainty | null;
  pick: { i: number; j: number } | null;
  onPick: (s: Scheme) => void;
  assume: Assumptions;
  setAssume: (a: Assumptions) => void;
  licences: Licence[] | null;
  gauges: Gauge[] | null;
  hydest: HydestScreen | null;
  grid: GridLink | null;
  conservation: { inside: ProtectedHit[]; near: ProtectedHit[]; hard: boolean } | null;
  localGis: LocalContext | null;
  topoCount: number;
  topoOn: boolean;
  onTopo: (v: boolean) => void;
  flowChoice: FlowChoice | null;
  sediment: { basin: Desander; source: SedimentSource | null } | null;
  bench: BenchFit | null;
  measured: { series: MeasuredSeries; ratio: number; name: string } | null;
  audit: {
    head: HeadAudit | null;
    shape: ShapeAudit | null;
    years: number | null;
    error: string | null;
  } | null;
  auditBusy: string | null;
  onAudit: () => void;
  onImport: (file: File) => void;
  onClearMeasured: () => void;
  wideSearch: boolean;
  onWideSearch: (v: boolean) => void;
  canExport: boolean;
  onExport: (kind: 'csv' | 'geojson' | 'field-plan') => void;
  busy: string | null;
  error: string | null;
  neighbours: { lat: number; lon: number; meanCms: number }[] | null;
  onProbe: () => void;
  onReset: () => void;
  tweaked: boolean;
}) {
  const {
    at,
    region,
    borderKm,
    readiness,
    hazards,
    upstreamConnectivity,
    connectivityBusy,
    connectivityError,
    cascade,
    cascadeBusy,
    cascadeError,
    faults,
    geology,
    study,
    flowOnly,
    found,
    scheme,
    uncertainty,
    pick,
    onPick,
    assume,
    setAssume,
    licences,
    gauges,
    hydest,
    grid,
    conservation,
    localGis,
    topoCount,
    topoOn,
    onTopo,
    flowChoice,
    sediment,
    bench,
    measured,
    audit,
    auditBusy,
    onAudit,
    onImport,
    onClearMeasured,
    wideSearch,
    onWideSearch,
    canExport,
    onExport,
    busy,
    error,
    neighbours,
    onProbe,
    onReset,
    tweaked,
  } = props;

  const set = <K extends keyof Assumptions>(k: K, v: Assumptions[K]) =>
    setAssume({ ...assume, [k]: v });

  const flow = study?.flow ?? flowOnly;
  const sourceValues = measured?.series.values ?? flow?.values ?? [];
  const flowScale = scheme?.flowScale ?? 1;
  const shownValues = flowScale === 1 ? sourceValues : sourceValues.map((v) => v * flowScale);
  const shownDates = measured?.series.dates ?? flow?.dates ?? [];
  const fdc = buildFdc(shownValues);
  const meanCms = flow ? flow.values.reduce((a, b) => a + b, 0) / flow.values.length : 0;
  const shownMeanCms = shownValues.length
    ? shownValues.reduce((a, b) => a + b, 0) / shownValues.length
    : 0;
  const years = new Set(
    shownDates.map((d) => Number(d.slice(0, 4))).filter((y) => Number.isInteger(y))
  ).size;
  const modelYears = new Set(
    (flow?.dates ?? []).map((d) => Number(d.slice(0, 4))).filter((y) => Number.isInteger(y))
  ).size;

  // Two independent models of the same quantity. When they diverge, the ~5 km
  // grid cell is probably not even on this channel.
  const rival = study?.reach?.meanDischargeCms;
  const disagreement =
    rival && rival > 0 && meanCms > 0 ? Math.max(rival / meanCms, meanCms / rival) : null;

  const verdict = grid ? connectionVerdict(grid) : null;

  const alternatives = found?.schemes ?? [];
  const turbineEvidence = scheme
    ? explainTurbineSelection(scheme.designFlowCms, scheme.netHeadM)
    : null;

  return (
    <aside className="reading-panel z-10 flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-line bg-panel lg:absolute lg:left-3 lg:top-3 lg:max-h-[calc(100%-1.5rem)] lg:w-[calc(50vw-18px)] lg:flex-none lg:rounded-2xl lg:border lg:shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
      <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-line bg-panel/90 px-4 py-2.5 backdrop-blur-md lg:rounded-t-2xl">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
          {!at ? 'Pick a river' : scheme ? 'Best scheme found' : 'Studying'}
        </span>
        {busy && (
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-river">
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-river" />
            <span className="truncate">{busy}</span>
          </span>
        )}
        {at && (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto rounded px-1 text-[11px] text-faint hover:text-ink"
          >
            clear
          </button>
        )}
      </div>

      {!at && (
        <div className="px-4 pb-4 pt-5">
          <p className="text-[15px] font-medium leading-snug text-ink [text-wrap:balance]">
            Click a river. Ghatta maps the strongest scheme and the constraints around it.
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            Blue is the river. Drag the intake or powerhouse marker to test another position.
          </p>
        </div>
      )}

      {at && (
        <div className="border-b border-line px-4 py-2 text-[10.5px] leading-relaxed text-faint">
          <span
            className={`mr-2 inline-block rounded-full px-2 py-0.5 font-semibold uppercase tracking-[0.08em] ${
              region === 'nepal'
                ? 'bg-[color-mix(in_srgb,var(--color-river)_12%,transparent)] text-river'
                : 'bg-panel-2 text-muted'
            }`}
          >
            {region === 'nepal' ? 'Nepal mode' : 'Global mode'}
          </span>
          {region === 'nepal'
            ? 'Nepal engineering and map layers are active.'
            : 'Global terrain, river and flow screening.'}
          {borderKm !== null && borderKm <= 10 && (
            <span className="mt-1 block text-amber">
              Only {n(borderKm, 1)} km from the generalized country outline — verify jurisdiction
              against authoritative border control before relying on the mode.
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="border-b border-line bg-[color-mix(in_srgb,var(--color-red)_9%,transparent)] px-4 py-2.5 text-[11.5px] leading-relaxed text-muted">
          <b className="text-red">{error}</b>
        </div>
      )}

      {at && !study && !busy && flowOnly && (
        <div className="border-b border-line px-4 py-3 text-[12px] leading-relaxed text-muted">
          The terrain here does not descend far enough to trace a river course.{' '}
          <b className="text-ink">Click directly on a watercourse</b> in a valley.
        </div>
      )}

      {study?.tracedFromTerrain && (
        <div className="border-b border-line px-4 py-2.5 text-[11px] leading-relaxed text-faint">
          No mapped river network covers this area, so the course was traced downhill through the
          terrain and the flood model&apos;s own flow is used unscaled. Both are weaker than where a
          network exists — treat this as a first look.
        </div>
      )}

      {conservation && (
        <div
          className={`border-b border-line px-4 py-3 ${
            conservation.hard
              ? 'bg-[color-mix(in_srgb,var(--color-red)_10%,transparent)]'
              : 'bg-[color-mix(in_srgb,var(--color-amber)_8%,transparent)]'
          }`}
        >
          <H>{conservation.inside.length ? 'inside a protected area' : 'beside a protected area'}</H>
          {conservation.inside.map((h) => (
            <div key={h.name} className="text-[12.5px] leading-snug">
              <b className={conservation.hard ? 'text-red' : 'text-amber'}>{h.name}</b>
              <span className="block text-[11px] text-muted">{h.regime}</span>
              {h.nearEdge && (
                <span className="block text-[10.5px] leading-relaxed text-faint">
                  close to the boundary — at this mapping accuracy, inside and outside cannot be
                  told apart here
                </span>
              )}
            </div>
          ))}
          {conservation.near.map((h) => (
            <div key={h.name} className="text-[12.5px] leading-snug">
              <b className="text-amber">{h.name}</b>
              <span className="block text-[11px] text-muted">within 3 km — {h.regime}</span>
            </div>
          ))}
          <Fine>
            Boundaries from OpenStreetMap, © contributors, ODbL, retrieved {PROTECTED_RETRIEVED}
            and simplified to ~200 m. Nepal&apos;s
            conservation areas do host licensed hydropower; national parks and reserves effectively
            do not. The permission question is DNPWC&apos;s, not this tool&apos;s.
          </Fine>
        </div>
      )}

      {disagreement && disagreement > 2 && (
        <details className="group border-b border-line px-4 py-2.5 text-[11px] leading-relaxed text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[10.5px] uppercase tracking-[0.06em] text-faint">
            <span>flow source</span>
            <b className="normal-case tracking-normal text-ink">
              {flowChoice?.authority === 'hydest'
                ? 'Nepal regression fallback'
                : flowChoice?.authority === 'model'
                  ? 'global flow model'
                  : 'mapped river network'}
            </b>
            <span className="ml-auto num normal-case tracking-normal text-amber">
              {n(disagreement, 1)}× mismatch&nbsp; +
            </span>
          </summary>
          <div className="mt-2">
            {flowChoice?.authority === 'hydest' ? (
            <>
              The mapped network claims {n(rival!, 1)} m³/s for this reach and the flood model{' '}
              {n(meanCms, 1)} — {n(disagreement, 1)}× apart, and <b className="text-ink">both sit
              far from the legacy WECS/DHM regional estimate</b>, which puts the annual mean at{' '}
              <b className="num text-ink">{n(flowChoice.judgeCms ?? NaN, 1)} m³/s</b> from this
              catchment&apos;s area, hypsometry and monsoon rainfall. Flows below keep the flood
              model&apos;s day-to-day shape provisionally rescaled onto the regression. This is a
              screening fallback with shared catchment geography and real regression scatter—not
              an observation—so treat the band seriously and gauge this river.
            </>
            ) : flowChoice?.authority === 'model' ? (
            <>
              The mapped network claims {n(rival!, 1)} m³/s for this reach against the flood
              model&apos;s {n(meanCms, 1)} — {n(disagreement, 1)}× apart, and the WECS/DHM regional
              comparison is closer to the flood model
              {flowChoice.judgeCms !== null && (
                <>
                  {' '}
                  ({n(flowChoice.modelCms ?? NaN, 1)} vs its {n(flowChoice.judgeCms, 1)} m³/s
                  dry-season figure)
                </>
              )}
              . The network&apos;s discharge is broken on this reach — a known failure of its
              global water model in high Himalayan valleys — so flows below use the flood model
              as-is.
            </>
            ) : (
            <>
              The flood model&apos;s ~5 km cell reads {n(meanCms, 1)} m³/s here,{' '}
              {n(disagreement, 1)}× off the {n(rival!, 1)} m³/s the mapped river network gives for
              this reach — its cell is not on this channel. Flows below use the network&apos;s
              magnitude and the model&apos;s day-to-day shape
              {flowChoice?.judgeCms != null && flowChoice.authority === 'network' && (
                <>
                  , and Nepal&apos;s own regression agrees with that choice (
                  {n(flowChoice.networkCms ?? NaN, 1)} vs its {n(flowChoice.judgeCms, 1)} m³/s
                  dry-season figure)
                </>
              )}
              .
            </>
            )}
          </div>
        </details>
      )}

      {/* ---- the answer ---- */}
      {scheme && (
        <div className="border-b border-line px-4 pb-4 pt-3.5">
          {scheme.grossHeadM <= 0 ? (
            <div className="text-[12.5px] leading-relaxed text-red">
              This pair has no drop between it — slide the powerhouse further downstream.
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="num text-[42px] font-medium leading-none tracking-tight text-ink">
                  {n(scheme.capacityMW, scheme.capacityMW < 10 ? 2 : 1)}
                </span>
                <span className="text-[15px] font-medium text-muted">MW</span>
                {tweaked && (
                  <span className="ml-auto rounded bg-[color-mix(in_srgb,var(--color-amber)_14%,transparent)] px-1.5 py-0.5 text-[10px] text-amber">
                    hand-adjusted
                  </span>
                )}
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="num text-[20px] font-medium leading-none text-ink">
                  {n(scheme.energyGwh, 1)}
                </span>
                <span className="text-[12px] text-muted">GWh per year</span>
              </div>
              {uncertainty && (
                <div className="mt-3 rounded-lg bg-panel-2 px-3 py-2.5">
                  <div className="mb-1.5 text-[11.5px] leading-snug text-ink">
                    Realistically{' '}
                    <b className="num text-amber">
                      {n(uncertainty.capacityMW.low, 1)}–{n(uncertainty.capacityMW.high, 1)} MW
                    </b>{' '}
                    and{' '}
                    <b className="num text-amber">
                      {n(uncertainty.energyGwh.low, 0)}–{n(uncertainty.energyGwh.high, 0)} GWh/yr
                    </b>
                  </div>
                  <Band
                    low={uncertainty.capacityMW.low}
                    mid={scheme.capacityMW}
                    high={uncertainty.capacityMW.high}
                    unit="MW"
                    d={1}
                  />
                  <div className="mt-2 space-y-1 border-t border-line pt-2">
                    {uncertainty.drivers.map((d) => (
                      <div key={d.name} className="flex items-baseline gap-2 text-[10.5px] leading-relaxed text-faint">
                        <span className="num shrink-0 text-muted">±{n(d.swingPct / 2, 0)}%</span>
                        <span>
                          <b className="font-medium text-muted">{d.name}</b> — {d.note}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
                    The single figure above is the midpoint, not a measurement. Narrowing this needs
                    a gauge record and a survey, which is what screening is for deciding.
                  </div>

                  {/* The site audit: replace assumptions with measurements, on request. */}
                  {auditBusy ? (
                    <div className="mt-2 flex items-center gap-1.5 border-t border-line pt-2 text-[11px] text-river">
                      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-river" />
                      <span>{auditBusy}</span>
                    </div>
                  ) : !audit ? (
                    <button
                      type="button"
                      onClick={onAudit}
                      className="mt-2 w-full rounded-md border border-line bg-panel px-2.5 py-2 text-left text-[11px] leading-relaxed text-muted hover:border-river/60 hover:text-ink"
                    >
                      <b className="text-ink">Audit this site</b> — re-measure the head on a second
                      terrain product{region === 'nepal' ? ', score all nine flow cells against Nepal’s seasonal regime,' : ''}
                      {' '}and request up to 40 years, keeping only complete local years. It uses
                      several requests to free public services, so it runs only when you ask.
                      Nothing is interpolated: every step replaces an assumption with evidence.
                    </button>
                  ) : (
                    <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-[10.5px] leading-relaxed">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
                        audited at this site
                      </div>
                      {audit.head ? (
                        <div className="text-muted">
                          <b className="text-ink">Head, measured twice:</b> the two terrain
                          products disagree by{' '}
                          <span className="num text-ink">{n(audit.head.deltaM, 1)} m</span> here (
                          {n(audit.head.primaryM, 0)} vs {n(audit.head.secondM, 0)} m), so the band
                          uses <span className="num text-ink">±{n(audit.head.errM, 0)} m</span>{' '}
                          measured, not ±15 assumed.
                        </div>
                      ) : (
                        <div className="text-faint">
                          Head cross-check unavailable — the second terrain product has no coverage
                          here.
                        </div>
                      )}
                      {audit.shape && (
                        <div className="text-muted">
                          <b className="text-ink">Flow cells:</b> {audit.shape.note}.
                        </div>
                      )}
                      {audit.years !== null && (
                        <div className="text-muted">
                          <b className="text-ink">Record:</b> extended to {audit.years} years —
                          deeper droughts and rarer floods now shape the curve.
                        </div>
                      )}
                      {audit.error && <div className="text-amber">{audit.error}</div>}
                    </div>
                  )}
                </div>
              )}
              <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
                A <b className="text-ink">{n(scheme.waterwayKm, 1)} km</b> waterway taking{' '}
                <b className="text-ink">{n(scheme.grossHeadM, 0)} m</b> of drop — about{' '}
                <b className="text-ink">{n((scheme.energyGwh * 1e6) / assume.householdKwh, 0)}</b>{' '}
                households, running at {n(scheme.plantFactor * 100, 0)}% of nameplate on hydrology
                alone.
              </p>
              <div className="num mt-2.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 rounded-lg bg-panel-2 px-3 py-2 text-[11.5px] text-muted">
                <span>{n(scheme.designFlowCms, 2)} m³/s</span>
                <span className="text-faint">×</span>
                <span>{n(scheme.netHeadM, 0)} m</span>
                <span className="text-faint">×</span>
                <span>{n(scheme.turbinePeak * assume.efficiency * 100, 0)}%</span>
                <span className="font-sans text-faint">× ρg →</span>
                <span className="font-semibold text-ink">{n(scheme.capacityMW, 2)} MW</span>
              </div>
              {scheme.waterway && (
                <div className="mt-2 rounded-lg border border-line px-3 py-2.5">
                  <div className="mb-1.5 text-[10.5px] uppercase tracking-[0.1em] text-faint">
                    the waterway costs {n(scheme.grossHeadM - scheme.netHeadM, 1)} m of that drop
                    {' · '}
                    {n(scheme.waterway.lossFrac * 100, 1)}%
                  </div>
                  {scheme.waterway.segments.map((s) => (
                    <div key={s.kind} className="flex items-baseline gap-2 text-[11px] leading-relaxed">
                      <span className="w-16 shrink-0 text-muted">{s.kind}</span>
                      <span className="num text-ink">
                        {s.lengthM >= 1000 ? `${n(s.lengthM / 1000, 2)} km` : `${n(s.lengthM, 0)} m`}
                      </span>
                      <span className="text-faint">·</span>
                      <span className="num text-ink">{n(s.diameterM, 2)} m</span>
                      <span className="text-faint">·</span>
                      <span className="num text-ink">{n(s.velocityMs, 1)} m/s</span>
                      <span className="num ml-auto text-muted">−{n(s.lossM, 2)} m</span>
                    </div>
                  ))}
                  <Fine>
                    Sized for this duty point, not assumed: ESHA 2004 economic diameter capped at
                    5 m/s, Darcy–Weisbach with Swamee–Jain friction, Manning for the headrace. This
                    is why a longer waterway is not free.
                  </Fine>
                </div>
              )}
              {scheme.turbine ? (
                <details className="group mt-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[11px] leading-relaxed">
                  <summary className="cursor-pointer list-none text-ink">
                    <b>Why {scheme.turbine}?</b>
                    <span className="ml-2 text-muted">
                      {n(scheme.netHeadM, 0)} m head · {n(scheme.designFlowCms, 2)} m³/s
                    </span>
                    <span className="float-right text-faint group-open:rotate-45">+</span>
                  </summary>
                  <div className="mt-2 border-t border-line pt-2 text-muted">
                    {turbineEvidence?.reason}{' '}
                    <span className="text-faint">Basis: {turbineEvidence?.method}.</span>
                    <div className="num mt-1.5 text-ink">
                      P = 1000 × 9.81 × {n(scheme.designFlowCms, 2)} × {n(scheme.netHeadM, 0)} ×{' '}
                      {n(scheme.turbinePeak * assume.efficiency, 3)} = {n(scheme.capacityMW, 2)} MW
                    </div>
                    <div className="mt-1 text-faint">
                      Peak turbine efficiency {n(scheme.turbinePeak * 100, 1)}%; generator and
                      transformer {n(assume.efficiency * 100, 0)}%. Daily energy uses the machine&apos;s
                      part-load curve, not the peak on every day.
                    </div>
                  </div>
                </details>
              ) : (
                <div className="mt-2 text-[11px] leading-relaxed text-amber">
                  This duty point falls outside every standard turbine envelope — the flat
                  efficiency is a placeholder.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ---- source-led geology: products to obtain, not a ground model ---- */}
      {scheme && geology && (geology.dmg || geology.regional || geology.regionalError) && (
        <div className="border-b border-line px-4 py-3.5">
          <H right={geology.dmg ? `DMG ${geology.dmg.scale}` : 'open regional context'}>
            engineering geology sources
          </H>
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
            {geology.dmg && (
              <div>
                <div className="text-[11.5px] leading-snug text-ink">
                  <b>
                    {geology.dmg.maps.length
                      ? `${geology.dmg.maps.length} official map publication${geology.dmg.maps.length === 1 ? '' : 's'} cover this reach`
                      : 'No 1:50,000 publication matched this reach in the online catalog'}
                  </b>
                </div>
                {geology.dmg.maps.length > 0 ? (
                  <div className="mt-2 space-y-1 border-t border-line pt-2">
                    {geology.dmg.maps.map((map) => (
                      <a
                        key={map.id}
                        href={map.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block text-[10.5px] leading-relaxed text-muted hover:text-ink"
                      >
                        <b className="text-ink">{map.sheets.map((sheet) => sheet.code).join(', ')}</b>
                        {' · '}{map.published.slice(0, 4)} · {map.title} ↗
                      </a>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-[10.5px] leading-relaxed text-muted">
                    {geology.dmg.limitation}
                  </div>
                )}
                <div className="mt-2 text-[10px] leading-relaxed text-faint">
                  {geology.dmg.availability} Footprints are derived catalog extents; DMG map imagery is not bundled.{' '}
                  <a href={geology.dmg.sourceUrl} target="_blank" rel="noreferrer" className="text-river hover:underline">
                    official catalog ↗
                  </a>
                </div>
              </div>
            )}

            {geology.regional && (
              <div className={`${geology.dmg ? 'mt-2.5 border-t border-line pt-2.5' : ''}`}>
                <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-faint">
                  small-scale regional samples
                </div>
                <div className="mt-1.5 space-y-1">
                  {geology.regional.samples.map((sample) => (
                    <div key={sample.role} className="flex items-start gap-2 text-[10.5px] leading-relaxed">
                      <span className="w-[72px] shrink-0 capitalize text-faint">{sample.role}</span>
                      <span className="min-w-0 text-muted">
                        {sample.units.length
                          ? sample.units.map((unit) => `${unit.name} · ${unit.lithology}`).join('; ')
                          : 'no mapped regional unit returned'}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[10px] leading-relaxed text-faint">
                  {geology.regional.limitation}{' '}
                  <a href={geology.regional.sourceUrl} target="_blank" rel="noreferrer" className="text-river hover:underline">
                    Macrostrat · {geology.regional.license} ↗
                  </a>
                  {Object.values(geology.regional.references).length > 0 && (
                    <span title={Object.values(geology.regional.references).join('\n')}> · original source reference retained in export</span>
                  )}
                </div>
              </div>
            )}

            {geology.regionalError && (
              <div className={`${geology.dmg ? 'mt-2 border-t border-line pt-2' : ''} text-[10.5px] leading-relaxed text-amber`}>
                Open regional geology unavailable: {geology.regionalError}
              </div>
            )}

            {region === 'nepal' && (
              <div className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-faint">
                Rainfall-induced landslide susceptibility is a separate official evidence source; it is linked, not imported, because an explicit reusable data licence/export was not identified.{' '}
                <a
                  href="https://wrerc.gov.np/content/39/rainfall-induced-landslide-susceptibility-map-of-nepal/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-river hover:underline"
                >
                  WRRDC Nepal susceptibility app ↗
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- regional active-fault context near this exact layout ---- */}
      {scheme && region === 'nepal' && faults && (
        <div className="border-b border-line px-4 py-3.5">
          <H right={`GEM · bundled ${faults.retrieved}`}>active fault context</H>
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
            <div className="flex items-start gap-2 text-[12px] leading-snug">
              <span
                className="mt-1 h-0 w-5 shrink-0 border-t-2 border-dashed"
                style={{ borderColor: FAULT_COLOR }}
              />
              <div>
                {faults.crossings > 0 ? (
                  <>
                    <b className="text-amber">
                      {faults.crossings} regional mapped trace{faults.crossings === 1 ? '' : 's'} intersect{faults.crossings === 1 ? 's' : ''} this river reach
                    </b>
                    <span className="mt-0.5 block text-[10.5px] text-muted">
                      This is not a surveyed canal, tunnel or penstock crossing.
                    </span>
                  </>
                ) : faults.nearest ? (
                  <>
                    <b className="text-ink">Nearest regional mapped trace {n(faults.nearest.distanceKm, 1)} km away</b>
                    <span className="mt-0.5 block text-[10.5px] text-muted">
                      {faults.nearest.name ?? `GEM ${faults.nearest.sourceId}`} · {faults.nearest.type}
                    </span>
                  </>
                ) : (
                  <b className="text-muted">No regional mapped trace result</b>
                )}
              </div>
            </div>

            {faults.nearby.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-line pt-2">
                {faults.nearby.slice(0, 4).map((fault) => (
                  <div key={fault.id} className="flex items-baseline gap-2 text-[10.5px] leading-relaxed text-muted">
                    <span className="min-w-0 flex-1 truncate" title={fault.reference ?? undefined}>
                      {fault.name ?? `GEM ${fault.sourceId}`} · {fault.type}
                    </span>
                    <span className="num shrink-0 text-faint">
                      {fault.intersectsReach ? `reach km ${n(fault.chainageKm, 1)}` : `${n(fault.distanceKm, 1)} km`}
                    </span>
                  </div>
                ))}
                {faults.nearby.length > 4 && (
                  <div className="text-[10px] text-faint">
                    +{faults.nearby.length - 4} more regional traces are shown on the map and included in GeoJSON.
                  </div>
                )}
              </div>
            )}

            <div className="mt-2 text-[10px] leading-relaxed text-faint">
              {faults.limitation}{' '}
              <a href={faults.sourceUrl} target="_blank" rel="noreferrer" className="text-river hover:underline">
                GEM source ↗
              </a>{' '}
              <a href={faults.licenseUrl} target="_blank" rel="noreferrer" className="text-river hover:underline">
                CC BY-SA 4.0 ↗
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ---- government incident history near this exact layout ---- */}
      {scheme && region === 'nepal' && hazards && (
        <div className="border-b border-line px-4 py-3.5">
          <H right={`BIPAD · bundled ${hazards.retrieved}`}>recorded natural hazards</H>
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
            <div className="text-[12px] leading-snug text-ink">
              <b>
                {hazards.total > 0
                  ? `${hazards.total} approved, verified report${hazards.total === 1 ? '' : 's'}`
                  : 'No approved, verified reports found'}
              </b>{' '}
              <span className="text-muted">within {n(hazards.radiusKm, 0)} km of this reach</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {hazards.categories.map((category) => (
                <span
                  key={category.kind}
                  className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted"
                  title={`${category.nationwideRecords.toLocaleString('en-US')} approved, verified records nationwide in the bundled inventory`}
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: HAZARD_COLORS[category.kind] }}
                  />
                  {category.title === 'Glacial lake outburst' ? 'GLOF' : category.title}{' '}
                  <b className="num text-ink">{category.count}</b>
                </span>
              ))}
            </div>

            {hazards.records.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-line pt-2">
                {hazards.records.slice(0, 5).map((record) => (
                  <a
                    key={record.id}
                    href={record.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-baseline gap-2 text-[10.5px] leading-relaxed text-muted hover:text-ink"
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: HAZARD_COLORS[record.kind] }}
                    />
                    <span className="min-w-0 flex-1">
                      {record.title} · {record.date}
                    </span>
                    <span className="num shrink-0 text-faint">{n(record.distanceKm, 1)} km ↗</span>
                  </a>
                ))}
                {hazards.records.length > 5 && (
                  <div className="pl-3.5 text-[10px] text-faint">
                    +{hazards.records.length - 5} more points are shown on the map and included in GeoJSON.
                  </div>
                )}
              </div>
            )}

            <div className="mt-2 text-[10px] leading-relaxed text-faint">
              Inventory {hazards.period.from} to {hazards.period.to}. {hazards.limitation}{' '}
              <a href={hazards.source} target="_blank" rel="noreferrer" className="text-river hover:underline">
                Government API ↗
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ---- candidates whose directed mapped channel reaches the intake ---- */}
      {scheme && region === 'nepal' && (connectivityBusy || connectivityError || upstreamConnectivity) && (
        <div className="border-b border-line px-4 py-3.5">
          <H right={connectivityBusy ? 'tracing network…' : 'GLO + BIPAD · HydroRIVERS'}>
            upstream channel screen
          </H>
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
            {connectivityBusy && (
              <div className="text-[11px] leading-relaxed text-muted">
                Walking open lake centroids and historical reports down the directed river network…
              </div>
            )}
            {connectivityError && (
              <div className="text-[10.5px] leading-relaxed text-amber">
                Upstream topology unavailable: {connectivityError}. This is missing evidence, not a clear screen.
              </div>
            )}
            {upstreamConnectivity && (
              <>
                <div className="text-[12px] leading-snug text-ink">
                  <b>
                    {upstreamConnectivity.lakes.length} mapped lake centroid{upstreamConnectivity.lakes.length === 1 ? '' : 's'} ·{' '}
                    {upstreamConnectivity.incidents.length} historical report{upstreamConnectivity.incidents.length === 1 ? '' : 's'}
                  </b>
                  <span className="mt-0.5 block text-[10.5px] text-muted">
                    have a candidate directed HydroRIVERS path to the selected intake
                  </span>
                </div>
                <div className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
                  Channel-connectivity candidates only—not lake danger, landslide runout, GLOF exposure or a design flood.
                </div>

                {upstreamConnectivity.lakes.length > 0 ? (
                  <div className="mt-2 space-y-1 border-t border-line pt-2">
                    <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">
                      glacial-lake candidates
                    </div>
                    {upstreamConnectivity.lakes.slice(0, 5).map((lake) => {
                      const growing = lake.expansionSignificant === true &&
                        (lake.expansionRateKm2Yr ?? 0) > 0 && lake.timeSeriesOutlier !== true;
                      return (
                        <a
                          key={lake.id}
                          href={upstreamConnectivity.lakeInventory.source}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded border border-line/70 px-2 py-1.5 text-[10.5px] leading-relaxed hover:border-river/40"
                        >
                          <span className="flex items-baseline justify-between gap-2">
                            <b className="min-w-0 truncate text-ink">
                              {lake.basin} · {lake.country} · {n(lake.elevationM, 0)} m
                            </b>
                            <span className="num shrink-0 text-faint">{n(lake.routeKm, 1)} km ↗</span>
                          </span>
                          <span className="block text-faint">
                            {lake.connectivity} · vertex snap {n(lake.snapKm, 2)} km
                            {lake.expansionRateKm2Yr != null
                              ? ` · ${(lake.expansionRateKm2Yr >= 0 ? '+' : '')}${lake.expansionRateKm2Yr.toFixed(4)} km²/yr`
                              : ' · trend unavailable'}
                          </span>
                          {(growing || lake.timeSeriesOutlier === true) && (
                            <span className={`block ${growing ? 'text-amber' : 'text-faint'}`}>
                              {growing
                                ? 'published significant positive expansion signal—not breach likelihood'
                                : 'time-series outlier flag—inspect before using the trend'}
                            </span>
                          )}
                        </a>
                      );
                    })}
                    {upstreamConnectivity.lakes.length > 5 && (
                      <div className="text-[10px] text-faint">
                        +{upstreamConnectivity.lakes.length - 5} more candidate centroids are on the map and in GeoJSON.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-2 border-t border-line pt-2 text-[10.5px] leading-relaxed text-faint">
                    No GLO centroid met the snap and directed-route tests. Small omitted streams, centroid-to-outlet error and network breaks mean this is not GLOF clearance.
                  </div>
                )}

                {upstreamConnectivity.incidents.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-line pt-2">
                    <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">
                      upstream report candidates
                    </div>
                    {upstreamConnectivity.incidents.slice(0, 5).map((incident) => (
                      <a
                        key={incident.id}
                        href={incident.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-baseline gap-2 text-[10.5px] leading-relaxed text-muted hover:text-ink"
                      >
                        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: HAZARD_COLORS[incident.kind] }} />
                        <span className="min-w-0 flex-1">{incident.title} · {incident.date}</span>
                        <span className="num shrink-0 text-faint">{n(incident.routeKm, 1)} km ↗</span>
                      </a>
                    ))}
                    {upstreamConnectivity.incidents.length > 5 && (
                      <div className="pl-3.5 text-[10px] text-faint">
                        +{upstreamConnectivity.incidents.length - 5} more report candidates are on the map and in GeoJSON.
                      </div>
                    )}
                  </div>
                )}

                <details className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-faint">
                  <summary className="cursor-pointer text-river">method, sources and required follow-up</summary>
                  <div className="mt-1.5 space-y-1.5">
                    <p>{upstreamConnectivity.method}</p>
                    <p>{upstreamConnectivity.limitation}</p>
                    <p>
                      GLO inventory {upstreamConnectivity.lakeInventory.observations.from}–{upstreamConnectivity.lakeInventory.observations.to},{' '}
                      {upstreamConnectivity.lakeInventory.license}. {upstreamConnectivity.lakeInventory.quality}
                    </p>
                    <div className="flex flex-wrap gap-x-2 gap-y-1">
                      <a href={upstreamConnectivity.lakeInventory.source} target="_blank" rel="noreferrer" className="text-river hover:underline">GLO dataset ↗</a>
                      <a href={ICIMOD_POTENTIALLY_DANGEROUS_LAKES} target="_blank" rel="noreferrer" className="text-river hover:underline">ICIMOD dangerous-lake assessment ↗</a>
                      <a href={ICIMOD_GLOF_DATABASE} target="_blank" rel="noreferrer" className="text-river hover:underline">ICIMOD GLOF event database ↗</a>
                      {inKoshiLandslideInventory(scheme.intake) && (
                        <a href={ICIMOD_KOSHI_LANDSLIDES} target="_blank" rel="noreferrer" className="text-river hover:underline">ICIMOD 2026 Koshi landslides ↗</a>
                      )}
                      <a href={upstreamConnectivity.network.sourceUrl} target="_blank" rel="noreferrer" className="text-river hover:underline">HydroRIVERS v1 ↗</a>
                    </div>
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- evidence gates and the work needed to advance the site ---- */}
      {false && scheme && readiness.gates.length > 0 && (
        <div className="border-b border-line px-4 py-3.5">
          <H right={region === 'nepal' ? 'DoED / PFS basis' : 'country rules open'}>
            engineering readiness
          </H>
          <div
            className={`rounded-lg border px-3 py-2.5 text-[12px] leading-snug ${
              readiness.decision === 'hold'
                ? 'border-red/30 bg-[color-mix(in_srgb,var(--color-red)_7%,transparent)] text-red'
                : 'border-amber/30 bg-[color-mix(in_srgb,var(--color-amber)_6%,transparent)] text-amber'
            }`}
          >
            <b>{readiness.label}</b>
            <span className="mt-1 block text-[10.5px] leading-relaxed text-muted">
              No combined score: a fatal legal, siting or hazard gate cannot be averaged away by
              good energy.
            </span>
          </div>

          <div className="mt-2 space-y-1.5">
            {readiness.gates.map((g) => (
              <details key={g.id} className="group rounded-lg border border-line bg-panel-2 px-2.5 py-2">
                <summary className="flex cursor-pointer list-none items-start gap-2">
                  <span
                    className={`mt-px shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ${evidenceTone(g.level)}`}
                  >
                    {g.level.replace('-', ' ')}
                  </span>
                  <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink">
                    <b>{g.title}</b>
                    <span className="mt-0.5 block text-[10.5px] font-normal leading-relaxed text-muted">
                      {g.summary}
                    </span>
                  </span>
                  <span className="text-[11px] text-faint group-open:rotate-45">+</span>
                </summary>
                <div className="mt-2 border-t border-line pt-2 text-[10.5px] leading-relaxed text-faint">
                  {g.evidence.map((e) => (
                    <div key={e}>â€¢ {e}</div>
                  ))}
                  <div className="mt-1.5 text-muted">
                    <b className="text-ink">Advance this gate:</b> {g.next}
                  </div>
                </div>
              </details>
            ))}
          </div>

          <details className="mt-2.5 rounded-lg border border-river/30 bg-[color-mix(in_srgb,var(--color-river)_5%,transparent)] px-3 py-2.5">
            <summary className="cursor-pointer list-none text-[11.5px] font-medium text-river">
              Field investigation campaign Â· {readiness.tasks.filter((t) => t.priority === 'P1').length}{' '}
              priority-1 packages
              <span className="ml-1 text-faint">({readiness.tasks.length} total)</span>
            </summary>
            <div className="mt-2 space-y-2.5 border-t border-line pt-2">
              {readiness.tasks.map((t, i) => (
                <div key={`${t.discipline}-${t.title}`} className="text-[10.5px] leading-relaxed">
                  <div className="flex items-baseline gap-2">
                    <span className={`num font-semibold ${t.priority === 'P1' ? 'text-amber' : 'text-river'}`}>
                      {t.priority}
                    </span>
                    <b className="text-ink">{i + 1}. {t.title}</b>
                  </div>
                  <div className="text-faint">{t.discipline} Â· {t.reason}</div>
                  <div className="mt-0.5 text-muted">
                    <b>Deliver:</b> {t.deliverable}
                  </div>
                </div>
              ))}
            </div>
          </details>
          <Fine>
            {region === 'nepal'
              ? 'Gates follow Nepal’s hydropower study/design guidance and '
              : 'Country rules remain open; gates use '}
            the World Bank pre-feasibility scope: hydrology, survey/layout, sediment/headworks,
            geology and hazards, grid, safeguards, costs, schedule and risk.
          </Fine>
        </div>
      )}

      {/* ---- river long profile with the scheme marked ---- */}
      {study && pick && (
        <div className="border-b border-line px-2.5 pb-2.5 pt-3">
          <div className="px-1.5">
            <H>
              {study.followsRiver
                ? 'The river, downstream from your click'
                : 'Terrain between the two points'}
            </H>
          </div>
          <RiverProfile path={study.path} i={pick.i} j={pick.j} />
          {scheme && (
            <div className="grid grid-cols-3 gap-2.5 px-1.5 pt-1.5">
              <Fact
                label="Gross head"
                value={n(scheme.grossHeadM, 0)}
                unit="m"
                from={`${study.dem.source}, ~${n(study.dem.resolutionM, 0)} m grid`}
              />
              <Fact
                label="Waterway"
                value={n(scheme.waterwayKm, 2)}
                unit="km"
                from={study.followsRiver ? 'along the channel' : 'straight line'}
              />
              <Fact
                label="Drop rate"
                value={n(scheme.slopeMPerKm, 0)}
                unit="m/km"
                from="how concentrated the head is"
              />
            </div>
          )}
        </div>
      )}

      {/* ---- alternatives ---- */}
      {alternatives.length > 1 && (
        <div className="border-b border-line px-4 py-3.5">
          <H right={<>of {n(found!.evaluated, 0)} tried</>}>
            {alternatives.length} alternatives worth keeping
          </H>
          <div className="space-y-1.5">
            {alternatives.map((s) => {
              const active = pick?.i === s.i && pick?.j === s.j;
              return (
                <button
                  key={`${s.i}-${s.j}`}
                  type="button"
                  onClick={() => onPick(s)}
                  className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left ${
                    active
                      ? 'border-river bg-[color-mix(in_srgb,var(--color-river)_9%,transparent)]'
                      : 'border-line hover:border-line-strong hover:bg-panel-2'
                  }`}
                >
                  <span className="num w-[52px] shrink-0 text-[14px] font-medium text-ink">
                    {n(s.capacityMW, s.capacityMW < 10 ? 1 : 0)}
                    <span className="ml-0.5 font-sans text-[9.5px] tracking-normal text-muted">MW</span>
                  </span>
                  <span className="num w-[88px] shrink-0 whitespace-nowrap text-[10.5px] leading-tight text-muted">
                    {n(s.grossHeadM, 0)}&thinsp;m · {n(s.waterwayKm, 1)}&thinsp;km
                  </span>
                  <span className="flex-1 text-[10.5px] leading-snug text-faint">
                    {s.turbine ? `${s.turbine} · ` : ''}
                    {s.reasons.join(' · ')}
                  </span>
                </button>
              );
            })}
          </div>
          <Fine>
            Every one of these beats all the others on at least one of energy, waterway length or
            head — none is simply worse than another. Which matters is your call.
          </Fine>
          <button
            type="button"
            onClick={() => onWideSearch(!wideSearch)}
            className={`mt-2.5 w-full rounded-lg border px-3 py-2 text-left text-[11px] leading-relaxed text-muted ${
              wideSearch ? 'border-river/50 bg-[color-mix(in_srgb,var(--color-river)_6%,transparent)]' : 'border-line bg-panel-2 hover:border-line-strong hover:text-ink'
            }`}
          >
            {wideSearch ? (
              <>
                <b className="text-river">Sweeping the whole reach.</b> The intake can sit anywhere
                in the 22 km below your click, so it may be far from it. Click to anchor it back to
                where you clicked.
              </>
            ) : (
              <>
                <b className="text-ink">Intake anchored near your click.</b> Click to sweep the
                whole 22 km downstream instead and find the strongest site on this river — the
                intake may then land well away from your click.
              </>
            )}
          </button>
        </div>
      )}

      {alternatives.length === 1 && (
        <div className="border-b border-line px-4 py-2.5 text-[11px] leading-relaxed text-faint">
          Only one scheme here survived screening out of {n(found!.evaluated, 0)} pairs tried.
        </div>
      )}
      {found && alternatives.length === 0 && !busy && (
        <div className="border-b border-line px-4 py-3 text-[12.5px] leading-relaxed text-muted">
          <b className="text-ink">Nothing here clears screening.</b> {n(found.evaluated, 0)} intake
          and powerhouse pairs were tried; none combined at least 15 m of drop with usable flow at a
          buildable gradient.
          {study?.tracedFromTerrain && (
            <>
              {' '}
              This course was traced from terrain rather than a mapped river. If the click was on a
              hillside the trace runs down the slope, which is too steep to build along —{' '}
              <b className="text-ink">click directly on the watercourse</b> and try again.
            </>
          )}
        </div>
      )}

      {/* ---- who already holds or has applied for this river ---- */}
      {licences && (
        <div className="border-b border-line px-4 py-3.5">
          <H>
            {licences.length > 0
              ? `${licences.length} DoED project record${licences.length > 1 ? 's' : ''} on this reach`
              : 'DoED conflict screen · clear within 6 km'}
          </H>
          {licences.length > 0 ? <div className="space-y-2">
            {licences.slice(0, 6).map((l) => (
              <div key={l.licenceNo + l.name} className="flex items-baseline gap-2.5 text-[12px]">
                <span
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{
                    background:
                      l.stage === 'Operating'
                        ? 'var(--color-red)'
                        : l.stage === 'Construction licence'
                          ? 'var(--color-amber)'
                          : 'var(--color-muted)',
                  }}
                />
                <span className="min-w-0 flex-1 leading-snug text-ink">
                  {l.name}
                  {l.capacityMW ? (
                    <span className="num text-muted"> · {n(l.capacityMW, 1)} MW</span>
                  ) : null}
                  <span className="block text-[10.5px] leading-relaxed text-faint">
                    {l.stage}
                    {l.river ? ` · ${l.river}` : ''} ·{' '}
                    {l.distanceKm < 0.05
                      ? 'published coordinate range overlaps the reach'
                      : `${n(l.distanceKm, 1)} km from its published coordinate range`}
                  </span>
                </span>
              </div>
            ))}
          </div> : (
            <div className="text-[12px] leading-relaxed text-ink">
              No geolocated operating plant, licence or application in the official register has a
              published coordinate range within 6 km of this studied reach.
            </div>
          )}
          <Fine>
            Official Department of Electricity Development register, updated {DOED_UPDATED} and
            bundled {DOED_RETRIEVED}.{' '}
            <span className="text-red">Operating</span> and{' '}
            <span className="text-amber">construction licence</span> records are a hard constraint;
            survey records and applications mean someone is already studying the water. DoED
            publishes coordinate ranges rather than alignments, so proximity is conservative.{' '}
            <a
              className="underline decoration-line underline-offset-2 hover:text-ink"
              href={DOED_REGISTER_URL}
              target="_blank"
              rel="noreferrer"
            >
              Check the live register
            </a>{' '}
            before relying on legal status.
          </Fine>
        </div>
      )}

      {/* ---- directed project interaction and cascade discovery ---- */}
      {scheme && region === 'nepal' && licences && (
        <div className="border-b border-line px-4 py-3.5">
          <H>
            {cascade
              ? `project interaction · ${cascade.upstream.length} upstream · ${cascade.downstream.length} downstream`
              : 'project interaction · directed network'}
          </H>
          {cascadeBusy ? (
            <div className="flex items-center gap-2 text-[11.5px] text-muted">
              <span className="size-1.5 animate-pulse rounded-full bg-river" />
              Walking official DoED project midpoints through the directed river network…
            </div>
          ) : cascade ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <CascadeProjectList direction="upstream" projects={cascade.upstream} />
                <CascadeProjectList direction="downstream" projects={cascade.downstream} />
              </div>
              <div className="mt-2.5 rounded-md border border-amber/30 bg-[color-mix(in_srgb,var(--color-amber)_6%,transparent)] px-2.5 py-2 text-[10.5px] leading-relaxed text-amber">
                Network candidates only—not a confirmed cascade, shared-water finding, legal overlap or operating interface.{' '}
                {[
                  ...cascade.upstream,
                  ...cascade.downstream,
                ].filter((project) => isAdvancedDoedStage(project.stage)).length}{' '}
                operating/construction-stage candidate(s) must be checked first.
              </div>
              <details className="mt-2 text-[10.5px] leading-relaxed text-faint">
                <summary className="cursor-pointer text-river">method, official guidance and required confirmation</summary>
                <div className="mt-1.5 space-y-1.5">
                  <p>{cascade.method}</p>
                  <p>{cascade.limitation}</p>
                  <p>
                    DoED registry updated {cascade.registry.updated}, bundled {cascade.registry.retrieved}: {cascade.registry.canonicalRecords.toLocaleString('en-US')} canonical geolocated projects after collapsing {cascade.registry.duplicateRowsCollapsed} duplicate lifecycle row(s). Retained route geometry is capped at {cascade.thresholds.routeGeometryLimit} candidates for responsive maps and exports.
                  </p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <a href={cascade.registry.source} target="_blank" rel="noreferrer" className="text-river hover:underline">live DoED register ↗</a>
                    <a href={cascade.guidance.study} target="_blank" rel="noreferrer" className="text-river hover:underline">DoED study guideline ↗</a>
                    <a href={cascade.guidance.optimization} target="_blank" rel="noreferrer" className="text-river hover:underline">DoED system optimization guideline ↗</a>
                    <a href={cascade.network.sourceUrl} target="_blank" rel="noreferrer" className="text-river hover:underline">HydroRIVERS v{cascade.network.version} ↗</a>
                  </div>
                </div>
              </details>
            </>
          ) : (
            <div className="text-[11.5px] leading-relaxed text-amber">
              No usable directed project screen was produced{cascadeError ? `: ${cascadeError}` : '. The selected layout may not match the bundled river network'}. Confirm upstream/downstream projects from current licence maps and surveyed component coordinates.
            </div>
          )}
        </div>
      )}

      {/* ---- private Nepali layers, when installed (src/local-gis.ts) ---- */}
      {localGis && (
        <div className="border-b border-line px-4 py-3.5">
          <H right={<span className="text-faint">private layer</span>}>Nepal survey context</H>
          {localGis.inBufferZone && (
            <div className="mb-2 text-[12px] leading-relaxed text-amber">
              <b>Inside a protected-area buffer zone.</b> A distinct permitting regime from the
              park itself, and one the OpenStreetMap layer above does not carry.
            </div>
          )}
          <div className="space-y-1 text-[11px]">
            {localGis.sheet && (
              <div className="flex items-baseline gap-2">
                <span className="w-24 shrink-0 text-faint">survey sheet</span>
                <span className="num text-ink">{localGis.sheet}</span>
                <span className="text-faint">
                  1:25,000{localGis.sheetRegion ? ` · ${localGis.sheetRegion}` : ''}
                </span>
              </div>
            )}
            {localGis.annualRainMm !== null && (
              <div className="flex items-baseline gap-2">
                <span className="w-24 shrink-0 text-faint">annual rain</span>
                <span className="num text-ink">{n(localGis.annualRainMm, 0)} mm</span>
                <span className="text-faint">Nepal&apos;s own isohyet map</span>
              </div>
            )}
            {localGis.unit && (
              <div className="flex items-baseline gap-2">
                <span className="w-24 shrink-0 text-faint">apply to</span>
                <span className="min-w-0 flex-1 text-ink">
                  {localGis.unit.name}
                  <span className="text-faint">
                    {' '}
                    {localGis.unit.kind} · {localGis.unit.district}
                  </span>
                </span>
              </div>
            )}
          </div>
          {topoCount > 0 && (
            <button
              type="button"
              onClick={() => onTopo(!topoOn)}
              className={`mt-2.5 w-full rounded-lg border px-3 py-2 text-left text-[11px] leading-relaxed ${
                topoOn
                  ? 'border-river/50 bg-[color-mix(in_srgb,var(--color-river)_8%,transparent)] text-ink'
                  : 'border-line bg-panel-2 text-muted hover:border-line-strong hover:text-ink'
              }`}
            >
              {topoOn ? (
                <>
                  <b className="text-river">Survey sheet shown under the map.</b> Zoom past 12 to
                  see it. Surveyed contours and spot heights, at about 2 m per pixel.
                </>
              ) : (
                <>
                  <b className="text-ink">Show the surveyed sheet under the map.</b>{' '}
                  {topoCount} of 691 scans are georeferenced, so it appears only where one covers
                  the view.
                </>
              )}
            </button>
          )}
          <Fine>
            The survey sheet is the one to order: Nepal&apos;s 1:25,000 sheets carry surveyed
            contours and spot heights, which is how you replace the ±15 m of error in the global
            terrain above with a measurement. These layers are installed locally and are not part
            of this repository.
          </Fine>
        </div>
      )}

      {/* ---- sediment: the basin, and whether the valley has room for it ---- */}
      {sediment && scheme && (
        <div className="border-b border-line px-4 py-3.5">
          <H>sediment · desanding basin</H>
          {sediment.source && (
            <div className="text-[12.5px] leading-snug">
              <b className="text-ink">{sediment.source.label}</b>
              <span className="text-faint">
                {' · '}
                {n(sediment.source.highFrac * 100, 0)}% of the catchment above 3000 m
              </span>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">{sediment.source.note}</p>
            </div>
          )}
          <div className="mt-2.5 space-y-1 text-[11px]">
            <div className="flex items-baseline gap-2">
              <span className="w-24 shrink-0 text-faint">to catch</span>
              <span className="num text-ink">{n(sediment.basin.particleMm, 2)} mm</span>
              <span className="text-faint">
                sand, settling at {n(sediment.basin.settlingMmS, 1)} mm/s
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="w-24 shrink-0 text-faint">basin</span>
              <span className="num text-ink">
                {n(sediment.basin.totalLengthM, 0)} × {n(sediment.basin.totalWidthM, 1)} ×{' '}
                {n(sediment.basin.depthM, 1)} m
              </span>
              <span className="text-faint">
                {sediment.basin.bays === 2 ? '2 chambers' : '1 chamber'}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="w-24 shrink-0 text-faint">flat ground</span>
              <span className="num text-ink">{n(sediment.basin.benchNeededM, 0)} m</span>
              <span className="text-faint">across the valley, beside the intake</span>
            </div>
          </div>

          {/* The part terrain can answer. */}
          {!bench ? (
            <div className="mt-2 text-[11px] leading-relaxed text-muted">
              Reading the valley cross-section…
            </div>
          ) : bench.verdict === 'fits' ? (
            <div className="mt-2 text-[12px] leading-relaxed text-ink">
              About <b className="num">{n(bench.widestM, 0)} m</b> of workable bench on the{' '}
              {bench.side} bank, {n(bench.liftM, 0)} m above the river — enough to hold it.
            </div>
          ) : bench.verdict === 'no-room' ? (
            <div className="mt-2 text-[12px] leading-relaxed text-amber">
              <b>No bench wide enough.</b>{' '}
              {bench.widestM === 0
                ? 'Nothing within 250 m of the intake is flatter than 1 in 4 — this is gorge.'
                : `The widest workable ground is ${n(bench.widestM, 0)} m against the
                   ${n(sediment.basin.benchNeededM, 0)} m this basin needs.`}{' '}
              A site like this ends up with an underground basin, a stepped cut into the hillside,
              or the intake moved — real money that a headline capacity figure will not show you.
            </div>
          ) : (
            <div className="mt-2 text-[12px] leading-relaxed text-muted">
              About {n(bench.widestM, 0)} m of workable bench against{' '}
              {n(sediment.basin.benchNeededM, 0)} m needed — closer than the ~
              {n(bench.resolutionM, 0)} m the terrain is known to. Too close to call from a DEM.
              Walk it.
            </div>
          )}

          <Fine>
            Zanke settling velocity for quartz, ideal basin × 2 for turbulence — a screening size,
            and deliberately on the generous side. Nepal does not publish suspended-sediment records,
            so the load here is inferred from catchment altitude, not measured. A real design needs
            a sampling programme; this is the flag that says you will need one.
          </Fine>
        </div>
      )}

      {/* ---- getting the power out ---- */}
      {grid && scheme && (
        <div className="border-b border-line px-4 py-3.5">
          <H>grid connection</H>
          <div className={`text-[12px] leading-relaxed ${verdict!.hard ? 'text-amber' : 'text-ink'}`}>
            {verdict!.text}
          </div>
          <div className="mt-2 space-y-1 text-[11px]">
            <div className="flex items-baseline gap-2">
              <span className="w-24 shrink-0 text-faint">nearest line</span>
              <span className="num text-ink">{n(grid.nearestKm, 1)} km</span>
              <span className="text-faint">
                {grid.nearestKv ? `${grid.nearestKv} kV` : 'voltage not tagged'}
              </span>
            </div>
            {grid.adequateKm !== null && (
              <div className="flex items-baseline gap-2">
                <span className="w-24 shrink-0 text-faint">at {grid.requiredKv} kV+</span>
                <span className="num text-ink">{n(grid.adequateKm, 1)} km</span>
                <span className="text-faint">{grid.adequateKv} kV</span>
              </div>
            )}
            {grid.nearestSub && (
              <div className="flex items-baseline gap-2">
                <span className="w-24 shrink-0 text-faint">substation</span>
                <span className="num text-ink">{n(grid.nearestSub.km, 1)} km</span>
                <span className="min-w-0 flex-1 truncate text-faint">
                  {grid.nearestSub.name ?? 'unnamed'}
                  {grid.nearestSub.kv ? ` · ${grid.nearestSub.kv} kV` : ''}
                </span>
              </div>
            )}
          </div>
          <Fine>
            Straight-line distance from the powerhouse — a line is not built straight through this
            terrain, so treat it as a floor. {n(scheme.capacityMW, 1)} MW would typically connect at{' '}
            {grid.requiredKv} kV. OpenStreetMap, © contributors, ODbL, retrieved {GRID_RETRIEVED};
            coverage is good on the
            transmission backbone and patchy below 66 kV, so an absent line means unmapped, not
            absent.
          </Fine>
        </div>
      )}

      {/* ---- Nepal's regional regression, as an independent screening comparator ---- */}
      {hydest && (
        <div className="border-b border-line px-4 py-3.5">
          <H>WECS/DHM · regional hydrology screen</H>
          <div className="flex items-baseline gap-2 text-[12px]">
            <span className="text-muted">lowest monthly mean</span>
            <span className="num text-[13.5px] font-medium text-ink">
              {n(hydest.driest.cms, 2)} m³/s
            </span>
            <span className="text-faint">{MONTH_NAMES[hydest.driest.month]}</span>
          </div>
          {hydest.agreement && (
            <div
              className={`mt-1.5 text-[11px] leading-relaxed ${
                hydest.agreement.agree ? 'text-muted' : 'text-amber'
              }`}
            >
              {hydest.agreement.agree ? (
                <>
                  The global model gives {n(hydest.modelledCms, 2)} m³/s for the same month — within{' '}
                  {n(hydest.agreement.ratio, 1)}×. Independent regional and global methods agree
                  on screening magnitude; this is not gauge validation.
                </>
              ) : (
                <>
                  The global model gives {n(hydest.modelledCms, 2)} m³/s for the same month —{' '}
                  {n(hydest.agreement.ratio, 1)}× apart. The regional regression and global model
                  disagree about the dry season here, so gauge transfer and measurement are a P1
                  hydrology task.
                </>
              )}
            </div>
          )}
          <div
            className={`mt-2.5 grid gap-1 rounded-lg bg-panel-2 px-2 py-1.5 ${
              hydest.months.length > 5 ? 'grid-cols-6' : 'grid-cols-5'
            }`}
          >
            {hydest.months.map((m) => (
              <div key={m.month} className="text-center">
                <div className="text-[9.5px] uppercase tracking-wide text-faint">
                  {MONTH_NAMES[m.month]}
                </div>
                <div className="num text-[11px] text-ink">{n(m.cms, m.cms >= 100 ? 0 : 1)}</div>
              </div>
            ))}
          </div>
          {hydest.floods.length > 0 && (
            <div className="mt-2.5 border-t border-line pt-2.5">
              <div className="mb-1 text-[10.5px] uppercase tracking-[0.1em] text-faint">
                regional flood estimates, m³/s
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                {hydest.floods
                  .filter((f) => [2, 100, 500].includes(f.t))
                  .map((f) => (
                    <span key={f.t}>
                      <span className="text-faint">Q{f.t}</span>{' '}
                      <span className="num text-ink">{n(f.cms, 0)}</span>
                    </span>
                  ))}
              </div>
            </div>
          )}
          <div className="mt-2.5 rounded-lg border border-amber/25 bg-[color-mix(in_srgb,var(--color-amber)_7%,transparent)] px-2 py-1.5 text-[10.5px] leading-relaxed text-amber">
            Screening comparator only—not a selected design, diversion, spillway check flood or
            PMF/PMP case. DoED guidance calls for applicable-method comparison, gauge-frequency and
            historical-flood evidence, direct measurement where data are absent, and GLOF/CLOF
            investigation.
          </div>
          <Fine>
            Legacy WECS/DHM 1990 regional regression, fitted to Nepal&apos;s gauged records. Catchment
            below 5000 m:{' '}
            {n(hydest.input.below5000Km2, 0)} of {n(hydest.input.totalKm2, 0)} km²; below 3000 m:{' '}
            {n(hydest.input.below3000Km2, 0)} km²
            {hydest.months.length > 5 ? (
              <>
                ; monsoon rainfall over the catchment: {n(hydest.input.monsoonMm ?? NaN, 0)} mm
                (CHPclim climatology), which is what lets the six monsoon months be stated at all.
              </>
            ) : (
              <>
                . Only Jan–May and the floods are shown here: this catchment falls outside the
                monsoon-rainfall layer, and a guessed monsoon flow would be worse than none.
              </>
            )}
            {' · '}
            <a
              href={hydest.provenance.primaryCitation.catalogue}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              method catalogue
            </a>
            {' · '}
            <a
              href={hydest.provenance.guidance.headworks}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              current DoED headworks guidance
            </a>
          </Fine>
        </div>
      )}

      {/* ---- a real record, if the engineer has one ---- */}
      {study && (
        <div className="border-b border-line px-4 py-3.5">
          <H>{measured ? 'flow is measured, not modelled' : 'have a gauge record?'}</H>
          {measured ? (
            <>
              <div className="flex items-baseline gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate text-ink">{measured.name}</span>
                <button
                  type="button"
                  onClick={onClearMeasured}
                  className="shrink-0 rounded px-1 text-[11px] text-faint hover:text-ink"
                >
                  remove
                </button>
              </div>
              <div className="num mt-1 text-[11px] text-muted">
                {measured.series.values.length.toLocaleString()} values
                {measured.series.from ? `, ${measured.series.from} to ${measured.series.to}` : ''}
                {measured.series.cadence !== 'unknown' ? ` · ${measured.series.cadence}` : ''}
                {measured.ratio !== 1 ? ` · scaled ${n(measured.ratio, 3)}×` : ''}
              </div>
              <ul className="mt-1.5 space-y-1">
                {measured.series.notes.map((note, k) => (
                  <li key={k} className="text-[10.5px] leading-relaxed text-faint">
                    {note}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <label className="block cursor-pointer rounded-lg border border-dashed border-line-strong px-3 py-3 text-center text-[12px] text-muted hover:border-river hover:bg-[color-mix(in_srgb,var(--color-river)_5%,transparent)] hover:text-ink">
                <input
                  type="file"
                  accept=".csv,.txt,.tsv,text/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onImport(f);
                    e.target.value = '';
                  }}
                />
                Load a discharge record
              </label>
              <Fine>
                CSV or text, one row per reading, discharge in m³/s — a date column if you have one.
                This replaces both global models outright and is the only thing that turns the range
                above into a measurement. Headers, tabs and no-data markers are handled; Bikram
                Sambat dates are detected and refused rather than approximated.
              </Fine>
            </>
          )}
        </div>
      )}

      {/* ---- where the real measurements are ---- */}
      {gauges && gauges.length > 0 && (
        <div className="border-b border-line px-4 py-3.5">
          <H>nearest measured record</H>
          <div className="space-y-2.5">
            {gauges.slice(0, 3).map((g) => (
              <div key={g.name} className="flex items-baseline gap-2.5 text-[12px]">
                <span
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{
                    background: g.trustworthy ? 'var(--color-river)' : 'var(--color-muted)',
                  }}
                />
                <span className="min-w-0 flex-1 leading-snug text-ink">
                  {g.name}
                  <span className="block text-[10.5px] leading-relaxed text-faint">
                    {g.relation} · {n(g.distanceKm, 1)} km away
                    {g.uplandKm2 ? ` · ${n(g.uplandKm2, 0)} km² catchment` : ''}
                    {g.basin ? ` · ${g.basin} basin` : ''}
                  </span>
                  <span
                    className={`block text-[10.5px] leading-relaxed ${g.measuresDischarge ? 'text-river' : 'text-faint'}`}
                  >
                    {recordKind(g)}
                  </span>
                  <span className="block text-[10.5px] leading-relaxed text-muted">
                    {transferAdvice(g)}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <Fine>
            Flow is the largest error in this estimate and a gauged record is the only thing that
            shrinks it. The DHM inventory retrieved {DHM_STATIONS_RETRIEVED} contains{' '}
            {RIVER_GAUGE_COUNT} river stations, {DISCHARGE_GAUGE_COUNT} of them
            recording discharge rather than water level alone. The readings are not public — the API
            requires a key, and refuses DHM&apos;s own portal too — so request the record for the
            station above and scale it by catchment area, which is what a feasibility study would do
            with it.
          </Fine>
        </div>
      )}

      {/* ---- flow ---- */}
      {flow && fdc.length > 0 && (
        <div className="border-b border-line px-3 pb-3 pt-3">
          <div className="px-1.5">
            <H right="m³/s · time exceeded">flow duration</H>
          </div>
          <Fdc
            fdc={fdc}
            designCms={scheme?.designFlowCms ?? 0}
            residualCms={scheme?.residualCms ?? 0}
          />
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-1.5 sm:grid-cols-3 xl:grid-cols-5">
            <FlowMetric
              label="Mean"
              value={n(shownMeanCms, 2)}
              unit="m³/s"
              short={measured ? 'measured record' : `${n(years, 0)} complete years`}
              detail={
                measured
                  ? `${measured.series.values.length.toLocaleString()} measured values`
                  : `${n(years, 0)} complete years${flowScale !== 1 ? ' · river-network magnitude' : ' · GloFAS magnitude'}`
              }
            />
            <FlowMetric
              label={`Design Q${Math.round(assume.exceedance * 100)}`}
              value={scheme ? n(scheme.designFlowCms, 2) : '—'}
              unit="m³/s"
              short="after release"
              detail="At the intake, after residual release"
              tone="good"
            />
            <FlowMetric
              label="Residual"
              value={scheme ? n(scheme.residualCms, 2) : '—'}
              unit="m³/s"
              short={region === 'nepal' ? 'policy-floor screen' : 'screening release'}
              detail={
                region === 'nepal'
                  ? `${n(assume.residualFrac * 100, 0)}% of lowest monthly mean · policy-floor screen`
                  : `${n(assume.residualFrac * 100, 0)}% of lowest monthly mean`
              }
              tone="warn"
            />
            {scheme?.powerDuration && (
              <>
                <FlowMetric
                  label="Daily P90"
                  value={n(scheme.powerDuration.p90MW, 2)}
                  unit="MW"
                  short="90% of days"
                  detail={`Equalled or exceeded on 90% of ${scheme.powerDuration.days.toLocaleString()} record days`}
                />
                <FlowMetric
                  label="Daily P95"
                  value={n(scheme.powerDuration.p95MW, 2)}
                  unit="MW"
                  short="95% of days"
                  detail={`95% exceedance · ${n(scheme.powerDuration.zeroOutputFraction * 100, 1)}% zero-output days`}
                  tone="warn"
                />
              </>
            )}
          </div>
          <Fine>
            <p>
              Mean flow uses {measured ? `${measured.series.values.length.toLocaleString()} supplied measurements` : `${n(years, 0)} complete years and ${flowScale !== 1 ? 'the mapped river-network magnitude' : 'the GloFAS magnitude'}`}.
              Design flow is measured at the intake after the residual release; the Nepal release is a policy-floor screen.
            </p>
            {scheme?.powerDuration && (
              <p className="mt-1.5">
                Daily power-duration screen from the same release, hydraulic loss and part-load
                dispatch as energy. This assumes one screening unit and hydrology only—no forced
                outages, station service, curtailment, multi-unit commitment or contract test. It is
                not firm capacity and is different from P90 annual energy.{' '}
                <a
                  href={POWER_DURATION_GUIDANCE.source}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-ink"
                >
                  ESHA §3.7 basis
                </a>
              </p>
            )}
          </Fine>
          {scheme?.unitSensitivity && scheme.unitSensitivity.length > 1 && (
            <div className="mx-1.5 mt-3 rounded-lg bg-panel-2 px-2.5 py-2">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
                Equal-rated unit-count sensitivity
              </div>
              <div className="grid grid-cols-[2rem_3.8rem_1fr_1fr] gap-x-2 border-b border-line pb-1 text-[9.5px] uppercase tracking-[0.06em] text-faint">
                <span>Units</span><span>Runner</span><span>Energy</span><span>Daily P90 / P95</span>
              </div>
              {scheme.unitSensitivity.map((scenario) => (
                <div
                  key={scenario.units}
                  className="grid grid-cols-[2rem_3.8rem_1fr_1fr] gap-x-2 border-b border-line py-1 text-[10.5px] last:border-0 last:pb-0"
                >
                  <span className="num text-ink">{scenario.units}</span>
                  <span className="truncate text-muted">{scenario.turbine ?? 'review'}</span>
                  <span className="num text-ink">{n(scenario.energyGwh, 1)} GWh</span>
                  <span className="num text-ink">
                    {n(scenario.dailyP90MW, 2)} / {n(scenario.dailyP95MW, 2)} MW
                  </span>
                </div>
              ))}
              <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
                Identical units; every feasible running-unit count is dispatched each day. The
                one-unit row matches the headline. Extra units have no cost or outage credit here,
                so this is not an equipment recommendation. Confirm unit rating, cavitation,
                transients, transport, maintenance and grid/PPA availability.{' '}
                <a
                  href={UNIT_SENSITIVITY_GUIDANCE.nepalOperatingCase}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-ink"
                >
                  Nepal operating example
                </a>
              </p>
            </div>
          )}
          {scheme?.reliability && (
            <>
              <div className="mt-2.5 grid grid-cols-2 gap-2.5 px-1.5">
                <Fact
                  label="P50 annual energy"
                  value={n(scheme.reliability.p50Gwh, 1)}
                  unit="GWh"
                  from={`median of ${scheme.reliability.annual.length} dispatched years`}
                />
                <Fact
                  label="P90 annual energy"
                  value={n(scheme.reliability.p90Gwh, 1)}
                  unit="GWh"
                  from="equalled or exceeded in 90% of modelled years"
                  tone="warn"
                />
              </div>
              {region === 'nepal' && (
                <>
              <div className="mx-1.5 mt-3 rounded-lg bg-panel-2 px-2.5 py-2">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
                  Nepal ROR PPA dry-energy tests
                </div>
                {[
                  ['6 + 6 months', scheme.reliability.ppaSixSix, 30],
                  ['8 + 4 months', scheme.reliability.ppaEightFour, 15],
                ].map(([label, result, required]) => {
                  const r = result as typeof scheme.reliability.ppaSixSix;
                  return (
                    <div key={String(label)} className="border-t border-line py-1 first:border-0 first:pt-0 last:pb-0">
                      <div className="flex items-baseline gap-2 text-[11px]">
                        <span className="w-24 shrink-0 text-muted">{String(label)}</span>
                        <span className={`num ${r.meets ? 'text-green' : 'text-amber'}`}>
                          {n(r.dryShare * 100, 1)}% dry
                        </span>
                        <span className="text-faint">
                          {r.meets ? 'meets' : 'below'} {String(required)}%
                        </span>
                      </div>
                      <div className="ml-[6.5rem] text-[10.5px] leading-relaxed text-faint">
                        <span className="num text-ink">
                          NPR {n(r.grossReferenceValueMillionNpr, 0)} million/yr
                        </span>{' '}
                        gross base-rate reference · {n(r.blendedBaseRateNprPerKwh, 2)} NPR/kWh
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-2.5 px-1.5">
                <Fact
                  label="NEA wet · 8 months"
                  value={n(scheme.reliability.ppaEightFour.wetGwh, 1)}
                  unit="GWh"
                  from="Baisakh through Mangsir"
                />
                <Fact
                  label="NEA dry · 4 months"
                  value={n(scheme.reliability.ppaEightFour.dryGwh, 1)}
                  unit="GWh"
                  from="Poush through Chaitra"
                />
              </div>
              <Fine>
                Gross reference energy value = dispatched wet energy × {NEA_ROR_PPA.wetNprPerKwh.toFixed(2)}
                {' + '}dry energy × {NEA_ROR_PPA.dryNprPerKwh.toFixed(2)} NPR/kWh, with no escalation.
                It is not a PPA entitlement, contracted revenue, cash flow, NPV or LCOE.
                {scheme.capacityMW > NEA_ROR_PPA.postedRateCapacityUpToMW && (
                  <> At {n(scheme.capacityMW, 1)} MW this is above the posted-rate 100 MW boundary;
                  negotiated/base-rate review is mandatory.</>
                )}{' '}
                <a
                  href={NEA_ROR_PPA.decisionPdf}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-ink"
                >
                  NEA Board decision
                </a>
              </Fine>
                </>
              )}
              <Fine>
                Every value above uses the selected turbine&apos;s part-load curve, this scheme&apos;s
                calculated hydraulic loss, residual flow, and the active measured or modelled
                record. P90 describes interannual hydrology, not a contractual firm-capacity
                guarantee.
                {region === 'nepal' && (
                  <> NEA&apos;s Bikram Sambat season boundaries are approximated to the nearest
                  Gregorian day for screening.</>
                )}
              </Fine>
            </>
          )}
        </div>
      )}

      {/* ---- assumptions ---- */}
      {flow && (
        <div className="space-y-3 border-b border-line px-4 py-3.5">
          <H>Assumptions</H>
          <Slider
            label="Design flow exceedance"
            value={assume.exceedance}
            min={0.15}
            max={0.85}
            step={0.05}
            display={`Q${Math.round(assume.exceedance * 100)}`}
            onChange={(v) => set('exceedance', v)}
            note="Lower Q = bigger turbine, more spill."
          />
          <Slider
            label="Generator & transformer"
            value={assume.efficiency}
            min={0.8}
            max={0.99}
            step={0.01}
            display={`${Math.round(assume.efficiency * 100)}%`}
            onChange={(v) => set('efficiency', v)}
            note="Turbine efficiency comes from the machine's own curve, not this."
          />
          <Slider
            label="Residual flow"
            value={assume.residualFrac}
            min={region === 'nepal' ? NEPAL_EFLOW_POLICY.minimumFractionOfLowestMonthlyMean : 0}
            max={0.5}
            step={0.01}
            display={`${Math.round(assume.residualFrac * 100)}% of min month`}
            onChange={(v) => set('residualFrac', v)}
            note={
              region === 'nepal'
                ? 'Policy floor: at least 10% of the lowest monthly average, or the higher EIA requirement.'
                : 'Left in the river. Bases vary by jurisdiction—set the applicable requirement.'
            }
          />
          {region === 'nepal' && (
            <p className="text-[10.5px] leading-relaxed text-faint">
              This control cannot go below Nepal&apos;s published floor, but 10% is not ecological
              clearance. Habitat, downstream use, seasonal releases, drought/ramping, fish passage
              and the approved EIA can require more.{' '}
              <a
                href={NEPAL_EFLOW_POLICY.source}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-ink"
              >
                policy §6.1.1
              </a>
            </p>
          )}
          <label className="flex items-center justify-between gap-2 pt-0.5">
            <span className="text-[12px] text-muted">Household use, kWh/yr</span>
            <input
              type="number"
              value={assume.householdKwh}
              min={100}
              step={50}
              onChange={(e) => set('householdKwh', Math.max(1, Number(e.target.value) || 1))}
              className="num w-24 rounded-md border border-line bg-panel-2 px-2 py-1 text-right text-[12px] text-ink"
            />
          </label>
        </div>
      )}

      {/* ---- evidence ---- */}
      {flow && (
        <div className="border-b border-line px-4 py-3.5 text-[11px] leading-relaxed text-faint">
          <H>Where this comes from</H>
          <div>
            <b className="text-muted">Flow</b> — GloFAS v4 consolidated history, {n(modelYears, 0)} complete years,{' '}
            {flow.from === 'network' ? 'fetched now' : flow.from === 'cache' ? 'from cache' : 'stale cache'}
            . Modelled, not gauged. Rescaled along the river by catchment.
          </div>
          <div className="mt-1">
            <b className="text-muted">Model cell</b> — {n(
              at
                ? Math.hypot(
                    (flow.cell.lat - at.lat) * 111.32,
                    (flow.cell.lon - at.lon) * 111.32 * Math.cos((at.lat * Math.PI) / 180)
                  )
                : 0,
              1
            )}{' '}
            km from your click.{' '}
            {neighbours ? (
              <span className="text-muted">
                Neighbours: {neighbours.slice(0, 3).map((x) => n(x.meanCms, 1)).join(' · ')} m³/s
                {neighbours[0] && neighbours[0].meanCms > meanCms * 3
                  ? ' — a much larger channel sits next door.'
                  : ' — this cell is the local maximum.'}
              </span>
            ) : (
              <button
                type="button"
                onClick={onProbe}
                className="rounded text-river underline underline-offset-2 hover:text-ink"
              >
                check neighbouring cells
              </button>
            )}
          </div>
          {study && (
            <div className="mt-1">
              <b className="text-muted">Terrain</b> — {study.dem.source}, zoom {study.dem.zoom},{' '}
              {n(study.dem.resolutionM, 0)} m sample spacing, {study.dem.tilesFetched} tiles. Global
              DEMs carry roughly ±10–16 m of vertical error in steep ground.
            </div>
          )}
          {study?.reach && (
            <div className="mt-1">
              <b className="text-muted">River</b> — {n(study.reach.uplandKm2, 0)} km² upstream
              (HydroRIVERS), whose own long-term mean here is {n(study.reach.meanDischargeCms, 1)}{' '}
              m³/s against GloFAS&apos;s {n(meanCms, 1)}.
              {study.followsRiver &&
                ` Walked ${n(study.path[study.path.length - 1].km, 1)} km downstream.`}
            </div>
          )}
        </div>
      )}

      {canExport && (
        <div className="border-b border-line px-4 py-3.5">
          <H>Take it with you</H>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onExport('csv')}
              className="flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12px] font-medium text-ink hover:border-river/60 hover:bg-[color-mix(in_srgb,var(--color-river)_8%,transparent)] hover:text-river"
            >
              CSV — the numbers
            </button>
            <button
              type="button"
              onClick={() => onExport('geojson')}
              className="flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12px] font-medium text-ink hover:border-river/60 hover:bg-[color-mix(in_srgb,var(--color-river)_8%,transparent)] hover:text-river"
            >
              GeoJSON — for QGIS
            </button>
            <button
              type="button"
              onClick={() => onExport('field-plan')}
              className="col-span-2 rounded-lg border border-river/30 bg-[color-mix(in_srgb,var(--color-river)_6%,transparent)] px-3 py-2 text-[12px] font-medium text-river hover:border-river/60 hover:text-ink"
            >
              Field plan CSV — gates, priorities & deliverables
            </button>
          </div>
          <Fine>
            Every alternative, plus a header naming each source, assumption and limitation — so the
            file still explains itself when nobody remembers where it came from. The link in your
            address bar reopens this exact study.
          </Fine>
        </div>
      )}

      <div className="mt-auto border-l-2 border-amber bg-[color-mix(in_srgb,var(--color-amber)_7%,transparent)] px-4 py-2.5 text-[11px] leading-relaxed text-muted">
        <b className="text-amber">Screening only.</b> These compare options and tell you what to
        survey next — they are not a feasibility study, and no waterway has been routed or costed.{' '}
        <a
          href="./validation.html"
          className="text-river underline-offset-2 hover:underline"
        >
          How wrong is it? See it run at ten built plants.
        </a>
      </div>
    </aside>
  );
}
