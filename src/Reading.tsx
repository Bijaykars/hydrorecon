import type { DischargeSeries, ElevationProfile } from './api.ts';
import type { Reach } from './rivers.ts';
import type { Assumptions, Pt } from './App.tsx';
import { Fdc, Profile } from './charts.tsx';
import type { EnergyResult, FdcPoint } from './engine/hydro.ts';

export type Result = {
  fdc: FdcPoint[];
  minMonth: number;
  residualCms: number;
  designFlowCms: number;
  grossHeadM: number;
  netHeadM: number;
  energy: EnergyResult;
  seasons: { wetGwh: number; dryGwh: number; wetDays: number; dryDays: number };
  meanCms: number;
  years: number;
  cellKm: number;
};

const n = (v: number, d = 1) =>
  !Number.isFinite(v)
    ? '—'
    : Math.abs(v) >= 1000
      ? Math.round(v).toLocaleString('en-US')
      : v.toLocaleString('en-US', { maximumFractionDigits: d });

/** A value with its provenance stated underneath, always visible — no hunting. */
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
  intake: Pt | null;
  power: Pt | null;
  reach: Reach | null;
  bigger: Reach | null;
  onUseBigger: () => void;
  flow: DischargeSeries | null;
  profile: ElevationProfile | null;
  result: Result | null;
  assume: Assumptions;
  setAssume: (a: Assumptions) => void;
  busy: 'flow' | 'terrain' | 'probe' | null;
  error: string | null;
  swapped: boolean;
  neighbours: { lat: number; lon: number; meanCms: number }[] | null;
  onProbe: () => void;
  onReset: () => void;
}) {
  const {
    intake,
    power,
    reach,
    bigger,
    onUseBigger,
    flow,
    profile,
    result,
    assume,
    setAssume,
    busy,
    error,
    swapped,
    neighbours,
    onProbe,
    onReset,
  } = props;

  // A second, independent estimate of the same quantity. HydroRIVERS models
  // long-term mean flow per reach; GloFAS models it on a ~5 km grid. When they
  // disagree by a lot, the grid cell is almost certainly on a different channel.
  const rivalCms = reach?.meanDischargeCms;
  const disagreement =
    result && rivalCms && rivalCms > 0 && result.meanCms > 0
      ? Math.max(rivalCms / result.meanCms, result.meanCms / rivalCms)
      : null;

  const set = <K extends keyof Assumptions>(k: K, v: Assumptions[K]) =>
    setAssume({ ...assume, [k]: v });

  const complete = Boolean(intake && power && result && profile);
  const headBad = complete && result!.grossHeadM <= 0;

  return (
    <aside
      className="z-10 flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-line bg-panel lg:absolute lg:right-3 lg:top-3 lg:max-h-[calc(100%-1.5rem)] lg:w-[352px] lg:flex-none lg:rounded-xl lg:border lg:shadow-[0_16px_50px_rgba(0,0,0,0.5)]"
    >
      {/* ---- step / status ---- */}
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          {!intake ? 'Place an intake' : !power ? 'Place a powerhouse' : 'Result'}
        </span>
        {busy && (
          <span className="text-[10.5px] text-river">
            {busy === 'flow' ? 'reading flow…' : busy === 'terrain' ? 'reading terrain…' : 'probing…'}
          </span>
        )}
        {intake && (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto text-[10.5px] text-faint hover:text-ink"
          >
            clear
          </button>
        )}
      </div>

      {/* ---- guidance ---- */}
      {!intake && (
        <div className="px-3.5 py-3 text-[12px] leading-relaxed text-muted">
          Click a river anywhere in the world to place the <b className="text-river">intake</b>, then
          click downstream to place the <b className="text-green">powerhouse</b>.
          <div className="mt-2 text-[11px] text-faint">
            Flow comes from the GloFAS reanalysis, head from terrain tiles. Both markers drag.
          </div>
        </div>
      )}
      {intake && !power && !error && (
        <div className="border-b border-line px-3.5 py-2 text-[11.5px] leading-snug text-muted">
          Now click <b className="text-green">downstream</b> — the further and steeper, the more head.
        </div>
      )}

      {swapped && (
        <div className="border-b border-line px-3.5 py-2 text-[11px] leading-snug text-muted">
          Swapped the two points — the terrain says the other one is higher, and the intake is
          always the upper end.
        </div>
      )}

      {disagreement && disagreement > 2 && (
        <div className="border-b border-line bg-[color-mix(in_srgb,var(--color-amber)_7%,transparent)] px-3.5 py-2 text-[11px] leading-snug text-muted">
          <b className="text-amber">Two models disagree {n(disagreement, 1)}×</b> about the flow
          here: GloFAS says {n(result!.meanCms, 1)} m³/s, HydroRIVERS says {n(rivalCms!, 1)} m³/s for
          this reach. The grid cell is likely on a different channel — move the intake, or check the
          neighbouring cells below.
        </div>
      )}

      {error && (
        <div className="border-b border-line bg-[color-mix(in_srgb,var(--color-red)_8%,transparent)] px-3.5 py-2 text-[11px] leading-snug text-muted">
          <b className="text-red">{error}</b>
        </div>
      )}

      {bigger && (
        <button
          type="button"
          onClick={onUseBigger}
          className="mx-3.5 mt-2.5 rounded-md border border-amber/40 bg-[color-mix(in_srgb,var(--color-amber)_8%,transparent)] px-2.5 py-2 text-left text-[11px] leading-snug text-ink hover:border-amber"
        >
          <b className="text-amber">Bigger channel {n(bigger.distanceKm, 1)} km away</b> —{' '}
          {n(bigger.uplandKm2, 0)} km² against {n(reach?.uplandKm2 ?? 0, 0)} km² here. Use it?
        </button>
      )}

      {/* ---- the answer ---- */}
      {complete && !headBad && (
        <div className="border-b border-line px-3.5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="num text-[34px] font-semibold leading-none tracking-tight">
              {n(result!.energy.ratedPowerW / 1e6, result!.energy.ratedPowerW < 1e7 ? 2 : 1)}
            </span>
            <span className="text-[15px] text-muted">MW</span>
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="num text-[19px] font-semibold leading-none">
              {n(result!.energy.gwhPerYear, 1)}
            </span>
            <span className="text-[12px] text-muted">GWh per year</span>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
            About{' '}
            <b className="text-ink">
              {n((result!.energy.gwhPerYear * 1e6) / assume.householdKwh, 0)}
            </b>{' '}
            households, and it would run at{' '}
            <b className="text-ink">{n(result!.energy.grossPlantFactor * 100, 0)}%</b> of nameplate
            on hydrology alone — before any outage.
          </p>

          {/* the physics, visible */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md bg-panel-2 px-2.5 py-2 text-[11px]">
            <span className="num text-river">{n(result!.designFlowCms, 2)} m³/s</span>
            <span className="text-faint">×</span>
            <span className="num text-river">{n(result!.netHeadM, 0)} m</span>
            <span className="text-faint">×</span>
            <span className="num text-river">{n(assume.efficiency * 100, 0)}%</span>
            <span className="text-faint">× ρg →</span>
            <span className="num font-semibold text-ink">
              {n(result!.energy.ratedPowerW / 1e6, 2)} MW
            </span>
          </div>
          <div className="mt-1 text-[9.5px] text-faint">
            Rated power at design flow. Annual energy dispatches every day of the record through the
            same equation.
          </div>
        </div>
      )}

      {headBad && (
        <div className="border-b border-line bg-[color-mix(in_srgb,var(--color-red)_8%,transparent)] px-3.5 py-2.5 text-[11.5px] leading-snug text-muted">
          <b className="text-red">The powerhouse is uphill of the intake</b> — terrain says{' '}
          {n(result!.grossHeadM, 0)} m. Drag it downstream, to lower ground.
        </div>
      )}

      {/* ---- terrain ---- */}
      {complete && profile && (
        <div className="border-b border-line px-2 pb-1.5 pt-2.5">
          <Profile points={profile.points} />
          <div className="grid grid-cols-3 gap-2 px-1.5 pt-1">
            <Fact
              label="Gross head"
              value={n(result!.grossHeadM, 0)}
              unit="m"
              from={`${profile.source}, ~${n(profile.resolutionM, 0)} m grid`}
            />
            <Fact
              label="Net head"
              value={n(result!.netHeadM, 0)}
              unit="m"
              from={`less ${n(assume.headLossFrac * 100, 0)}% losses`}
            />
            <Fact
              label="Distance"
              value={n(profile.points[profile.points.length - 1].distanceKm, 2)}
              unit="km"
              from="straight line intake→powerhouse"
            />
          </div>
        </div>
      )}

      {/* ---- flow ---- */}
      {result && flow && (
        <div className="border-b border-line px-2 pb-2 pt-2.5">
          <div className="px-1.5 text-[10px] uppercase tracking-[0.08em] text-faint">
            Flow at the intake — m³/s vs % of time exceeded
          </div>
          <Fdc
            fdc={result.fdc}
            designCms={result.designFlowCms}
            residualCms={result.residualCms}
          />
          <div className="grid grid-cols-3 gap-2 px-1.5">
            <Fact
              label="Mean"
              value={n(result.meanCms, 2)}
              unit="m³/s"
              from={`${n(result.years, 0)} yr GloFAS record`}
            />
            <Fact
              label={`Design Q${Math.round(assume.exceedance * 100)}`}
              value={n(result.designFlowCms, 2)}
              unit="m³/s"
              from="after residual flow"
              tone="good"
            />
            <Fact
              label="Residual"
              value={n(result.residualCms, 2)}
              unit="m³/s"
              from={`${n(assume.residualFrac * 100, 0)}% of driest month`}
              tone="warn"
            />
          </div>
          {complete && (
            <div className="mt-2 grid grid-cols-2 gap-2 px-1.5">
              <Fact
                label="Wet half-year"
                value={n(result.seasons.wetGwh, 1)}
                unit="GWh"
                from="mid-Apr → mid-Dec"
              />
              <Fact
                label="Dry half-year"
                value={n(result.seasons.dryGwh, 1)}
                unit="GWh"
                from="mid-Dec → mid-Apr, the hard months"
              />
            </div>
          )}
        </div>
      )}

      {/* ---- assumptions ---- */}
      {result && (
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
            label="Overall efficiency"
            value={assume.efficiency}
            min={0.6}
            max={0.93}
            step={0.01}
            display={`${Math.round(assume.efficiency * 100)}%`}
            onChange={(v) => set('efficiency', v)}
          />
          <Slider
            label="Head loss"
            value={assume.headLossFrac}
            min={0}
            max={0.2}
            step={0.005}
            display={`${(assume.headLossFrac * 100).toFixed(1)}%`}
            onChange={(v) => set('headLossFrac', v)}
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
      {result && flow && (
        <div className="border-b border-line px-3.5 py-2.5 text-[10.5px] leading-relaxed text-faint">
          <div className="mb-1 text-[10px] uppercase tracking-[0.08em]">Where this comes from</div>
          <div>
            <b className="text-muted">Flow</b> — GloFAS v4 reanalysis, {n(result.years, 0)} years,{' '}
            {flow.from === 'network' ? 'fetched now' : flow.from === 'cache' ? 'from cache' : 'stale cache (rate-limited)'}. Modelled, not gauged.
          </div>
          <div className="mt-0.5">
            <b className="text-muted">Model cell</b> — {n(result.cellKm, 1)} km from your intake.
            {result.cellKm > 2 && ' That is far enough to be a different channel.'}{' '}
            {neighbours ? (
              <span className="text-muted">
                Neighbours: {neighbours.slice(0, 3).map((x) => `${n(x.meanCms, 1)}`).join(' · ')} m³/s
                mean{' '}
                {neighbours[0] && neighbours[0].meanCms > result.meanCms * 3
                  ? '— a much larger channel sits next door; move the intake onto it.'
                  : '— this cell is the local maximum.'}
              </span>
            ) : (
              <button
                type="button"
                onClick={onProbe}
                disabled={busy === 'probe'}
                className="text-river underline underline-offset-2 hover:text-ink disabled:opacity-50"
              >
                check neighbouring cells
              </button>
            )}
          </div>
          {profile && (
            <div className="mt-0.5">
              <b className="text-muted">Terrain</b> — {profile.source}, zoom {profile.zoom},{' '}
              {n(profile.resolutionM, 0)} m sample spacing, {profile.tilesFetched} tiles. Global DEMs
              carry roughly ±10–16 m vertical error in steep ground.
            </div>
          )}
          {reach && (
            <div className="mt-0.5">
              <b className="text-muted">Catchment</b> — {n(reach.uplandKm2, 0)} km² upstream
              {reach.distanceKm < 0.05
                ? ' right here'
                : ` on the mapped centreline ${n(reach.distanceKm, 2)} km away`}{' '}
              (HydroRIVERS), whose own long-term mean there is {n(reach.meanDischargeCms, 1)} m³/s
              against GloFAS&apos;s {n(result.meanCms, 1)}.
            </div>
          )}
        </div>
      )}

      <div className="mt-auto border-l-2 border-amber bg-[color-mix(in_srgb,var(--color-amber)_7%,transparent)] px-3.5 py-2 text-[10.5px] leading-snug text-muted">
        <b className="text-amber">Screening only.</b> Enough to rank ideas and decide what to survey
        — not a feasibility study, and not a basis for investment.
      </div>
    </aside>
  );
}
