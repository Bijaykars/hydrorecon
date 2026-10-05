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
import type { CorridorTerrain } from './engine/corridor.ts';
import { SEARCH_KM } from './engine/discover.ts';
import type { MhspScreen } from './engine/mhsp.ts';
import type { ShapeVerdict } from './engine/fdcshape.ts';
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
  minMonthlyMean,
  NEA_ROR_PPA,
  NEPAL_EFLOW_POLICY,
  POWER_DURATION_GUIDANCE,
} from './engine/hydro.ts';
import { explainTurbineSelection } from './engine/turbine.ts';
import type { EngineeringReadiness, EvidenceLevel } from './readiness.ts';
import { HAZARD_COLORS, type HazardScreen } from './hazards.ts';
import { FAULT_COLOR, type FaultScreen } from './faults.ts';
import { PGA_RETRIEVED, QUAKE_COUNT, type SeismicScreen } from './seismic.ts';
import type { CollectorScreen } from './collector.ts';
import { DHM_STATION_COUNT, transferMeetsBar, type Transfer } from './dhm.ts';
import { DHM_STATISTICS_BUNDLED, DHM_STATISTICS_ABSENT_NOTE } from './dhm-statistics.ts';
import type { GeologyScreen } from './geology.ts';
import { BUILT_UP, CROPLAND, TREE_COVER, type LandcoverScreen } from './landcover.ts';
import { geologySpans, type GeologyTraverse } from './geology-units.ts';
import type { DesignFlowSweep } from './engine/designflow.ts';
import type { PondagePositionSweep } from './pondage.ts';
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
import { PONDAGE_METHOD, pondageDemand, type PondageResult } from './pondage.ts';
import type { ReportMeta } from './report.ts';
import {
  ROAD_ACCESS_METHOD,
  roadMapUrl,
  type RoadAccessScreen,
} from './access.ts';

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

/**
 * The answer, before any of the evidence for it.
 *
 * THE PROBLEM THIS FIXES. The panel had twenty-five sections of equal weight and
 * the capacity was somewhere around the twelfth — after protected areas, gauges,
 * head, grid, collectors, faults, hazards and connectivity. An engineer opening
 * this asks two questions in this order: how much power, and how much should I
 * trust it. Both were reachable only by scrolling past the working.
 *
 * The uncertainty sits INSIDE the number rather than in a section of its own,
 * because a capacity without its band is the single most misleading thing this
 * tool can print. Everything measured this session says the honest figure is a
 * range: flow on an ungauged Nepali catchment is good to roughly a factor of
 * 1.6, and that dominates everything else the model does.
 *
 * The binding constraint is named too. "Flow dominates, plus or minus 62%" tells
 * an engineer where to spend money to narrow the answer — a gauge, not a survey
 * — which is the most useful sentence on the page.
 */
