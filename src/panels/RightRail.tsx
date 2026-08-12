import { lazy, Suspense, type ReactNode } from 'react';
import { useStore, type RailTab } from '../state/store.ts';
import { traced, type Scheme } from '../types.ts';
import { nearestStations } from '../map/rivers.ts';

// ECharts is ~190 KB gz and only needed once a site is selected — keep it out
// of the initial bundle.
const FdcChart = lazy(() => import('../charts/charts.tsx').then((m) => ({ default: m.FdcChart })));
const MonthlyChart = lazy(() =>
  import('../charts/charts.tsx').then((m) => ({ default: m.MonthlyChart }))
);
const ParetoChart = lazy(() =>
  import('../charts/charts.tsx').then((m) => ({ default: m.ParetoChart }))
);

function ChartSlot({ height, children }: { height: number; children: ReactNode }) {
  return (
    <Suspense fallback={<div style={{ height }} className="animate-pulse rounded bg-panel-2" />}>
      {children}
    </Suspense>
  );
}
import {
  fmt,
  QualityChip,
  SampleBanner,
  ScreeningNotice,
  Section,
  Stat,
  Tag,
  TracedValue,
} from '../ui/primitives.tsx';
import { NEPAL } from '../engine/hydro.ts';

const TABS: { key: RailTab; label: string }[] = [
  { key: 'site', label: 'Site' },
  { key: 'hydrology', label: 'Hydrology' },
  { key: 'schemes', label: 'Schemes' },
  { key: 'compare', label: 'Compare' },
];

const JUMPS: { name: string; lon: number; lat: number; zoom: number }[] = [
  { name: 'Kabeli (Panchthar)', lon: 87.77, lat: 27.2, zoom: 11 },
  { name: 'Nyadi (Lamjung)', lon: 84.42, lat: 28.36, zoom: 11.5 },
  { name: 'Tamakoshi (Lamabagar)', lon: 86.27, lat: 27.9, zoom: 11 },
  { name: 'Chilime (Rasuwa)', lon: 85.3, lat: 28.13, zoom: 11.5 },
  { name: 'Karnali (Chisapani)', lon: 81.29, lat: 28.64, zoom: 10.5 },
];

