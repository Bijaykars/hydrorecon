import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import {
  BENCHMARK,
  DEFAULT_HOUSEHOLD_KWH,
  HOURS_PER_YEAR,
  NEPAL,
  RHO,
  G,
  annualEnergy,
  buildFdc,
  flowAtExceedance,
  mean,
  minMonthlyMean,
  netHead,
  powerW,
  residualForBasis,
  seasonalRatio,
  turbineFlow,
  wetDryEnergy,
  type ResidualBasis,
  type FdcPoint,
  type PlantParams,
} from './hydro.ts';
import {
  GLOFAS_END,
  GLOFAS_START,
  fetchElevationProfile,
  fetchGlofas,
  fetchLiveReading,
  fetchNearbyGauges,
  fetchNearbyInfrastructure,
  fetchPrecip,
  fetchSeismicity,
  fetchNepalProjects,
  nearestReach,
  scanNepalCandidates,
  scanGlofasCandidates,
  type ReachHit,
  type SeismicSummary,
  fetchUsgsDaily,
  isInNepal,
  nearbyDhmStations,
  projectsNear,
  type NepalProject,
  type Candidate,
  type ScanResult,
  type DischargeSeries,
  type ElevationProfile,
  type Gauge,
  type LiveReading,
  type OsmFeature,
  type PrecipSummary,
  type ProfilePoint,
} from './api.ts';
import { drawFdc, drawMonthly, drawProfile } from './charts.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EXCEEDANCES = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

type Pt = { lat: number; lon: number };

/**
 * Jump targets. Navigation only — nothing is hidden by region, and regional
 * defaults are picked from where you click, not from a menu choice.
 */
const PLACES: { label: string; lat: number; lon: number; zoom: number }[] = [
  { label: 'Nepal — Trishuli valley', lat: 27.92, lon: 85.15, zoom: 11 },
  { label: 'Nepal — Karnali basin', lat: 28.65, lon: 81.62, zoom: 10 },
  { label: 'Nepal — Koshi basin', lat: 27.2, lon: 87.15, zoom: 10 },
  { label: 'United States — Potomac', lat: 38.94, lon: -77.12, zoom: 11 },
  { label: 'Switzerland — Alpine Rhône', lat: 46.25, lon: 7.65, zoom: 10 },
  { label: 'Norway — western fjords', lat: 61.2, lon: 7.1, zoom: 9 },
];

/**
 * `#zoom/lat/lon` in the URL, so a view can be shared or bookmarked.
 * Read and written by hand rather than via MapLibre's `hash: true`, because
 * StrictMode's double-mount lets the second map instance overwrite the incoming
 * hash with its own default centre before the first one's value is ever used.
 */
function readHashView(): { zoom: number; lat: number; lon: number } {
  const m = /^#(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(location.hash);
  if (!m) return { zoom: 7, lat: 27.9, lon: 85.3 };
  return { zoom: Number(m[1]), lat: Number(m[2]), lon: Number(m[3]) };
}

/** Snap a click to the river line the user can actually see on the basemap. */
function snapToVisibleRiver(
  map: maplibregl.Map,
  point: { x: number; y: number },
  tolerancePx = 16
): Pt | null {
  if (!map.getLayer('waterway')) return null;
  const features = map.queryRenderedFeatures(
    [
      [point.x - tolerancePx, point.y - tolerancePx],
      [point.x + tolerancePx, point.y + tolerancePx],
    ],
    { layers: ['waterway'] }
  );
  let bestX = 0;
  let bestY = 0;
  let bestD2 = Infinity;
  const considerLine = (line: number[][]) => {
    for (let i = 1; i < line.length; i++) {
      const a = map.project([line[i - 1][0], line[i - 1][1]]);
      const b = map.project([line[i][0], line[i][1]]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const denom = dx * dx + dy * dy;
      const t = denom === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denom));
      const x = a.x + t * dx;
      const y = a.y + t * dy;
      const d2 = (x - point.x) ** 2 + (y - point.y) ** 2;
      if (d2 < bestD2) {
        bestX = x;
        bestY = y;
        bestD2 = d2;
      }
    }
  };
  for (const feature of features) {
    if (feature.geometry.type === 'LineString') considerLine(feature.geometry.coordinates);
    if (feature.geometry.type === 'MultiLineString') {
      for (const line of feature.geometry.coordinates) considerLine(line);
    }
  }
  if (!Number.isFinite(bestD2) || bestD2 > tolerancePx ** 2) return null;
  const p = map.unproject([bestX, bestY]);
  return { lat: +p.lat.toFixed(5), lon: +p.lng.toFixed(5) };
}

/** measured = read off an instrument. calculated = this app's arithmetic. estimate = modelled. */
function Prov({ kind }: { kind: 'measured' | 'calculated' | 'estimate' }) {
  return <span className={`prov ${kind}`}>{kind}</span>;
}

function Num({ v, d = 2, unit }: { v: number; d?: number; unit?: string }) {
  const txt = Number.isFinite(v)
    ? v >= 1e6
      ? v.toExponential(2)
      : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
    : '—';
  return (
    <span className="num">
      {txt}
      {unit ? <span className="unit">{unit}</span> : null}
    </span>
  );
}