function Verdict({
  scheme,
  uncertainty,
  flowChoice,
}: {
  flowChoice: FlowChoice | null;
  scheme: { capacityMW: number; energyGwh: number; grossHeadM: number; netHeadM: number; designFlowCms: number; waterwayKm: number; turbine: string | null; plantFactor: number };
  uncertainty: Uncertainty | null;
}) {
  const cap = uncertainty?.capacityMW;
  const gwh = uncertainty?.energyGwh;
  const driver = uncertainty?.drivers?.[0];
  const network = flowChoice?.networkCms ?? 0;
  const regional = flowChoice?.judgeCms ?? 0;
  const apart = network > 0 && regional > 0 ? Math.max(network / regional, regional / network) : 0;
  return (
    <div data-tour="headline" className="border-b border-line bg-panel-2/40 px-4 py-3.5">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.1em] text-faint">Capacity</div>
          <div className="num mt-0.5 text-[30px] leading-none text-ink">
            {n(scheme.capacityMW, 1)}
            <span className="ml-1.5 font-sans text-[12px] tracking-normal text-muted">MW</span>
          </div>
          {cap && (
            <div className="num mt-1 text-[11px] leading-none text-faint">
              {n(cap.low, 1)}–{n(cap.high, 1)}
              <span className="ml-1 font-sans text-[10px]">likely range</span>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.1em] text-faint">Annual energy</div>
          <div className="num mt-0.5 text-[30px] leading-none text-ink">
            {n(scheme.energyGwh, 0)}
            <span className="ml-1.5 font-sans text-[12px] tracking-normal text-muted">GWh</span>
          </div>
          {gwh && (
            <div className="num mt-1 text-[11px] leading-none text-faint">
              {n(gwh.low, 0)}–{n(gwh.high, 0)}
              <span className="ml-1 font-sans text-[10px]">likely range</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-2.5 text-[11px] text-muted">
        <span>
          <span className="text-faint">head </span>
          <b className="num text-ink">{n(scheme.netHeadM, 0)}</b> m net
        </span>
        <span>
          <span className="text-faint">design flow </span>
          <b className="num text-ink">{n(scheme.designFlowCms, 2)}</b> m³/s
        </span>
        <span>
          <span className="text-faint">waterway </span>
          <b className="num text-ink">{n(scheme.waterwayKm, 2)}</b> km
        </span>
        {scheme.turbine && (
          <span>
            <span className="text-faint">turbine </span>
            <b className="text-ink">{scheme.turbine}</b>
          </span>
        )}
      </div>

      {driver && (
        <div className="mt-2 text-[11px] leading-relaxed text-faint">
          {/* swingPct is the FULL low-to-high range; ± is half of it, which is
              what the detailed driver rows below the band also show. */}
          Widest uncertainty is <b className="text-amber">{driver.name}</b>, worth ±
          {n(driver.swingPct / 2, 0)}% of the capacity. {driver.note}
        </div>
      )}

      {/*
        Two independent estimates of the same river, side by side.
        ONE IS A GLOBAL HYDROLOGICAL MODEL, the other a regression fitted to
        Nepali gauges. They share no input data, so agreement is real evidence
        and disagreement is a warning worth acting on before anything else on
        this page is worth reading.
        Neither the methods NOR which number is which are given here: the top of
        the panel is for figures, and a reader who wants to know how far apart
        two independent estimates are does not need to know their names to act
        on it. Both are named, sourced and explained in the regional-methods
        section below, which is where someone reconciling this against an office
        spreadsheet lands anyway.
      */}
      {network > 0 && regional > 0 && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line pt-2 text-[11px]">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">
            cross-check
          </span>
          <span className="text-muted">
            <b className="num text-ink">{n(network, 2)}</b>
            <span className="mx-1.5 text-faint">·</span>
            <b className="num text-ink">{n(regional, 2)}</b>
            <span className="ml-1 text-faint">m³/s mean</span>
          </span>
          <span className={apart <= 1.3 ? 'text-green' : apart <= 2 ? 'text-muted' : 'text-amber'}>
            {apart <= 1.15 ? 'they agree' : `${n(apart, 1)}× apart`}
          </span>
        </div>
      )}
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
  onLocate,
}: {
  direction: 'upstream' | 'downstream';
  projects: CascadeProject[];
  /** Centre the map on a project. These rows were unclickable dead text. */
  onLocate: (lat: number, lon: number) => void;
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
            <button
              key={`${direction}-${project.licenceNo}-${project.name}`}
              type="button"
              onClick={() => onLocate(project.snapped.lat, project.snapped.lon)}
              title="show this project on the map"
              className="group flex w-full gap-2 rounded px-1 py-0.5 text-left text-[11.5px] hover:bg-white/[0.06]"
            >
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
                <span className="mt-0.5 block text-[10px] text-river opacity-0 transition-opacity group-hover:opacity-100">
                  show on map ↗
                </span>
              </span>
            </button>
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
  mapAlignment?: React.ReactNode;
  methodComparison?: React.ReactNode;
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
  seismic: SeismicScreen | null;
  /** Secondary intakes feeding the same powerhouse, screened by src/collector.ts. */
  collectors: (CollectorScreen & { combinedMW: number; combinedGwh: number }) | null;
  /** Move the main intake below a confluence, retiring that collector pin. */
  onMoveIntakeTo: (pathIndex: number, collectorIndex: number) => void;
  /** Re-anchor the whole study on this point — the bigger river becomes the main stem. */
  onStudyHere: (lat: number, lon: number) => void;
  /** Fly the map to a piece of evidence and ring it. */
  onLocate: (lat: number, lon: number) => void;
  /** A far larger river beside the one this study picked, if there is one. */
  ambiguity: {
    nearestKm2: number;
    mainKm2: number;
    mainKm: number;
    lat: number;
    lon: number;
  } | null;
  /** The nearest DHM record worth transferring to this site, if any. */
  transfer: Transfer | null;
  transferBusy: boolean;
  onAdoptGauge: () => void;
  geology: GeologyScreen | null;
  /**
   * Units the waterway crosses on Nepal's own 1:1,000,000 sheet. Null is NOT
   * RUN; a traverse can itself report that the sheet is blank there, which is
   * a different and commoner answer in the high country.
   */
  geologyUnits: GeologyTraverse | null;
  /** What the waterway crosses. Null is NOT SCREENED, not "nothing there". */
  landcover: LandcoverScreen | null;
  /** How capacity, energy and dry share move with the size of the machine. */
  designSweep: DesignFlowSweep | null;
  /** How storage moves with WHERE the dam goes, at the height on the slider. */
  pondageSweep: PondagePositionSweep | null;
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
  mhsp: MhspScreen | null;
  flowShape: ShapeVerdict | null;
  grid: GridLink | null;
  conservation: { inside: ProtectedHit[]; near: ProtectedHit[]; hard: boolean } | null;
  localGis: LocalContext | null;
  topoCount: number;
  topoOn: boolean;
  onTopo: (v: boolean) => void;
  /** Canal-vs-tunnel read across the waterway corridor; null until terrain lands. */
  corridor: CorridorTerrain | null;
  pondage: PondageResult | null;
  pondageBusy: boolean;
  pondageError: string | null;
  pondageHeightM: number;
  onPondageHeight: (heightM: number) => void;
  roadAccess: RoadAccessScreen | null;
  roadAccessBusy: boolean;
  roadAccessError: string | null;
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
  onExport: (kind: 'csv' | 'geojson' | 'field-plan' | 'report') => void;
  reportMeta: ReportMeta;
  onReportMeta: (m: ReportMeta) => void;
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
    seismic,
    collectors,
    onMoveIntakeTo,
    onStudyHere,
    onLocate,
    ambiguity,
    transfer,
    transferBusy,
    onAdoptGauge,
    geology,
    landcover,
    geologyUnits,
    designSweep,
    pondageSweep,
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
    mhsp,
    flowShape,
    grid,
    conservation,
    localGis,
    topoCount,
    topoOn,
    onTopo,
    corridor,
    pondage,
    pondageBusy,
    pondageError,
    pondageHeightM,
    onPondageHeight,
    roadAccess,
    roadAccessBusy,
    roadAccessError,
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
    reportMeta,
    onReportMeta,
    busy,
    error,
    neighbours,
    onProbe,
    onReset,
    tweaked,
  } = props;

  const set = <K extends keyof Assumptions>(k: K, v: Assumptions[K]) =>
    setAssume({ ...assume, [k]: v });

  /** Feasible collector intakes scale the headline and its band together. */
  const collectorBoost = collectors && collectors.gainFrac > 0 ? 1 + collectors.gainFrac : 1;

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
    <aside className="reading-panel z-10 flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-line bg-panel lg:absolute lg:right-3 lg:top-3 lg:max-h-[calc(100%-1.5rem)] lg:w-[calc(34vw-18px)] lg:min-w-[380px] lg:flex-none lg:rounded-2xl lg:border lg:shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
      <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-line bg-panel/90 px-4 py-2.5 backdrop-blur-md lg:rounded-t-2xl">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
          {!at ? 'Pick a river' : scheme ? 'Best scheme found' : busy ? 'Studying' : 'Site assessment'}
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
            Click a river. HydroRecon maps the strongest scheme and the constraints around it.
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            Blue is the river. Drag the intake or powerhouse marker to test another position.
          </p>
        </div>
      )}

      {props.mapAlignment}
      {scheme && <Verdict scheme={scheme} uncertainty={uncertainty} flowChoice={flowChoice} />}
      {props.methodComparison}

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

      {/* ---- the study may be on the wrong river entirely ---- */}
      {ambiguity && study && (
        <div className="border-b border-line bg-amber/5 px-4 py-3.5">
          <H right={`${n(ambiguity.mainKm, 1)} km away`}>is this the right river?</H>
          <div className="rounded-lg border border-amber/40 bg-panel-2 px-3 py-2.5">
            <div className="text-[12px] leading-snug text-ink">
              Your click landed on a channel draining{' '}
              <b className="num">{n(ambiguity.nearestKm2, 0)} km²</b>. A river draining{' '}
              <b className="num text-amber">{n(ambiguity.mainKm2, 0)} km²</b> —{' '}
              {n(ambiguity.mainKm2 / Math.max(1, ambiguity.nearestKm2), 0)}× the catchment — runs{' '}
              <b className="num">{n(ambiguity.mainKm, 1)} km</b> away.
            </div>
            <div className="mt-1.5 text-[10.5px] leading-relaxed text-muted">
              HydroRecon studies the river downstream of your click, so the layout below may already have
              slid onto the larger river — check where the intake pin actually sits. What is certain
              is that anything you place back at the click itself takes the small channel&apos;s
              flow, and that is wrong by the ratio of the two catchments, not by a few percent.
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => onStudyHere(ambiguity.lat, ambiguity.lon)}
                className="flex-1 rounded-md border border-amber/50 bg-amber/10 px-2.5 py-1.5 text-[11px] font-medium text-amber hover:border-amber hover:text-ink"
              >
                Study the {n(ambiguity.mainKm2, 0)} km² river instead
              </button>
              <button
                type="button"
                onClick={() => onLocate(ambiguity.lat, ambiguity.lon)}
                className="rounded-md border border-line px-2.5 py-1.5 text-[11px] text-muted hover:border-river/60 hover:text-ink"
              >
                Show me
              </button>
            </div>
            <div className="mt-1.5 text-[10px] leading-relaxed text-faint">
              If you did mean the smaller stream, ignore this — clicking a hundred metres further up
              it will stop the larger river being a candidate at all.
            </div>
          </div>
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
              {/*
                This was four lines of caveat under a table whose rows differ by
                about three per cent. All of it is true and none of it is the
                first thing to read, so it sits behind the same disclosure every
                other method note uses.
              */}
              <Fine>
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
              </Fine>
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

      {/* ---- Nepal's regional regression, as an independent screening comparator ---- */}
      {hydest && (
        <div className="border-b border-line px-4 py-3.5">
          <H>Nepal's regional methods · two independent screens</H>
          <div className="flex items-baseline gap-2 text-[12px]">
            <span className="text-muted">lowest monthly mean</span>
            <span className="num text-[13.5px] font-medium text-ink">
              {n(hydest.driest.cms, 2)} m³/s
            </span>
            <span className="text-faint">{MONTH_NAMES[hydest.driest.month]}</span>
            <span className="text-faint">· WECS/DHM 1990</span>
          </div>
          {mhsp && (
            <div className="mt-1 flex items-baseline gap-2 text-[12px]">
              <span className="text-muted">lowest monthly mean</span>
              <span className="num text-[13.5px] font-medium text-ink">
                {n(mhsp.driest.cms, 2)} m³/s
              </span>
              <span className="text-faint">{MONTH_NAMES[mhsp.driest.month]}</span>
              <span className="text-faint">· MHSP 1997</span>
            </div>
          )}
          {mhsp && hydest.driest.cms > 0 && (
            <div className="mt-1.5 text-[11px] leading-relaxed text-muted">
              {(() => {
                const spread =
                  Math.max(mhsp.driest.cms, hydest.driest.cms) /
                  Math.min(mhsp.driest.cms, hydest.driest.cms);
                return spread <= 1.5 ? (
                  <>
                    The two methods Nepali feasibility studies run are {n(spread, 1)}× apart on the
                    dry season. That is close agreement for an ungauged catchment — a licensing
                    workbook would adopt the mean of the two and move on.
                  </>
                ) : (
                  <>
                    The two methods are {n(spread, 1)}× apart on the dry season. Neither is a
                    measurement, and averaging them would hide the disagreement rather than settle
                    it. This is the spread a gauge transfer is meant to close.
                  </>
                );
              })()}
            </div>
          )}
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
            Screening comparator only — never a design, diversion or spillway check flood.
          </div>
          <Fine>
            DoED guidance calls for applicable-method comparison, gauge-frequency and
            historical-flood evidence, direct measurement where data are absent, and GLOF/CLOF
            investigation before any of these figures is used for design.{' '}
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

      {/* ---- the flow-duration shape, checked against Nepal's own gauges ---- */}
      {flowShape && (
        <div className="border-b border-line px-4 py-3.5">
          <H>Flow-duration shape · checked against {flowShape.stations} gauges</H>
          <div className="mt-1 text-[11px] leading-relaxed text-muted">
            Design flow is a point on the flow-duration curve, so it depends on how
            spread out the year is, not just on how much water there is. The global
            model puts Q{Math.round(flowShape.exceedance * 100)} at{' '}
            <span className="num text-ink">{n(flowShape.ratio, 2)}×</span> the annual mean
            here. Nepali rivers with ten or more complete years of record run{' '}
            <span className="num text-ink">
              {n(flowShape.band[0], 2)}–{n(flowShape.band[2], 2)}×
            </span>{' '}
            (median <span className="num text-ink">{n(flowShape.band[1], 2)}×</span>).
          </div>
          <div
            className={`mt-2 rounded-lg px-2.5 py-2 text-[11px] leading-relaxed ${
              flowShape.implausible ? 'bg-panel-2 text-amber' : 'bg-panel-2 text-muted'
            }`}
          >
            {flowShape.implausible ? (
              <>
                That is outside the range any gauged Nepali river shows, so the shape has
                been remapped onto the measured national curve — design flow lifted{' '}
                <span className="num">{n(flowShape.designFactor, 2)}×</span>. The mean and
                the day order are untouched: only the spread around the mean changed. A
                gauge record for this river would replace this correction outright.
              </>
            ) : (
              <>
                That sits inside the measured range, so the modelled shape is used as it
                came. No correction applied.
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- where the real measurements are ---- */}
      {gauges && gauges.length > 0 && (
        <div className="border-b border-line px-4 py-3.5">
          {/*
            Three sections in a row concern measured records: the gauges that
            exist near here, the one that can actually be borrowed, and loading
            your own. Their headings said "nearest measured record", "a measured
            record exists nearby" and "have a gauge record?" — three names for
            what a reader experiences as one subject, and once a record was
            loaded two of them rendered the identical heading. They are named as
            a sequence now: what is here, what can be used, what you can bring.
          */}
          <H>gauges near this site</H>
          <div className="space-y-2.5">
            {gauges.slice(0, 3).map((g) => (
              <button
                key={g.name}
                type="button"
                onClick={() => onLocate(g.lat, g.lon)}
                title="show this gauge on the map"
                className="group flex w-full items-baseline gap-2.5 rounded px-1 py-0.5 text-left text-[12px] hover:bg-white/[0.06]"
              >
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
                  <span className="mt-0.5 block text-[10px] text-river opacity-0 transition-opacity group-hover:opacity-100">
                    show on map ↗
                  </span>
                </span>
              </button>
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

      {/* ---- the records themselves, where this build does not hold them ----
           Said rather than left blank. Without the statistics `bestTransfer`
           refuses every donor on its own specific-discharge screen, so the
           panel below never renders and the reader would see a screen that
           simply is not there. See src/dhm-statistics.ts. */}
      {scheme && !DHM_STATISTICS_BUNDLED && (
        <div className="border-b border-line px-4 py-3.5">
          <H right="not bundled">borrowed gauge record</H>
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[11px] leading-relaxed text-muted">
            <b className="text-ink">No DHM record can be transferred in this build.</b>{' '}
            {DHM_STATISTICS_ABSENT_NOTE}
          </div>
        </div>
      )}

      {/* ---- a measured record for this river, if Nepal has one nearby ---- */}
      {scheme && transfer && (
        <div className="border-b border-line px-4 py-3.5">
          <H right={`DHM · ${DHM_STATION_COUNT} stations held`}>
            {measured ? 'borrowed gauge record in use' : 'borrow the nearest usable record'}
          </H>
          <div
            className={`rounded-lg border px-3 py-2.5 ${
              measured ? 'border-green/40 bg-green/5' : 'border-river/40 bg-river/5'
            }`}
          >
            <div className="flex items-baseline gap-2 text-[12px] leading-snug">
              <button
                type="button"
                onClick={() => onLocate(transfer.station.lat!, transfer.station.lon!)}
                title="show this gauge on the map"
                className="min-w-0 flex-1 text-left"
              >
                <b className="text-ink">
                  {transfer.station.river || 'River'} at {transfer.station.location || 'gauge'}
                </b>
                <span className="block text-[10.5px] text-muted">
                  DHM station {transfer.station.id} · {transfer.station.from}–{transfer.station.to} ·{' '}
                  <span className="num">{transfer.station.completeYears}</span> complete years
                </span>
              </button>
              <span
                className={`shrink-0 rounded-full px-2 py-px text-[9.5px] uppercase tracking-[0.08em] ${
                  transfer.quality === 'close'
                    ? 'bg-green/15 text-green'
                    : transfer.quality === 'usable'
                      ? 'bg-river/15 text-river'
                      : 'bg-amber/15 text-amber'
                }`}
              >
                {transfer.quality}
              </span>
            </div>

            <div className="mt-2 grid grid-cols-3 gap-2 border-t border-line pt-2 text-[10.5px]">
              <div>
                <div className="num text-[13px] text-ink">{n(transfer.station.meanCms, 1)}</div>
                <div className="text-faint">m³/s measured at the gauge</div>
              </div>
              <div>
                <div className="num text-[13px] text-ink">{n(transfer.ratio, 2)}×</div>
                <div className="text-faint">
                  catchment {n(transfer.siteKm2, 0)} vs {n(transfer.gaugeKm2, 0)} km²
                </div>
              </div>
              <div>
                <div className="num text-[13px] text-ink">
                  {n(transfer.station.meanCms * transfer.ratio, 1)}
                </div>
                <div className="text-faint">m³/s implied here</div>
              </div>
            </div>

            <div className="mt-1.5 text-[10.5px] leading-relaxed text-muted">{transfer.note}</div>

            {measured ? (
              <div className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-green">
                <b>This record is driving the estimate above.</b>{' '}
                <span className="text-muted">
                  The flood model no longer sets the flow — only Nepal&apos;s own measurements,
                  scaled by catchment area.
                </span>
              </div>
            ) : transferMeetsBar(transfer) ? (
              <button
                type="button"
                onClick={onAdoptGauge}
                disabled={transferBusy}
                className="mt-2 w-full rounded-md border border-river/50 bg-river/10 px-2.5 py-2 text-left text-[11px] leading-relaxed text-river hover:border-river hover:text-ink disabled:opacity-60"
              >
                {transferBusy ? (
                  'Loading the record…'
                ) : (
                  <>
                    <b>Use this record instead of the model</b> — replaces a global flow model
                    carrying roughly 0.6× to 1.7× error with {transfer.station.completeYears} years
                    of measured daily flow, scaled by catchment area. This is the transfer a
                    feasibility study does for an ungauged site.
                  </>
                )}
              </button>
            ) : (
              /* Shown, not adoptable. The bar for REPLACING both models is the
                 one the validation harness scores against — a `close` catchment
                 and ten complete years — and the button used to ignore it. */
              <div className="mt-2 rounded-md border border-line bg-panel-2 px-2.5 py-2 text-[11px] leading-relaxed text-faint">
                <b className="text-muted">Context only — not adoptable.</b> Replacing the models
                needs a catchment within a factor of two and ten complete years; this donor is{' '}
                {transfer.quality} on {transfer.station.completeYears}. Nearby is not the same as
                transferable, and a short record on a mismatched catchment has sent a plant to a
                fifth of its licensed capacity here before.
              </div>
            )}

            <div className="mt-1.5 text-[10px] leading-relaxed text-faint">
              Catchment-area transfer assumes both catchments yield the same runoff per km², which
              is why the area ratio decides the grade. The seasonal shape and the wet-year to
              dry-year spread transfer well; the absolute magnitude only as far as the two
              catchments resemble each other. It is not a gauge on your site.
            </div>
          </div>
        </div>
      )}

      {/* ---- a real record, if the engineer has one ---- */}
      {study && (
        <div className="border-b border-line px-4 py-3.5">
          <H>{measured ? 'your own record is loaded' : 'or load your own record'}</H>
          {!measured && (
            <p className="mb-2 text-[11px] leading-relaxed text-faint">
              If you hold a gauged daily flow series for this river, load it and every flow figure
              above is recomputed from the measurement instead of the model.
            </p>
          )}
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

      {/* ---- the answer ---- */}
      {scheme && (
        <div className="border-b border-line px-4 pb-4 pt-3.5">
          {scheme.grossHeadM <= 0 ? (
            <div className="text-[12.5px] leading-relaxed text-red">
              This pair has no drop between it — slide the powerhouse further downstream.
            </div>
          ) : (
            <>
              {/* Collector intakes scale the headline itself — nobody should
                  have to scroll to learn what their second stream bought. */}
              {(() => {
                const boost = collectorBoost;
                const mw = scheme.capacityMW * boost;
                return (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="num text-[42px] font-medium leading-none tracking-tight text-ink">
                        {n(mw, mw < 10 ? 2 : 1)}
                      </span>
                      <span className="text-[15px] font-medium text-muted">MW</span>
                      <span className="ml-auto flex gap-1.5">
                        {boost > 1 && (
                          <span className="rounded bg-[color-mix(in_srgb,var(--color-river)_14%,transparent)] px-1.5 py-0.5 text-[10px] text-river">
                            +{n(collectors!.gainFrac * 100, 0)}% collectors
                          </span>
                        )}
                        {tweaked && (
                          <span className="rounded bg-[color-mix(in_srgb,var(--color-amber)_14%,transparent)] px-1.5 py-0.5 text-[10px] text-amber">
                            hand-adjusted
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="mt-2 flex items-baseline gap-1.5">
                      <span className="num text-[20px] font-medium leading-none text-ink">
                        {n(scheme.energyGwh * boost, 1)}
                      </span>
                      <span className="text-[12px] text-muted">GWh per year</span>
                      {boost > 1 && (
                        <span className="text-[10.5px] text-faint">
                          ({n(scheme.capacityMW, 1)} MW · {n(scheme.energyGwh, 1)} GWh from the main river alone)
                        </span>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* ---- the read: what you would tell a colleague, before the tables ---- */}
              <div className="mt-3 rounded-lg border-l-2 border-river/50 bg-panel-2 px-3 py-2.5">
                <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-faint">
                  the read
                </div>
                <p className="text-[12px] leading-relaxed text-muted">
                  {conservation && conservation.inside.length > 0 ? (
                    <>
                      This reach sits{' '}
                      <b className={conservation.hard ? 'text-red' : 'text-amber'}>
                        inside {conservation.inside[0].name}
                      </b>
                      {conservation.hard ? ' — ordinarily a hard stop, and nothing below matters until that is resolved' : ''}.{' '}
                    </>
                  ) : licences && licences.length > 0 ? (
                    <>
                      This river is <b className="text-ink">already spoken for</b> —{' '}
                      {licences.length} official record{licences.length > 1 ? 's' : ''} touch
                      {licences.length > 1 ? '' : 'es'} this reach, so the first question is whether
                      this layout coexists with them.{' '}
                    </>
                  ) : (
                    <>Nothing in the official record blocks this reach outright.{' '}</>
                  )}
                  {grid &&
                    (() => {
                      const v = connectionVerdict(grid);
                      return v.hard ? (
                        <>
                          Getting the power out is the fight here: <b className="text-amber">{v.text}</b>.{' '}
                        </>
                      ) : (
                        <>Power evacuation looks workable — {v.text}.{' '}</>
                      );
                    })()}
                  {(seismic?.pgaG != null || (hazards && hazards.records.length > 0)) && (
                    <>
                      The valley has a memory
                      {hazards && hazards.records.length > 0 &&
                        (() => {
                          const counts: Record<string, number> = {};
                          for (const r of hazards.records) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
                          const parts = Object.entries(counts)
                            .sort((a, b) => b[1] - a[1])
                            .map(([kind, k]) => `${k} ${kind}${k > 1 ? 's' : ''}`);
                          return <> — {parts.join(', ')} on record near the corridor</>;
                        })()}
                      {seismic?.pgaG != null && (
                        <>
                          {hazards && hazards.records.length > 0 ? '; ' : ' — '}
                          design shaking is <b className="num text-ink">{seismic.pgaG.toFixed(2)} g</b>
                          {seismic.largest && (
                            <>
                              {' '}and it has already felt{' '}
                              <b className="num text-ink">M{seismic.largest.mag}</b> ({seismic.largest.year})
                            </>
                          )}
                        </>
                      )}
                      .{' '}
                    </>
                  )}
                  {uncertainty && uncertainty.drivers.length > 0 && (
                    <>
                      If you spend money on one thing next, spend it on{' '}
                      <b className="text-ink">{uncertainty.drivers[0].name.toLowerCase()}</b> — that
                      alone moves this estimate ±{n(uncertainty.drivers[0].swingPct / 2, 0)}%.
                    </>
                  )}
                </p>
              </div>

              {uncertainty && (
                <div className="mt-3 rounded-lg bg-panel-2 px-3 py-2.5">
                  <div className="mb-1.5 text-[11.5px] leading-snug text-ink">
                    Realistically{' '}
                    <b className="num text-amber">
                      {n(uncertainty.capacityMW.low * collectorBoost, 1)}–{n(uncertainty.capacityMW.high * collectorBoost, 1)} MW
                    </b>{' '}
                    and{' '}
                    <b className="num text-amber">
                      {n(uncertainty.energyGwh.low * collectorBoost, 0)}–{n(uncertainty.energyGwh.high * collectorBoost, 0)} GWh/yr
                    </b>
                  </div>
                  <Band
                    low={uncertainty.capacityMW.low * collectorBoost}
                    mid={scheme.capacityMW * collectorBoost}
                    high={uncertainty.capacityMW.high * collectorBoost}
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

      {/* ---- the drop the estimate rests on, straight under the estimate ---- */}
      {study && pick && (
        <div className="border-b border-line px-2.5 pb-2.5 pt-3">
          <div className="px-1.5">
            <H right={`${study.dem.source} · ~${n(study.dem.resolutionM, 0)} m grid`}>
              {study.followsRiver
                ? 'The river, downstream from your click'
                : 'Terrain between the two points'}
            </H>
          </div>
          <RiverProfile path={study.path} i={pick.i} j={pick.j} />
          {scheme && (
            <>
              <div className="grid grid-cols-3 gap-2.5 px-1.5 pt-1.5">
                <Fact
                  label="Gross head"
                  value={n(scheme.grossHeadM, 0)}
                  unit="m"
                  from={
                    audit?.head
                      ? `±${n(audit.head.errM, 0)} m, measured on two terrain products`
                      : '±15 m assumed — audit to measure it'
                  }
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
                {corridor && (
                  <Fact
                    label="Benchable"
                    value={n(corridor.canalFrac * 100, 0)}
                    unit="%"
                    tone={corridor.canalFrac > 0.8 ? 'good' : corridor.canalFrac < 0.4 ? 'warn' : undefined}
                    from={
                      corridor.tunnelKm > 0
                        ? `${n(corridor.tunnelKm, 2)} km needs tunnel`
                        : 'canal throughout'
                    }
                  />
                )}
              </div>
              {/* The honest reading of that number, since it drives the answer. */}
              <div className="mt-1.5 px-1.5 text-[10px] leading-relaxed text-faint">
                The drop is a difference between two terrain readings, so its error is in metres, not
                percent: at {n(scheme.grossHeadM, 0)} m,{' '}
                {audit?.head ? `±${n(audit.head.errM, 0)} m` : '±15 m'} is{' '}
                <b className="text-muted">
                  ±{n(((audit?.head?.errM ?? 15) / Math.max(1, scheme.grossHeadM)) * 100, 1)}%
                </b>
                . What moves it more than the terrain does is where you put the two markers —{' '}
                {n(scheme.slopeMPerKm, 0)} m/km here means every 100 m you slide the intake changes
                the head by about {n(scheme.slopeMPerKm / 10, 0)} m. A dam would raise the intake
                above the bed this reads, and no dam is assumed.
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- level-pool pondage behind a proposed intake dam ---- */}
      {scheme && (
        <div className="border-b border-line px-4 py-3.5">
          <H
            right={
              pondage
                ? `${pondage.terrainComparison ? 'two DEMs checked' : pondage.source} · ~${n(pondage.resolutionM, 0)} m grid`
                : 'terrain screen'
            }
          >
            possible pondage at the intake
          </H>
          <Slider
            label="Retained water level above detected bed"
            value={pondageHeightM}
            min={2}
            max={60}
            step={1}
            display={`${n(pondageHeightM, 0)} m`}
            onChange={onPondageHeight}
            note="If you know structural dam height, subtract freeboard and any non-retaining crest allowance first."
          />

          {pondageBusy ? (
            <div className="mt-3 flex items-center gap-1.5 text-[11px] text-river">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-river" />
              Reading two terrain products and filling connected upstream cells…
            </div>
          ) : pondageError ? (
            <div className="mt-3 text-[11px] leading-relaxed text-amber">
              Pondage could not be screened: {pondageError}
            </div>
          ) : pondage ? (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2.5">
                <Fact
                  label="Water area"
                  value={`${pondage.edgeLimited ? '≥' : ''}${n(pondage.areaM2 / 10_000, 2)}`}
                  unit="ha"
                  from={
                    pondage.terrainComparison
                      ? pondage.terrainComparison.edgeLimited
                        ? `${pondage.floodedCells.toLocaleString()} primary cell${pondage.floodedCells === 1 ? '' : 's'} · second DEM uncontained`
                        : `${pondage.floodedCells.toLocaleString()} primary cell${pondage.floodedCells === 1 ? '' : 's'} · two-DEM span ${n(Math.min(pondage.areaM2, pondage.terrainComparison.areaM2) / 10_000, 2)}–${n(Math.max(pondage.areaM2, pondage.terrainComparison.areaM2) / 10_000, 2)} ha`
                      : `${pondage.floodedCells.toLocaleString()} connected cells`
                  }
                  tone={pondage.edgeLimited ? 'warn' : undefined}
                />
                <Fact
                  label="Storage"
                  value={`${pondage.edgeLimited ? '≥' : ''}${n(pondage.volumeM3 / 1_000_000, 3)}`}
                  unit="million m³"
                  from={
                    pondage.terrainComparison
                      ? pondage.terrainComparison.edgeLimited
                        ? `${n(pondage.meanDepthM, 1)} m primary mean · second DEM uncontained`
                        : `two-DEM span ${n(Math.min(pondage.volumeM3, pondage.terrainComparison.volumeM3) / 1_000_000, 3)}–${n(Math.max(pondage.volumeM3, pondage.terrainComparison.volumeM3) / 1_000_000, 3)} Mm³`
                      : `${n(pondage.meanDepthM, 1)} m mean depth`
                  }
                  tone={pondage.edgeLimited ? 'warn' : undefined}
                />
                <Fact
                  label="Backwater reach"
                  value={`${pondage.edgeLimited ? '≥' : ''}${n(pondage.upstreamLengthM / 1000, 2)}`}
                  unit="km"
                  from={`${n(pondage.shorelineM / 1000, 1)} km cell-edge shoreline`}
                  tone={pondage.edgeLimited ? 'warn' : undefined}
                />
              </div>
              <div className="mt-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[11px] leading-relaxed">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted">full-supply elevation</span>
                  <span className="num text-ink">{n(pondage.waterLevelM, 1)} m</span>
                </div>
                <div className="mt-0.5 flex items-baseline justify-between gap-3">
                  <span className="text-muted">inferred dam-axis span</span>
                  <span className={pondage.damLengthM === null ? 'text-amber' : 'num text-ink'}>
                    {pondage.damLengthM === null ? 'bank not closed in window' : `${n(pondage.damLengthM, 0)} m`}
                  </span>
                </div>
                <div className="mt-0.5 flex items-baseline justify-between gap-3">
                  <span className="text-muted">maximum modelled depth</span>
                  <span className="num text-ink">{n(pondage.maxDepthM, 1)} m</span>
                </div>
              </div>
              {/**
               * Is that enough? The screened volume alone cannot say, and the
               * dry-season month is the one that decides it. `flowScale` moves
               * the clicked record onto the intake, the same multiplier the
               * energy calculation uses, so this is the app's own flow rather
               * than a second opinion about it.
               */}
              {(() => {
                if (!scheme || !study?.flow?.dates?.length) return null;
                const dryInflowCms =
                  minMonthlyMean(study.flow.dates, study.flow.values) * scheme.flowScale;
                const demand = pondageDemand(
                  scheme.designFlowCms,
                  scheme.residualCms,
                  dryInflowCms,
                  pondage.volumeM3
                );
                if (!demand) return null;
                /**
                 * What the pond DELIVERS, not what it holds. Storage beyond a
                 * day's inflow cannot be refilled, so reporting the raw
                 * storage hours told this site it could peak for 24 h on a
                 * river that supports 10.
                 */
                const hours =
                  demand.hoursSupported === null
                    ? null
                    : Math.min(demand.hoursSupported, demand.inflowCeilingHours);
                const covered = hours !== null && hours >= demand.referenceHours;
                return (
                  <div className="mt-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[10.5px] leading-relaxed">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      is it enough · daily peaking balance
                    </div>
                    {demand.deficitCms <= 0 ? (
                      <div className="text-muted">
                        The driest month already carries{' '}
                        <span className="num text-ink">{n(demand.usableInflowCms, 2)} m³/s</span>{' '}
                        past the residual release, at or above the{' '}
                        <span className="num text-ink">{n(demand.designFlowCms, 2)} m³/s</span>{' '}
                        design flow. Nothing has to be stored to run flat out, so pondage here buys
                        dispatch timing, not energy.
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                          <span className="text-muted">dry-month flow at the intake</span>
                          <span className="num text-ink">{n(demand.dryInflowCms, 2)} m³/s</span>
                          <span className="text-muted">usable after residual release</span>
                          <span className="num text-ink">{n(demand.usableInflowCms, 2)} m³/s</span>
                          <span className="text-muted">
                            storage for {demand.referenceHours} h at design flow
                          </span>
                          <span className="num text-ink">
                            {n(demand.requiredM3 / 1_000_000, 3)} Mm³
                          </span>
                          <span className="text-muted">this pond covers</span>
                          <span className={`num ${covered ? 'text-green' : 'text-amber'}`}>
                            {pondage.edgeLimited && !demand.inflowLimited ? '≥' : ''}
                            {n(hours ?? 0, 1)} h
                          </span>
                        </div>
                        {/**
                         * The ceiling no pond can lift. Without it a generous
                         * valley reads as permission to peak longer than the
                         * river delivers in a day.
                         */}
                        <div className={`mt-1.5 ${demand.inflowLimited ? 'text-amber' : 'text-muted'}`}>
                          {demand.inflowLimited ? (
                            <>
                              <b>Inflow-limited, not storage-limited.</b> The basin holds enough
                              for{' '}
                              <span className="num">{n(demand.hoursSupported ?? 0, 1)} h</span>, but
                              a dry-season day delivers only enough water for{' '}
                              <span className="num">{n(demand.inflowCeilingHours, 1)} h</span> at
                              design flow however much is impounded. The hours above are capped at
                              what refills; the rest of the volume buys nothing here.
                            </>
                          ) : (
                            <>
                              A dry-season day supports at most{' '}
                              <span className="num text-ink">
                                {n(demand.inflowCeilingHours, 1)} h
                              </span>{' '}
                              at design flow whatever is built. Single average day, level pool: no
                              ramping, spill, turbine minimum, drawdown rule or flushing allowance.
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
              {pondage.terrainComparison && (
                <div className="mt-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[10.5px] leading-relaxed">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                    same site · second terrain chain
                  </div>
                  <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5">
                    <span className="text-muted">{pondage.source}</span>
                    <span className="num text-ink">{n(pondage.areaM2 / 10_000, 2)} ha</span>
                    <span className="num text-ink">{n(pondage.volumeM3 / 1_000_000, 3)} Mm³</span>
                    <span className="text-muted">{pondage.terrainComparison.source}</span>
                    <span className="num text-ink">
                      {pondage.terrainComparison.edgeLimited ? '≥' : ''}{n(pondage.terrainComparison.areaM2 / 10_000, 2)} ha
                    </span>
                    <span className="num text-ink">
                      {pondage.terrainComparison.edgeLimited ? '≥' : ''}{n(pondage.terrainComparison.volumeM3 / 1_000_000, 3)} Mm³
                    </span>
                  </div>
                  {pondage.terrainComparison.edgeLimited ? (
                    <div className="mt-1.5 text-amber">
                      The second terrain pool reaches the 10 km window edge, so its figures are
                      unresolved minimums and no two-DEM span is claimed. This extreme disagreement
                      is itself a stop signal for global-DEM storage at this axis.
                    </div>
                  ) : (
                    <div className="mt-1.5 text-muted">
                      Pair spread: {n(pondage.terrainComparison.areaSpreadPct, 0)}% area and{' '}
                      {n(pondage.terrainComparison.volumeSpreadPct, 0)}% storage. This is a
                      source-sensitivity check, not a confidence interval; agreement cannot replace
                      a site survey.
                    </div>
                  )}
                </div>
              )}
              {pondage.terrainComparison === null && (
                <div className="mt-2 text-[10.5px] leading-relaxed text-amber">
                  The second terrain chain was unavailable, so this footprint has no live
                  source-sensitivity check. Do not read a single-source result as agreement.
                </div>
              )}
              {pondage.stageCurve && pondage.stageCurve.length > 1 && (
                <div className="mt-2.5 overflow-hidden rounded-lg border border-line text-[10.5px]">
                  <div className="grid grid-cols-3 bg-panel-2 px-3 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted">
                    <span>retained level</span>
                    <span className="text-right">water area</span>
                    <span className="text-right">storage</span>
                  </div>
                  {pondage.stageCurve.map((point) => (
                    <div
                      key={point.retainedHeightM}
                      className="grid grid-cols-3 border-t border-line px-3 py-1.5"
                    >
                      <span className="num text-ink">{n(point.retainedHeightM, 1)} m</span>
                      <span className="num text-right text-ink">
                        {point.edgeLimited ? '≥' : ''}{n(point.areaM2 / 10_000, 2)} ha
                      </span>
                      <span className="num text-right text-ink">
                        {point.edgeLimited ? '≥' : ''}{n(point.volumeM3 / 1_000_000, 3)} Mm³
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {pondage.ruggedness && (
                <div className="mt-2 text-[10.5px] leading-relaxed text-amber">
                  <b>Rugged-terrain accuracy check:</b> TRI variability is{' '}
                  {n(pondage.ruggedness.triStdDevM, 1)} m across a{' '}
                  {n(pondage.ruggedness.sampleRadiusKm, 1)} km radius. A{' '}
                  <a
                    className="underline decoration-line underline-offset-2 hover:text-ink"
                    href={PONDAGE_METHOD.validation}
                    target="_blank"
                    rel="noreferrer"
                  >
                    2025 field validation of ten small dams
                  </a>{' '}
                  found this metric was the dominant predictor of 30 m DEM storage error, with
                  large absolute errors in rugged sites. It is a warning signal here, not a
                  transferable error percentage.
                </div>
              )}
              {pondage.floodedCells < 25 && (
                <div className="mt-2 text-[10.5px] leading-relaxed text-amber">
                  <b>Resolution-limited footprint:</b> the preferred result contains only{' '}
                  {pondage.floodedCells.toLocaleString()} complete 30 m cell{pondage.floodedCells === 1 ? '' : 's'}.
                  The outline and low-stage area are therefore controlled by grid posting; a finer
                  bare-earth DTM is required before using the shape or capacity.
                </div>
              )}
              {pondage.edgeLimited && (
                <div className="mt-2 text-[11px] leading-relaxed text-amber">
                  <b>The connected water reaches the 10 km terrain-window edge.</b> Area, storage
                  and reach above are minimums; this level may spill through a low saddle or extend
                  farther upstream. Delineate it in a larger surveyed DEM before comparing sites.
                </div>
              )}
              {!pondage.edgeLimited && pondage.damAxisLimited && (
                <div className="mt-2 text-[11px] leading-relaxed text-amber">
                  The level-pool footprint closes, but one bank of the perpendicular dam transect
                  does not. Draw and survey the actual axis before using a crest length.
                </div>
              )}
              {pondage.seedMovedM > pondage.resolutionM * 2 && (
                <div className="mt-2 text-[10.5px] leading-relaxed text-muted">
                  The DEM channel floor is {n(pondage.seedMovedM, 0)} m from the mapped intake
                  centreline. The blue footprint uses that lower cell; verify the axis on imagery.
                </div>
              )}
              {pondageHeightM <= 5 && (
                <div className="mt-2 text-[10.5px] leading-relaxed text-amber">
                  A {n(pondageHeightM, 0)} m retained level is close to the DEM&apos;s local vertical
                  uncertainty. Treat the shape as indicative until surveyed contours replace it.
                </div>
              )}
            </>
          ) : null}

          <Fine>
            Seeded 8-neighbour inundation: only upstream cells below the level and connected to the
            intake channel are retained. A perpendicular barrier closes the natural river outlet;
            without that step a simple elevation mask would leak downstream. Area is flooded-cell
            area and storage is the sum of depth × cell area. This combines the connectivity rule in{' '}
            <a className="underline decoration-line underline-offset-2 hover:text-ink" href={PONDAGE_METHOD.grass} target="_blank" rel="noreferrer">
              GRASS r.lake
            </a>{' '}
            with the explicit dam concept in{' '}
            <a className="underline decoration-line underline-offset-2 hover:text-ink" href={PONDAGE_METHOD.whitebox} target="_blank" rel="noreferrer">
              WhiteboxTools
            </a>
            . The calculation is repeated on a second terrain chain and swept through four lower
            operating stages. The active 30 m provider is still not bathymetry or a surveyed
            site DTM. Vegetation/buildings in surface-model inputs, narrow channels and sub-grid
            saddles can move the outline. See the{' '}
            <a className="underline decoration-line underline-offset-2 hover:text-ink" href={PONDAGE_METHOD.reearth} target="_blank" rel="noreferrer">
              Re:Earth / Mapterhorn source chain
            </a>{' '}
            and{' '}
            <a className="underline decoration-line underline-offset-2 hover:text-ink" href={PONDAGE_METHOD.awsTerrain} target="_blank" rel="noreferrer">
              AWS terrain fallback
            </a>
            ; Mapterhorn includes{' '}
            <a className="underline decoration-line underline-offset-2 hover:text-ink" href={PONDAGE_METHOD.copernicus} target="_blank" rel="noreferrer">
              Copernicus GLO-30
            </a>
            , which is a DSM.
          </Fine>
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
                <b className="text-ink">Pin the intake to your click →</b>
                <span className="block text-faint">
                  Now searching all {SEARCH_KM} km downstream, so the intake may sit far from where
                  you clicked.
                </span>
              </>
            ) : (
              <>
                <b className="text-ink">Search {SEARCH_KM} km downstream →</b>
                <span className="block text-faint">
                  Now holding the intake at your click. Searching finds the strongest site on the
                  river, which may be well away from it.
                </span>
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
                <CascadeProjectList direction="upstream" projects={cascade.upstream} onLocate={onLocate} />
                <CascadeProjectList
                  direction="downstream"
                  projects={cascade.downstream}
                  onLocate={onLocate}
                />
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


      {/* ---- collector intakes: extra streams piped into the headpond ---- */}
      {scheme && collectors && (
        <div className="border-b border-line px-4 py-3.5">
          <H right="Ctrl-click a stream to add another">collector intakes</H>
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
            <div className="space-y-2">
              {collectors.items.map((c, i) => {
                const ok = c.verdict === 'ok';
                return (
                  <div key={`${c.lat},${c.lon}`} className={i > 0 ? 'border-t border-line pt-2' : ''}>
                    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
                      <span className={`shrink-0 font-medium ${ok ? 'text-ink' : 'text-red'}`}>
                        intake {i + 2}
                      </span>
                      <span className="min-w-0 flex-1 text-muted">
                        {c.meanCms != null ? (
                          <>
                            <span className="num">{n(c.meanCms, 1)} m³/s</span> mean
                            {c.uplandKm2 != null && (
                              <> · <span className="num">{n(c.uplandKm2, 0)} km²</span></>
                            )}
                            {' · '}
                          </>
                        ) : null}
                        <span className="num">{n(c.channelKm, 1)} km</span> link to the waterway
                        {c.gradientMPerKm != null && ok && (
                          <> at <span className="num">{n(c.gradientMPerKm, 1)} m/km</span></>
                        )}
                      </span>
                      <span className={`num shrink-0 ${ok ? 'text-green' : 'text-red'}`}>
                        {ok ? `+${n(c.ratio * 100, 0)}%` : '✕'}
                      </span>
                    </div>
                    <div
                      className={`mt-0.5 text-[10.5px] leading-relaxed ${ok ? 'text-faint' : 'text-red'}`}
                    >
                      {ok && c.headroomM != null && (
                        <span className="num text-muted">+{n(c.headroomM, 0)} m above the headpond. </span>
                      )}
                      {c.reason}
                    </div>
                    {c.snappedKm != null && c.snappedKm > 0.25 && (
                      <div className="mt-0.5 text-[10px] leading-relaxed text-faint">
                        Pin moved {n(c.snappedKm, 1)} km onto the mapped channel.
                      </div>
                    )}
                    {/* The bigger branch below the intake: study IT instead. */}
                    {c.verdict === 'below-headpond' && c.biggerThanMain && (
                      <button
                        type="button"
                        onClick={() => onStudyHere(c.lat, c.lon)}
                        className="mt-1 w-full rounded-md border border-green/50 bg-green/10 px-2 py-1.5 text-left text-[10.5px] leading-relaxed text-green hover:border-green hover:text-ink"
                      >
                        <b>Study this river as the main stem</b> — take it at its own elevation,
                        {c.headroomM != null && (
                          <> keeping the {n(Math.abs(c.headroomM), 0)} m you would surrender by dropping to the confluence,</>
                        )}{' '}
                        then bring your current stream down into it as a collector.
                      </button>
                    )}
                    {/* The twin-intake fix: bring the intake down to the junction. */}
                    {c.junctionPathIndex != null && c.verdict === 'below-headpond' && (
                      <button
                        type="button"
                        onClick={() => onMoveIntakeTo(c.junctionPathIndex!, i)}
                        className="mt-1 w-full rounded-md border border-river/50 bg-river/10 px-2 py-1.5 text-left text-[10.5px] leading-relaxed text-river hover:border-river hover:text-ink"
                      >
                        <b>Move the main intake below this junction</b> — one intake on the merged
                        river takes both branches.
                        {c.junctionMeanCms != null && c.mainMeanCms != null && (
                          <>
                            {' '}The network carries{' '}
                            <span className="num">{n(c.junctionMeanCms, 1)} m³/s</span> there against{' '}
                            <span className="num">{n(c.mainMeanCms, 1)} m³/s</span> at your intake,
                          </>
                        )}{' '}
                        traded against the head given up over{' '}
                        {n(c.joinsMainBelowIntakeKm ?? 0, 1)} km. The estimate re-runs.
                      </button>
                    )}
                    {c.warnings.map((w) => (
                      <div key={w} className="mt-0.5 text-[10.5px] leading-relaxed text-amber">
                        Watch: {w}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            {collectors.gainFrac > 0 ? (
              <div className="mt-2 border-t border-line pt-2 text-[11.5px] leading-snug text-ink">
                {collectors.counted} collector{collectors.counted > 1 ? 's' : ''} counted —{' '}
                <b className="num text-amber">{n(collectors.combinedMW, 1)} MW</b> ·{' '}
                <b className="num text-amber">{n(collectors.combinedGwh, 0)} GWh/yr</b>{' '}
                <span className="text-muted">(+{n(collectors.gainFrac * 100, 0)}% over the main river alone)</span>
              </div>
            ) : (
              <div className="mt-2 border-t border-line pt-2 text-[11px] leading-snug text-muted">
                Nothing counted yet — the headline is the main river alone.
              </div>
            )}
            <div className="mt-1.5 text-[10px] leading-relaxed text-faint">
              On the map the dashed line is the link canal, running down the tributary&apos;s own
              valley to the diamond where it meets the main waterway —{' '}
              <b className="text-muted">drag that diamond</b> to move the junction along the
              waterway, and the link length and gradient re-derive from where you put it. Below it below that dot the two rivers are one flow in one
              headrace, which is why a single line continues to the powerhouse. The
              alignment is indicative — a real canal is cut into the valley side above the river at a
              far gentler grade, and only a survey settles it. Arithmetic, not simulation — each
              counted tributary is assumed to
              share the main catchment&apos;s flow-duration shape, so its share of the flow is the
              ratio of network means, which also carries its own residual-flow obligation. The
              waterway was sized for the main river alone, so a large gain means re-sizing the
              headrace, and channel lengths here are straight-line. Double-click a pin to remove it.
            </div>
          </div>
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
              <button
                key={l.licenceNo + l.name}
                type="button"
                onClick={() => onLocate(l.lat, l.lon)}
                title="show this project on the map"
                className="group flex w-full items-baseline gap-2.5 rounded px-1 py-0.5 text-left text-[12px] hover:bg-white/[0.06]"
              >
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
                  {/*
                    These rows have always centred the map on the project, and
                    nothing said so — the only clue was a title attribute, which
                    a touch screen never shows and a mouse only reveals after a
                    second of hovering over something you had no reason to hover
                    over. A visible target is the whole difference between a
                    feature and a secret.
                  */}
                  <span className="ml-1.5 whitespace-nowrap text-[10px] text-river opacity-0 transition-opacity group-hover:opacity-100">
                    show on map ↗
                  </span>
                  <span className="block text-[10.5px] leading-relaxed text-faint">
                    {l.stage}
                    {l.river ? ` · ${l.river}` : ''} ·{' '}
                    {l.distanceKm < 0.05
                      ? 'its published area overlaps your reach'
                      : `${n(l.distanceKm, 1)} km from your reach`}
                    {l.bounds && (
                      <>
                        {' · '}
                        published as a{' '}
                        <span className="num">
                          {n(
                            Math.hypot(
                              (l.bounds[2] - l.bounds[0]) * 111.32,
                              (l.bounds[3] - l.bounds[1]) * 111.32 * Math.cos((l.lat * Math.PI) / 180)
                            ),
                            1
                          )}{' '}
                          km
                        </span>{' '}
                        area, not a point
                      </>
                    )}
                  </span>
                </span>
              </button>
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

      {/* ---- road access at both ends of the selected layout ---- */}
      {scheme && (
        <div className="border-b border-line px-4 py-3.5">
          <H right="OpenStreetMap · live car graph">motor-road access</H>
          {roadAccessBusy ? (
            <div className="flex items-center gap-1.5 text-[11px] text-river">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-river" />
              Snapping the intake and powerhouse to routable roads…
            </div>
          ) : roadAccessError ? (
            <div className="text-[11px] leading-relaxed text-amber">
              Live road access is unavailable: {roadAccessError}
            </div>
          ) : roadAccess ? (
            <div className="space-y-2">
              {[roadAccess.intake, roadAccess.powerhouse].map((hit, index) => {
                const role = index === 0 ? 'intake' : 'powerhouse';
                if (!hit) {
                  return (
                    <div key={role} className="flex items-baseline gap-2 text-[11.5px]">
                      <span className="w-24 shrink-0 capitalize text-faint">{role}</span>
                      <span className="text-amber">no car-routable OSM segment within 20 km</span>
                    </div>
                  );
                }
                const far = hit.distanceM > 5000;
                return (
                  <div key={role} className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
                    <div className="flex items-baseline gap-2">
                      <button
                        type="button"
                        onClick={() => onLocate(hit.road.lat, hit.road.lon)}
                        className="w-24 shrink-0 text-left text-[11.5px] capitalize text-muted hover:text-river"
                        title="show the road snap on the map"
                      >
                        {role} ↗
                      </button>
                      <span className={`num text-[15px] ${far ? 'text-amber' : 'text-ink'}`}>
                        {hit.distanceM < 1000
                          ? `${n(hit.distanceM, 0)} m`
                          : `${n(hit.distanceM / 1000, 2)} km`}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">
                        {hit.name ?? 'unnamed routable road'}
                      </span>
                    </div>
                    <a
                      href={roadMapUrl(hit)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 block text-right text-[9.5px] text-river hover:text-ink"
                    >
                      inspect in OpenStreetMap ↗
                    </a>
                  </div>
                );
              })}
            </div>
          ) : null}
          <Fine>
            The blue/green dashed map lines are the straight gaps from each structure to the nearest
            segment accepted by an OSRM car-routing profile built from OpenStreetMap. That is a
            stronger motorability filter than counting every <span className="num">highway=*</span>{' '}
            feature, which also includes footways and paths. It is still only a lower bound: a road
            cannot be built straight through this terrain, and OSM does not prove width, surface,
            bridge capacity, seasonal condition, construction status or legal access.{' '}
            <a className="underline decoration-line underline-offset-2 hover:text-ink" href={ROAD_ACCESS_METHOD.osrm} target="_blank" rel="noreferrer">
              OSRM nearest method
            </a>{' '}
            ·{' '}
            <a className="underline decoration-line underline-offset-2 hover:text-ink" href={ROAD_ACCESS_METHOD.osmCopyright} target="_blank" rel="noreferrer">
              © OpenStreetMap contributors, ODbL ↗
            </a>
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
                  {grid.nearestSub.inferredKv ? '*' : ''}
                  {grid.nearestSub.kind === 'distribution' ? ' · distribution' : ''}
                </span>
              </div>
            )}
            {/* The nearest yard this plant could actually connect INTO, which is
                frequently a different one from the nearest yard. */}
            {grid.nearestAdequateSub &&
              grid.nearestAdequateSub.km !== grid.nearestSub?.km && (
                <div className="flex items-baseline gap-2">
                  <span className="w-24 shrink-0 text-faint">…able to take it</span>
                  <span className="num text-ink">{n(grid.nearestAdequateSub.km, 1)} km</span>
                  <span className="min-w-0 flex-1 truncate text-faint">
                    {grid.nearestAdequateSub.name ?? 'unnamed'} ·{' '}
                    {grid.nearestAdequateSub.kv} kV
                    {grid.nearestAdequateSub.inferredKv ? '*' : ''}
                  </span>
                </div>
              )}
            {!grid.nearestAdequateSub && (
              <div className="flex items-baseline gap-2">
                <span className="w-24 shrink-0 text-faint">…able to take it</span>
                <span className="text-amber">
                  no mapped substation at {grid.requiredKv} kV or above
                </span>
              </div>
            )}
          </div>
          <Fine>
            {grid.nearestSub?.inferredKv || grid.nearestAdequateSub?.inferredKv ? (
              <>
                <b className="text-muted">* voltage inferred</b> from a line terminating in the
                yard, not read from a tag — OpenStreetMap leaves most of Nepal&apos;s substations
                untagged, and a yard is defined by what connects to it.{' '}
              </>
            ) : null}
            Straight-line distance from the powerhouse — a line is not built straight through this
            terrain, so treat it as a floor. {n(scheme.capacityMW, 1)} MW would typically connect at{' '}
            {grid.requiredKv} kV. OpenStreetMap, © contributors, ODbL, retrieved {GRID_RETRIEVED};
            coverage is good on the
            transmission backbone and patchy below 66 kV, so an absent line means unmapped, not
            absent.
          </Fine>
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

      {/* ---- regional active-fault context near this exact layout ---- */}
      {scheme && region === 'nepal' && (faults || seismic) && (
        <div className="border-b border-line px-4 py-3.5">
          <H right={`GEM + USGS · bundled ${faults?.retrieved ?? PGA_RETRIEVED}`}>
            seismic & fault context
          </H>
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
            {faults && (
              <>
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
              </>
            )}

            {seismic && (
              <div className="mt-2 grid grid-cols-2 gap-3 border-t border-line pt-2">
                <div>
                  <div className="num text-[15px] font-medium text-ink">
                    {seismic.pgaG !== null ? `${seismic.pgaG.toFixed(2)} g` : '—'}
                  </div>
                  <div className="mt-0.5 text-[10px] leading-snug text-faint">
                    475-yr PGA on rock · GEM 2023. A floor for design — valley sediment amplifies shaking.
                  </div>
                </div>
                <div>
                  <div className="num text-[15px] font-medium text-ink">{seismic.within50}</div>
                  <div className="mt-0.5 text-[10px] leading-snug text-faint">
                    instrumented M4+ within 50 km since 1900
                    {seismic.largest
                      ? ` · largest M${seismic.largest.mag} (${seismic.largest.year}) ${seismic.largest.km.toFixed(0)} km away`
                      : ''}{' '}
                    · USGS
                  </div>
                </div>
              </div>
            )}

            <div className="mt-2 text-[10px] leading-relaxed text-faint">
              {faults && (
                <>
                  {faults.limitation}{' '}
                  <a href={faults.sourceUrl} target="_blank" rel="noreferrer" className="text-river hover:underline">
                    GEM source ↗
                  </a>{' '}
                  <a href={faults.licenseUrl} target="_blank" rel="noreferrer" className="text-river hover:underline">
                    CC BY-SA 4.0 ↗
                  </a>{' '}
                </>
              )}
              {seismic && (
                <>
                  Shaking is the 475-year return on rock, the reference case of NBC 105 — a site
                  response study is what turns it into a design value. Epicentres are where past
                  ruptures began, not where shaking was worst.{' '}
                  <a
                    href="https://doi.org/10.5281/zenodo.8409646"
                    target="_blank"
                    rel="noreferrer"
                    className="text-river hover:underline"
                  >
                    GEM hazard map ↗
                  </a>{' '}
                  <a
                    href="https://earthquake.usgs.gov/fdsnws/event/1/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-river hover:underline"
                  >
                    USGS catalog ({QUAKE_COUNT.toLocaleString()} events) ↗
                  </a>
                </>
              )}
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
                  <div key={record.id} className="flex items-baseline gap-2 text-[10.5px] leading-relaxed">
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: HAZARD_COLORS[record.kind] }}
                    />
                    <button
                      type="button"
                      onClick={() => onLocate(record.lat, record.lon)}
                      title="show this report on the map"
                      className="min-w-0 flex-1 text-left text-muted hover:text-ink"
                    >
                      {record.title} · {record.date}
                    </button>
                    <span className="num shrink-0 text-faint">{n(record.distanceKm, 1)} km</span>
                    <a
                      href={record.url}
                      target="_blank"
                      rel="noreferrer"
                      title="official BIPAD record"
                      className="shrink-0 text-faint hover:text-river"
                    >
                      ↗
                    </a>
                  </div>
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

                {/* ICIMOD ranked the 47 most dangerous lakes in these basins.
                    Whether any of them drains to this intake is the question a
                    GLOF-conscious engineer actually asks. */}
                {(() => {
                  const ranked = upstreamConnectivity.lakes.filter((l) => l.pdgl);
                  const rankI = ranked.filter((l) => l.pdgl?.rank === 1).length;
                  return (
                    <div
                      className={`mt-1.5 rounded border px-2 py-1.5 text-[10.5px] leading-relaxed ${
                        rankI > 0
                          ? 'border-red/40 bg-red/5 text-red'
                          : ranked.length > 0
                            ? 'border-amber/40 bg-amber/5 text-amber'
                            : 'border-line text-muted'
                      }`}
                    >
                      {ranked.length > 0 ? (
                        <>
                          <b>
                            {ranked.length} of ICIMOD&apos;s 47 potentially dangerous glacial lakes
                            {ranked.length === 1 ? ' has' : ' have'} a channel route to this intake
                          </b>
                          {rankI > 0 && <> — {rankI} at Rank I, the highest danger level assessed.</>}{' '}
                          <span className="block text-faint">
                            Named below. A GLOF from any of them would arrive down this channel.
                          </span>
                          <details className="mt-1 text-faint">
                            <summary className="cursor-pointer text-river">
                              what &ldquo;dangerous&rdquo; means here, and what it does not
                            </summary>
                            <div className="mt-1 space-y-1 leading-relaxed">
                              <p>
                                ICIMOD assessed every lake in these basins in 2020 and ranked 47 of
                                them on four physical measures: how far the lake outlet sits from the
                                moraine dam crest, whether the lake has been growing, whether its
                                glacier is retreating, and whether lake and glacier are still in
                                contact. Lakes more than 500 m from their glacier were excluded
                                outright. Dam height, width and steepness, and the avalanche and
                                landslide paths above the lake, set the rank.
                              </p>
                              <p>
                                <b className="text-muted">Rank I</b> means a large lake that can still
                                grow by calving, sitting against loose moraine with no overflow
                                channel, a steep outlet slope, a hanging source glacier, and slopes
                                above it that can drop ice or rock into the water.
                              </p>
                              <p>
                                It is a hazard ranking, not a probability. It does not say a lake
                                will burst, when, or how big the flood would be — that needs a dam
                                breach study. What it is good for is knowing which lakes upstream of
                                you are the ones an EIA will ask about.
                              </p>
                            </div>
                          </details>
                        </>
                      ) : (
                        <>
                          <b className="text-ink">
                            No ICIMOD-listed dangerous lake drains to this intake
                          </b>{' '}
                          <span className="text-faint">
                            — none of the 47 ranked lakes in the Koshi, Gandaki and Karnali basins has
                            a directed route here. That is a screening result, not GLOF clearance.
                          </span>
                        </>
                      )}
                    </div>
                  );
                })()}

                {upstreamConnectivity.lakes.length > 0 ? (
                  <div className="mt-2 space-y-1 border-t border-line pt-2">
                    <div className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-faint">
                      glacial-lake candidates
                    </div>
                    {upstreamConnectivity.lakes.slice(0, 5).map((lake) => {
                      const growing = lake.expansionSignificant === true &&
                        (lake.expansionRateKm2Yr ?? 0) > 0 && lake.timeSeriesOutlier !== true;
                      return (
                        <button
                          key={lake.id}
                          type="button"
                          onClick={() => onLocate(lake.lat, lake.lon)}
                          title="show this lake on the map"
                          className="block w-full rounded border border-line/70 px-2 py-1.5 text-left text-[10.5px] leading-relaxed hover:border-river/40"
                        >
                          <span className="flex items-baseline justify-between gap-2">
                            <b className="min-w-0 truncate text-ink">
                              {lake.pdgl?.name ?? `${lake.basin} · ${lake.country}`} · {n(lake.elevationM, 0)} m
                            </b>
                            <span className="num shrink-0 text-faint">{n(lake.routeKm, 1)} km</span>
                          </span>
                          {/* ICIMOD's national danger ranking, where this lake carries one. */}
                          {lake.pdgl && (
                            <span
                              className={`mt-0.5 block font-medium ${lake.pdgl.rank === 1 ? 'text-red' : 'text-amber'}`}
                            >
                              ICIMOD potentially dangerous lake · Rank {'I'.repeat(lake.pdgl.rank)} of III
                              {lake.pdgl.rank === 1 ? ' — the highest danger level assessed' : ''}
                            </span>
                          )}
                          <span className="block text-faint">
                            {lake.connectivity === 'Glacier-fed' ? 'fed by a glacier' : 'no glacier feeding it'}
                            {lake.expansionRateKm2Yr != null
                              ? ` · ${lake.expansionRateKm2Yr >= 0 ? 'growing' : 'shrinking'} ${Math.abs(lake.expansionRateKm2Yr * 100).toFixed(2)} hectares a year`
                              : ' · no measured trend'}
                          </span>
                          {(growing || lake.timeSeriesOutlier === true) && (
                            <span className={`block ${growing ? 'text-amber' : 'text-faint'}`}>
                              {growing
                                ? 'the growth is statistically significant — it is getting bigger, which is not the same as about to burst'
                                : 'the measured trend is erratic here; check the imagery before trusting it'}
                            </span>
                          )}
                        </button>
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
                      <div key={incident.id} className="flex items-baseline gap-2 text-[10.5px] leading-relaxed">
                        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: HAZARD_COLORS[incident.kind] }} />
                        <button
                          type="button"
                          onClick={() => onLocate(incident.lat, incident.lon)}
                          title="show this report on the map"
                          className="min-w-0 flex-1 text-left text-muted hover:text-ink"
                        >
                          {incident.title} · {incident.date}
                        </button>
                        <span className="num shrink-0 text-faint">{n(incident.routeKm, 1)} km</span>
                        <a
                          href={incident.url}
                          target="_blank"
                          rel="noreferrer"
                          title="official BIPAD record"
                          className="shrink-0 text-faint hover:text-river"
                        >
                          ↗
                        </a>
                      </div>
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
                {/* Three identical rows say nothing three times. At this scale
                    one unit usually covers the whole layout, so say that once
                    and only break it out where the samples actually differ. */}
                {(() => {
                  const describe = (s: (typeof geology.regional.samples)[number]) =>
                    s.units.length
                      ? s.units.map((unit) => `${unit.name} · ${unit.lithology}`).join('; ')
                      : 'no mapped regional unit returned';
                  const texts = geology.regional.samples.map(describe);
                  const uniform = texts.length > 1 && texts.every((t) => t === texts[0]);
                  return uniform ? (
                    <div className="mt-1.5 text-[10.5px] leading-relaxed text-muted">
                      {texts[0]}
                      <span className="block text-faint">
                        The same unit under the intake, the waterway and the powerhouse — at this
                        map scale the whole layout sits in one formation, so it separates nothing.
                      </span>
                    </div>
                  ) : (
                    <div className="mt-1.5 space-y-1">
                      {geology.regional.samples.map((sample, si) => (
                        <div key={sample.role} className="flex items-start gap-2 text-[10.5px] leading-relaxed">
                          <span className="w-[72px] shrink-0 capitalize text-faint">{sample.role}</span>
                          <span className="min-w-0 text-muted">{texts[si]}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
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

      {/* ---- the DHM records near this reach, and whether they can be used ---- */}
      {scheme && gauges && gauges.length > 0 && (() => {
        const near = gauges.slice(0, 6);
        const usable = gauges.filter((g) => g.measuresDischarge && g.trustworthy);
        const best = usable[0] ?? null;
        const where = (g: (typeof gauges)[number]) =>
          g.relation === 'upstream'
            ? 'upstream'
            : g.relation === 'downstream'
              ? 'downstream'
              : 'side branch';
        return (
          <div className="border-b border-line px-4 py-3.5">
            <H right={`${gauges.length} DHM`}>gauges near this reach</H>
            <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
              <div className="space-y-1.5">
                {near.map((g) => {
                  const ok = g.measuresDischarge && g.trustworthy;
                  return (
                    <div key={g.name} className="flex items-center gap-2">
                      <i
                        className={`size-2.5 shrink-0 rounded-full ${
                          ok
                            ? 'bg-[#1d6b4f]'
                            : g.measuresDischarge
                              ? 'bg-[#41525e]'
                              : 'border border-[#41525e] bg-transparent'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-[11px] leading-tight ${ok ? 'text-ink' : 'text-faint'}`}>
                          {g.name}
                        </div>
                        <div className="text-[9.5px] leading-tight text-faint">
                          {g.distanceKm < 0.1
                            ? `${Math.round(g.distanceKm * 1000)} m`
                            : `${g.distanceKm.toFixed(1)} km`}{' '}
                          {where(g)} ·{' '}
                          {!g.measuresDischarge
                            ? 'level only'
                            : g.areaRatio == null
                              ? 'catchment unknown'
                              : g.trustworthy
                                ? `×${g.areaRatio.toFixed(2)}, usable`
                                : `×${g.areaRatio.toFixed(2)}, too different`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {best ? (
                <div className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink">
                  <b>Ask DHM for {best.name}.</b> It measures discharge, and its catchment scales to
                  your intake by ×{best.areaRatio?.toFixed(2)}
                  {best.seriesId ? ` — quote series ${best.seriesId}` : ''}. A real record here beats
                  every modelled number in this panel.
                </div>
              ) : (
                <div className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-amber">
                  Nothing nearby both measures discharge and sits on a catchment close enough in size
                  to transfer. The flow here stays modelled.
                </div>
              )}

              <div className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-faint">
                Filled = measures discharge and transfers. Hollow = water level only, which is not a
                flow series until you get its rating curve. Transfer is Q × (your catchment ÷ theirs),
                defensible roughly 0.5–2×. Distance is straight-line to the reach.
              </div>
            </div>
          </div>
        );
      })()}

      {/* ---- where along the reach the storage is ---- */}
      {scheme && pondageSweep && pondageSweep.points.length >= 3 && (() => {
        const sw = pondageSweep;
        const hi = Math.max(...sw.points.map((q) => q.volumePerDamMetreM3 ?? 0));
        const gain =
          sw.current?.volumePerDamMetreM3 && sw.best?.volumePerDamMetreM3 && sw.best.i !== sw.current.i
            ? sw.best.volumePerDamMetreM3 / sw.current.volumePerDamMetreM3
            : null;
        return (
          <div className="border-b border-line px-4 py-3.5">
            <H right={`${sw.damHeightM.toFixed(0)} m retained`}>where the storage is</H>
            <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
              <div className="space-y-1">
                {sw.points.map((q) => {
                  const isCurrent = sw.current != null && q.i === sw.current.i;
                  const isBest = sw.best != null && q.i === sw.best.i;
                  return (
                    <div key={q.i} className="flex items-center gap-2">
                      <div className="w-11 shrink-0 text-[10.5px] leading-none tabular-nums text-faint">
                        {q.offsetKm >= 0 ? '+' : ''}
                        {q.offsetKm.toFixed(1)}
                      </div>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel">
                        <div
                          className={`h-full rounded-full ${isCurrent ? 'bg-river' : isBest ? 'bg-[#c9a227]' : 'bg-[#41525e]'} ${q.edgeLimited ? 'opacity-40' : ''}`}
                          style={{ width: `${Math.max(2, ((q.volumePerDamMetreM3 ?? 0) / (hi || 1)) * 100)}%` }}
                        />
                      </div>
                      <div className={`w-[4.6rem] shrink-0 text-right text-[10.5px] leading-none tabular-nums ${isCurrent ? 'text-ink' : 'text-faint'}`}>
                        {(q.volumeM3 / 1e6).toFixed(2)} Mm³
                      </div>
                      <div className={`w-[3.6rem] shrink-0 text-right text-[10.5px] leading-none tabular-nums ${isCurrent ? 'text-ink' : 'text-faint'}`}>
                        {q.damLengthM == null ? '–' : `${q.damLengthM.toFixed(0)} m`}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[9.5px] leading-none text-faint">
                <span className="w-11 shrink-0">km</span>
                <span className="flex-1">per metre of dam</span>
                <span className="w-[4.6rem] text-right">storage</span>
                <span className="w-[3.6rem] text-right">span</span>
              </div>

              {gain && gain >= 1.25 && sw.best && (
                <div className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-amber">
                  <b>
                    {Math.abs(sw.best.offsetKm).toFixed(2)} km{' '}
                    {sw.best.offsetKm > (sw.current?.offsetKm ?? 0) ? 'downstream' : 'upstream'} holds{' '}
                    {gain.toFixed(1)}× the water per metre of dam
                  </b>{' '}
                  — {(sw.best.volumeM3 / 1e6).toFixed(2)} Mm³ behind a{' '}
                  {sw.best.damLengthM?.toFixed(0)} m span. Head and flow chose this intake; storage
                  did not get a vote.
                </div>
              )}

              <div className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-faint">
                Ranked on storage per metre of dam, not storage — volume grows downstream whatever
                the site is like. Faded bars reached the edge of their terrain window and are
                minima. A screen on top of a screen: no spillway, geology, land take or cost.
              </div>
            </div>
          </div>
        );
      })()}

      {/* ---- the one parameter the developer actually chooses ---- */}
      {scheme && designSweep && designSweep.points.length >= 3 && (() => {
        const sw = designSweep;
        const eMax = Math.max(...sw.points.map((p) => p.energyGwh));
        // Every tenth percentile, plus whatever the scheme is actually sized at,
        // so the panel stays eight rows rather than seventeen.
        const shown = sw.points.filter(
          (p) =>
            Math.round(p.exceedance * 100) % 10 === 0 ||
            (sw.chosen && p.exceedance === sw.chosen.exceedance)
        );
        const bar = sw.dryLimitSixSix;
        const shrink = Boolean(bar && sw.chosen && bar.designFlowCms < sw.chosen.designFlowCms);
        return (
          <div className="border-b border-line px-4 py-3.5">
            <H right={`Q${Math.round((sw.chosen?.exceedance ?? 0) * 100)} as designed`}>
              design flow — how big a machine
            </H>
            <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
              <div className="space-y-1">
                {shown.map((p) => {
                  const isChosen = sw.chosen && p.exceedance === sw.chosen.exceedance;
                  const isBar = bar && p.exceedance === bar.exceedance;
                  return (
                    <div key={p.exceedance} className="flex items-center gap-2">
                      <div className="w-8 shrink-0 text-[10.5px] leading-none tabular-nums text-faint">
                        Q{Math.round(p.exceedance * 100)}
                      </div>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel">
                        <div
                          className={`h-full rounded-full ${isChosen ? 'bg-river' : isBar ? 'bg-[#c9a227]' : 'bg-[#41525e]'}`}
                          style={{ width: `${Math.max(2, (p.energyGwh / eMax) * 100)}%` }}
                        />
                      </div>
                      <div className={`w-[5rem] shrink-0 text-right text-[10.5px] leading-none tabular-nums ${isChosen ? 'text-ink' : 'text-faint'}`}>
                        {p.capacityMW.toFixed(p.capacityMW < 10 ? 2 : 1)} MW
                      </div>
                      <div className={`w-[3.2rem] shrink-0 text-right text-[10.5px] leading-none tabular-nums ${isChosen ? 'text-ink' : 'text-faint'}`}>
                        {((p.dryShareSixSix ?? 0) * 100).toFixed(0)}%
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[9.5px] leading-none text-faint">
                <span className="flex-1" />
                <span className="w-[5rem] text-right">capacity</span>
                <span className="w-[3.2rem] text-right">dry 6+6</span>
              </div>

              {shrink && bar && sw.chosen && (
                <div className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-amber">
                  <b>Sizing at Q{Math.round(bar.exceedance * 100)} would clear the 30% dry bar</b> —{' '}
                  {bar.capacityMW.toFixed(2)} MW instead of {sw.chosen.capacityMW.toFixed(2)}, giving up{' '}
                  {(sw.chosen.energyGwh - bar.energyGwh).toFixed(1)} GWh/yr to move dry energy from{' '}
                  {((sw.chosen.dryShareSixSix ?? 0) * 100).toFixed(1)}% to {((bar.dryShareSixSix ?? 0) * 100).toFixed(1)}%.
                </div>
              )}
              {!bar && (
                <div className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-amber">
                  No size screened clears the 30% dry bar on this river. Design flow is not the
                  lever here; pondage is.
                </div>
              )}
              {bar && !shrink && (
                <div className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink">
                  Clears the 30% dry bar as designed, and up to Q{Math.round(bar.exceedance * 100)} —{' '}
                  {bar.capacityMW.toFixed(2)} MW. There is room to size up.
                </div>
              )}

              <div className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-faint">
                Same layout throughout; only the machine changes. Each size re-sizes its own
                waterway and re-selects its own turbine, so the marked row reproduces the figures
                above exactly. No capital cost is applied — this is the physical trade-off, not an
                economic optimum, and the dry share reads 4–6 points low against DHM gauges.
              </div>
            </div>
          </div>
        );
      })()}

      {/* ---- what the alignment crosses: the consents ground triggers ---- */}
      {/* ---- Nepal's own map, read along the line rather than at a point ---- */}
      {scheme && geologyUnits && (() => {
        const g = geologyUnits;
        const blankKm = g.lengthKm - g.mappedKm;
        const spans = geologySpans(g).filter((sp) => !sp.unit.offSheet);
        const dist = (k: number) => (k < 0.1 ? `${Math.round(k * 1000)} m` : `${k.toFixed(1)} km`);
        const label = (u: GeologyTraverse['intake']) =>
          u.noData ? 'not mapped' : u.named ? u.name : `${u.name} (code only)`;
        return (
          <div className="border-b border-line px-4 py-3.5">
            <H right={g.scale}>rock the waterway crosses</H>
            <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <div className="text-[22px] font-semibold leading-none tabular-nums text-ink">
                  {g.formationContacts}
                </div>
                <div className="text-[11px] leading-tight text-faint">
                  formation contact{g.formationContacts === 1 ? '' : 's'} in {dist(g.lengthKm)}
                  {g.contacts.length > g.formationContacts
                    ? ` · ${g.contacts.length - g.formationContacts} member boundary not counted`
                    : ''}
                </div>
              </div>

              <div className="mt-2.5 space-y-1">
                {spans.map((sp) => (
                  <div key={sp.unit.code || 'blank'} className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel">
                      <div
                        className={`h-full rounded-full ${sp.unit.noData ? 'bg-[#5b6b78]' : 'bg-[#8a6f4e]'}`}
                        style={{ width: `${Math.max(2, sp.share * 100)}%` }}
                      />
                    </div>
                    <div
                      className={`w-[9.5rem] shrink-0 truncate text-[10.5px] leading-none ${
                        sp.unit.noData ? 'text-faint italic' : 'text-faint'
                      }`}
                      title={sp.unit.name}
                    >
                      {sp.unit.noData ? 'not mapped' : sp.unit.name}
                    </div>
                    <div className="w-[4rem] shrink-0 text-right text-[10.5px] leading-none tabular-nums text-ink">
                      {dist(sp.km)}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-2 border-t border-line pt-2 text-[11px] leading-snug text-ink">
                Intake on <b>{label(g.intake)}</b>, powerhouse on <b>{label(g.powerhouse)}</b>.
              </div>

              {blankKm > 0.05 * g.lengthKm && (
                <div className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-amber">
                  {dist(blankKm)} of this alignment is <b>not carried by the national dataset</b> — a
                  gap in the digitisation, not in Nepal's geology. DMG's printed sheets do map this
                  ground; about 30% of the digitised extent is missing this way, concentrated in the
                  high north, so a high-head site lands in it more often than a low one. Obtain the
                  province sheet for those kilometres.
                </div>
              )}

              <div className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-faint">
                DMG's national map at {g.scale}. A contact chainage here is good to about{' '}
                {g.contactErrorKm.toFixed(1)} km — half a millimetre of ink is 500 m of ground — so this
                says a contact is crossed and roughly where, never where to put a portal.
              </div>
            </div>
          </div>
        );
      })()}

      {scheme && landcover && landcover.along.length > 0 && (() => {
        const share = (code: number) =>
          landcover.along.find((a) => a.code === code)?.share ?? 0;
        const kmOf = (code: number) => landcover.along.find((a) => a.code === code)?.km ?? 0;
        const tree = kmOf(TREE_COVER);
        const built = kmOf(BUILT_UP);
        const crop = kmOf(CROPLAND);
        const dist = (k: number) => (k < 0.1 ? `${Math.round(k * 1000)} m` : `${k.toFixed(2)} km`);
        return (
          <div className="border-b border-line px-4 py-3.5">
            <H right={`${landcover.cellM} m cover`}>land the waterway crosses</H>
            <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
              <div className="space-y-1">
                {landcover.along.map((a) => (
                  <div key={a.code} className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel">
                      <div
                        className={`h-full rounded-full ${
                          a.code === TREE_COVER
                            ? 'bg-[#4f9d69]'
                            : a.code === BUILT_UP
                              ? 'bg-[#c2554d]'
                              : a.code === CROPLAND
                                ? 'bg-[#c9a227]'
                                : 'bg-[#5b6b78]'
                        }`}
                        style={{ width: `${Math.max(2, a.share * 100)}%` }}
                      />
                    </div>
                    <div className="w-[8.5rem] shrink-0 text-[10.5px] leading-none text-faint">
                      {a.label}
                    </div>
                    <div className="w-[4.5rem] shrink-0 text-right text-[10.5px] leading-none tabular-nums text-ink">
                      {dist(a.km)}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-2 border-t border-line pt-2 text-[11px] leading-snug text-ink">
                Intake on <b>{landcover.intake ?? 'unclassified ground'}</b>, powerhouse on{' '}
                <b>{landcover.powerhouse ?? 'unclassified ground'}</b>.
              </div>

              {tree > 0 && (
                <div className="mt-2 text-[11px] leading-relaxed text-amber">
                  <b>{dist(tree)} of the alignment ({Math.round(share(TREE_COVER) * 100)}%) runs on tree cover.</b>{' '}
                  Forest clearance and compensatory plantation apply, and the authority differs for
                  national, community and private forest — which land cover cannot tell apart.
                </div>
              )}
              {built > 0 && (
                <div className="mt-1.5 text-[11px] leading-relaxed text-amber">
                  <b>{dist(built)} crosses built-up ground.</b> Expect structures in the way and a
                  resettlement question, not only an easement.
                </div>
              )}
              {crop > 0 && (
                <div className="mt-1.5 text-[11px] leading-relaxed text-ink">
                  {dist(crop)} crosses cropland: private acquisition and crop compensation.
                </div>
              )}
              {tree === 0 && built === 0 && crop === 0 && (
                <div className="mt-2 text-[11px] leading-relaxed text-ink">
                  No forest, settlement or cropland on the centreline.
                </div>
              )}

              <div className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-faint">
                Centreline only — a right of way, spoil disposal and access track take more ground
                than the line, so these are floors. Cover is not tenure, and water cells are the
                channel the corridor follows rather than ground it occupies.{' '}
                <a
                  href="https://esa-worldcover.org/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-river hover:underline"
                >
                  ESA WorldCover 2021 · CC-BY-4.0 ↗
                </a>
              </div>
            </div>
          </div>
        );
      })()}

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
                    <div key={e}>• {e}</div>
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
              Field investigation campaign · {readiness.tasks.filter((t) => t.priority === 'P1').length}{' '}
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
                  <div className="text-faint">{t.discipline} · {t.reason}</div>
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
              onChange={(e) => set('householdKwh', Math.max(100, Number(e.target.value) || 100))}
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
        <div data-tour="export" className="border-b border-line px-4 py-3.5">
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

          {/**
            * The desk study needs three things the river cannot supply. They are
            * remembered between studies because a consultancy files many
            * reports under one letterhead.
            */}
          <div className="mt-3 grid grid-cols-1 gap-1.5">
            {(
              [
                ['projectName', 'Project name', 'e.g. Chepe Kalika Hydropower Project'],
                ['developer', 'Developer', 'Submitted by'],
                ['consultant', 'Consultant', 'Prepared by'],
              ] as const
            ).map(([key, label, placeholder]) => (
              <label key={key} className="flex items-center gap-2 text-[10.5px] text-muted">
                <span className="w-[74px] shrink-0">{label}</span>
                <input
                  type="text"
                  value={reportMeta[key]}
                  placeholder={placeholder}
                  onChange={(e) => onReportMeta({ ...reportMeta, [key]: e.target.value })}
                  className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-ink placeholder:text-faint focus:border-river/60 focus:outline-none"
                />
              </label>
            ))}
            <button
              type="button"
              onClick={() => onExport('report')}
              className="mt-1 rounded-lg border border-river/40 bg-[color-mix(in_srgb,var(--color-river)_10%,transparent)] px-3 py-2 text-[12px] font-medium text-river hover:border-river hover:text-ink"
            >
              Desk study report — print or save as PDF
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