export function RightRail() {
  const site = useStore((s) => s.site);
  const railTab = useStore((s) => s.railTab);
  const setRailTab = useStore((s) => s.setRailTab);

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-line bg-panel">
      {site ? (
        <>
          <header className="border-b border-line px-3.5 pb-2.5 pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[15px] font-semibold tracking-tight">
                {site.usedMainStem ? 'Main stem reach' : 'River reach'}
              </h2>
              <span className="num text-[10.5px] text-faint">
                {site.lat.toFixed(4)}°N {site.lon.toFixed(4)}°E
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted">
              HydroRIVERS · Strahler {site.reach.strahler} ·{' '}
              {fmt(site.reach.distanceKm, 2)} km from mapped centreline
            </div>
          </header>
          <nav className="flex border-b border-line">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setRailTab(t.key)}
                className={`flex-1 border-b-2 px-1 py-2 text-[11.5px] font-medium ${
                  railTab === t.key
                    ? 'border-river text-ink'
                    : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {railTab === 'site' && <SiteTab />}
            {railTab === 'hydrology' && <HydrologyTab />}
            {railTab === 'schemes' && <SchemesTab />}
            {railTab === 'compare' && <CompareTab />}
          </div>
        </>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

function EmptyState() {
  const requestFly = useStore((s) => s.requestFly);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-5">
        <h2 className="text-[15px] font-semibold tracking-tight">Start from a river</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
          Click any river on the map. The workbench resolves the mapped reach, its catchment and
          long-term flow, then drafts comparable scheme alternatives to study.
        </p>
        <div className="mt-4">
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            Jump to a valley
          </div>
          <div className="flex flex-wrap gap-1.5">
            {JUMPS.map((j) => (
              <button
                key={j.name}
                type="button"
                onClick={() => requestFly({ lon: j.lon, lat: j.lat, zoom: j.zoom })}
                className="rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted hover:border-river hover:text-river"
              >
                {j.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="mt-3 text-[11.5px] text-faint hover:text-river"
          >
            or press <kbd className="rounded border border-line bg-panel-2 px-1 py-px text-[10px]">Ctrl K</kbd>{' '}
            to search
          </button>
        </div>
        <div className="mt-5 rounded-lg border border-line bg-panel-2 p-3 text-[11.5px] leading-relaxed text-muted">
          <div className="mb-1 font-semibold text-ink">What this build shows</div>
          The workbench UI with real Nepal data on the map — HydroRIVERS network, DHM stations,
          terrain. Scheme numbers are <span className="text-amber">sample-labelled</span> until the
          discovery and hydrology engines land (plan.md M1–M3).
        </div>
      </div>
      <ScreeningNotice />
    </div>
  );
}

function SiteTab() {
  const site = useStore((s) => s.site)!;
  const useMainStem = useStore((s) => s.useMainStem);
  const stations = nearestStations(site.lat, site.lon, 4);
  const r = site.reach;

  return (
    <>
      <Section title="Reach — HydroRIVERS v1.0">
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <Stat label="Upstream catchment">
            <TracedValue
              t={traced(r.uplandKm2, 'modelled', 'HydroRIVERS upstream area at this reach', {
                unit: 'km²',
                source: 'HydroSHEDS/HydroRIVERS v1.0 (validated ±7% vs 5 published Nepali catchments)',
              })}
              digits={0}
            />
          </Stat>
          <Stat label="Long-term mean flow">
            <TracedValue
              t={traced(r.meanDischargeCms, 'modelled', 'HydroRIVERS long-term mean discharge', {
                unit: 'm³/s',
                source: 'WaterGAP v2.2 via HydroRIVERS',
              })}
              digits={r.meanDischargeCms < 10 ? 2 : 1}
            />
          </Stat>
          <Stat label="Strahler order">
            <span className="num">{r.strahler}</span>
          </Stat>
          <Stat label="Snap distance">
            <span className="num">{fmt(r.distanceKm, 2)} km</span>
          </Stat>
        </div>
        {site.mainStem && (
          <button
            type="button"
            onClick={useMainStem}
            className="mt-3 w-full rounded-md border border-amber/40 bg-[color-mix(in_srgb,var(--color-amber)_8%,transparent)] px-2.5 py-2 text-left text-[11.5px] leading-snug text-ink hover:border-amber"
          >
            {site.usedMainStem ? (
              <>↩ Back to the clicked tributary ({fmt(site.mainStem.uplandKm2, 0)} km² main stem in use)</>
            ) : (
              <>
                <span className="font-semibold text-amber">Larger channel nearby.</span> The{' '}
                {fmt(site.mainStem.uplandKm2, 0)} km² main stem passes{' '}
                {fmt(site.mainStem.distanceKm, 1)} km away — use it instead?
              </>
            )}
          </button>
        )}
      </Section>

      <Section title="Nearby DHM stations" right={<Tag>real catalog</Tag>}>
        <table className="w-full text-[11.5px]">
          <tbody>
            {stations.map((st) => (
              <tr key={st.n} className="border-b border-line/60 last:border-0">
                <td className="py-1 pr-2 leading-tight">{st.n}</td>
                <td className="py-1 pr-2 text-right">
                  <Tag tone={st.r === 1 ? 'river' : 'muted'}>{st.r === 1 ? 'gauge' : 'met'}</Tag>
                </td>
                <td className="num py-1 text-right text-muted">{fmt(st.km, 1)} km</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1.5 text-[10.5px] leading-snug text-faint">
          Period-of-record and licensed projects nearby land in M1 (DoED + rmsdoed snapshots).
        </p>
      </Section>

      <Section title="Context">
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <Stat label="Households equivalent">
            <span className="num">
              {fmt((useStore.getState().analysis?.schemes[1]?.energyGwh.value ?? 0) * 1e6 / NEPAL.householdKwhPerYear / 1e3, 0)}k
            </span>
            <span className="ml-1 text-[10.5px] text-faint">@ {NEPAL.householdKwhPerYear} kWh/yr</span>
          </Stat>
          <Stat label="vs national hydro">
            <span className="num">
              {fmt(((useStore.getState().analysis?.schemes[1]?.energyGwh.value ?? 0) / NEPAL.annualHydroGwh) * 100, 2)}%
            </span>
          </Stat>
        </div>
        <p className="mt-1.5 text-[10.5px] leading-snug text-faint">
          Based on the balanced sample scheme; NEA FY2024/25 figures.
        </p>
      </Section>
      <ScreeningNotice />
    </>
  );
}

function HydrologyTab() {
  const analysis = useStore((s) => s.analysis)!;
  const site = useStore((s) => s.site)!;

  const evidence: { name: string; quality: Parameters<typeof QualityChip>[0]['q']; note: string; live: boolean }[] = [
    {
      name: 'HydroRIVERS long-term mean',
      quality: 'modelled',
      note: `${fmt(site.reach.meanDischargeCms, 1)} m³/s at this reach — anchors the sample series`,
      live: true,
    },
    {
      name: 'Sample monsoon series',
      quality: 'sample',
      note: '3 synthetic years shaped like a Nepali regime, scaled to the reach mean',
      live: true,
    },
    { name: 'GloFAS daily reanalysis', quality: 'modelled', note: '29 years, wired in M1', live: false },
    { name: 'WECS/HYDEST + MHSP regressions', quality: 'estimated', note: 'coefficients recovered — lands in M1', live: false },
    { name: 'Catchment transfer from DHM gauge', quality: 'estimated', note: 'needs station records (import or M1)', live: false },
    { name: 'Your measured series (CSV)', quality: 'measured', note: 'import lands in M6', live: false },
  ];

  return (
    <>
      <SampleBanner />
      <Section title="Evidence stack — never one number">
        <div className="space-y-1.5">
          {evidence.map((e) => (
            <div
              key={e.name}
              className={`flex items-start justify-between gap-2 rounded-md border px-2.5 py-1.5 ${
                e.live ? 'border-line bg-panel-2' : 'border-line/50 opacity-55'
              }`}
            >
              <div>
                <div className="text-[12px] leading-tight">{e.name}</div>
                <div className="mt-0.5 text-[10.5px] leading-snug text-faint">{e.note}</div>
              </div>
              <QualityChip q={e.quality} />
            </div>
          ))}
        </div>
      </Section>
      <Section title="Flow-duration curve">
        <ChartSlot height={190}>
          <FdcChart
            fdc={analysis.fdc}
            designFlowCms={analysis.schemes[1]?.designFlowCms.value}
            residualCms={analysis.residualCms}
          />
        </ChartSlot>
      </Section>
      <Section title="Monthly regime · NEA seasons">
        <ChartSlot height={150}>
          <MonthlyChart monthlyMeans={analysis.monthlyMeans} />
        </ChartSlot>
        <p className="mt-1 text-[10.5px] leading-snug text-faint">
          <span className="text-river">Wet</span> mid-Apr → mid-Dec ·{' '}
          <span className="text-amber">dry</span> mid-Dec → mid-Apr. Residual flow{' '}
          {fmt(analysis.residualCms, 2)} m³/s = 10% of minimum monthly mean (Nepal licensing basis).
        </p>
      </Section>
      <ScreeningNotice />
    </>
  );
}

function SchemesTab() {
  const analysis = useStore((s) => s.analysis)!;
  const selectedSchemeId = useStore((s) => s.selectedSchemeId);
  const selectScheme = useStore((s) => s.selectScheme);

  return (
    <>
      <SampleBanner>
        Three hand-specified families stand in for the discovery engine (M2), which will search
        intake × waterway × powerhouse combinations and keep the Pareto set. Numbers run through
        the validated kernel.
      </SampleBanner>
      <div className="space-y-2 px-3.5 py-3">
        {analysis.schemes.map((s) => (
          <SchemeCard
            key={s.id}
            scheme={s}
            selected={s.id === selectedSchemeId}
            onSelect={() => selectScheme(s.id === selectedSchemeId ? null : s.id)}
          />
        ))}
      </div>
      <ScreeningNotice />
    </>
  );
}

const FAMILY_TONE: Record<Scheme['family'], string> = {
  canal: 'var(--color-green)',
  tunnel: 'var(--color-purple)',
  'high-head': 'var(--color-red)',
};

function SchemeCard({
  scheme,
  selected,
  onSelect,
}: {
  scheme: Scheme;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`rounded-lg border bg-panel-2 transition-colors ${
        selected ? 'border-river' : 'border-line hover:border-line-strong'
      }`}
    >
      <button type="button" onClick={onSelect} className="w-full px-3 pb-1 pt-2.5 text-left">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ background: FAMILY_TONE[scheme.family] }}
            />
            <span className="text-[12.5px] font-semibold">{scheme.id}</span>
            <span className="text-[12px] text-muted">{scheme.name}</span>
          </div>
          <span className="num text-[14px] font-semibold">
            {fmt(scheme.capacityMW.value, scheme.capacityMW.value < 10 ? 1 : 0)}
            <span className="text-[10.5px] text-muted"> MW</span>
          </span>
        </div>
      </button>
      <div className="grid grid-cols-3 gap-x-2 gap-y-2 px-3 pb-2.5 pt-1">
        <Stat label="Energy">
          <TracedValue t={scheme.energyGwh} digits={1} />
        </Stat>
        <Stat label="Dry season">
          <TracedValue t={scheme.dryGwh} digits={1} />
        </Stat>
        <Stat label="Plant factor">
          <span className="num">{fmt(scheme.plantFactor.value * 100, 0)}%</span>
        </Stat>
        <Stat label="Gross head">
          <TracedValue t={scheme.grossHeadM} digits={0} />
        </Stat>
        <Stat label="Design flow">
          <TracedValue t={scheme.designFlowCms} digits={1} />
        </Stat>
        <Stat label="Waterway">
          <TracedValue t={scheme.waterwayM} digits={0} />
        </Stat>
        <Stat label="CAPEX">
          <TracedValue t={scheme.capexMnNpr} digits={0} />
        </Stat>
        <Stat label="Specific">
          <TracedValue t={scheme.specificUsdPerKw} digits={0} />
        </Stat>
        <Stat label="Payback">
          <TracedValue t={scheme.paybackYears} digits={1} />
        </Stat>
      </div>
      {scheme.flags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {scheme.flags.map((f) => (
            <Tag key={f} tone="amber">
              {f}
            </Tag>
          ))}
        </div>
      )}
      {selected && (
        <div className="border-t border-line px-3 py-2 text-[11.5px] leading-relaxed text-muted">
          {scheme.whySurvives}
          <div className="mt-1 text-[10.5px] text-faint">
            Longitudinal profile opens below the map.
          </div>
        </div>
      )}
    </div>
  );
}

function CompareTab() {
  const analysis = useStore((s) => s.analysis)!;
  const selectedSchemeId = useStore((s) => s.selectedSchemeId);
  const selectScheme = useStore((s) => s.selectScheme);

  return (
    <>
      <SampleBanner>
        With real discovery this becomes a Pareto front over energy, cost, tunnel length, hazard
        exposure and grid distance — dozens of non-dominated alternatives, not three.
      </SampleBanner>
      <Section title="Energy vs cost">
        <ChartSlot height={240}>
          <ParetoChart
            schemes={analysis.schemes}
            selectedId={selectedSchemeId}
            onSelect={(id) => selectScheme(id)}
          />
        </ChartSlot>
      </Section>
      <Section title="Side by side">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[340px] text-[11.5px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-faint">
                <th className="py-1 pr-2 font-medium">Metric</th>
                {analysis.schemes.map((s) => (
                  <th key={s.id} className="num py-1 pr-2 text-right font-medium">
                    {s.id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Capacity, MW', (s: Scheme) => fmt(s.capacityMW.value, 1)],
                  ['Energy, GWh/yr', (s: Scheme) => fmt(s.energyGwh.value, 1)],
                  ['Dry GWh', (s: Scheme) => fmt(s.dryGwh.value, 1)],
                  ['Head, m', (s: Scheme) => fmt(s.grossHeadM.value, 0)],
                  ['Design Q, m³/s', (s: Scheme) => fmt(s.designFlowCms.value, 1)],
                  ['Waterway, km', (s: Scheme) => fmt(s.waterwayM.value / 1000, 1)],
                  ['CAPEX, Mn NPR', (s: Scheme) => fmt(s.capexMnNpr.value, 0)],
                  ['USD/kW', (s: Scheme) => fmt(s.specificUsdPerKw.value, 0)],
                  ['Payback, yr', (s: Scheme) => fmt(s.paybackYears.value, 1)],
                ] as const
              ).map(([label, get]) => (
                <tr key={label} className="border-t border-line/60">
                  <td className="py-1 pr-2 text-muted">{label}</td>
                  {analysis.schemes.map((s) => (
                    <td
                      key={s.id}
                      className={`num py-1 pr-2 text-right ${s.id === selectedSchemeId ? 'text-river' : ''}`}
                    >
                      {get(s)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <ScreeningNotice />
    </>
  );
}