function useCanvas(draw: (c: HTMLCanvasElement) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const run = () => draw(c);
    run();
    const ro = new ResizeObserver(run);
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

export default function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);

  const [intake, setIntake] = useState<Pt | null>(null);
  const [powerhouse, setPowerhouse] = useState<Pt | null>(null);
  const intakeRef = useRef<Pt | null>(null);
  const [selectionNotice, setSelectionNotice] = useState('Click directly on a blue river line to place the intake.');

  useEffect(() => {
    intakeRef.current = intake;
  }, [intake]);

  const [glofas, setGlofas] = useState<DischargeSeries | null>(null);
  const [gauges, setGauges] = useState<Gauge[]>([]);
  const [live, setLive] = useState<LiveReading | null>(null);
  const [gaugeSeries, setGaugeSeries] = useState<DischargeSeries | null>(null);
  const [precip, setPrecip] = useState<PrecipSummary | null>(null);
  const [infra, setInfra] = useState<OsmFeature[]>([]);
  const [profile, setProfile] = useState<ProfilePoint[]>([]);
  /** What the DEM measured between the two points. Negative means the powerhouse is uphill. */
  const [measuredHead, setMeasuredHead] = useState<number | null>(null);
  const [profileMeta, setProfileMeta] = useState<ElevationProfile | null>(null);
  const [projects, setProjects] = useState<NepalProject[]>([]);
  const [seismic, setSeismic] = useState<SeismicSummary | null>(null);
  const [reachHit, setReachHit] = useState<ReachHit | null>(null);
  /** Never silently replace the river the user picked with a larger neighbour. */
  const reach = reachHit?.nearest ?? null;

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [useGauge, setUseGauge] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [minFlow, setMinFlow] = useState(2);
  const [viewInNepal, setViewInNepal] = useState(true);
  /** minMonth is the default: 10% of mean annual flow is wrong on monsoon rivers. */
  const [residualBasis, setResidualBasis] = useState<ResidualBasis>('minMonth');
  const [householdKwh, setHouseholdKwh] = useState(DEFAULT_HOUSEHOLD_KWH);
  const [householdTouched, setHouseholdTouched] = useState(false);

  const [params, setParams] = useState<PlantParams>({
    grossHeadM: 50,
    headLossFrac: 0.05,
    efficiency: 0.85,
    designFlowCms: 1,
    residualFlowCms: 0,
    minFlowFrac: 0.2,
  });

  const flag = (k: string, v: boolean) => setBusy((b) => ({ ...b, [k]: v }));
  const fail = (k: string, e: unknown) =>
    setErrs((x) => ({ ...x, [k]: e instanceof Error ? e.message : String(e) }));

  // ---------------- map ----------------
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const initialView = readHashView();
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [initialView.lon, initialView.lat],
      zoom: initialView.zoom,
      attributionControl: { compact: true },
      // AWS terrain tiles ship no Cache-Control, so MapLibre treats them as
      // expired and re-requests them on every revisit. They are static DEM data.
      refreshExpiredTiles: false,
      // Snappier zoom, and one less thing animating for reduced-motion users.
      fadeDuration: 0,
      // Default is 5 zoom levels of tile cache. People zoom in to inspect a reach
      // and straight back out; holding more levels makes the return trip free.
      maxTileCacheZoomLevels: 10,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

    // A few optional OpenFreeMap sprite entries occasionally arrive missing.
    // Supply a small neutral raster fallback so MapLibre does not warn or drop
    // the affected cartographic detail.
    map.on('styleimagemissing', (event) => {
      if (map.hasImage(event.id)) return;
      const size = event.id.includes('circle') ? 12 : 8;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = event.id.includes('circle') ? '#9fb2bd' : '#26352f';
      if (event.id.includes('circle')) {
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(0, 0, size, size);
      }
      map.addImage(event.id, ctx.getImageData(0, 0, size, size));
    });

    // The stock dark style paints water at rgb(27,27,29) — invisible. In a river
    // app the rivers are the subject, so hillshade goes under them and the
    // waterways get repainted bright and zoom-scaled.
    map.on('load', () => {
      if (!map.getSource('dem')) {
        map.addSource('dem', {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          encoding: 'terrarium', // NOT mapbox — wrong encoding renders garbage
          tileSize: 256,
          // Measured: DEM tiles were 84% of all bytes on zoom (4.4 MB per zoom
          // sweep at maxzoom 14). Relief is only shown at basin scale now, so a
          // z12 cap avoids downloading overzoomed DEM tiles at site scale.
          maxzoom: 12,
          attribution: 'Terrain: AWS Terrain Tiles',
        });
      }
      const firstWater = map.getStyle().layers?.find((l) => l.id === 'water')?.id;
      if (!map.getLayer('hillshade')) {
        map.addLayer(
          {
            id: 'hillshade',
            type: 'hillshade',
            source: 'dem',
            minzoom: 9,
            maxzoom: 12,
            paint: {
              // Relief is useful at basin scale. At site scale the vector map
              // carries the detail, so stop loading the bandwidth-heavy DEM.
              'hillshade-exaggeration': [
                'interpolate',
                ['linear'],
                ['zoom'],
                9, 0.35,
                11, 0.55,
                12, 0.18,
              ],
              'hillshade-shadow-color': '#000914',
              'hillshade-highlight-color': '#43617d',
              'hillshade-accent-color': '#0d1a26',
            },
          },
          firstWater
        );
      }
      if (map.getLayer('water')) {
        map.setPaintProperty('water', 'fill-color', '#12456b');
        map.setPaintProperty('water', 'fill-opacity', 0.9);
      }
      if (map.getLayer('waterway')) {
        map.setPaintProperty('waterway', 'line-color', '#4db8ff');
        map.setPaintProperty('waterway', 'line-opacity', 0.85);
        map.setPaintProperty('waterway', 'line-width', [
          'interpolate',
          ['linear'],
          ['zoom'],
          5, 0.6,
          9, 1.4,
          13, 2.6,
          16, 4.5,
        ]);
      }
    });
    map.on('moveend', () => {
      const c = map.getCenter();
      setViewInNepal(isInNepal(c.lat, c.lng));
      const h = `#${map.getZoom().toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`;
      history.replaceState(null, '', h); // replace, so panning does not fill the back button
    });
    map.on('click', (e) => {
      if (e.defaultPrevented) return;
      const p = snapToVisibleRiver(map, e.point);
      if (!p) {
        setSelectionNotice('No mapped river at that spot. Zoom in and click within the blue river line.');
        return;
      }
      if (intakeRef.current === null) {
        setIntake(p);
        setSelectionNotice('Intake placed on the mapped river. Now choose a downstream point for the powerhouse.');
      } else {
        setPowerhouse(p);
        setSelectionNotice('Reach ready. Review the measured head and hydrology below.');
      }
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // markers + reach line
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    const add = (p: Pt, colour: string, title: string) => {
      const m = new maplibregl.Marker({ color: colour })
        .setLngLat([p.lon, p.lat])
        .setPopup(new maplibregl.Popup({ offset: 24 }).setText(title))
        .addTo(map);
      markers.current.push(m);
    };
    if (intake) add(intake, '#4db8ff', 'Intake');
    if (powerhouse) add(powerhouse, '#ffb454', 'Powerhouse');

    const draw = () => {
      const data: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates:
            intake && powerhouse
              ? [
                  [intake.lon, intake.lat],
                  [powerhouse.lon, powerhouse.lat],
                ]
              : [],
        },
      };
      const src = map.getSource('reach') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
      else {
        map.addSource('reach', { type: 'geojson', data });
        map.addLayer({
          id: 'reach',
          type: 'line',
          source: 'reach',
          paint: { 'line-color': '#ffb454', 'line-width': 3, 'line-dasharray': [2, 1.5] },
        });
      }
    };
    map.isStyleLoaded() ? draw() : map.once('load', draw);
  }, [intake, powerhouse]);

  // ---------------- data for the intake point ----------------
  useEffect(() => {
    if (!intake) return;
    const ac = new AbortController();
    setErrs({});
    setGlofas(null);
    setGauges([]);
    setLive(null);
    setGaugeSeries(null);
    setUseGauge(false);
    setInfra([]);
    setPrecip(null);
    setMeasuredHead(null);

    flag('flow', true);
    fetchGlofas(intake.lat, intake.lon, ac.signal)
      .then(setGlofas)
      .catch((e) => !ac.signal.aborted && fail('flow', e))
      .finally(() => flag('flow', false));

    flag('precip', true);
    fetchPrecip(intake.lat, intake.lon, ac.signal)
      .then(setPrecip)
      .catch((e) => !ac.signal.aborted && fail('precip', e))
      .finally(() => flag('precip', false));

    flag('gauge', true);
    fetchNearbyGauges(intake.lat, intake.lon, ac.signal)
      .then(async (gs) => {
        setGauges(gs);
        const withFlow = gs.find((g) => g.hasDischargeRecord);
        if (withFlow) setLive(await fetchLiveReading(withFlow.siteNo, ac.signal));
      })
      .catch((e) => !ac.signal.aborted && fail('gauge', e))
      .finally(() => flag('gauge', false));

    // A European household figure understates "homes powered" in Nepal by ~3.8x.
    if (!householdTouched) {
      setHouseholdKwh(isInNepal(intake.lat, intake.lon) ? NEPAL.householdKwhPerYear : DEFAULT_HOUSEHOLD_KWH);
    }

    setSeismic(null);
    flag('seismic', true);
    fetchSeismicity(intake.lat, intake.lon, 100, ac.signal)
      .then(setSeismic)
      .catch((e) => !ac.signal.aborted && fail('seismic', e))
      .finally(() => flag('seismic', false));

    setReachHit(null);
    setProjects([]);
    if (isInNepal(intake.lat, intake.lon)) {
      flag('reach', true);
      nearestReach(intake.lat, intake.lon)
        .then((r) => !ac.signal.aborted && setReachHit(r))
        .catch((e) => !ac.signal.aborted && fail('reach', e))
        .finally(() => flag('reach', false));

      flag('projects', true);
      fetchNepalProjects(ac.signal)
        .then((all) => setProjects(projectsNear(all, intake.lat, intake.lon, 25)))
        .catch((e) => !ac.signal.aborted && fail('projects', e))
        .finally(() => flag('projects', false));
    }

    flag('infra', true);
    fetchNearbyInfrastructure(intake.lat, intake.lon, 25, ac.signal)
      .then(setInfra)
      .catch((e) => !ac.signal.aborted && fail('infra', e))
      .finally(() => flag('infra', false));

    return () => ac.abort();
  }, [intake]);

  // ---------------- terrain profile ----------------
  useEffect(() => {
    if (!intake || !powerhouse) return;
    let alive = true;
    flag('terrain', true);
    fetchElevationProfile([intake.lat, intake.lon], [powerhouse.lat, powerhouse.lon])
      .then((r) => {
        if (!alive) return;
        setProfile(r.points);
        setProfileMeta(r);
        const good = r.points.filter((x) => Number.isFinite(x.elevationM));
        if (good.length < 2) {
          setMeasuredHead(null);
          return;
        }
        // Always record what the DEM actually said, including a negative drop.
        // Silently keeping the default while labelling it "measured" would be a lie.
        const head = Math.round((good[0].elevationM - good[good.length - 1].elevationM) * 10) / 10;
        setMeasuredHead(head);
        if (head > 0) setParams((q) => ({ ...q, grossHeadM: head }));
      })
      .catch((e) => alive && fail('terrain', e))
      .finally(() => alive && flag('terrain', false));
    return () => {
      alive = false;
    };
  }, [intake, powerhouse]);

  // ---------------- which series drives the numbers ----------------
  const series: DischargeSeries | null = useGauge && gaugeSeries ? gaugeSeries : glofas;
  const sourceLabel = useGauge && gaugeSeries ? 'USGS gauge record' : 'GloFAS v4 (20 complete years)';
  const sourceProv: 'measured' | 'estimate' = useGauge && gaugeSeries ? 'measured' : 'estimate';

  const fdc: FdcPoint[] = useMemo(() => (series ? buildFdc(series.values) : []), [series]);
  const meanFlow = useMemo(() => (series ? mean(series.values) : NaN), [series]);

  // Seed design flow from the hydrology whenever the series changes.
  useEffect(() => {
    if (fdc.length === 0) return;
    const q40 = flowAtExceedance(fdc, 0.4);
    setParams((p) => ({ ...p, designFlowCms: Math.round(q40 * 1000) / 1000 }));
  }, [fdc]);

  // Residual flow follows the chosen basis until the user types their own value.
  useEffect(() => {
    if (!series || residualBasis === 'manual') return;
    const v = residualForBasis(residualBasis, series.dates, series.values);
    if (!Number.isFinite(v)) return;
    setParams((p) => ({ ...p, residualFlowCms: Math.round(v * 1000) / 1000 }));
  }, [series, residualBasis]);

  const energy = useMemo(
    () => (series ? annualEnergy(series.values, params) : null),
    [series, params]
  );

  const seasonal = useMemo(
    () => (series ? seasonalRatio(series.dates, series.values) : null),
    [series]
  );

  const rows = useMemo(
    () =>
      fdc.length === 0
        ? []
        : EXCEEDANCES.map((p) => {
            const q = flowAtExceedance(fdc, p);
            const qt = turbineFlow(q, params);
            return { p, q, qt, w: powerW(qt, netHead(params), params.efficiency) };
          }),
    [fdc, params]
  );

  const inNepal = !!intake && isInNepal(intake.lat, intake.lon);
  const seasons = useMemo(
    () => (series && inNepal ? wetDryEnergy(series.dates, series.values, params) : null),
    [series, params, inNepal]
  );

  const p50 = rows.find((r) => r.p === 0.5);
  const p90 = rows.find((r) => r.p === 0.9);
  const households = energy ? (energy.gwhPerYear * 1e6) / householdKwh : 0;

  const set = (k: keyof PlantParams) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setParams((p) => ({ ...p, [k]: v }));
  };

  const fdcRef = useCanvas(
    (c) =>
      drawFdc(
        c,
        fdc,
        [
          { exceedance: 0.4, label: 'Q40', colour: '#7ee787' },
          { exceedance: 0.5, label: 'P50' },
          { exceedance: 0.9, label: 'P90' },
        ],
        params.designFlowCms
      ),
    [fdc, params.designFlowCms]
  );
  const profRef = useCanvas((c) => drawProfile(c, profile), [profile]);
  const flowMonthRef = useCanvas(
    (c) => drawMonthly(c, seasonal?.monthlyMeans ?? [], 'm³/s'),
    [seasonal]
  );
  const rainRef = useCanvas(
    (c) => drawMonthly(c, precip?.monthlyMeanMm ?? [], 'mm/month', '#7ee787'),
    [precip]
  );

  const matches: Candidate[] = useMemo(
    () => (scan ? scan.cells.filter((c) => c.meanCms >= minFlow) : []),
    [scan, minFlow]
  );

  const runScan = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    flag('scan', true);
    setErrs((x) => ({ ...x, scan: '' }));
    try {
      const center = map.getCenter();
      const box = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
      // Nepal has the bundled river network: free, instant, on real centrelines.
      // Everywhere else falls back to sampling the GloFAS grid, which costs one
      // shared-API request and is coarser — but keeps discovery global.
      setScan(
        isInNepal(center.lat, center.lng)
          ? await scanNepalCandidates(box)
          : await scanGlofasCandidates(box)
      );
    } catch (e) {
      fail('scan', e);
      setScan(null);
    } finally {
      flag('scan', false);
    }
  }, []);

  // Paint the matching cells on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: matches.map((c) => ({
        type: 'Feature',
        properties: { flow: c.meanCms, label: `${c.meanCms.toFixed(1)} m³/s` },
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      })),
    };
    const draw = () => {
      const src = map.getSource('candidates') as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
        return;
      }
      map.addSource('candidates', { type: 'geojson', data });
      map.addLayer({
        id: 'candidates',
        type: 'circle',
        source: 'candidates',
        paint: {
          // Radius by flow magnitude, so the trunk rivers read at a glance.
          'circle-radius': ['interpolate', ['linear'], ['log10', ['max', ['get', 'flow'], 0.1]], -1, 4, 3, 18],
          'circle-color': '#4db8ff',
          'circle-opacity': 0.32,
          // Blue, deliberately NOT green: green means "real DHM gauge" on this map.
          'circle-stroke-color': '#9ad8ff',
          'circle-stroke-width': 1.2,
          'circle-stroke-opacity': 0.7,
        },
      });
      map.on('click', 'candidates', (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== 'Point') return;
        event.preventDefault();
        const [lon, lat] = feature.geometry.coordinates;
        setPowerhouse(null);
        setIntake({ lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
        setSelectionNotice('Intake placed on a HydroRIVERS centreline. Now choose a downstream point for the powerhouse.');
      });
      map.on('mouseenter', 'candidates', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'candidates', () => (map.getCanvas().style.cursor = ''));
    };
    map.isStyleLoaded() ? draw() : map.once('load', draw);
  }, [matches]);

  // Nepal DHM gauges as a map layer, not just a table — seeing that a real gauge
  // sits on your river is the point.
  const dhmNearby = useMemo(
    () => (intake && isInNepal(intake.lat, intake.lon) ? nearbyDhmStations(intake.lat, intake.lon, true, 40) : []),
    [intake]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: dhmNearby.map((s) => ({
        type: 'Feature',
        properties: { name: s.name, km: s.distanceKm.toFixed(1) },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    };
    const draw = () => {
      const src = map.getSource('dhm') as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
        return;
      }
      map.addSource('dhm', { type: 'geojson', data });
      map.addLayer({
        id: 'dhm',
        type: 'circle',
        source: 'dhm',
        paint: {
          'circle-radius': 5,
          'circle-color': '#7ee787',
          'circle-opacity': 0.95,
          // Light halo: a dark ring disappeared against the hillshade.
          'circle-stroke-color': '#eafff0',
          'circle-stroke-width': 1.6,
          'circle-stroke-opacity': 0.9,
        },
      });
      map.on('click', 'dhm', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        new maplibregl.Popup({ offset: 10 })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${String(f.properties?.name ?? '')}</b><br>DHM gauge · ${f.properties?.km} km<br><span style="color:#8fa3b8">readings not published openly</span>`
          )
          .addTo(map);
      });
      map.on('mouseenter', 'dhm', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'dhm', () => (map.getCanvas().style.cursor = ''));
    };
    map.isStyleLoaded() ? draw() : map.once('load', draw);
    // Small informational dots must sit above the big project circles, and effect
    // order alone does not guarantee that.
    if (map.getLayer('dhm')) map.moveLayer('dhm');
  }, [dhmNearby, projects]);

  // Licensed projects on the map, coloured by how far along they are.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: projects.map((p) => ({
        type: 'Feature',
        properties: {
          name: p.name,
          stage: p.stage,
          mw: p.capacityMW ?? 0,
          river: p.river,
          promoter: p.promoter,
          km: p.distanceKm.toFixed(1),
        },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      })),
    };
    const draw = () => {
      const src = map.getSource('projects') as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
        return;
      }
      map.addSource('projects', { type: 'geojson', data });
      map.addLayer({
        id: 'projects',
        type: 'circle',
        source: 'projects',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['sqrt', ['max', ['get', 'mw'], 0.1]], 0.3, 4, 20, 14],
          'circle-color': [
            'match',
            ['get', 'stage'],
            'Operation', '#ff7b72',
            'Generation', '#ffb454',
            '#8fa3b8',
          ],
          'circle-opacity': 0.55,
          'circle-stroke-color': '#0d1218',
          'circle-stroke-width': 1.2,
        },
      });
      map.on('click', 'projects', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const q = f.properties ?? {};
        new maplibregl.Popup({ offset: 12 })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${String(q.name ?? '')}</b><br>${q.mw} MW · ${String(q.stage ?? '')}<br>` +
              `<span style="color:#8fa3b8">${String(q.river ?? '')} · ${q.km} km</span><br>` +
              `<span style="color:#8fa3b8">${String(q.promoter ?? '')}</span>`
          )
          .addTo(map);
      });
      map.on('mouseenter', 'projects', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'projects', () => (map.getCanvas().style.cursor = ''));
    };
    map.isStyleLoaded() ? draw() : map.once('load', draw);
  }, [projects]);

  const loadGaugeRecord = useCallback(async (siteNo: string) => {
    flag('gaugeSeries', true);
    try {
      const s = await fetchUsgsDaily(siteNo);
      setGaugeSeries(s);
      if (s) setUseGauge(true);
      else fail('gaugeSeries', new Error('no daily discharge record at this station'));
    } catch (e) {
      fail('gaugeSeries', e);
    } finally {
      flag('gaugeSeries', false);
    }
  }, []);

  const exportCsv = useCallback(() => {
    if (!series || !energy || fdc.length === 0 || !intake) return;
    const h = netHead(params);
    const meta = [
      '# RiverPower — run-of-river prefeasibility screening export',
      '# PREFEASIBILITY SCREENING ONLY — not a feasibility study.',
      `# generated,${new Date().toISOString()}`,
      `# intake_lat,${intake.lat}`,
      `# intake_lon,${intake.lon}`,
      powerhouse ? `# powerhouse_lat,${powerhouse.lat}` : '# powerhouse_lat,',
      powerhouse ? `# powerhouse_lon,${powerhouse.lon}` : '# powerhouse_lon,',
      `# flow_source,${sourceLabel}`,
      `# flow_provenance,${sourceProv}`,
      // The gauge's own coordinates when measured, the model grid cell when estimated.
      `# source_lat,${series.cell.lat}`,
      `# source_lon,${series.cell.lon}`,
      `# record_start,${series.dates[0] ?? ''}`,
      `# record_end,${series.dates[series.dates.length - 1] ?? ''}`,
      `# record_days,${series.values.length}`,
      `# discharge_units,m3/s`,
      `# gross_head_m,${params.grossHeadM}`,
      `# head_loss_fraction,${params.headLossFrac}`,
      `# net_head_m,${h.toFixed(3)}`,
      `# overall_efficiency,${params.efficiency}`,
      `# design_flow_m3s,${params.designFlowCms}`,
      `# residual_flow_m3s,${params.residualFlowCms}`,
      `# min_turbine_flow_fraction,${params.minFlowFrac}`,
      `# rho_kg_m3,${RHO}`,
      `# g_m_s2,${G}`,
      `# hours_per_year,${HOURS_PER_YEAR}`,
      `# rated_power_MW,${(energy.ratedPowerW / 1e6).toFixed(4)}`,
      `# annual_energy_GWh,${energy.gwhPerYear.toFixed(4)}`,
      `# gross_plant_factor,${energy.grossPlantFactor.toFixed(4)}`,
      '# NOTE: gross plant factor contains hydrology only — no outages, curtailment or station service.',
      '# NOTE: real capacity factor = gross plant factor x availability (0.90-0.97 typical for hydro).',
      '',
      'exceedance_percent,river_flow_m3s,turbine_flow_m3s,power_kW',
    ];
    const body: string[] = [];
    for (let i = 1; i <= 99; i++) {
      const p = i / 100;
      const q = flowAtExceedance(fdc, p);
      const qt = turbineFlow(q, params);
      body.push(`${i},${q.toFixed(4)},${qt.toFixed(4)},${(powerW(qt, h, params.efficiency) / 1e3).toFixed(3)}`);
    }
    const blob = new Blob([[...meta, ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `riverpower_${intake.lat}_${intake.lon}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [series, energy, fdc, params, intake, powerhouse, sourceLabel, sourceProv]);

  const anyBusy = Object.values(busy).some(Boolean);

  return (
    <>
      <header className="app-bar">
        <div className="bar-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">↘</span>
            <span>RiverPower<small>Run-of-river prefeasibility screening</small></span>
          </div>
          <div className="bar-status">
            {/* Not a badge — the brief requires this caveat to sit next to the numbers. */}
            <span className="screening-pill">Screening only · not a feasibility study</span>
          </div>
        </div>
      </header>

      <main>
        <section className="workspace" aria-label="Hydropower site finder">
          <div className="map-shell">
            <div id="map" ref={mapEl} />
            {(matches.length > 0 || dhmNearby.length > 0 || projects.length > 0) && (
              <div className="map-legend">
                {matches.length > 0 && <span><i className="legend-flow" />flow ≥ {minFlow} m³/s</span>}
                {dhmNearby.length > 0 && <span><i className="legend-gauge" />DHM gauge</span>}
                {projects.length > 0 && (
                  <>
                    <span><i className="legend-operating" />operating</span>
                    <span><i className="legend-build" />licensed to build</span>
                    <span><i className="legend-survey" />survey licence</span>
                  </>
                )}
              </div>
            )}
            <div className="map-hint" role="status">
              <span>{selectionNotice}</span>
              {intake && (
                <span className="map-coordinate mono">{intake.lat.toFixed(4)}, {intake.lon.toFixed(4)}</span>
              )}
              {(intake || powerhouse) && (
                <button
                  className="quiet-button"
                  onClick={() => {
                    setIntake(null);
                    setPowerhouse(null);
                    setProfile([]);
                    setMeasuredHead(null);
                    setSelectionNotice('Click directly on a blue river line to place the intake.');
                  }}
                >
                  Start over
                </button>
              )}
            </div>
          </div>

          <aside className="site-panel">
            <div className="panel-kicker">Site finder</div>
            <h1>Find a site</h1>
            <p className="panel-lede">
              Screen mapped flow, place an intake on a river, then place a powerhouse downstream to
              measure head from terrain.
            </p>

            <ol className="workflow-steps" aria-label="Analysis progress">
              <li className={intake ? 'done' : 'active'}><span>1</span><b>Intake</b><small>{intake ? 'Placed on river' : 'Choose a river'}</small></li>
              <li className={powerhouse ? 'done' : intake ? 'active' : ''}><span>2</span><b>Powerhouse</b><small>{powerhouse ? 'Reach measured' : 'Place downstream'}</small></li>
              <li className={powerhouse ? 'active' : ''}><span>3</span><b>Review</b><small>Adjust & export</small></li>
            </ol>

            <div className="field panel-field">
              <label htmlFor="jump">Jump to a river region</label>
              <select
                id="jump"
                defaultValue=""
                onChange={(e) => {
                  const p = PLACES.find((x) => x.label === e.target.value);
                  if (p) {
                    setScan(null);
                    mapRef.current?.flyTo({ center: [p.lon, p.lat], zoom: p.zoom });
                  }
                }}
              >
                <option value="">Choose a region…</option>
                {PLACES.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
              </select>
            </div>

            <div className="threshold-row">
              <div>
                <label htmlFor="minflow">Minimum mapped flow</label>
                <small>{viewInNepal ? 'HydroRIVERS long-term mean' : 'GloFAS long-term mean'}</small>
              </div>
              <div className="flow-input-wrap">
                <input
                  id="minflow"
                  type="number"
                  min="0"
                  step="0.5"
                  value={minFlow}
                  onChange={(e) => setMinFlow(Math.max(0, Number(e.target.value) || 0))}
                />
                <span>m³/s</span>
              </div>
            </div>

            <button className="primary scan-button" onClick={runScan} disabled={busy.scan}>
              {busy.scan ? <><span className="spinner" /> Mapping rivers…</> : 'Show flowing rivers in this view'}
            </button>
            {!viewInNepal && (
              <p className="panel-note">
                Outside Nepal this samples the GloFAS grid instead of a mapped river network, so
                results are coarser and cost one request to a shared free API.
              </p>
            )}
            {errs.scan && <div className="notice service compact">{errs.scan}</div>}

            {scan && (
              <div className="scan-summary">
                <span><b>{matches.length}</b> reaches above {minFlow} m³/s</span>
                <small>{scan.limited ? 'Strongest 240 shown — zoom in for more detail.' : 'Every marker is on a mapped river centreline.'}</small>
              </div>
            )}
            {scan && matches.length === 0 && !busy.scan && (
              <div className="empty-scan">No river in this view reaches the threshold. Lower it or pan to a larger channel.</div>
            )}
            {matches.length > 0 && (
              <div className="candidate-list" aria-label="Top river candidates">
                {matches.slice(0, 6).map((c, i) => (
                  <button
                    key={`${c.lat},${c.lon}`}
                    onClick={() => {
                      mapRef.current?.flyTo({ center: [c.lon, c.lat], zoom: 13 });
                      setPowerhouse(null);
                      setIntake({ lat: c.lat, lon: c.lon });
                      setSelectionNotice('Intake placed on a HydroRIVERS centreline. Now choose a downstream point.');
                    }}
                  >
                    <span className="candidate-rank">{String(i + 1).padStart(2, '0')}</span>
                    <span><b>{c.meanCms.toFixed(1)} m³/s</b><small>{c.uplandKm2?.toLocaleString(undefined, { maximumFractionDigits: 0 })} km² catchment</small></span>
                    <span className="candidate-action">Analyse</span>
                  </button>
                ))}
              </div>
            )}

            <div className="rate-note">
              <span className="rate-icon" aria-hidden="true">✓</span>
              <p><b>No flood-API call for river discovery.</b> In Nepal this reads the bundled HydroRIVERS network; Open-Meteo is requested only once for a selected site, then cached on this device.</p>
            </div>
          </aside>
        </section>

        <div className="wrap results-wrap">

        {!intake && (
          <section className="empty-dashboard">
            <div className="empty-heading">
              <span>Before you start</span>
              <h2>A fast screen, with the uncertainty left visible.</h2>
            </div>
            <div className="empty-grid">
              <article><span>01</span><h3>River-true placement</h3><p>Clicks snap to the river line you can see. Larger neighbouring channels are offered as a choice, never substituted silently.</p></article>
              <article><span>02</span><h3>Traceable hydrology</h3><p>HydroRIVERS ranks Nepal’s channels locally. A 20-year GloFAS record is requested only after selection and saved for reuse.</p></article>
              <article><span>03</span><h3>Engineering context</h3><p>Head, flow duration, nearby licences, gauges, terrain and seismic history stay separate so estimates are not mistaken for measurements.</p></article>
            </div>
          </section>
        )}

        {intake && (
          <>
            {/* ---------------- PLAIN LANGUAGE ---------------- */}
            <section>
              <h2>What this river could power</h2>
              <div className="card hero">
                {busy.flow && (
                  <p className="sub">
                    <span className="spinner" /> Loading the {GLOFAS_START.slice(0, 4)}–{GLOFAS_END.slice(0, 4)} daily flow record…
                  </p>
                )}
                {errs.flow && (
                  <div className="notice service">
                    <b>Detailed flow history is paused.</b> {errs.flow}
                    {reach && (
                      <> The bundled river network still identifies this reach at approximately{' '}
                        <span className="mono">{reach.meanDischargeCms.toFixed(1)} m³/s</span>{' '}
                        long-term mean flow.</>
                    )}
                  </div>
                )}

                {energy && fdc.length > 0 && (
                  <>
                    {glofas?.cacheStatus && glofas.cacheStatus !== 'network' && !useGauge && (
                      <div className="data-freshness">
                        Using {glofas.cacheStatus === 'stale' ? 'the last saved' : 'a saved'} flow record from this device — no new Open-Meteo request was made.
                      </div>
                    )}
                    <p className="headline">
                      About <span className="big">{Math.round(households).toLocaleString()}</span>{' '}
                      homes&rsquo; worth of electricity a year — roughly{' '}
                      <span className="big">{energy.gwhPerYear.toFixed(1)} GWh</span> from a{' '}
                      <span className="big">{(energy.ratedPowerW / 1e6).toFixed(2)} MW</span> plant.
                    </p>
                    <p className="sub">
                      That is {((energy.gwhPerYear / BENCHMARK.annualEnergyGWh) * 100).toFixed(0)}% of{' '}
                      {BENCHMARK.name} ({BENCHMARK.capacityMW} MW, {BENCHMARK.annualEnergyGWh} GWh/yr),
                      a real run-of-river plant
                      {intake && isInNepal(intake.lat, intake.lon) && (
                        <>
                          , and{' '}
                          <b>
                            {((energy.gwhPerYear / NEPAL.annualHydroGwh) * 100).toFixed(2)}%
                          </b>{' '}
                          of Nepal&rsquo;s total hydro generation ({NEPAL.annualHydroGwh.toLocaleString()}{' '}
                          GWh/yr from {NEPAL.installedHydroMW.toLocaleString()} MW, NEA FY2024/25)
                        </>
                      )}
                      . Assumes {params.grossHeadM} m of gross head and{' '}
                      {(params.efficiency * 100).toFixed(0)}% overall efficiency — change those below
                      and every number here moves.
                    </p>

                    <div className="stat-row" style={{ marginTop: 16 }}>
                      <div className="stat">
                        <div className="label">Reliable output (P90)</div>
                        <div className="value">
                          <Num v={(p90?.w ?? 0) / 1e3} d={0} unit=" kW" />
                        </div>
                      </div>
                      <div className="stat">
                        <div className="label">Typical output (P50)</div>
                        <div className="value">
                          <Num v={(p50?.w ?? 0) / 1e3} d={0} unit=" kW" />
                        </div>
                      </div>
                      <div className="stat">
                        <div className="label">Running time</div>
                        <div className="value">
                          <Num v={energy.utilisationFrac * 100} d={0} unit="%" />
                        </div>
                      </div>
                      <div className="stat">
                        <div className="label">Gross plant factor</div>
                        <div className="value">
                          <Num v={energy.grossPlantFactor * 100} d={0} unit="%" />
                        </div>
                      </div>
                    </div>

                    {p90 && p90.w === 0 && (
                      <div className="notice" style={{ marginTop: 16 }}>
                        <b>No firm power.</b> At 90% exceedance this river carries{' '}
                        <span className="mono">{p90.q.toFixed(2)} m³/s</span>. After the{' '}
                        <span className="mono">{params.residualFlowCms} m³/s</span> residual flow is
                        left in the channel, only{' '}
                        <span className="mono">{Math.max(0, p90.q - params.residualFlowCms).toFixed(2)} m³/s</span>{' '}
                        remains — below the{' '}
                        <span className="mono">{(params.minFlowFrac * params.designFlowCms).toFixed(2)} m³/s</span>{' '}
                        minimum this turbine can run on, so it shuts down. That is a real result, not
                        a missing number: a scheme sized on Q40 in a strongly seasonal river produces
                        nothing in the dry season. Lower the design flow for firm output, or accept a
                        seasonal plant.
                      </div>
                    )}

                    <div className="notice" style={{ marginTop: 16 }}>
                      <b>How much to trust this.</b>{' '}
                      {sourceProv === 'estimate' ? (
                        <>
                          The flow figures are <b>modelled</b>, from the GloFAS global reanalysis on a
                          roughly 5 km grid — not a measurement of this river. On a large river that
                          is a reasonable first estimate. On a small stream the model may not resolve
                          your watercourse at all, and the numbers above could be wrong by a large
                          factor. Treat this as a screening indication that tells you whether a real
                          study is worth commissioning.
                        </>
                      ) : (
                        <>
                          The flow figures come from a <b>real gauge record</b> at a nearby station —
                          measured, not modelled. The remaining uncertainty is mostly in how well that
                          station represents your exact site, plus the head and efficiency you
                          entered.
                        </>
                      )}
                    </div>
                  </>
                )}
                {!busy.flow && !errs.flow && fdc.length === 0 && (
                  <div className="notice bad">
                    <b>No usable discharge record at this point.</b> The reanalysis returned no
                    values here — this usually means the point is not on a river the global model
                    resolves. Try a point on a larger mapped watercourse.
                  </div>
                )}
              </div>
            </section>

            {/* ---------------- ASSUMPTIONS ---------------- */}
            {series && (
              <>
            <section>
              <h2>Assumptions — change these</h2>
              <div className="card">
                <div className="inputs">
                  <div className="field">
                    <label htmlFor="head">Gross head (m)</label>
                    <input id="head" type="number" min="0" step="1" value={params.grossHeadM} onChange={set('grossHeadM')} />
                    <div className="note">
                      {measuredHead === null
                        ? 'set two points to measure'
                        : measuredHead > 0
                          ? `measured ${measuredHead} m from terrain tiles`
                          : `terrain says ${measuredHead} m — powerhouse is uphill, so this is your assumption, not a measurement`}
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="loss">Head loss (fraction)</label>
                    <input id="loss" type="number" min="0" max="0.5" step="0.01" value={params.headLossFrac} onChange={set('headLossFrac')} />
                    <div className="note">net head {netHead(params).toFixed(1)} m</div>
                  </div>
                  <div className="field">
                    <label htmlFor="eff">Overall efficiency</label>
                    <input id="eff" type="number" min="0.1" max="1" step="0.01" value={params.efficiency} onChange={set('efficiency')} />
                    <div className="note">turbine × generator × transformer</div>
                  </div>
                  <div className="field">
                    <label htmlFor="design">Design flow (m³/s)</label>
                    <input id="design" type="number" min="0" step="0.1" value={params.designFlowCms} onChange={set('designFlowCms')} />
                    <div className="note">seeded from Q40</div>
                  </div>
                  <div className="field">
                    <label htmlFor="residBasis">Residual flow basis</label>
                    <select
                      id="residBasis"
                      value={residualBasis}
                      onChange={(e) => setResidualBasis(e.target.value as ResidualBasis)}
                    >
                      <option value="minMonth">10% of lowest monthly mean</option>
                      <option value="meanAnnual">10% of mean annual flow</option>
                      <option value="manual">Enter my own</option>
                    </select>
                    <div className="note">
                      {residualBasis === 'minMonth'
                        ? 'the basis Nepal licensing uses'
                        : residualBasis === 'meanAnnual'
                          ? 'temperate default — can exceed dry-season flow'
                          : 'set the value yourself'}
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="resid">Residual flow (m³/s)</label>
                    <input
                      id="resid"
                      type="number"
                      min="0"
                      step="0.1"
                      value={params.residualFlowCms}
                      onChange={(e) => {
                        setResidualBasis('manual');
                        set('residualFlowCms')(e);
                      }}
                    />
                    <div className="note">left in the river, not available to the turbine</div>
                  </div>
                  <div className="field">
                    <label htmlFor="minf">Min turbine flow (fraction of design)</label>
                    <input id="minf" type="number" min="0" max="1" step="0.05" value={params.minFlowFrac} onChange={set('minFlowFrac')} />
                    <div className="note">below this the unit stops</div>
                  </div>
                  <div className="field">
                    <label htmlFor="hh">Household use (kWh/yr)</label>
                    <input
                      id="hh"
                      type="number"
                      min="50"
                      step="50"
                      value={householdKwh}
                      onChange={(e) => {
                        setHouseholdTouched(true);
                        setHouseholdKwh(Number(e.target.value) || DEFAULT_HOUSEHOLD_KWH);
                      }}
                    />
                    <div className="note">
                      {intake && isInNepal(intake.lat, intake.lon) && !householdTouched
                        ? 'Nepal: 912 kWh/yr per NEA connection'
                        : 'for the “homes powered” line only'}
                    </div>
                  </div>
                </div>
                {series && seasonal && Number.isFinite(seasonal.ratio) && (
                  <p className="sub" style={{ marginTop: 12 }}>
                    This river swings <b><Num v={seasonal.ratio} d={1} />×</b> between{' '}
                    {MONTHS[seasonal.wettestMonth]} and {MONTHS[seasonal.driestMonth]}. Mean annual
                    flow is <Num v={meanFlow} d={2} unit=" m³/s" /> but the lowest monthly mean is
                    only <Num v={minMonthlyMean(series.dates, series.values)} d={2} unit=" m³/s" /> —
                    which is why basing residual flow on the annual mean can leave nothing to
                    generate with in the dry season.
                  </p>
                )}
                <p className="sub" style={{ marginTop: 10 }}>
                  Residual (environmental) flow is a policy decision, not a physical one. These
                  defaults are conventions, not a legal requirement for your jurisdiction — confirm
                  the rule that actually applies to your site.
                </p>
              </div>
            </section>

            {/* ---------------- FDC ---------------- */}
            <section>
              <h2>Flow-duration curve <Prov kind={sourceProv} /></h2>
              <div className="card">
                <p className="sub" style={{ marginTop: 0 }}>
                  Source: <b>{sourceLabel}</b>
                  {series && (
                    <>
                      {' '}· {series.values.length.toLocaleString()} daily values ·{' '}
                      {series.dates[0]} → {series.dates[series.dates.length - 1]}
                      {sourceProv === 'estimate' && (
                        <> · model cell {series.cell.lat.toFixed(3)}, {series.cell.lon.toFixed(3)}</>
                      )}
                    </>
                  )}
                </p>
                <canvas className="fdc" ref={fdcRef} />
                <div className="tbl-scroll" style={{ marginTop: 14 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Exceedance</th>
                        <th>River flow m³/s</th>
                        <th>Through turbine m³/s</th>
                        <th>Power kW</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.p}>
                          <td>
                            Q{Math.round(r.p * 100)}
                            {r.p === 0.4 ? ' (design)' : ''}
                          </td>
                          <td><Num v={r.q} /></td>
                          <td><Num v={r.qt} /></td>
                          <td><Num v={r.w / 1e3} d={0} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
              </>
            )}

            {/* ---------------- THE COMPUTATION ---------------- */}
            {energy && (
              <section>
                <h2>The computation <Prov kind="calculated" /></h2>
                <div className="card">
                  <div className="formula mono">
                    <div className="step"><span className="lhs">P</span><span className="rhs">= ρ · g · Q · H · η</span></div>
                    <div className="step"><span className="lhs">ρ (water density)</span><span className="rhs">= {RHO} kg/m³</span></div>
                    <div className="step"><span className="lhs">g</span><span className="rhs">= {G} m/s²</span></div>
                    <div className="step"><span className="lhs">H gross</span><span className="rhs">= {params.grossHeadM} m</span></div>
                    <div className="step"><span className="lhs">H net = H·(1−loss)</span><span className="rhs">= {params.grossHeadM} × (1 − {params.headLossFrac}) = {netHead(params).toFixed(2)} m</span></div>
                    <div className="step"><span className="lhs">Q design</span><span className="rhs">= {params.designFlowCms} m³/s</span></div>
                    <div className="step"><span className="lhs">η</span><span className="rhs">= {params.efficiency}</span></div>
                    <div className="step result"><span className="lhs">P rated</span><span className="rhs">= {RHO} × {G} × {params.designFlowCms} × {netHead(params).toFixed(2)} × {params.efficiency} = {(energy.ratedPowerW / 1e6).toFixed(4)} MW</span></div>
                    <div className="step" style={{ marginTop: 10 }}><span className="lhs">mean power</span><span className="rhs">= average of P over all {series?.values.length.toLocaleString()} days = {(energy.meanPowerW / 1e6).toFixed(4)} MW</span></div>
                    <div className="step result"><span className="lhs">E annual</span><span className="rhs">= {(energy.meanPowerW / 1e6).toFixed(4)} MW × {HOURS_PER_YEAR} h = {energy.gwhPerYear.toFixed(3)} GWh/yr = {(energy.gwhPerYear * 1000).toFixed(0)} MWh/yr</span></div>
                    <div className="step result"><span className="lhs">gross plant factor</span><span className="rhs">= {(energy.meanPowerW / 1e6).toFixed(4)} ÷ {(energy.ratedPowerW / 1e6).toFixed(4)} = {(energy.grossPlantFactor * 100).toFixed(1)}%</span></div>
                  </div>
                  <div className="notice info" style={{ marginTop: 14 }}>
                    <b>Gross plant factor is not capacity factor.</b> The curve above contains
                    hydrology only — no forced outages, no maintenance, no grid curtailment, no
                    station service load. A bankable capacity factor is this figure multiplied by
                    availability, typically 0.90–0.97 for hydro. So expect roughly{' '}
                    <span className="mono">{(energy.grossPlantFactor * 0.94 * 100).toFixed(1)}%</span> in
                    practice, not {(energy.grossPlantFactor * 100).toFixed(1)}%.
                  </div>
                  <p className="sub" style={{ marginTop: 12 }}>
                    Energy is the average of P over every day in the record, which is exactly the
                    integral of power across the 0–100% exceedance axis. Order of operations:
                    residual flow is removed from the river first, then the turbine cap is applied,
                    then the unit shuts down below {(params.minFlowFrac * 100).toFixed(0)}% of design
                    flow.
                  </p>
                </div>
              </section>
            )}

            {/* ---------------- MEASURED CROSS-CHECK ---------------- */}
            <section>
              <h2>Nearest gauging station <Prov kind="measured" /></h2>
              <div className="card">
                {busy.gauge && <p className="sub"><span className="spinner" /> Searching for gauges…</p>}
                {errs.gauge && (
                  <div className="notice bad">
                    <b>Could not reach the gauge service.</b> {errs.gauge}. This is a temporary
                    failure, <b>not</b> a statement that no gauge exists here — reload to retry.
                  </div>
                )}
                {/* Only claim there is no gauge when the lookup actually succeeded. */}
                {!busy.gauge && !errs.gauge && gauges.length === 0 && (
                  <div className="notice">
                    <b>No openly-readable gauge here.</b> This app can read live gauge records
                    directly only for the United States. Every flow figure above is therefore
                    modelled rather than measured. That is a real limit, not a loading failure.
                  </div>
                )}

                {/* Nepal has 1,115 DHM stations; they are simply not open. Saying
                    "no gauge" without saying that would be misleading. */}
                {!busy.gauge && gauges.length === 0 && intake && isInNepal(intake.lat, intake.lon) && (
                  <div style={{ marginTop: 14 }}>
                    <p className="sub" style={{ marginTop: 0 }}>
                      <b>Nepal DHM stations near this point</b> — these gauges exist and are
                      measured, but DHM does not publish the readings openly, so this tool cannot
                      use them. Request the record for the station you need from{' '}
                      <a href="https://dhm.gov.np/" target="_blank" rel="noreferrer">dhm.gov.np</a>.
                    </p>
                    <div className="tbl-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Station</th>
                            <th>Distance</th>
                            <th>Elevation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nearbyDhmStations(intake.lat, intake.lon).map((s) => (
                            <tr key={`${s.name}-${s.lat}-${s.lon}`}>
                              <td>{s.name}</td>
                              <td><Num v={s.distanceKm} d={1} unit=" km" /></td>
                              <td>{s.elevationM !== null ? <Num v={s.elevationM} d={0} unit=" m" /> : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="sub" style={{ marginBottom: 0 }}>
                      River gauges only, identified from station names in the DHM inventory
                      (1,115 stations, bundled at build time).
                    </p>
                  </div>
                )}
                {gauges.length > 0 && (
                  <>
                    {live && (
                      <div className="stat-row" style={{ marginBottom: 14 }}>
                        <div className="stat">
                          <div className="label">Live discharge</div>
                          <div className="value">
                            {live.dischargeCms !== null ? <Num v={live.dischargeCms} unit=" m³/s" /> : '—'}
                          </div>
                        </div>
                        <div className="stat">
                          <div className="label">Gage height</div>
                          <div className="value">
                            {live.gageHeightM !== null ? <Num v={live.gageHeightM} unit=" m" /> : '—'}
                          </div>
                        </div>
                        <div className="stat">
                          <div className="label">Reading age</div>
                          <div className="value">
                            {live.ageMinutes !== null ? <Num v={live.ageMinutes} d={0} unit=" min" /> : '—'}
                          </div>
                        </div>
                        <div className="stat">
                          <div className="label">Status</div>
                          <div className="value" style={{ fontSize: 15 }}>
                            {live.qualifiers.includes('P')
                              ? 'Provisional'
                              : live.qualifiers.includes('A')
                                ? 'Approved'
                                : live.qualifiers.join(', ') || '—'}
                          </div>
                        </div>
                      </div>
                    )}
                    {live && live.dischargeCms === null && (
                      <div className="notice">
                        This station reports <b>gage height but not discharge</b>. Stage alone cannot
                        be turned into power without a rating curve, so it cannot drive the estimate
                        above.
                      </div>
                    )}
                    <div className="tbl-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Station</th>
                            <th>Distance</th>
                            <th>Catchment</th>
                            <th>Record</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {gauges.map((g) => {
                            const stale =
                              g.recordEnd && new Date(g.recordEnd).getTime() < Date.now() - 400 * 864e5;
                            return (
                              <tr key={g.siteNo}>
                                <td>
                                  {g.name}
                                  <br />
                                  <span className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>
                                    {g.siteNo}
                                  </span>
                                </td>
                                <td><Num v={g.distanceKm} d={1} unit=" km" /></td>
                                <td>{g.drainageAreaKm2 !== null ? <Num v={g.drainageAreaKm2} d={0} unit=" km²" /> : '—'}</td>
                                <td>
                                  {g.hasDischargeRecord ? (
                                    <>
                                      <span className="mono" style={{ fontSize: 12 }}>
                                        {g.recordStart} → {g.recordEnd}
                                      </span>
                                      <br />
                                      <span style={{ fontSize: 12, color: stale ? 'var(--warn)' : 'var(--dim)' }}>
                                        {g.recordDays?.toLocaleString()} days
                                        {stale ? ' · discontinued' : ''}
                                      </span>
                                    </>
                                  ) : (
                                    <span style={{ color: 'var(--warn)' }}>no discharge record</span>
                                  )}
                                </td>
                                <td>
                                  {g.hasDischargeRecord && (
                                    <button onClick={() => loadGaugeRecord(g.siteNo)} disabled={busy.gaugeSeries}>
                                      {busy.gaugeSeries ? 'Loading…' : 'Use this record'}
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {errs.gaugeSeries && <div className="notice bad" style={{ marginTop: 12 }}>{errs.gaugeSeries}</div>}
                    {useGauge && gaugeSeries && (
                      <div className="notice info" style={{ marginTop: 12 }}>
                        Now using the <b>measured gauge record</b> ({gaugeSeries.values.length.toLocaleString()}{' '}
                        daily values, converted from ft³/s) instead of the model.{' '}
                        <button onClick={() => setUseGauge(false)}>Back to modelled</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>

            {/* ---------------- CATCHMENT ---------------- */}
            <section>
              <h2>Catchment context</h2>
              <div className={`grid ${series ? 'two' : ''}`}>
                {series && (
                <div className="card">
                  <p className="sub" style={{ marginTop: 0 }}>
                    Mean monthly flow <Prov kind={sourceProv} />
                  </p>
                  <canvas className="months" ref={flowMonthRef} />
                  {seasonal && Number.isFinite(seasonal.ratio) && (
                    <p className="sub" style={{ marginBottom: 0 }}>
                      Wettest month <b>{MONTHS[seasonal.wettestMonth]}</b>, driest{' '}
                      <b>{MONTHS[seasonal.driestMonth]}</b> — a{' '}
                      <b><Num v={seasonal.ratio} d={1} />×</b> swing. A high ratio means most of the
                      year&rsquo;s energy arrives in a few months.
                    </p>
                  )}
                </div>
                )}
                <div className="card">
                  <p className="sub" style={{ marginTop: 0 }}>
                    Mean monthly rainfall <Prov kind="estimate" />
                  </p>
                  {busy.precip && <p className="sub"><span className="spinner" /> Loading ERA5…</p>}
                  {errs.precip && <div className="notice bad">{errs.precip}</div>}
                  <canvas className="months" ref={rainRef} />
                  {precip && (
                    <>
                      <p className="sub" style={{ marginBottom: 8 }}>
                        <b><Num v={precip.annualMeanMm} d={0} unit=" mm/yr" /></b> mean over{' '}
                        {precip.years} years ({precip.model}). This is rainfall{' '}
                        <b>at this point</b>, not averaged over the upstream catchment.
                      </p>
                      <div className="notice" style={{ fontSize: 12.5 }}>
                        <b>Treat mountain rainfall as indicative only.</b> Global reanalyses do not
                        resolve Himalayan orography. Measured against three Nepali stations, the
                        real wettest:driest contrast is about <b>16×</b>; this dataset renders it as
                        roughly 1.4× and ERA5 as 1.04×. Absolute totals in a rain shadow or on a
                        windward slope can be wrong by a factor of several.
                      </div>
                    </>
                  )}
                </div>
              </div>
            </section>

            {/* ---------------- TERRAIN ---------------- */}
            <section>
              <h2>Terrain along the reach <Prov kind="measured" /></h2>
              <div className="card">
                {!powerhouse && (
                  <p className="sub" style={{ margin: 0 }}>
                    Click a second point on the map, downstream, to measure gross head from the
                    digital elevation model instead of assuming it.
                  </p>
                )}
                {busy.terrain && <p className="sub"><span className="spinner" /> Decoding terrain tiles…</p>}
                {errs.terrain && <div className="notice bad">{errs.terrain}</div>}
                {powerhouse && profile.length > 0 && (
                  <>
                    {measuredHead !== null && measuredHead <= 0 && (
                      <div className="notice bad">
                        <b>The second point is not downstream.</b> The DEM puts it{' '}
                        <span className="mono">{Math.abs(measuredHead).toFixed(1)} m</span>{' '}
                        <b>higher</b> than the intake, which gives no usable head. The gross head
                        above is still your typed assumption — it has <b>not</b> been measured. Move
                        the powerhouse downhill.
                      </div>
                    )}
                    <canvas className="profile" ref={profRef} />
                    <p className="sub">
                      Sampled {profile.length} points from <b>{profileMeta?.source}</b> terrarium
                      tiles decoded in your browser — zoom {profileMeta?.zoom},{' '}
                      {profileMeta && Number.isFinite(profileMeta.resolutionM)
                        ? `~${profileMeta.resolutionM.toFixed(1)} m per pixel`
                        : 'resolution unknown'}
                      , {profileMeta?.tilesFetched} tiles. Elevation is bare-earth and quantised to
                      ~1/256 m by the encoding, which is far finer than the underlying data is
                      accurate — the real vertical error is several metres (SRTM-class outside the
                      US). <b>Gross head is the most error-sensitive input to the whole estimate</b>,
                      so confirm it by survey before relying on it.
                    </p>
                  </>
                )}
              </div>
            </section>

            {/* ---------------- CATCHMENT FROM HYDRORIVERS ---------------- */}
            {inNepal && (
              <section>
                <h2>Upstream catchment <Prov kind="estimate" /></h2>
                <div className="card">
                  {busy.reach && (
                    <p className="sub" style={{ margin: 0 }}>
                      <span className="spinner" /> Loading the Nepal river network…
                    </p>
                  )}
                  {errs.reach && <div className="notice bad">{errs.reach}</div>}
                  {!busy.reach && !errs.reach && !reach && (
                    <p className="sub" style={{ margin: 0 }}>
                      No mapped river reach near this point. HydroRIVERS only includes channels with
                      a catchment above 10 km² or mean flow above 0.1 m³/s, so very small streams
                      are genuinely absent.
                    </p>
                  )}
                  {reach && (
                    <>
                      {reachHit?.mainStem && (
                        <div className="notice info" style={{ marginBottom: 14 }}>
                          <b>A larger river is nearby, but we did not move your intake.</b> Your
                          selected reach has a{' '}
                          <span className="mono">{reachHit.nearest.uplandKm2.toFixed(0)} km²</span>{' '}
                          catchment. A main channel with{' '}
                          <span className="mono">{reachHit.mainStem.uplandKm2.toFixed(0)} km²</span>{' '}
                          of upstream area is{' '}
                          <span className="mono">{reachHit.mainStem.distanceKm.toFixed(2)} km</span>{' '}
                          away. Choose it only if that is the river you meant.{' '}
                          <button
                            onClick={() => {
                              const p = reachHit.mainStem!.point;
                              mapRef.current?.flyTo({ center: [p.lon, p.lat], zoom: 13 });
                              setPowerhouse(null);
                              setIntake(p);
                              setSelectionNotice('Moved to the larger HydroRIVERS channel you explicitly selected.');
                            }}
                          >
                            Use the larger channel
                          </button>
                        </div>
                      )}
                      <div className="stat-row">
                        <div className="stat">
                          <div className="label">Upstream catchment</div>
                          <div className="value"><Num v={reach.uplandKm2} d={0} unit=" km²" /></div>
                        </div>
                        <div className="stat">
                          <div className="label">Long-term mean flow</div>
                          <div className="value"><Num v={reach.meanDischargeCms} d={2} unit=" m³/s" /></div>
                        </div>
                        <div className="stat">
                          <div className="label">Stream order</div>
                          <div className="value">{reach.strahler}</div>
                        </div>
                        <div className="stat">
                          <div className="label">Reach is</div>
                          <div className="value"><Num v={reach.distanceKm} d={2} unit=" km" /></div>
                        </div>
                      </div>

                      {/* Two independent estimates of the same quantity — worth comparing. */}
                      {Number.isFinite(meanFlow) && reach.meanDischargeCms > 0 && (
                        <div
                          className={
                            Math.max(meanFlow, reach.meanDischargeCms) /
                              Math.min(meanFlow, reach.meanDischargeCms) >
                            2
                              ? 'notice bad'
                              : 'notice info'
                          }
                          style={{ marginTop: 14 }}
                        >
                          <b>Cross-check.</b> GloFAS puts the long-term mean at{' '}
                          <span className="mono">{meanFlow.toFixed(2)} m³/s</span>; HydroRIVERS says{' '}
                          <span className="mono">{reach.meanDischargeCms.toFixed(2)} m³/s</span> —{' '}
                          a{' '}
                          <b>
                            {(
                              Math.max(meanFlow, reach.meanDischargeCms) /
                              Math.min(meanFlow, reach.meanDischargeCms)
                            ).toFixed(1)}
                            ×
                          </b>{' '}
                          difference.{' '}
                          {Math.max(meanFlow, reach.meanDischargeCms) /
                            Math.min(meanFlow, reach.meanDischargeCms) >
                          2
                            ? 'That is a big disagreement between two independent models. Treat the energy estimate above as weakly constrained until a real gauge record settles it.'
                            : 'Two independent models agreeing this closely is a good sign for the flow figures above.'}
                        </div>
                      )}

                      <p className="sub" style={{ marginBottom: 0, marginTop: 12 }}>
                        From HydroRIVERS v1.0, extracted for Nepal at build time (42,197 reaches,
                        525 KB gzipped, loaded only for Nepali points). Catchment area is modelled
                        from a 15-arcsecond DEM, not surveyed. Use it to sanity-check scale, and to
                        scale flow from a gauge with a known catchment — not as a substitute for
                        delineating your own.
                      </p>
                    </>
                  )}
                </div>
              </section>
            )}

            {/* ---------------- NEPAL INDICATIVE REVENUE ---------------- */}
            {inNepal && seasons && energy && energy.gwhPerYear > 0 && (
              <section>
                <h2>Indicative revenue at NEA PPA rates <Prov kind="calculated" /></h2>
                <div className="card">
                  <div className="stat-row">
                    <div className="stat">
                      <div className="label">Wet season energy</div>
                      <div className="value"><Num v={seasons.wetGwh} d={1} unit=" GWh" /></div>
                    </div>
                    <div className="stat">
                      <div className="label">Dry season energy</div>
                      <div className="value"><Num v={seasons.dryGwh} d={1} unit=" GWh" /></div>
                    </div>
                    <div className="stat">
                      <div className="label">Dry share</div>
                      <div className="value">
                        <Num
                          v={(seasons.dryGwh / Math.max(1e-9, seasons.wetGwh + seasons.dryGwh)) * 100}
                          d={0}
                          unit="%"
                        />
                      </div>
                    </div>
                    <div className="stat">
                      <div className="label">Indicative annual revenue</div>
                      <div className="value">
                        <Num
                          v={
                            (seasons.wetGwh * 1e6 * NEPAL.ppaWetNpr +
                              seasons.dryGwh * 1e6 * NEPAL.ppaDryNpr) /
                            1e6
                          }
                          d={0}
                          unit=" M NPR"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="formula mono" style={{ marginTop: 14 }}>
                    <div className="step">
                      <span className="lhs">wet (mid-Apr–mid-Dec)</span>
                      <span className="rhs">
                        {seasons.wetGwh.toFixed(2)} GWh × NPR {NEPAL.ppaWetNpr}/kWh ={' '}
                        {((seasons.wetGwh * 1e6 * NEPAL.ppaWetNpr) / 1e6).toFixed(0)} M NPR
                      </span>
                    </div>
                    <div className="step">
                      <span className="lhs">dry (mid-Dec–mid-Apr)</span>
                      <span className="rhs">
                        {seasons.dryGwh.toFixed(2)} GWh × NPR {NEPAL.ppaDryNpr}/kWh ={' '}
                        {((seasons.dryGwh * 1e6 * NEPAL.ppaDryNpr) / 1e6).toFixed(0)} M NPR
                      </span>
                    </div>
                  </div>
                  <div className="notice" style={{ marginTop: 14 }}>
                    <b>Indicative only.</b> These are standard NEA run-of-river PPA rates
                    (NPR {NEPAL.ppaWetNpr} wet / NPR {NEPAL.ppaDryNpr} dry per kWh, with escalation
                    clauses this ignores). Revenue is not profit: it excludes capex, financing,
                    royalties, O&amp;M, transmission and the very real possibility that no PPA is
                    offered at all. A dry-season share near{' '}
                    {(NEPAL.dryEnergyShare * 100).toFixed(0)}% is typical for a Nepali scheme.
                  </div>
                </div>
              </section>
            )}

            {/* ---------------- NEPAL LICENSED PROJECTS ---------------- */}
            {inNepal && (
              <section>
                <h2>Is this river already taken? <Prov kind="measured" /></h2>
                <div className="card">
                  {busy.projects && (
                    <p className="sub" style={{ margin: 0 }}>
                      <span className="spinner" /> Loading the Nepal licence registry…
                    </p>
                  )}
                  {errs.projects && <div className="notice bad">{errs.projects}</div>}
                  {!busy.projects && !errs.projects && projects.length === 0 && (
                    <p className="sub" style={{ margin: 0 }}>
                      No licensed hydropower project within 25 km of this point in the Department of
                      Electricity Development registry. That is a genuine gap in the registry, not
                      proof that nobody holds rights here.
                    </p>
                  )}
                  {projects.length > 0 && (
                    <>
                      <div className="stat-row" style={{ marginBottom: 14 }}>
                        <div className="stat">
                          <div className="label">Projects within 25 km</div>
                          <div className="value">{projects.length}</div>
                        </div>
                        <div className="stat">
                          <div className="label">Licensed capacity nearby</div>
                          <div className="value">
                            <Num
                              v={projects.reduce((n, p) => n + (p.capacityMW ?? 0), 0)}
                              d={1}
                              unit=" MW"
                            />
                          </div>
                        </div>
                        <div className="stat">
                          <div className="label">Nearest</div>
                          <div className="value">
                            <Num v={projects[0].distanceKm} d={1} unit=" km" />
                          </div>
                        </div>
                      </div>
                      <div className="tbl-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Project</th>
                              <th>River</th>
                              <th>Capacity</th>
                              <th>Stage</th>
                              <th>Distance</th>
                            </tr>
                          </thead>
                          <tbody>
                            {projects.slice(0, 12).map((p) => (
                              <tr key={p.licenseNo + p.name}>
                                <td>
                                  {p.name}
                                  {p.promoter && (
                                    <>
                                      <br />
                                      <span style={{ fontSize: 12, color: 'var(--dim)' }}>
                                        {p.promoter}
                                      </span>
                                    </>
                                  )}
                                </td>
                                <td>{p.river || '—'}</td>
                                <td>
                                  {p.capacityMW !== null ? <Num v={p.capacityMW} d={1} unit=" MW" /> : '—'}
                                </td>
                                <td>
                                  <span className={`stage ${p.stage.toLowerCase()}`}>{p.stage || '—'}</span>
                                </td>
                                <td><Num v={p.distanceKm} d={1} unit=" km" /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="sub" style={{ marginBottom: 0 }}>
                        <b>Survey</b> = licensed to study it. <b>Generation</b> = licensed to build
                        it. <b>Operation</b> = already generating. From the Department of Electricity
                        Development registry via Open Data Nepal — 572 projects nationally. Licence
                        validity dates are Bikram Sambat. A licence here does not stop you assessing
                        the site, but it does tell you who to talk to.
                      </p>
                    </>
                  )}
                </div>
              </section>
            )}

            {/* ---------------- SEISMICITY ---------------- */}
            <section>
              <h2>Earthquake history <Prov kind="measured" /></h2>
              <div className="card">
                {busy.seismic && <p className="sub" style={{ margin: 0 }}><span className="spinner" /> Reading the USGS catalog…</p>}
                {errs.seismic && <div className="notice bad">{errs.seismic}</div>}
                {seismic && seismic.count === 0 && (
                  <p className="sub" style={{ margin: 0 }}>
                    No magnitude 4.5+ earthquake recorded within {seismic.radiusKm} km since 1900.
                  </p>
                )}
                {seismic && seismic.count > 0 && (
                  <>
                    <div className="stat-row" style={{ marginBottom: 14 }}>
                      <div className="stat">
                        <div className="label">M4.5+ within {seismic.radiusKm} km</div>
                        <div className="value">{seismic.count}</div>
                      </div>
                      {seismic.largest && (
                        <>
                          <div className="stat">
                            <div className="label">Largest recorded</div>
                            <div className="value">M{seismic.largest.mag.toFixed(1)}</div>
                          </div>
                          <div className="stat">
                            <div className="label">When</div>
                            <div className="value" style={{ fontSize: 16 }}>{seismic.largest.date}</div>
                          </div>
                          <div className="stat">
                            <div className="label">Distance</div>
                            <div className="value">
                              <Num v={seismic.largest.distanceKm} d={0} unit=" km" />
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                    <p className="sub" style={{ marginBottom: 0 }}>
                      Since 1900, from the USGS FDSN catalog. This is a record of what has
                      happened, <b>not a seismic hazard model</b> — it cannot give you a design
                      ground acceleration, and it says nothing about local site response or fault
                      proximity. Any scheme here needs a proper seismic assessment.
                    </p>
                  </>
                )}
              </div>
            </section>

            {/* ---------------- EXISTING INFRASTRUCTURE ---------------- */}
            <section>
              <h2>What already exists nearby <Prov kind="measured" /></h2>
              <div className="card">
                {busy.infra && <p className="sub"><span className="spinner" /> Querying OpenStreetMap…</p>}
                {errs.infra && (
                  <div className="notice">
                    {errs.infra}. OpenStreetMap&rsquo;s query service throttles heavy use; this does
                    not affect any other figure on the page.
                  </div>
                )}
                {!busy.infra && !errs.infra && infra.length === 0 && (
                  <p className="sub" style={{ margin: 0 }}>
                    No mapped dams, weirs, reservoirs or hydro plants within 25 km. Absence in
                    OpenStreetMap is not proof of absence on the ground.
                  </p>
                )}
                {infra.length > 0 && (
                  <div className="tbl-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Feature</th>
                          <th>Type</th>
                          <th>Capacity</th>
                          <th>Distance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {infra.slice(0, 15).map((f) => (
                          <tr key={f.id}>
                            <td>
                              {f.name ?? <span style={{ color: 'var(--dim)' }}>unnamed</span>}
                              {f.operator && (
                                <>
                                  <br />
                                  <span style={{ fontSize: 12, color: 'var(--dim)' }}>{f.operator}</span>
                                </>
                              )}
                            </td>
                            <td>
                              {f.kind}
                              {f.method === 'water-pumped-storage' && (
                                <>
                                  <br />
                                  <span style={{ fontSize: 12, color: 'var(--warn)' }}>pumped storage</span>
                                </>
                              )}
                            </td>
                            <td>{f.capacityMW !== null ? <Num v={f.capacityMW} d={1} unit=" MW" /> : '—'}</td>
                            <td><Num v={f.distanceKm} d={1} unit=" km" /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>

            {/* ---------------- EXPORT + LIMITS ---------------- */}
            <section>
              <h2>Export</h2>
              <div className="card">
                <button className="primary" onClick={exportCsv} disabled={!energy || fdc.length === 0}>
                  Download CSV
                </button>
                <p className="sub" style={{ marginBottom: 0, marginTop: 10 }}>
                  Includes a metadata header with the station or model cell, period of record, units,
                  and every assumption used, followed by the flow-duration curve and power at each
                  1% exceedance step.
                </p>
              </div>
            </section>
          </>
        )}

        <section>
          <h2>What this tool cannot see</h2>
          <div className="card">
            <ul className="limits">
              <li>Geology and foundation conditions</li>
              <li>Sediment load and reservoir sedimentation</li>
              <li>Land ownership, rights and consents</li>
              <li>Grid connection distance, capacity and cost</li>
              <li>Legally required environmental flows</li>
              <li>Fish passage and ecological impact</li>
              <li>Seismic design loads (history shown, not hazard modelled)</li>
              <li>Seasonal ice, and ice-affected gauge readings</li>
              <li>Water rights and existing abstractions</li>
              <li>Access roads and construction logistics</li>
              <li>Flood risk and spillway design</li>
              <li>Capital cost, tariff and financing</li>
              <li>Sub-daily flow variability (this uses daily means)</li>
            </ul>
            <div className="notice bad" style={{ marginTop: 14 }}>
              <b>This is prefeasibility screening, not a feasibility study.</b> Its purpose is to
              tell you whether a site is worth investigating properly. It is not evidence for an
              investment decision, a permit application, or a grid connection request.
            </div>
          </div>
        </section>

        <section>
          <h2>Provenance of every figure</h2>
          <div className="card prov-key">
            <span><Prov kind="measured" /> read from an instrument or survey</span>
            <span><Prov kind="calculated" /> this app&rsquo;s arithmetic, formula shown</span>
            <span><Prov kind="estimate" /> modelled or reanalysis-derived, limits stated</span>
          </div>
        </section>

        <footer>
          <p>
            Data: <a href="https://open-meteo.com/">Open-Meteo</a> (GloFAS river discharge,
            CC-BY 4.0) · NASA POWER (MERRA-2 precipitation) · <a href="https://waterservices.usgs.gov/">USGS Water
            Services</a> (public domain) · <a href="https://www.openstreetmap.org/copyright">
            OpenStreetMap</a> contributors via Overpass (ODbL) ·{' '}
            <a href="https://openfreemap.org/">OpenFreeMap</a> basemap (ODbL) ·{' '}
            <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (Terrarium
            DEM). MIT licensed. {anyBusy ? 'Loading…' : null}
          </p>
        </footer>
      </div>
      </main>
    </>
  );
}
