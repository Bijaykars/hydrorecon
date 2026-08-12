import type { DischargeSeries } from './api.ts';
import type { Assumptions, Pt, Study } from './App.tsx';
import type { DiscoverResult, Scheme } from './engine/discover.ts';
import type { Uncertainty } from './engine/uncertainty.ts';
import type { Licence } from './context.ts';
import { MONTH_NAMES } from './engine/hydest.ts';
import { connectionVerdict, type GridLink } from './grid.ts';
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
      <div className="text-[10px] uppercase tracking-[0.08em] text-faint">{label}</div>
      <div
        className={`num text-[15px] leading-tight ${tone === 'good' ? 'text-green' : tone === 'warn' ? 'text-amber' : 'text-ink'}`}
      >
        {value}
        {unit && <span className="ml-0.5 text-[10.5px] text-muted">{unit}</span>}
      </div>
      <div className="mt-0.5 text-[9.5px] leading-tight text-faint">{from}</div>
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
        <span className="text-[11px] text-muted">{label}</span>
        <span className="num text-[11.5px] text-ink">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[#4db8ff]"
      />
      {note && <span className="block text-[9.5px] leading-tight text-faint">{note}</span>}
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
    input: { totalKm2: number; below5000Km2: number; below3000Km2: number };
    driest: { month: number; cms: number };
    months: { month: number; cms: number }[];
    modelledCms: number;
    agreement: { ratio: number; agree: boolean } | null;
    floods: { t: number; cms: number }[];
  } | null;
  grid: GridLink | null;
  conservation: { inside: ProtectedHit[]; near: ProtectedHit[]; hard: boolean } | null;
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
    <aside className="z-10 flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-line bg-panel lg:absolute lg:right-3 lg:top-3 lg:max-h-[calc(100%-1.5rem)] lg:w-[356px] lg:flex-none lg:rounded-xl lg:border lg:shadow-[0_16px_50px_rgba(0,0,0,0.5)]">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          {!at ? 'Pick a river' : scheme ? 'Best scheme found' : 'Studying'}
        </span>
        {busy && <span className="text-[10.5px] text-river">{busy}</span>}
        {at && (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto text-[10.5px] text-faint hover:text-ink"
          >
            clear
          </button>
        )}
      </div>

      {!at && (
        <div className="px-3.5 py-3 text-[12px] leading-relaxed text-muted">
          <b className="text-ink">Click once on a river.</b> Ghatta walks {22} km downstream along
          the real channel, reads the terrain and the flow, and searches hundreds of intake and
          powerhouse positions for the schemes worth studying.
          <div className="mt-2 text-[11px] text-faint">
            You get alternatives to compare, not one number. Drag either marker to slide it along
            the river.
          </div>
        </div>
      )}

      {error && (
        <div className="border-b border-line bg-[color-mix(in_srgb,var(--color-red)_8%,transparent)] px-3.5 py-2 text-[11px] leading-snug text-muted">
          <b className="text-red">{error}</b>
        </div>
      )}

      {at && !study && !busy && flowOnly && (
        <div className="border-b border-line px-3.5 py-2 text-[11.5px] leading-snug text-muted">
          The terrain here does not descend far enough to trace a river course.{' '}
          <b className="text-ink">Click directly on a watercourse</b> in a valley.
        </div>
      )}

      {study?.tracedFromTerrain && (
        <div className="border-b border-line px-3.5 py-2 text-[10.5px] leading-snug text-faint">
          No mapped river network covers this area, so the course was traced downhill through the
          terrain and the flood model&apos;s own flow is used unscaled. Both are weaker than where a
          network exists — treat this as a first look.
        </div>
      )}

      {conservation && (
        <div
          className={`border-b border-line px-3.5 py-2.5 ${
            conservation.hard
              ? 'bg-[color-mix(in_srgb,var(--color-red)_10%,transparent)]'
              : 'bg-[color-mix(in_srgb,var(--color-amber)_8%,transparent)]'
          }`}
        >
          <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-faint">
            {conservation.inside.length ? 'inside a protected area' : 'beside a protected area'}
          </div>
          {conservation.inside.map((h) => (
            <div key={h.name} className="text-[11px] leading-snug">
              <b className={conservation.hard ? 'text-red' : 'text-amber'}>{h.name}</b>
              <span className="block text-[10px] text-muted">{h.regime}</span>
              {h.nearEdge && (
                <span className="block text-[9.5px] text-faint">
                  close to the boundary — at this mapping accuracy, inside and outside cannot be
                  told apart here
                </span>
              )}
            </div>
          ))}
          {conservation.near.map((h) => (
            <div key={h.name} className="text-[11px] leading-snug">
              <b className="text-amber">{h.name}</b>
              <span className="block text-[10px] text-muted">
                within 3 km — {h.regime}
              </span>
            </div>
          ))}
          <p className="mt-1 text-[9.5px] leading-snug text-faint">
            Boundaries from OpenStreetMap, © contributors, ODbL, simplified to ~200 m. Nepal&apos;s
            conservation areas do host licensed hydropower; national parks and reserves effectively
            do not. The permission question is DNPWC&apos;s, not this tool&apos;s.
          </p>
        </div>
      )}

      {disagreement && disagreement > 2 && (
        <div className="border-b border-line px-3.5 py-2 text-[11px] leading-snug text-muted">
          The flood model&apos;s ~5 km cell reads {n(meanCms, 1)} m³/s here, {n(disagreement, 1)}×
          off the {n(rival!, 1)} m³/s the mapped river network gives for this reach — its cell is
          not on this channel. Flows below use the network&apos;s magnitude and the model&apos;s
          day-to-day shape.
        </div>
      )}

      {/* ---- the answer ---- */}
      {scheme && (
        <div className="border-b border-line px-3.5 py-3">
          {scheme.grossHeadM <= 0 ? (
            <div className="text-[11.5px] leading-snug text-red">
              This pair has no drop between it — slide the powerhouse further downstream.
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="num text-[34px] font-semibold leading-none tracking-tight">
                  {n(scheme.capacityMW, scheme.capacityMW < 10 ? 2 : 1)}
                </span>
                <span className="text-[15px] text-muted">MW</span>
                {tweaked && <span className="ml-auto text-[10px] text-amber">hand-adjusted</span>}
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="num text-[19px] font-semibold leading-none">
                  {n(scheme.energyGwh, 1)}
                </span>
                <span className="text-[12px] text-muted">GWh per year</span>
              </div>
              {uncertainty && (
                <div className="mt-2 rounded-md border border-amber/30 bg-[color-mix(in_srgb,var(--color-amber)_6%,transparent)] px-2.5 py-2">
                  <div className="text-[11.5px] leading-snug text-ink">
                    Realistically{' '}
                    <b className="num text-amber">
                      {n(uncertainty.capacityMW.low, 1)}–{n(uncertainty.capacityMW.high, 1)} MW
                    </b>{' '}
                    and{' '}
                    <b className="num text-amber">
                      {n(uncertainty.energyGwh.low, 0)}–{n(uncertainty.energyGwh.high, 0)} GWh/yr
                    </b>
                    .
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {uncertainty.drivers.map((d) => (
                      <div key={d.name} className="text-[9.5px] leading-snug text-faint">
                        <b className="text-muted">{d.name}</b> moves it ±
                        {n(d.swingPct / 2, 0)}% — {d.note}
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[9.5px] leading-snug text-faint">
                    The single figure above is the midpoint, not a measurement. Narrowing this needs
                    a gauge record and a survey, which is what screening is for deciding.
                  </div>
                </div>
              )}
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
                A <b className="text-ink">{n(scheme.waterwayKm, 1)} km</b> waterway taking{' '}
                <b className="text-ink">{n(scheme.grossHeadM, 0)} m</b> of drop — about{' '}
                <b className="text-ink">
                  {n((scheme.energyGwh * 1e6) / assume.householdKwh, 0)}
                </b>{' '}
                households, running at {n(scheme.plantFactor * 100, 0)}% of nameplate on hydrology
                alone.
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md bg-panel-2 px-2.5 py-2 text-[11px]">
                <span className="num text-river">{n(scheme.designFlowCms, 2)} m³/s</span>
                <span className="text-faint">×</span>
                <span className="num text-river">{n(scheme.netHeadM, 0)} m</span>
                <span className="text-faint">×</span>
                <span className="num text-river">{n(scheme.turbinePeak * assume.efficiency * 100, 0)}%</span>
                <span className="text-faint">× ρg →</span>
                <span className="num font-semibold text-ink">{n(scheme.capacityMW, 2)} MW</span>
              </div>
              {scheme.waterway && (
                <div className="mt-1.5 rounded-md border border-line px-2.5 py-2">
                  <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-faint">
                    the waterway costs {n(scheme.grossHeadM - scheme.netHeadM, 1)} m of that drop
                    {' · '}
                    {n(scheme.waterway.lossFrac * 100, 1)}%
                  </div>
                  {scheme.waterway.segments.map((s) => (
                    <div key={s.kind} className="flex items-baseline gap-1.5 text-[10px] leading-tight">
                      <span className="w-14 shrink-0 text-muted">{s.kind}</span>
                      <span className="num text-river">
                        {s.lengthM >= 1000
                          ? `${n(s.lengthM / 1000, 2)} km`
                          : `${n(s.lengthM, 0)} m`}
                      </span>
                      <span className="text-faint">·</span>
                      <span className="num text-river">{n(s.diameterM, 2)} m</span>
                      <span className="text-faint">·</span>
                      <span className="num text-river">{n(s.velocityMs, 1)} m/s</span>
                      <span className="ml-auto num text-ink">−{n(s.lossM, 2)} m</span>
                    </div>
                  ))}
                  <p className="mt-1 text-[9.5px] leading-snug text-faint">
                    Sized for this duty point, not assumed: ESHA 2004 economic diameter capped at
                    5 m/s, Darcy–Weisbach with Swamee–Jain friction, Manning for the headrace. This
                    is why a longer waterway is not free.
                  </p>
                </div>
              )}
              {scheme.turbine ? (
                <div className="mt-1 text-[10px] leading-snug text-faint">
                  <b className="text-muted">{scheme.turbine}</b> selected for this duty point —
                  best point {n(scheme.turbinePeak * 100, 1)}%, times {n(assume.efficiency * 100, 0)}%
                  generator. Every day of the record is dispatched on its part-load curve, so low
                  flows are not credited with best-point efficiency.
                </div>
              ) : (
                <div className="mt-1 text-[10px] leading-snug text-amber">
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
        <div className="border-b border-line px-2 pb-1.5 pt-2.5">
          <div className="px-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
            {study.followsRiver ? 'The river, downstream from your click' : 'Terrain between the two points'}
          </div>
          <RiverProfile path={study.path} i={pick.i} j={pick.j} />
          {scheme && (
            <div className="grid grid-cols-3 gap-2 px-1.5 pt-1">
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
        <div className="border-b border-line px-3.5 py-3">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-[0.08em] text-faint">
              {alternatives.length} alternatives worth keeping
            </span>
            <span className="text-[9.5px] text-faint">of {n(found!.evaluated, 0)} tried</span>
          </div>
          <div className="space-y-1">
            {alternatives.map((s) => {
              const active = pick?.i === s.i && pick?.j === s.j;
              return (
                <button
                  key={`${s.i}-${s.j}`}
                  type="button"
                  onClick={() => onPick(s)}
                  className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left ${
                    active
                      ? 'border-river bg-[color-mix(in_srgb,var(--color-river)_10%,transparent)]'
                      : 'border-line hover:border-line-strong'
                  }`}
                >
                  <span className="num w-[46px] shrink-0 text-[13px] font-semibold">
                    {n(s.capacityMW, s.capacityMW < 10 ? 1 : 0)}
                    <span className="text-[9px] text-muted"> MW</span>
                  </span>
                  <span className="num w-[52px] shrink-0 text-[10.5px] text-muted">
                    {n(s.grossHeadM, 0)} m / {n(s.waterwayKm, 1)} km
                  </span>
                  <span className="flex-1 text-[10px] leading-tight text-faint">
                    {s.turbine ? `${s.turbine} · ` : ''}
                    {s.reasons.join(' · ')}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[9.5px] leading-snug text-faint">
            Every one of these beats all the others on at least one of energy, waterway length or
            head — none is simply worse than another. Which matters is your call.
          </p>
          <button
            type="button"
            onClick={() => onWideSearch(!wideSearch)}
            className="mt-2 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-left text-[10.5px] leading-snug text-muted hover:border-river hover:text-ink"
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
        <div className="border-b border-line px-3.5 py-2 text-[10.5px] leading-snug text-faint">
          Only one scheme here survived screening out of {n(found!.evaluated, 0)} pairs tried.
        </div>
      )}
      {found && alternatives.length === 0 && !busy && (
        <div className="border-b border-line px-3.5 py-2.5 text-[11.5px] leading-snug text-muted">
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
        <div className="border-b border-line px-3.5 py-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
            {licences.length} licensed project{licences.length > 1 ? 's' : ''} on this reach
          </div>
          <div className="space-y-1">
            {licences.slice(0, 6).map((l) => (
              <div key={l.licenceNo + l.name} className="flex items-baseline gap-2 text-[11px]">
                <span
                  className="mt-[3px] size-2 shrink-0 rounded-full"
                  style={{
                    background:
                      l.stage === 'Operation'
                        ? 'var(--color-red)'
                        : l.stage === 'Generation'
                          ? 'var(--color-amber)'
                          : 'var(--color-muted)',
                  }}
                />
                <span className="min-w-0 flex-1 leading-tight text-ink">
                  {l.name}
                  {l.capacityMW ? <span className="text-muted"> · {n(l.capacityMW, 1)} MW</span> : null}
                  <span className="block text-[9.5px] text-faint">
                    {l.stage}
                    {l.river ? ` · ${l.river}` : ''} · {n(l.distanceKm, 1)} km away
                  </span>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[9.5px] leading-snug text-faint">
            Department of Electricity Development registry.{' '}
            <span className="text-red">Operating</span> and{' '}
            <span className="text-amber">construction</span> licences are a hard constraint on this
            water; a survey licence means someone is already studying it. The public snapshot lags,
            so check the current register before relying on this.
          </p>
        </div>
      )}

      {/* ---- getting the power out ---- */}
      {grid && scheme && (
        <div className="border-b border-line px-3.5 py-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
            grid connection
          </div>
          <div className={`text-[11px] leading-snug ${verdict!.hard ? 'text-amber' : 'text-ink'}`}>
            {verdict!.text}
          </div>
          <div className="mt-1.5 space-y-0.5 text-[10px]">
            <div className="flex items-baseline gap-1.5">
              <span className="w-24 shrink-0 text-faint">nearest line</span>
              <span className="num text-river">{n(grid.nearestKm, 1)} km</span>
              <span className="text-faint">
                {grid.nearestKv ? `${grid.nearestKv} kV` : 'voltage not tagged'}
              </span>
            </div>
            {grid.adequateKm !== null && (
              <div className="flex items-baseline gap-1.5">
                <span className="w-24 shrink-0 text-faint">at {grid.requiredKv} kV+</span>
                <span className="num text-river">{n(grid.adequateKm, 1)} km</span>
                <span className="text-faint">{grid.adequateKv} kV</span>
              </div>
            )}
            {grid.nearestSub && (
              <div className="flex items-baseline gap-1.5">
                <span className="w-24 shrink-0 text-faint">substation</span>
                <span className="num text-river">{n(grid.nearestSub.km, 1)} km</span>
                <span className="min-w-0 flex-1 truncate text-faint">
                  {grid.nearestSub.name ?? 'unnamed'}
                  {grid.nearestSub.kv ? ` · ${grid.nearestSub.kv} kV` : ''}
                </span>
              </div>
            )}
          </div>
          <p className="mt-1.5 text-[9.5px] leading-snug text-faint">
            Straight-line distance from the powerhouse — a line is not built straight through this
            terrain, so treat it as a floor. {n(scheme.capacityMW, 1)} MW would typically connect at{' '}
            {grid.requiredKv} kV. OpenStreetMap, © contributors, ODbL; coverage is good on the
            transmission backbone and patchy below 66 kV, so an absent line means unmapped, not
            absent.
          </p>
        </div>
      )}

      {/* ---- Nepal's own regression, as an independent third opinion ---- */}
      {hydest && (
        <div className="border-b border-line px-3.5 py-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
            HYDEST · Nepal's national method
          </div>
          <div className="flex items-baseline gap-2 text-[11px]">
            <span className="text-muted">driest month</span>
            <span className="num font-semibold text-ink">
              {n(hydest.driest.cms, 2)} m³/s
            </span>
            <span className="text-faint">{MONTH_NAMES[hydest.driest.month]}</span>
          </div>
          {hydest.agreement && (
            <div
              className={`mt-1 text-[10px] leading-snug ${
                hydest.agreement.agree ? 'text-muted' : 'text-amber'
              }`}
            >
              {hydest.agreement.agree ? (
                <>
                  The global model gives {n(hydest.modelledCms, 2)} m³/s for the same month —{' '}
                  within {n(hydest.agreement.ratio, 1)}×. Two methods built from different data
                  agree, which is the strongest corroboration available without a gauge.
                </>
              ) : (
                <>
                  The global model gives {n(hydest.modelledCms, 2)} m³/s for the same month —{' '}
                  {n(hydest.agreement.ratio, 1)}× apart. Nepal's own regression and the flood model
                  disagree about the dry season here, and the dry season is what sets firm power.
                </>
              )}
            </div>
          )}
          <div className="mt-2 grid grid-cols-5 gap-1">
            {hydest.months.map((m) => (
              <div key={m.month} className="text-center">
                <div className="text-[9px] text-faint">{MONTH_NAMES[m.month]}</div>
                <div className="num text-[10px] text-river">{n(m.cms, 1)}</div>
              </div>
            ))}
          </div>
          {hydest.floods.length > 0 && (
            <div className="mt-2 border-t border-line pt-2">
              <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-faint">
                design flood, m³/s
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
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
          <p className="mt-1.5 text-[9.5px] leading-snug text-faint">
            WECS/DHM 1990, fitted to Nepal's own gauged records — the method a feasibility study
            would use for an ungauged site. Needs the catchment below 5000 m ({n(hydest.input.below5000Km2, 0)} of{' '}
            {n(hydest.input.totalKm2, 0)} km²) and below 3000 m ({n(hydest.input.below3000Km2, 0)} km²).
            Only Jan–May and the floods are shown: the monsoon months need rainfall data this app
            does not have yet, and a guessed monsoon flow would be worse than none.
          </p>
        </div>
      )}

      {/* ---- a real record, if the engineer has one ---- */}
      {study && (
        <div className="border-b border-line px-3.5 py-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
            {measured ? 'flow is measured, not modelled' : 'have a gauge record?'}
          </div>
          {measured ? (
            <>
              <div className="flex items-baseline gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-ink">{measured.name}</span>
                <button
                  type="button"
                  onClick={onClearMeasured}
                  className="shrink-0 text-[10px] text-faint hover:text-ink"
                >
                  remove
                </button>
              </div>
              <div className="mt-1 text-[10px] text-muted">
                {measured.series.values.length.toLocaleString()} values
                {measured.series.from ? `, ${measured.series.from} to ${measured.series.to}` : ''}
                {measured.series.cadence !== 'unknown' ? ` · ${measured.series.cadence}` : ''}
                {measured.ratio !== 1 ? ` · scaled ${n(measured.ratio, 3)}×` : ''}
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {measured.series.notes.map((note, k) => (
                  <li key={k} className="text-[9.5px] leading-snug text-faint">
                    {note}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <label className="block cursor-pointer rounded-md border border-dashed border-line px-2.5 py-2.5 text-center text-[11px] text-muted hover:border-river hover:text-ink">
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
              <p className="mt-1.5 text-[9.5px] leading-snug text-faint">
                CSV or text, one row per reading, discharge in m³/s — a date column if you have
                one. This replaces both global models outright and is the only thing that turns the
                range above into a measurement. Headers, tabs and no-data markers are handled;
                Bikram Sambat dates are detected and refused rather than approximated.
              </p>
            </>
          )}
        </div>
      )}

      {/* ---- where the real measurements are ---- */}
      {gauges && gauges.length > 0 && (
        <div className="border-b border-line px-3.5 py-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
            nearest measured record
          </div>
          <div className="space-y-1.5">
            {gauges.slice(0, 3).map((g) => (
              <div key={g.name} className="flex items-baseline gap-2 text-[11px]">
                <span
                  className="mt-[3px] size-2 shrink-0 rounded-full"
                  style={{
                    background: g.trustworthy ? 'var(--color-accent)' : 'var(--color-muted)',
                  }}
                />
                <span className="min-w-0 flex-1 leading-tight text-ink">
                  {g.name}
                  <span className="block text-[9.5px] text-faint">
                    {g.relation} · {n(g.distanceKm, 1)} km away
                    {g.uplandKm2 ? ` · ${n(g.uplandKm2, 0)} km² catchment` : ''}
                    {g.basin ? ` · ${g.basin} basin` : ''}
                  </span>
                  <span
                    className={`block text-[9.5px] ${g.measuresDischarge ? 'text-river' : 'text-faint'}`}
                  >
                    {recordKind(g)}
                  </span>
                  <span className="block text-[9.5px] text-muted">{transferAdvice(g)}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[9.5px] leading-snug text-faint">
            Flow is the largest error in this estimate and a gauged record is the only thing that
            shrinks it. DHM runs {RIVER_GAUGE_COUNT} river stations, {DISCHARGE_GAUGE_COUNT} of them
            recording discharge rather than water level alone. The readings are not public — the API
            requires a key, and refuses DHM's own portal too — so request the record for the station
            above and scale it by catchment area, which is what a feasibility study would do with it.
          </p>
        </div>
      )}

      {/* ---- flow ---- */}
      {flow && fdc.length > 0 && (
        <div className="border-b border-line px-2 pb-2 pt-2.5">
          <div className="px-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
            Flow at your click — m³/s vs % of time exceeded
          </div>
          <Fdc
            fdc={fdc}
            designCms={scheme?.designFlowCms ?? 0}
            residualCms={scheme?.residualCms ?? 0}
          />
          <div className="grid grid-cols-3 gap-2 px-1.5">
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
            <div className="mt-2 grid grid-cols-2 gap-2 px-1.5">
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
        <div className="space-y-2.5 border-b border-line px-3.5 py-3">
          <div className="text-[10px] uppercase tracking-[0.08em] text-faint">Assumptions</div>
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
            <span className="text-[11px] text-muted">Household use, kWh/yr</span>
            <input
              type="number"
              value={assume.householdKwh}
              min={100}
              step={50}
              onChange={(e) => set('householdKwh', Math.max(1, Number(e.target.value) || 1))}
              className="num w-20 rounded border border-line bg-panel-2 px-1.5 py-0.5 text-right text-[11.5px] text-ink"
            />
          </label>
        </div>
      )}

      {/* ---- evidence ---- */}
      {flow && (
        <div className="border-b border-line px-3.5 py-2.5 text-[10.5px] leading-relaxed text-faint">
          <div className="mb-1 text-[10px] uppercase tracking-[0.08em]">Where this comes from</div>
          <div>
            <b className="text-muted">Flow</b> — GloFAS v4 reanalysis, {n(years, 0)} years,{' '}
            {flow.from === 'network' ? 'fetched now' : flow.from === 'cache' ? 'from cache' : 'stale cache'}
            . Modelled, not gauged. Rescaled along the river by catchment.
          </div>
          <div className="mt-0.5">
            <b className="text-muted">Model cell</b> — {n(
              at ? Math.hypot((flow.cell.lat - at.lat) * 111.32, (flow.cell.lon - at.lon) * 111.32 * Math.cos((at.lat * Math.PI) / 180)) : 0,
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
                className="text-river underline underline-offset-2 hover:text-ink"
              >
                check neighbouring cells
              </button>
            )}
          </div>
          {study && (
            <div className="mt-0.5">
              <b className="text-muted">Terrain</b> — {study.dem.source}, zoom {study.dem.zoom},{' '}
              {n(study.dem.resolutionM, 0)} m sample spacing, {study.dem.tilesFetched} tiles. Global
              DEMs carry roughly ±10–16 m of vertical error in steep ground.
            </div>
          )}
          {study?.reach && (
            <div className="mt-0.5">
              <b className="text-muted">River</b> — {n(study.reach.uplandKm2, 0)} km² upstream
              (HydroRIVERS), whose own long-term mean here is {n(study.reach.meanDischargeCms, 1)}{' '}
              m³/s against GloFAS&apos;s {n(meanCms, 1)}.
              {study.followsRiver && ` Walked ${n(study.path[study.path.length - 1].km, 1)} km downstream.`}
            </div>
          )}
        </div>
      )}

      {canExport && (
        <div className="border-b border-line px-3.5 py-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
            Take it with you
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onExport('csv')}
              className="flex-1 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[11.5px] text-ink hover:border-river hover:text-river"
            >
              CSV — the numbers
            </button>
            <button
              type="button"
              onClick={() => onExport('geojson')}
              className="flex-1 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[11.5px] text-ink hover:border-river hover:text-river"
            >
              GeoJSON — for QGIS
            </button>
          </div>
          <p className="mt-1.5 text-[9.5px] leading-snug text-faint">
            Every alternative, plus a header naming each source, assumption and limitation — so the
            file still explains itself when nobody remembers where it came from. The link in your
            address bar reopens this exact study.
          </p>
        </div>
      )}

      <div className="mt-auto border-l-2 border-amber bg-[color-mix(in_srgb,var(--color-amber)_7%,transparent)] px-3.5 py-2 text-[10.5px] leading-snug text-muted">
        <b className="text-amber">Screening only.</b> These compare options and tell you what to
        survey next — they are not a feasibility study, and no waterway has been routed or costed.
      </div>
    </aside>
  );
}
