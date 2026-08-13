import type { DischargeSeries } from './api.ts';
import type { Assumptions, Pt, Study } from './App.tsx';
import type { DiscoverResult, Scheme } from './engine/discover.ts';
import type { Uncertainty } from './engine/uncertainty.ts';
import type { Licence } from './context.ts';
import { MONTH_NAMES } from './engine/hydest.ts';
import { connectionVerdict, type GridLink } from './grid.ts';
import type { BenchFit, Desander, SedimentSource } from './engine/sediment.ts';
import type { FlowChoice } from './engine/flowchoice.ts';
import type { ProtectedHit } from './protected.ts';
import type { MeasuredSeries } from './measured.ts';
import {
  DISCHARGE_GAUGE_COUNT,
  RIVER_GAUGE_COUNT,
  recordKind,
  transferAdvice,
  type Gauge,
} from './gauges.ts';
import { Fdc, RiverProfile } from './charts.tsx';
import { buildFdc } from './engine/hydro.ts';

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
  return <p className="mt-2 text-[10.5px] leading-relaxed text-faint">{children}</p>;
}

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
  study: Study | null;
  flowOnly: DischargeSeries | null;
  found: DiscoverResult | null;
  scheme: Scheme | null;
  seasons: { wetGwh: number; dryGwh: number } | null;
  uncertainty: Uncertainty | null;
  pick: { i: number; j: number } | null;
  onPick: (s: Scheme) => void;
  assume: Assumptions;
  setAssume: (a: Assumptions) => void;
  licences: Licence[] | null;
  gauges: Gauge[] | null;
  hydest: {
    input: { totalKm2: number; below5000Km2: number; below3000Km2: number; monsoonMm?: number };
    driest: { month: number; cms: number };
    months: { month: number; cms: number }[];
    modelledCms: number;
    agreement: { ratio: number; agree: boolean } | null;
    floods: { t: number; cms: number }[];
  } | null;
  grid: GridLink | null;
  conservation: { inside: ProtectedHit[]; near: ProtectedHit[]; hard: boolean } | null;
  flowChoice: FlowChoice | null;
  sediment: { basin: Desander; source: SedimentSource | null } | null;
  bench: BenchFit | null;
  measured: { series: MeasuredSeries; ratio: number; name: string } | null;
  onImport: (file: File) => void;
  onClearMeasured: () => void;
  wideSearch: boolean;
  onWideSearch: (v: boolean) => void;
  canExport: boolean;
  onExport: (kind: 'csv' | 'geojson') => void;
  busy: string | null;
  error: string | null;
  neighbours: { lat: number; lon: number; meanCms: number }[] | null;
  onProbe: () => void;
  onReset: () => void;
  tweaked: boolean;
}) {
  const {
    at,
    study,
    flowOnly,
    found,
    scheme,
    seasons,
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
    flowChoice,
    sediment,
    bench,
    measured,
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
  const fdc = study ? buildFdc(study.flow.values) : flowOnly ? buildFdc(flowOnly.values) : [];
  const meanCms = flow ? flow.values.reduce((a, b) => a + b, 0) / flow.values.length : 0;
  const years = flow ? flow.dates.length / 365.25 : 0;

  // Two independent models of the same quantity. When they diverge, the ~5 km
  // grid cell is probably not even on this channel.
  const rival = study?.reach?.meanDischargeCms;
  const disagreement =
    rival && rival > 0 && meanCms > 0 ? Math.max(rival / meanCms, meanCms / rival) : null;

  const verdict = grid ? connectionVerdict(grid) : null;

  const alternatives = found?.schemes ?? [];

  return (
    <aside className="z-10 flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-line bg-panel lg:absolute lg:right-3 lg:top-3 lg:max-h-[calc(100%-1.5rem)] lg:w-[400px] lg:flex-none lg:rounded-2xl lg:border lg:shadow-[0_24px_70px_rgba(0,0,0,0.55)] xl:w-[440px]">
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
            Click once on a river, get the schemes worth studying.
          </p>
          <div className="mt-3.5 space-y-2.5">
            {[
              ['1', 'Ghatta walks 22 km downstream along the real channel.'],
              ['2', 'It reads the terrain and twenty years of daily flow.'],
              ['3', 'It searches hundreds of intake and powerhouse positions.'],
            ].map(([k, t]) => (
              <div key={k} className="flex items-start gap-2.5">
                <span className="num mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-panel-2 text-[10.5px] text-muted">
                  {k}
                </span>
                <span className="text-[12.5px] leading-relaxed text-muted">{t}</span>
              </div>
            ))}
          </div>
          <p className="mt-3.5 text-[11.5px] leading-relaxed text-faint">
            You get alternatives to compare, not one number. Drag either marker to slide it along
            the river.
          </p>
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
            Boundaries from OpenStreetMap, © contributors, ODbL, simplified to ~200 m. Nepal&apos;s
            conservation areas do host licensed hydropower; national parks and reserves effectively
            do not. The permission question is DNPWC&apos;s, not this tool&apos;s.
          </Fine>
        </div>
      )}

      {disagreement && disagreement > 2 && (
        <div className="border-b border-line px-4 py-2.5 text-[11px] leading-relaxed text-muted">
          {flowChoice?.authority === 'hydest' ? (
            <>
              The mapped network claims {n(rival!, 1)} m³/s for this reach and the flood model{' '}
              {n(meanCms, 1)} — {n(disagreement, 1)}× apart, and <b className="text-ink">both fail
              Nepal&apos;s own regression</b>, which puts the annual mean at{' '}
              <b className="num text-ink">{n(flowChoice.judgeCms ?? NaN, 1)} m³/s</b> from this
              catchment&apos;s area, hypsometry and monsoon rainfall. Flows below keep the flood
              model&apos;s day-to-day shape rescaled onto the regression — a fitted method with
              real scatter, so treat the band seriously and gauge this river before believing
              anyone.
            </>
          ) : flowChoice?.authority === 'model' ? (
            <>
              The mapped network claims {n(rival!, 1)} m³/s for this reach against the flood
              model&apos;s {n(meanCms, 1)} — {n(disagreement, 1)}× apart, and Nepal&apos;s own
              regression sides with the flood model
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
                <div className="mt-2 text-[11px] leading-relaxed text-faint">
                  <b className="text-muted">{scheme.turbine}</b> selected for this duty point — best
                  point {n(scheme.turbinePeak * 100, 1)}%, times {n(assume.efficiency * 100, 0)}%
                  generator. Every day of the record is dispatched on its part-load curve, so low
                  flows are not credited with best-point efficiency.
                </div>
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

      {/* ---- who already holds this river ---- */}
      {licences && licences.length > 0 && (
        <div className="border-b border-line px-4 py-3.5">
          <H>
            {licences.length} licensed project{licences.length > 1 ? 's' : ''} on this reach
          </H>
          <div className="space-y-2">
            {licences.slice(0, 6).map((l) => (
              <div key={l.licenceNo + l.name} className="flex items-baseline gap-2.5 text-[12px]">
                <span
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{
                    background:
                      l.stage === 'Operation'
                        ? 'var(--color-red)'
                        : l.stage === 'Generation'
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
                    {l.river ? ` · ${l.river}` : ''} · {n(l.distanceKm, 1)} km away
                  </span>
                </span>
              </div>
            ))}
          </div>
          <Fine>
            Department of Electricity Development registry.{' '}
            <span className="text-red">Operating</span> and{' '}
            <span className="text-amber">construction</span> licences are a hard constraint on this
            water; a survey licence means someone is already studying it. The public snapshot lags,
            so check the current register before relying on this.
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
            {grid.requiredKv} kV. OpenStreetMap, © contributors, ODbL; coverage is good on the
            transmission backbone and patchy below 66 kV, so an absent line means unmapped, not
            absent.
          </Fine>
        </div>
      )}

      {/* ---- Nepal's own regression, as an independent third opinion ---- */}
      {hydest && (
        <div className="border-b border-line px-4 py-3.5">
          <H>HYDEST · Nepal&apos;s national method</H>
          <div className="flex items-baseline gap-2 text-[12px]">
            <span className="text-muted">driest month</span>
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
                  {n(hydest.agreement.ratio, 1)}×. Two methods built from different data agree,
                  which is the strongest corroboration available without a gauge.
                </>
              ) : (
                <>
                  The global model gives {n(hydest.modelledCms, 2)} m³/s for the same month —{' '}
                  {n(hydest.agreement.ratio, 1)}× apart. Nepal&apos;s own regression and the flood
                  model disagree about the dry season here, and the dry season is what sets firm
                  power.
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
                design flood, m³/s
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
          <Fine>
            WECS/DHM 1990, fitted to Nepal&apos;s own gauged records — the method a feasibility
            study would use for an ungauged site. Catchment below 5000 m:{' '}
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
            shrinks it. DHM runs {RIVER_GAUGE_COUNT} river stations, {DISCHARGE_GAUGE_COUNT} of them
            recording discharge rather than water level alone. The readings are not public — the API
            requires a key, and refuses DHM&apos;s own portal too — so request the record for the
            station above and scale it by catchment area, which is what a feasibility study would do
            with it.
          </Fine>
        </div>
      )}

      {/* ---- flow ---- */}
      {flow && fdc.length > 0 && (
        <div className="border-b border-line px-2.5 pb-3 pt-3">
          <div className="px-1.5">
            <H>Flow at your click — m³/s vs % of time exceeded</H>
          </div>
          <Fdc
            fdc={fdc}
            designCms={scheme?.designFlowCms ?? 0}
            residualCms={scheme?.residualCms ?? 0}
          />
          <div className="grid grid-cols-3 gap-2.5 px-1.5">
            <Fact
              label="Mean"
              value={n(meanCms, 2)}
              unit="m³/s"
              from={`${n(years, 0)} yr GloFAS record`}
            />
            <Fact
              label={`Design Q${Math.round(assume.exceedance * 100)}`}
              value={scheme ? n(scheme.designFlowCms, 2) : '—'}
              unit="m³/s"
              from="at the intake, after residual"
              tone="good"
            />
            <Fact
              label="Residual"
              value={scheme ? n(scheme.residualCms, 2) : '—'}
              unit="m³/s"
              from={`${n(assume.residualFrac * 100, 0)}% of driest month`}
              tone="warn"
            />
          </div>
          {seasons && (
            <div className="mt-2.5 grid grid-cols-2 gap-2.5 px-1.5">
              <Fact
                label="Wet half-year"
                value={n(seasons.wetGwh, 1)}
                unit="GWh"
                from="mid-Apr → mid-Dec"
              />
              <Fact
                label="Dry half-year"
                value={n(seasons.dryGwh, 1)}
                unit="GWh"
                from="mid-Dec → mid-Apr, the hard months"
              />
            </div>
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
            min={0}
            max={0.5}
            step={0.01}
            display={`${Math.round(assume.residualFrac * 100)}% of min month`}
            onChange={(v) => set('residualFrac', v)}
            note="Left in the river. Bases vary by jurisdiction — set yours."
          />
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
            <b className="text-muted">Flow</b> — GloFAS v4 reanalysis, {n(years, 0)} years,{' '}
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
          <div className="flex gap-2">
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
