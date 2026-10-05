import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapExplorer } from './MapExplorer.tsx';
import { HydrologyComparison } from './HydrologyComparison.tsx';
import { Tour, TOUR_EVENTS, tourDone, tourWide } from './Tour.tsx';
import { buildRiverDisplay, displayGeoJson, type RiverDisplay } from './river-display.ts';
import { NEPAL_VIEW, NEPAL_BOUNDS, mapPadding, validPoint, readPreference, savePreference } from './map-navigation.ts';
import {
  fetchDischarge,
  fetchDischargeYears,
  fetchPathProfile,
  fetchProfile,
  meanOf,
  probeNeighbours,
  traceDownhill,
  type DischargeSeries,
  type ElevationProfile,
} from './api.ts';
import {
  downstreamPath,
  hasReachData,
  nearestReach,
  reachToRead,
  riversGeoJson,
  SNAP_KM,
  type Reach,
} from './rivers.ts';
import { glaciersUpstreamOf, type GlacierScreen } from './glaciers.ts';
import { assessCollectors } from './collector.ts';
import { bestTransfer, loadStationSeries, transferMeetsBar, type Transfer } from './dhm.ts';
import { discover, evaluate, SEARCH_KM, type Scheme, type SchemeInput } from './engine/discover.ts';
import {
  crossSectionPoints,
  readCrossSlopes,
  type CorridorTerrain,
} from './engine/corridor.ts';
import { chooseFlowMagnitude } from './engine/flowchoice.ts';
import { uncertaintyFor } from './engine/uncertainty.ts';
import {
  NEPAL_EFLOW_POLICY,
  enforceNepalEflowFloor,
  haversineKm,
  minMonthlyMean,
} from './engine/hydro.ts';
import { licencesAlong, loadLicences, type DoedProject } from './context.ts';
import { gaugesFor, type Gauge } from './gauges.ts';
import { gridLinesGeoJson, gridLink, gridSubstationsGeoJson } from './grid.ts';
import {
  isHardStop,
  protectedAreasGeoJson,
  protectedAt,
  protectedNear,
} from './protected.ts';
import { localContextAt, type LocalContext } from './local-gis.ts';
import { syncTopoOverlay, topoAvailable } from './topo-overlay.ts';
import { geologySheetAt, loadGeologyIndex, syncGeologyOverlay } from './geology-overlay.ts';
import { screenLandcover, type LandcoverScreen } from './landcover.ts';
import { geologyAlongPath, type GeologyTraverse } from './geology-units.ts';
import { sweepDesignFlow, type DesignFlowSweep } from './engine/designflow.ts';
import { sweepPondagePosition, type PondagePositionSweep } from './pondage.ts';
import { auditHead, auditShape, type HeadAudit, type ShapeAudit } from './audit.ts';
import { benchFit, desander, sedimentSource, type BenchFit } from './engine/sediment.ts';
import {
  fillGaps,
  measuredSpread,
  parseMeasured,
  scaleSeries,
  type MeasuredSeries,
} from './measured.ts';
import {
  RETURN_PERIODS,
  HYDEST_PROVENANCE,
  allMonthlyFlows,
  driestMonthFlow,
  drySeasonAgreement,
  monthMean,
  regionalFloodEstimate,
  type HydestScreen,
} from './engine/hydest.ts';
import { mhspScreen } from './engine/mhsp.ts';
import { osmLengthFactor, stretchPath } from './osm-rivers.ts';
import { judgeShape, correctShape } from './engine/fdcshape.ts';
import { DHM_STATISTICS_BUNDLED } from './dhm-statistics.ts';
import {
  download,
  fieldPlanToCsv,
  fileStem,
  schemesToCsv,
  schemesToGeoJson,
  type ExportContext,
} from './export.ts';
import { Reading } from './Reading.tsx';
import { distanceToNepalBoundaryKm, regionFor, type RegionMode } from './region.ts';
import { assessReadiness } from './readiness.ts';
import { HAZARD_COLORS, hazardsFor, hazardInventory } from './hazards.ts';
import { quakesGeoJson, seismicAt, type SeismicScreen } from './seismic.ts';
import { FAULT_COLOR, faultsFor } from './faults.ts';
import {
  fetchRegionalGeology,
  geologyMapsFor,
  type GeologyScreen,
  type RegionalGeologyScreen,
} from './geology.ts';
import {
  upstreamConnectivityFor,
  type UpstreamConnectivityScreen,
} from './connectivity.ts';
import { cascadeFor, type CascadeScreen } from './cascade.ts';
import {
  pondageGeoJson,
  screenPondage,
  type PondageResult,
} from './pondage.ts';
import { printDeskStudy, type ReportFigures, type ReportMeta } from './report.ts';
import {
  roadAccessGeoJson,
  screenRoadAccess,
  type RoadAccessScreen,
} from './access.ts';

export type Pt = { lat: number; lon: number };

export type Assumptions = {
  exceedance: number;
  efficiency: number;
  headLossFrac: number;
  residualFrac: number;
  householdKwh: number;
};

const DEFAULTS: Assumptions = {
  exceedance: 0.4,
  // Generator + transformer only. The turbine's own efficiency now comes from
  // its part-load curve (engine/turbine.ts).
  efficiency: 0.96,
  headLossFrac: 0.05,
  residualFrac: NEPAL_EFLOW_POLICY.minimumFractionOfLowestMonthlyMean,
  householdKwh: 900,
};

const MIN_FLOW_FRAC = 0.2;
/**
 * Hold the intake at the selected river position unless corridor search is enabled.
 */
const INTAKE_WINDOW_KM = 0;

/**
 * Driest monthly mean as a share of the annual mean, for a record with no dates.
 *
 * Measured on the 81 DHM stations holding ten or more complete years: median
 * 0.208, p10 0.131, p90 0.295. The median is used — it is the unbiased estimate
 * of the quantity the missing dates would have supplied, and the conservatism
 * belongs in `residualFrac`, which is already Nepal's policy floor, rather than
 * being smuggled a second time into this constant.
 *
 * Only ever reached when a record carries no usable dates at all. It is an
 * assumption standing in for a measurement, and the panel says so.
 */
const NO_DATE_LOW_MONTH_FRAC = 0.208;

/**
 * Half-width of the valley cross-section taken at the intake, m.
 *
 * 250 m each side reaches well past any bench a desanding basin could use — the
 * basin must be gravity-fed from the intake, so anything further out is up the
 * hillside and out of reach anyway. Sampled at 25 m, near the 30 m posting of
 * the terrain itself; going finer would interpolate the gorge walls smooth.
 */
const HALF_SECTION_M = 250;
const SECTION_SAMPLES = 21;

/** A point on the studied river with everything the engine needs. */
export type StudyPoint = {
  km: number;
  lat: number;
  lon: number;
  /**
   * Where this point is DRAWN — its position on the traced channel the map
   * shows, which differs from lat/lon by a 77 m median and up to 493 m.
   *
   * Markers and dragging use it so the intake sits on the blue line and a drop
   * onto that line picks the vertex the user aimed at. Nothing numeric does:
   * every elevation, catchment and flow figure is read at lat/lon, because
   * moving the engine onto the traced course was measured and lost on capacity.
   */
  drawnLat: number;
  drawnLon: number;
  elevationM: number;
  meanCms: number;
  /**
   * Upstream catchment HERE, km².
   *
   * `downstreamPath` has carried this per vertex all along and the type dropped
   * it, so every regional calculation used `study.reach.uplandKm2` — the area
   * at the CLICK — however far downstream the engine then chose to put the
   * intake. The search may move up to 2 km, and across 338 bundled anchors the
   * catchment grew by more than 20% within that distance at 103 of them and by
   * more than 2× at 60. So flow arbitration, HYDEST, Modified HYDEST, MHSP and
   * the sediment context could all be describing a catchment hundreds of times
   * smaller than the one the engine took its flow from.
   */
  uplandKm2: number;
  /**
   * The directed HydroRIVERS reach this point lies on.
   *
   * Carried so topology screens can ask whether two places are actually on one
   * river rather than merely near each other — the gauge relations were built
   * from a 1.5 km proximity test alone, which in a Nepali valley reaches across
   * the floor to a different watercourse.
   */
  networkIndex: number;
};

/**
 * A stand-in for a discharge record that was never fetched.
 *
 * Empty, so nothing downstream can mistake it for data: `buildFdc` returns no
 * points, `evaluate` finds no finite design flow and declines every scheme, and
 * the panel reads `flowUnavailable` to say why rather than showing a zero.
 */
const emptyFlowAt = (p: { lat: number; lon: number }): DischargeSeries => ({
  dates: [],
  values: [],
  cell: { lat: p.lat, lon: p.lon },
  elevationM: 0,
  from: 'network',
});

export type Study = {
  path: StudyPoint[];
  flow: DischargeSeries;
  /**
   * Why there is no hydrology, when there is none. Terrain, head and the scheme
   * geometry still work outside Nepal; discharge deliberately does not.
   */
  flowUnavailable?: string | null;
  dem: ElevationProfile;
  /** False when the river had to be approximated by a straight line. */
  followsRiver: boolean;
  /** True when the course came from tracing terrain, not a mapped river network. */
  tracedFromTerrain?: boolean;
  reach: Reach | null;
};

// ---------------------------------------------------------------------------

/**
 * Basemaps you can swap under the analysis, so a river can be read against
 * imagery or a contour sheet without leaving for another site.
 *
 * These are raster tiles laid over the shipped dark vector style rather than a
 * `setStyle` swap, because `setStyle` throws away every source and layer this
 * app adds and would have to rebuild the whole map on each switch. Visibility
 * costs nothing and loses nothing, the same reason the legend toggles work
 * that way.
 *
 * `keepLabels` decides where the raster is inserted. Imagery goes UNDER the
 * style's own symbol layers so Nepali place names survive on top of it; the
 * two map renderings carry their own labels, so they go over everything and
 * the dark style's white-on-dark type is not left fighting a pale basemap.
 *
 * OSM and OpenTopoMap are donation-funded volunteer tile servers whose usage
 * policies allow interactive browsing and forbid bulk fetching. `maxzoom`
 * bounds how deep a pan can dig; nothing here pre-fetches.
 */
const BASEMAPS = [
  { id: 'dark', label: 'dark', tiles: null, maxzoom: 0, attribution: '', keepLabels: true },
  {
    id: 'satellite',
    label: 'satellite',
    tiles:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxzoom: 18,
    attribution: 'Imagery: Esri, Maxar, Earthstar Geographics',
    keepLabels: true,
  },
  {
    id: 'street',
    label: 'street',
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxzoom: 18,
    attribution: '© OpenStreetMap contributors',
    keepLabels: false,
  },
  {
    id: 'topo',
    label: 'topo',
    tiles: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    maxzoom: 16,
    attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
    keepLabels: false,
  },
] as const;
type BasemapId = (typeof BASEMAPS)[number]['id'];

/**
 * What the legend can switch on and off. Groups follow the questions an
 * engineer asks — "what has this valley done", "who else is on this river",
 * "where does the power go" — not the app's internal source names.
 */
const DEFAULT_LAYERS = {
  gauges: true,
  site: true,
  access: false,
  hazards: true,
  lakes: true,
  projects: true,
  areas: true,
  geology: false,
  grid: true,
  protected: true,
  quakes: true,
  geo: true,
  labels: true,
};
type LayerToggles = typeof DEFAULT_LAYERS;

const LAYER_GROUPS: Record<Exclude<keyof LayerToggles, 'labels' | 'geology' | 'gauges'>, string[]> = {
  site: ['pondage-fill', 'pondage-dam'],
  access: ['road-access-lines', 'road-access-points'],
  hazards: ['hazards', 'hazard-labels'],
  lakes: [
    'glaciers-upstream-fill',
    'glaciers-upstream-line',
    'upstream-routes',
    'upstream-sources',
    'upstream-source-labels',
  ],
  projects: ['licences', 'licence-labels', 'cascade-routes', 'cascade-projects', 'cascade-labels'],
  areas: ['licence-area-fill', 'licence-area-line'],
  grid: ['grid-lines', 'grid-line-labels', 'grid-substations', 'grid-substation-labels'],
  protected: ['protected-area-fill', 'protected-area-line'],
  quakes: ['quakes'],
  geo: ['faults', 'geology-sheet-fill', 'geology-sheet-lines', 'geology-sheet-labels'],
};

/** Text layers, additionally gated by the global labels toggle. */
const LABEL_LAYERS = new Set([
  'hazard-labels',
  'licence-labels',
  'cascade-labels',
  'grid-line-labels',
  'grid-substation-labels',
  'geology-sheet-labels',
  'upstream-source-labels',
]);

/** A secondary intake, resolved against the river network and the terrain. */
type ExtraIntake = {
  lat: number;
  lon: number;
  elevationM: number | null;
  meanCms: number | null;
  uplandKm2: number | null;
  /** How far the pin moved to reach the mapped channel, km. */
  snappedKm: number;
  /**
   * Where this water goes if left alone, subsampled. Whether that route passes
   * the main intake is what separates a genuine tributary from the same river
   * counted twice — and it must be re-tested whenever the intake moves, so the
   * route is stored rather than the answer.
   */
  downstream: { lat: number; lon: number }[];
};

/** How close the downstream route must pass to count as "through the intake". */
const NESTED_KM = 0.3;

/**
 * Collector pins snap further than an ordinary click (SNAP_KM = 0.8).
 *
 * Someone Ctrl-clicking a second stream is aiming at a specific river they can
 * see, and the mapped centreline can sit a few hundred metres off the channel
 * they are looking at on the basemap. Refusing with "not a stream" when the
 * intent is obvious is worse than moving the pin — so it moves, and the panel
 * says how far it moved rather than pretending the click was exact.
 */
const COLLECTOR_SNAP_KM = 2;

/**
 * How close a downstream route must pass to the diverted reach to be a junction.
 *
 * Proximity alone is not enough and this was a real error: in a Himalayan gorge
 * two rivers can run 400 m apart in adjacent valleys for kilometres without
 * meeting. Geometry alone put the "confluence" 5 km above the real one and the
 * app cheerfully offered to move the intake there, losing 830 m of head for no
 * extra water. The flow test below is what makes it a junction.
 */
const JUNCTION_KM = 0.25;

/**
 * A junction must show up in the network's own discharge: the diverted reach
 * has to be carrying at least this share of the tributary's mean before we
 * call it merged. Half absorbs rounding between neighbouring reaches while
 * still refusing a river that has not actually arrived.
 */
const JUNCTION_FLOW_SHARE = 0.5;

/**
 * Zoom levels to pull back for the geological figure.
 *
 * Each level doubles the ground width, so 1.15 is about a 2.2-fold widening: a
 * 20 km frame on the scheme becomes about 45 km, wide enough to show the belt
 * and its thrusts and close enough to the tiles' own native resolution that the
 * figure is sharp.
 *
 * NOT WIDER. At 1.6 the frame ran 62 km and reached the southern neat-line of
 * the Gandaki sheet, so the bottom of the printed figure was bare — the
 * province sheets are separate publications and do not abut on the ground.
 * White space there reads as a rendering fault rather than as the edge of a
 * map, which is the wrong thing for a reader to conclude.
 */
const GEOLOGY_ZOOM_OUT = 1.15;

type UrlState = { view: { lat: number; lon: number; zoom: number }; at: Pt | null; hasView: boolean };

function readUrl(): UrlState {
  const p = new URLSearchParams(location.hash.slice(1));
  const m = p.get('at')?.split(',').map(Number);
  const v = p.get('map')?.split('/').map(Number);
  const hasView = !!(v && v.length === 3 && v.every(Number.isFinite) && v[0] >= 0 && v[0] <= 22 && validPoint({ lat: v[1], lon: v[2] }));
  const at = m && m.length === 2 && validPoint({ lat: m[0], lon: m[1] }) ? { lat: m[0], lon: m[1] } : null;
  return {
    hasView: hasView || !!at,
    view:
      hasView && v
        ? { zoom: v[0], lat: v[1], lon: v[2] }
        : at ? { ...at, zoom: 12 } : NEPAL_VIEW,
    at,
  };
}

function writeUrl(view: { lat: number; lon: number; zoom: number }, at: Pt | null) {
  const p = new URLSearchParams();
  p.set('map', `${view.zoom.toFixed(2)}/${view.lat.toFixed(4)}/${view.lon.toFixed(4)}`);
  if (at) p.set('at', `${at.lat.toFixed(5)},${at.lon.toFixed(5)}`);
  history.replaceState(null, '', `#${p}`);
}

type BadgeShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'hex';

/** Compact, labelled map symbols remain distinguishable without relying on colour alone. */
function mapBadge(label: string, color: string, shape: BadgeShape): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 40;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(20, 20);
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(0, 0, 15, 0, Math.PI * 2);
  else if (shape === 'square') ctx.rect(-14, -14, 28, 28);
  else if (shape === 'diamond') {
    ctx.moveTo(0, -17); ctx.lineTo(17, 0); ctx.lineTo(0, 17); ctx.lineTo(-17, 0); ctx.closePath();
  } else if (shape === 'triangle') {
    ctx.moveTo(0, -17); ctx.lineTo(17, 14); ctx.lineTo(-17, 14); ctx.closePath();
  } else {
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 3 * i - Math.PI / 2;
      const x = Math.cos(a) * 17;
      const y = Math.sin(a) * 17;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#0e0f11';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 15px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, shape === 'triangle' ? 3 : 0);
  return ctx.getImageData(0, 0, 40, 40);
}

// ---------------------------------------------------------------------------

export default function App() {
  const initial = useMemo(readUrl, []);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const markers = useRef<{ a?: maplibregl.Marker; b?: maplibregl.Marker }>({});
  /** Current drop handlers — markers outlive the render that created them. */
  const dropHandlers = useRef<{ a?: (p: Pt, ctrl: boolean) => void; b?: (p: Pt, ctrl: boolean) => void }>({});
  const extraMarkers = useRef<maplibregl.Marker[]>([]);
  const junctionMarkers = useRef<maplibregl.Marker[]>([]);

  /** Where the user clicked on the river. The only input the app needs. */
  const [at, setAt] = useState<Pt | null>(initial.at);
  // First run only; a skip counts as done, otherwise it nags. Hidden below 1024px with the header.
  const [tourOpen, setTourOpen] = useState(() => tourWide() && !tourDone());
  const closeTour = useCallback(() => {
    setTourOpen(false);
    try { localStorage.setItem('hydrorecon.tour.done', '1'); } catch { /* Browsing works without storage. */ }
  }, []);
  useEffect(() => { if (at) window.dispatchEvent(new Event(TOUR_EVENTS.site)); }, [at]);
  const region: RegionMode = useMemo(
    () => (at ? regionFor(at.lat, at.lon) : 'global'),
    [at]
  );
  const isNepal = region === 'nepal';
  const borderKm = useMemo(
    () => (at ? distanceToNepalBoundaryKm(at.lat, at.lon) : null),
    [at]
  );

  const [study, setStudy] = useState<Study | null>(null);
  const [displayResult, setDisplayResult] = useState<{ path: StudyPoint[]; geometry: RiverDisplay | null } | null>(null);
  const [showModelGeometry, setShowModelGeometry] = useState(false);
  const riverDisplay = displayResult?.path === study?.path ? displayResult?.geometry : null;
  useEffect(() => {
    if (!study || study.tracedFromTerrain) { setDisplayResult(null); return; }
    let cancelled = false;
    const path = study.path;
    void buildRiverDisplay(path).then((geometry) => {
      if (!cancelled) setDisplayResult({ path, geometry });
    }).catch(() => { if (!cancelled) setDisplayResult({ path, geometry: null }); });
    return () => { cancelled = true; };
  }, [study?.path]);
  /**
   * The live study, readable from inside an in-flight async callback.
   *
   * Long-running work (the site audit) captures the study it started on and
   * compares against this before writing anything back, so a result cannot
   * land on a river the user has since navigated away from.
   */
  const studyRef = useRef<Study | null>(null);
  useEffect(() => {
    studyRef.current = study;
  }, [study]);
  const [assume, setAssume] = useState<Assumptions>(DEFAULTS);
  const effectiveResidualFrac = isNepal
    ? enforceNepalEflowFloor(assume.residualFrac)
    : assume.residualFrac;
  const effectiveAssume = useMemo(
    () => ({ ...assume, residualFrac: effectiveResidualFrac }),
    [assume, effectiveResidualFrac]
  );
  // A user can select 0% in global mode and then move into Nepal. Do not let
  // that prior jurisdiction's scenario survive below Nepal's published floor.
  useEffect(() => {
    if (isNepal && assume.residualFrac < effectiveResidualFrac) {
      setAssume((current) => ({ ...current, residualFrac: effectiveResidualFrac }));
    }
  }, [isNepal, assume.residualFrac, effectiveResidualFrac]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [neighbours, setNeighbours] = useState<{ lat: number; lon: number; meanCms: number }[] | null>(null);
  /** Chosen intake/powerhouse indices into study.path. */
  const [pick, setPick] = useState<{ i: number; j: number } | null>(null);
  const [tweaked, setTweaked] = useState(false);
  /** Sweep the whole downstream reach instead of anchoring to the click. */
  const [wideSearch, setWideSearch] = useState(false);
  const [maxWaterwayKm, setMaxWaterwayKm] = useState(6);
  /**
   * Secondary intakes feeding the same powerhouse — a collector scheme, the
   * Khimti pattern. Spawned by Ctrl-dragging the intake pin onto a tributary.
   */
  const [extraIntakes, setExtraIntakes] = useState<ExtraIntake[]>([]);
  /**
   * Where each collector's link canal meets the main waterway, when the
   * engineer has moved it.
   *
   * The default is the closest point on the waterway, which is the shortest
   * canal and often the wrong one — the shortest line between a tributary and
   * the headrace can run straight over a spur. Keyed by collector index; an
   * absent entry means "use the default".
   */
  const [junctionOverride, setJunctionOverride] = useState<Record<number, number>>({});
  useEffect(() => {
    setExtraIntakes([]);
    setJunctionOverride({});
  }, [at]);
  /** Licensed and operating projects sitting on the studied reach. */
  const [doedProjects, setDoedProjects] = useState<DoedProject[] | null>(null);
  const [gauges, setGauges] = useState<Gauge[] | null>(null);
  /** A gauge record the engineer supplied, which outranks every model here. */
  const [measured, setMeasured] = useState<{ series: MeasuredSeries; ratio: number; name: string } | null>(null);
  /** Results of the on-request site audit — measured, never assumed. */
  const [audit, setAudit] = useState<{
    head: HeadAudit | null;
    shape: ShapeAudit | null;
    years: number | null;
    error: string | null;
  } | null>(null);
  const [auditBusy, setAuditBusy] = useState<string | null>(null);
  const auditGeneration = useRef(0);
  const auditTarget = useRef({ study, i: pick?.i, j: pick?.j, measured });
  auditTarget.current = { study, i: pick?.i, j: pick?.j, measured };
  /** Canal-vs-tunnel read along the chosen waterway; null until terrain arrives. */
  const [corridor, setCorridor] = useState<CorridorTerrain | null>(null);
  /** Retained level above the DEM-detected channel floor at the intake. */
  const [pondageHeightM, setPondageHeightM] = useState(10);
  const [pondageState, setPondageState] = useState<{
    result: PondageResult | null;
    busy: boolean;
    error: string | null;
  }>({ result: null, busy: false, error: null });
  const [roadAccessState, setRoadAccessState] = useState<{
    result: RoadAccessScreen | null;
    busy: boolean;
    error: string | null;
  }>({ result: null, busy: false, error: null });
  /**
   * What the waterway crosses. Null means NOT SCREENED — a production build has
   * no land-cover route and a site outside Nepal has no store — never "no
   * forest". The two read the same in a summary and only one of them is safe.
   */
  const [landcover, setLandcover] = useState<LandcoverScreen | null>(null);
  /** Storage against POSITION along the reach, at the height on the slider. */
  const [pondageSweep, setPondageSweep] = useState<PondagePositionSweep | null>(null);

  const atRef = useRef(at);
  atRef.current = at;
  /** For the map's click handler, which is bound once and outlives renders. */
  const schemeRef = useRef<Scheme | null>(null);

  // ---------------- map ----------------
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapEl.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [initial.view.lon, initial.view.lat],
      zoom: initial.view.zoom,
      attributionControl: { compact: true },
      /**
       * Required for figure capture. WebGL discards the drawing buffer after
       * compositing unless asked not to, and getCanvas().toDataURL() then
       * returns a blank image — which is exactly what the report would have
       * embedded, silently. The cost is one extra buffer of video memory.
       */
      canvasContextAttributes: { preserveDrawingBuffer: true },
      refreshExpiredTiles: false,
      fadeDuration: 0,
      maxTileCacheZoomLevels: 10,
    });
    map.current = m;
    if (!initial.hasView) {
      m.fitBounds([[NEPAL_BOUNDS.west, NEPAL_BOUNDS.south], [NEPAL_BOUNDS.east, NEPAL_BOUNDS.north]], { padding: mapPadding(), duration: 0 });
    }
    (window as unknown as { __map: maplibregl.Map }).__map = m;
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    const ro = new ResizeObserver(() => m.resize());
    ro.observe(mapEl.current);
    requestAnimationFrame(() => m.resize());

    m.on('styleimagemissing', (e) => {
      if (m.hasImage(e.id)) return;
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#26352f';
      ctx.fillRect(0, 0, 8, 8);
      m.addImage(e.id, ctx.getImageData(0, 0, 8, 8));
    });

    m.on('load', () => {
      const firstWater = m.getStyle().layers?.find((l) => l.id === 'water')?.id;
      const firstSymbol = m.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
      for (const b of BASEMAPS) {
        if (!b.tiles) continue;
        m.addSource(`basemap-${b.id}`, {
          type: 'raster',
          tiles: [b.tiles],
          tileSize: 256,
          maxzoom: b.maxzoom,
          attribution: b.attribution,
        });
        m.addLayer(
          {
            id: `basemap-${b.id}`,
            type: 'raster',
            source: `basemap-${b.id}`,
            layout: { visibility: 'none' },
            paint: { 'raster-fade-duration': 0 },
          },
          // Undefined appends, which at load time is the top of the base style
          // and still below every overlay this app adds afterwards.
          b.keepLabels ? firstSymbol : undefined
        );
      }
      m.addSource('dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 12, // measured: DEM was 84% of bytes on zoom
        attribution: 'Terrain: AWS Terrain Tiles',
      });
      m.addLayer(
        {
          id: 'hillshade',
          type: 'hillshade',
          source: 'dem',
          minzoom: 5,
          // Above the source maxzoom on purpose: MapLibre overzooms the z12
          // tiles, so relief keeps drawing at site scale for no extra bytes.
          maxzoom: 16,
          paint: {
            'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 11, 0.5, 14, 0.22],
            // Neutral rock-grey relief. The old steel-blue highlight tinted the
            // entire country the same hue as the rivers, and both disappeared.
            'hillshade-shadow-color': '#030405',
            'hillshade-highlight-color': '#5a6169',
            'hillshade-accent-color': '#0f1114',
          },
        },
        firstWater
      );
      if (m.getLayer('water')) m.setPaintProperty('water', 'fill-color', '#1b3540');
      if (m.getLayer('waterway')) {
        m.setPaintProperty('waterway', 'line-color', '#4fc1d8');
        m.setPaintProperty('waterway', 'line-opacity', 0.8);
      }

      const badges: [string, string, string, BadgeShape][] = [
        ['hazard-landslide', 'L', HAZARD_COLORS.landslide, 'triangle'],
        ['hazard-flood', 'F', HAZARD_COLORS.flood, 'square'],
        ['hazard-earthquake', 'E', HAZARD_COLORS.earthquake, 'diamond'],
        ['hazard-glof', 'G', HAZARD_COLORS.glof, 'hex'],
        ['hazard-avalanche', 'A', HAZARD_COLORS.avalanche, 'triangle'],
        ['hazard-inundation', 'I', HAZARD_COLORS.inundation, 'square'],
        ['glacial-lake', 'G', '#8bd3e6', 'hex'],
        ['doed-operating', 'H', '#e06552', 'square'],
        ['doed-construction', 'H', '#d2a04a', 'square'],
        ['doed-study', 'H', '#9aa1a9', 'circle'],
        ['cascade-up', 'U', '#c58af9', 'diamond'],
        ['cascade-down', 'D', '#65c8a3', 'diamond'],
        // Substations carry the same voltage ramp as the lines they terminate,
        // so a 132 kV yard and the 132 kV line feeding it read as one system.
        ['sub-0', '+', '#6d747c', 'square'],
        ['sub-33', '+', '#9aa1a9', 'square'],
        ['sub-66', '+', '#b5a46a', 'square'],
        ['sub-132', '+', '#e0bd55', 'square'],
        ['sub-220', '+', '#f29f4b', 'square'],
        ['sub-400', '+', '#e8794f', 'square'],
      ];
      for (const [id, label, color, shape] of badges) {
        if (!m.hasImage(id)) m.addImage(id, mapBadge(label, color, shape), { pixelRatio: 2 });
      }

      // National layers that the summary refers to must also be visible on the map.
      m.addSource('protected-areas', { type: 'geojson', data: protectedAreasGeoJson() });
      m.addLayer({
        id: 'protected-area-fill',
        type: 'fill',
        source: 'protected-areas',
        minzoom: 5,
        paint: {
          'fill-color': ['match', ['get', 'kind'], 'national_park', '#63b981', '#8abf76'],
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.035, 10, 0.1],
        },
      });
      m.addLayer({
        id: 'protected-area-line',
        type: 'line',
        source: 'protected-areas',
        minzoom: 5,
        paint: {
          'line-color': '#79c58d',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 12, 2],
          'line-opacity': 0.8,
          'line-dasharray': [3, 2],
        },
      });
      m.on('click', 'protected-area-line', (e) => {
        const p = e.features?.[0]?.properties as
          | { name: string; regime: string; areaKm2: number }
          | undefined;
        if (!p) return;
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.name}</b><br/><span style="color:#9aa1a9">${p.regime} · ${Math.round(p.areaKm2).toLocaleString()} km²</span>` +
              `<br/><span style="color:#9aa1a9">Simplified OSM boundary; confirm with DNPWC.</span>`
          )
          .addTo(m);
      });

      m.addSource('grid-lines', { type: 'geojson', data: gridLinesGeoJson() });
      m.addLayer({
        id: 'grid-lines',
        type: 'line',
        source: 'grid-lines',
        minzoom: 6,
        paint: {
          'line-color': [
            'step', ['get', 'kv'], '#6d747c', 66, '#b5a46a', 132, '#e0bd55', 220, '#f29f4b', 400, '#e8794f',
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 12, 2.2],
          'line-opacity': ['case', ['==', ['get', 'kv'], 0], 0.24, 0.78],
        },
      });
      // Label glyphs must come from the basemap's own font stack — asking for a
      // font the style does not ship renders nothing at all.
      const styleFont = (() => {
        for (const l of m.getStyle().layers ?? []) {
          const f = (l as { layout?: Record<string, unknown> }).layout?.['text-font'];
          if (Array.isArray(f) && typeof f[0] === 'string') return f as string[];
        }
        return ['Noto Sans Regular'];
      })();

      // The voltage, read straight off the line — the first question an
      // engineer asks of any line in view, answered without a click.
      m.addLayer({
        id: 'grid-line-labels',
        type: 'symbol',
        source: 'grid-lines',
        minzoom: 9.5,
        filter: ['>', ['get', 'kv'], 0],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['concat', ['to-string', ['get', 'kv']], ' kV'],
          'text-font': styleFont,
          'text-size': 10,
          'symbol-spacing': 420,
        },
        paint: {
          'text-color': ['step', ['get', 'kv'], '#b5a46a', 132, '#e0bd55', 220, '#f29f4b', 400, '#e8794f'],
          'text-halo-color': '#0b0c0e',
          'text-halo-width': 1.4,
        },
      });

      m.addSource('grid-substations', { type: 'geojson', data: gridSubstationsGeoJson() });
      m.addLayer({
        id: 'grid-substations',
        type: 'symbol',
        source: 'grid-substations',
        minzoom: 8,
        layout: {
          'icon-image': ['step', ['get', 'kv'], 'sub-0', 33, 'sub-33', 66, 'sub-66', 132, 'sub-132', 220, 'sub-220', 400, 'sub-400'],
          // Bigger yards draw bigger: a 220 kV connection point should be
          // findable at a glance, an 11/33 kV bazaar feed should not compete.
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            8, ['step', ['get', 'kv'], 0.55, 66, 0.64, 132, 0.74, 220, 0.84],
            13, ['step', ['get', 'kv'], 0.85, 66, 0.95, 132, 1.1, 220, 1.25],
          ],
          'icon-allow-overlap': false,
        },
        paint: {
          // A distribution yard is a landmark, not a connection point.
          'icon-opacity': ['case', ['==', ['get', 'kind'], 'distribution'], 0.45, 1],
        },
      });
      m.addLayer({
        id: 'grid-substation-labels',
        type: 'symbol',
        source: 'grid-substations',
        minzoom: 10.5,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': styleFont,
          'text-size': 10.5,
          'text-anchor': 'top',
          'text-offset': [0, 0.9],
          'text-max-width': 9,
        },
        paint: {
          'text-color': '#d9c98f',
          'text-halo-color': '#0b0c0e',
          'text-halo-width': 1.3,
          'text-opacity': ['case', ['==', ['get', 'kind'], 'distribution'], 0.55, 0.95],
        },
      });
      m.on('click', 'grid-substations', (e) => {
        const p = e.features?.[0]?.properties as
          | { name: string; kv: number; kind?: string; inferred?: number }
          | undefined;
        if (!p) return;
        const kv = p.kv
          ? `${p.kv} kV${p.inferred ? ' (inferred from a connecting line)' : ''}`
          : 'voltage not tagged';
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(`<b>${p.name}</b><br/><span style="color:#9aa1a9">${kv} · ${p.kind || 'unclassified'} · OSM/NEA context</span>`)
          .addTo(m);
      });

      // A century of instrumented earthquakes, USGS ComCat. Circles rather
      // than symbols: at country zoom the PATTERN — the Main Himalayan Thrust
      // lighting up as a belt — is the information, not any single event.
      m.addSource('quakes', { type: 'geojson', data: quakesGeoJson() });
      m.addLayer({
        id: 'quakes',
        type: 'circle',
        source: 'quakes',
        minzoom: 6,
        paint: {
          'circle-color': HAZARD_COLORS.earthquake,
          'circle-opacity': ['interpolate', ['linear'], ['get', 'm'], 4, 0.22, 6, 0.5, 7.5, 0.75],
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            6, ['interpolate', ['linear'], ['get', 'm'], 4, 1.4, 6, 4, 8, 9],
            12, ['interpolate', ['linear'], ['get', 'm'], 4, 3, 6, 8, 8, 18],
          ],
          'circle-stroke-color': '#0b0c0e',
          'circle-stroke-width': 0.5,
        },
      });
      m.on('click', 'quakes', (e) => {
        const p = e.features?.[0]?.properties as { m: number; y: number; d: number } | undefined;
        if (!p) return;
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>M${p.m} earthquake · ${p.y}</b><br/><span style="color:#9aa1a9">${p.d} km deep · USGS instrumented catalog</span>` +
              `<br/><span style="color:#9aa1a9">An epicentre, not a shaking footprint — Gorkha 2015 was IX in Kathmandu from 77 km away.</span>`
          )
          .addTo(m);
      });

      /**
       * National borders, drawn on purpose rather than left to the basemap.
       *
       * The engineer's first orientation question on a country-scale view is
       * "where is Nepal" — and the basemap's own hairline drowned under the
       * hillshade. A dark casing under a sand-coloured line reads on ridge and
       * shadow alike, and sand is deliberately neither the river teal nor any
       * alert colour: a border is geography, not a warning.
       */
      const vectorSource = Object.entries(m.getStyle().sources).find(
        ([, s]) => (s as { type?: string }).type === 'vector'
      )?.[0];
      if (vectorSource) {
        const national = [
          'all',
          ['==', ['get', 'admin_level'], 2],
          ['!=', ['get', 'maritime'], 1],
        ] as maplibregl.FilterSpecification;
        m.addLayer({
          id: 'border-casing',
          type: 'line',
          source: vectorSource,
          'source-layer': 'boundary',
          filter: national,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#000000',
            'line-opacity': 0.5,
            'line-blur': 1.4,
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2.4, 8, 4.6],
          },
        });
        m.addLayer({
          id: 'border-line',
          type: 'line',
          source: vectorSource,
          'source-layer': 'boundary',
          filter: national,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#cfc7a8',
            'line-opacity': 0.9,
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.3, 8, 2],
            // Disputed stretches stay visible but honest.
            'line-dasharray': ['case', ['==', ['get', 'disputed'], 1], ['literal', [2, 2]], ['literal', [1, 0]]],
          },
        });
      }

      // Approved, verified BIPAD reports near the selected layout. Only
      // corridor hits are loaded here, not all national records, so the points
      // cannot masquerade as a susceptibility surface.
      // Official DMG publication footprints touched by the selected layout.
      // The map image itself is not bundled or drawn: DMG labels the online
      // previews publication information and sells usable maps in hard copy.
      m.addSource('geology-sheets', { type: 'geojson', data: empty() });
      // Capped at z12: past that only one edge of the big rectangle fits the
      // screen, and a lone dashed line at site zoom reads as a mystery UI
      // artifact, not a document footprint. The panel's geology section keeps
      // the same links at every zoom.
      m.addLayer({
        id: 'geology-sheet-fill',
        type: 'fill',
        source: 'geology-sheets',
        maxzoom: 12,
        paint: {
          'fill-color': '#b79bdb',
          'fill-opacity': 0.035,
        },
      });
      m.addLayer({
        id: 'geology-sheet-lines',
        type: 'line',
        source: 'geology-sheets',
        maxzoom: 12,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#b79bdb',
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1, 13, 2.2],
          'line-opacity': 0.82,
          'line-dasharray': [3, 2],
        },
      });
      // Say what the rectangle IS, on the rectangle. An unlabelled dashed box
      // reads as a selection artifact, not as "a published map covers this".
      m.addLayer({
        id: 'geology-sheet-labels',
        type: 'symbol',
        source: 'geology-sheets',
        minzoom: 9,
        maxzoom: 12,
        layout: {
          // Along the dashed edge itself, like the title block on a survey
          // sheet — a centroid anchor vanishes whenever it scrolls off-tile.
          'symbol-placement': 'line',
          'symbol-spacing': 500,
          'text-field': ['get', 'label'],
          'text-font': styleFont,
          'text-size': 9.5,
        },
        paint: {
          'text-color': '#c9b3e6',
          'text-halo-color': '#0b0c0e',
          'text-halo-width': 1.3,
          'text-opacity': 0.85,
        },
      });
      m.on('click', 'geology-sheet-lines', (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as {
          title: string;
          year: string;
          sheet: string;
          previewUrl: string;
        };
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.title}</b><br/><span style="color:#9aa1a9">DMG 1:50,000 · sheet ${p.sheet} · ${p.year}</span>` +
              `<br/><span style="color:#9aa1a9">Footprint marks publication availability, not mapped site geology.</span>` +
              `<br/><a href="${p.previewUrl}" target="_blank" rel="noopener">official low-resolution preview ↗</a>`
          )
          .addTo(m);
      });

      // Regional active-fault traces near the selected reach. These are GEM /
      // HimaTibetMap context lines, not site-survey geometry. They stay dashed
      // so they cannot be mistaken for either the river or a project alignment.
      m.addSource('faults', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'faults',
        type: 'line',
        source: 'faults',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': FAULT_COLOR,
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.1, 13, 2.5],
          'line-opacity': 0.8,
          'line-dasharray': [2, 1.5],
        },
      });
      m.on('click', 'faults', (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as {
          name: string;
          type: string;
          sourceId: string;
          distance: string;
          intersection: string;
        };
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.name || 'Unnamed mapped trace'}</b><br/><span style="color:#9aa1a9">${p.type} · GEM ${p.sourceId}</span>` +
              `<br/><span style="color:#9aa1a9">${p.intersection === 'yes' ? 'intersects selected mapped river reach' : `${p.distance} km from reach`}</span>` +
              `<br/><a href="https://github.com/GEMScienceTools/gem-global-active-faults" target="_blank" rel="noopener">GEM source and references ↗</a>`
          )
          .addTo(m);
      });

      // Directed channel-topology candidates upstream of the intake. Lines are
      // deliberately dashed: they are HydroRIVERS walks, not simulated runout
      // or a design flood envelope.
      m.addSource('upstream-routes', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'upstream-routes',
        type: 'line',
        source: 'upstream-routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match', ['get', 'sourceType'],
            'lake', '#8bd3e6',
            '#d2a04a',
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.7, 13, 2.2],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.16, 10, 0.58],
          'line-dasharray': [2, 2],
        },
      });
      /**
       * Connected ice, under the lakes rather than over them.
       *
       * Figure 11 used to be 43 anonymous dots on a 151 km frame with the
       * alignment a squiggle in one corner: it proved lakes exist upstream and
       * answered nothing else. The ice is what a reader is looking for when they
       * ask which glacier feeds this river, and it is what makes the lakes read
       * as a chain rather than a scatter.
       */
      m.addSource('glaciers-upstream', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'glaciers-upstream-fill',
        type: 'fill',
        source: 'glaciers-upstream',
        paint: { 'fill-color': '#8fd6ef', 'fill-opacity': 0.45 },
      });
      m.addLayer({
        id: 'glaciers-upstream-line',
        type: 'line',
        source: 'glaciers-upstream',
        paint: { 'line-color': '#4aa8cc', 'line-width': 0.7, 'line-opacity': 0.9 },
      });
      m.addSource('upstream-sources', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'upstream-sources',
        type: 'symbol',
        source: 'upstream-sources',
        layout: {
          'icon-image': [
            'case',
            // ICIMOD's 47 potentially dangerous lakes wear the GLOF badge; an
            // ordinary mapped lake stays the quiet ice-blue one.
            ['==', ['get', 'sourceType'], 'lake'],
            ['case', ['==', ['get', 'pdgl'], 1], 'hazard-glof', 'glacial-lake'],
            ['match', ['get', 'kind'],
              'landslide', 'hazard-landslide',
              'flood', 'hazard-flood',
              'glof', 'hazard-glof',
              'avalanche', 'hazard-avalanche',
              'inundation', 'hazard-inundation',
              'hazard-flood'],
          ],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.65, 13, 1],
          'icon-allow-overlap': true,
        },
      });
      /**
       * Off in the app, on for the figure. On screen these labels stack on top
       * of every lake at once and the map stops being readable; in a framed
       * capture of the few lakes that matter, the flow-path distance IS the
       * finding and a dot without it says nothing at all.
       */
      m.addLayer({
        id: 'upstream-source-labels',
        type: 'symbol',
        source: 'upstream-sources',
        filter: ['==', ['get', 'sourceType'], 'lake'],
        layout: {
          visibility: 'none',
          'text-field': [
            'case',
            ['==', ['get', 'pdgl'], 1],
            ['concat', ['get', 'pdglName'], ' — ', ['get', 'route'], ' km'],
            ['concat', ['get', 'route'], ' km'],
          ],
          'text-size': ['case', ['==', ['get', 'pdgl'], 1], 12, 10],
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': '#0b6a9e',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.6,
        },
      });

      m.on('click', 'upstream-sources', (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as {
          sourceType: string;
          id: string;
          title: string;
          detail: string;
          route: string;
          snap: string;
          url: string;
        };
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.title}</b><br/><span style="color:#9aa1a9">${p.detail}</span>` +
              `<br/><span style="color:#9aa1a9">${p.route} km directed route · ${p.snap} km vertex snap</span>` +
              `<br/><span style="color:#9aa1a9">Channel-connectivity candidate only—not runout or GLOF exposure.</span>` +
              `<br/><a href="${p.url}" target="_blank" rel="noopener">${p.sourceType === 'lake' ? 'open lake dataset' : 'official BIPAD record'} ↗</a>`
          )
          .addTo(m);
      });

      m.addSource('hazards', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'hazards',
        type: 'symbol',
        source: 'hazards',
        layout: {
          'icon-image': [
            'match',
            ['get', 'kind'],
            'landslide', 'hazard-landslide',
            'flood', 'hazard-flood',
            'earthquake', 'hazard-earthquake',
            'glof', 'hazard-glof',
            'avalanche', 'hazard-avalanche',
            'inundation', 'hazard-inundation',
            'hazard-flood',
          ],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 13, 1],
          'icon-allow-overlap': true,
        },
        paint: {
          // Recent reports carry the live risk signal; decade-old ones stay
          // visible but stop shouting.
          'icon-opacity': ['interpolate', ['linear'], ['coalesce', ['get', 'age'], 0], 3, 1, 12, 0.55],
        },
      });
      m.addLayer({
        id: 'hazard-labels',
        type: 'symbol',
        source: 'hazards',
        minzoom: 11,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': styleFont,
          'text-size': 10,
          'text-anchor': 'top',
          'text-offset': [0, 0.9],
          'text-max-width': 10,
        },
        paint: {
          'text-color': '#c9ced4',
          'text-halo-color': '#0b0c0e',
          'text-halo-width': 1.3,
          'text-opacity': ['interpolate', ['linear'], ['coalesce', ['get', 'age'], 0], 3, 0.95, 12, 0.6],
        },
      });
      m.on('click', 'hazards', (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as {
          id: number;
          title: string;
          date: string;
          distance: string;
        };
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.title}</b><br/><span style="color:#9aa1a9">${p.date}${p.distance ? ` · ${p.distance} km from reach` : ' · historical report'}</span>` +
              `<br/><a href="https://bipadportal.gov.np/incidents/${p.id}/response" target="_blank" rel="noopener">official BIPAD record ↗</a>`
          )
          .addTo(m);
      });

      // Official DoED records already on or proposed for this river.
      /**
       * The licence boxes.
       *
       * DoED licences a COORDINATE RANGE, not a point, and the register
       * publishes that range for 1,169 of 1,175 records. The map has always
       * drawn the centre and thrown the extent away, which loses the one thing
       * a screener most needs to know: how much of this river is already
       * claimed, and by whom. A new intake inside someone else's licence box is
       * not a new scheme.
       *
       * It is an administrative extent, not a surveyed boundary — the median
       * diagonal is 4.2 km, which is a plausible headworks-to-powerhouse span,
       * but 33 records exceed 20 km and the largest is 114 km. Drawn faintly and
       * dashed for that reason: it marks a claim, not a footprint.
       *
       * Added BEFORE the licence symbols so the markers stay on top and stay
       * clickable.
       */
      /**
       * Intake and powerhouse, drawn INTO THE CANVAS for report figures.
       *
       * The pair the user sees are maplibregl.Marker instances, which are HTML
       * elements positioned over the map — and getCanvas().toDataURL() reads
       * the WebGL canvas only. So every captured figure showed the waterway
       * running between two invisible endpoints, and the one thing a layout
       * figure has to show was the one thing missing from it.
       *
       * Hidden in normal use; captureFigures turns it on for the shot.
       */
      /**
       * DHM gauging stations, for the report's gauge figure.
       *
       * They have never been on the map at all — the panel and the report both
       * described them in words and a reader had no way to see whether a
       * station sat on the intake, on the tailrace, or up a side valley. Same
       * trick as the intake/powerhouse pair: drawn into the CANVAS so a capture
       * picks them up, hidden until the capture asks for them.
       *
       * A square, not a circle. On the printed figure it has to be
       * distinguishable from the two round scheme ends at a glance, and shape
       * survives a grey print where colour does not.
       */
      m.addSource('report-gauges', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'report-gauges-dot',
        type: 'circle',
        source: 'report-gauges',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 6,
          /**
           * Colour carries USABILITY, and BOTH states are filled.
           *
           * A strong blue mark is a record you can transfer; a slate one is
           * not. They were previously blue-filled against WHITE-filled, which
           * worked on the dark app basemap and vanished completely on the
           * report's white relief ground — the printed figure showed a single
           * station as a faint smudge and a reader said they could not see the
           * stations at all. They were there. Hue still separates the two, a
           * white casing keeps both legible on any ground, and the solid-versus
           * -hollow distinction is kept where it still works: the chart.
           */
          'circle-color': ['case', ['get', 'usable'], '#0b6a9e', '#5c6f7d'],
          'circle-stroke-width': 2.6,
          'circle-stroke-color': '#ffffff',
        },
      });
      m.addLayer({
        id: 'report-gauges-label',
        type: 'symbol',
        source: 'report-gauges',
        layout: {
          visibility: 'none',
          'text-field': ['get', 'label'],
          'text-font': styleFont,
          'text-size': 12,
          'text-anchor': 'top',
          /**
           * FURTHER DOWN, AND NEVER DROPPED.
           *
           * The best station on the first real site sits 0.1 km from the intake
           * — the same point at this scale — so with collision detection on,
           * MapLibre kept the INTAKE label and silently discarded the one that
           * actually mattered. A figure that hides its most important label
           * because two things are close together is worse than a slightly
           * crowded one, so the label is placed clear of the scheme's own and
           * allowed to overlap rather than vanish.
           */
          'text-offset': [0, 1.9],
          'text-allow-overlap': true,
          'text-optional': false,
        },
        paint: {
          // Near-black on a thick white halo. Dark green looked like a stain on
          // grey relief and lost every contrast fight it entered.
          'text-color': ['case', ['get', 'usable'], '#0b3f5c', '#4b555c'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 2.8,
        },
      });

      m.addSource('report-ends', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'report-ends-dot',
        type: 'circle',
        source: 'report-ends',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 7,
          'circle-color': ['case', ['==', ['get', 'role'], 'intake'], '#38bde8', '#f0a04b'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });
      m.addLayer({
        id: 'report-ends-label',
        type: 'symbol',
        source: 'report-ends',
        layout: {
          visibility: 'none',
          'text-field': ['get', 'label'],
          'text-font': styleFont,
          'text-size': 15,
          'text-anchor': 'top',
          'text-offset': [0, 0.95],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0b0c0e',
          'text-halo-width': 2,
        },
      });

      m.addSource('licence-areas', { type: 'geojson', data: empty() });
      const areaColour: maplibregl.ExpressionSpecification = [
        'case',
        ['==', ['get', 'stage'], 'Operating'], '#eb9484',
        ['in', ['get', 'stage'], ['literal', ['Construction licence', 'Construction application']]], '#ddb072',
        '#aab1b9',
      ];
      m.addLayer({
        id: 'licence-area-fill',
        type: 'fill',
        source: 'licence-areas',
        paint: { 'fill-color': areaColour, 'fill-opacity': 0.07 },
      });
      m.addLayer({
        id: 'licence-area-line',
        type: 'line',
        source: 'licence-areas',
        paint: {
          'line-color': areaColour,
          'line-width': 1.1,
          'line-opacity': 0.55,
          'line-dasharray': [3, 2],
        },
      });

      m.addSource('licences', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'licences',
        type: 'symbol',
        source: 'licences',
        layout: {
          'icon-image': [
            'case',
            ['==', ['get', 'stage'], 'Operating'], 'doed-operating',
            ['in', ['get', 'stage'], ['literal', ['Construction licence', 'Construction application']]], 'doed-construction',
            'doed-study',
          ],
          // A 100 MW neighbour matters more than a 2 MW one; let the size say so.
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            8, ['step', ['coalesce', ['get', 'capN'], 0], 0.6, 5, 0.72, 25, 0.8, 100, 0.92],
            13, ['step', ['coalesce', ['get', 'capN'], 0], 0.9, 5, 1.05, 25, 1.18, 100, 1.35],
          ],
          'icon-allow-overlap': true,
        },
      });
      m.addLayer({
        id: 'licence-labels',
        type: 'symbol',
        source: 'licences',
        minzoom: 10,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': styleFont,
          'text-size': 10.5,
          'text-anchor': 'top',
          'text-offset': [0, 0.95],
          'text-max-width': 9,
        },
        paint: {
          'text-color': [
            'case',
            ['==', ['get', 'stage'], 'Operating'], '#eb9484',
            ['in', ['get', 'stage'], ['literal', ['Construction licence', 'Construction application']]], '#ddb072',
            '#aab1b9',
          ],
          'text-halo-color': '#0b0c0e',
          'text-halo-width': 1.3,
        },
      });
      m.on('click', 'licences', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as {
          name: string; stage: string; cap: string; promoter: string; rangeKm: string;
        };
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.name}</b><br/><span style="color:#9aa1a9">${p.stage}` +
              `${p.cap ? ` · ${p.cap} MW` : ''}${p.promoter ? `<br/>${p.promoter}` : ''}</span>` +
              `<br/><span style="color:#d2a04a">This dot is the centre of DoED's published ` +
              `${p.rangeKm} km coordinate range, not the intake or powerhouse. ` +
              `The real works sit somewhere inside it.</span>`
          )
          .addTo(m);
      });

      // DoED project midpoints connected by directed HydroRIVERS topology.
      // These are intentionally distinct from direct reach conflicts above:
      // they are leads for cascade-interface checks, not project alignments.
      m.addSource('cascade-routes', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'cascade-routes',
        type: 'line',
        source: 'cascade-routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match', ['get', 'direction'],
            'upstream', '#c58af9',
            '#65c8a3',
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 13, 2.4],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.14, 10, 0.62],
          'line-dasharray': [3, 2],
        },
      });
      m.addSource('cascade-projects', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'cascade-projects',
        type: 'symbol',
        source: 'cascade-projects',
        layout: {
          'icon-image': [
            'match', ['get', 'direction'],
            'upstream', 'cascade-up',
            'cascade-down',
          ],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.66, 13, 1],
          'icon-allow-overlap': true,
        },
      });
      m.addLayer({
        id: 'cascade-labels',
        type: 'symbol',
        source: 'cascade-projects',
        minzoom: 9.5,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': styleFont,
          'text-size': 10,
          'text-anchor': 'top',
          'text-offset': [0, 0.95],
          'text-max-width': 9,
        },
        paint: {
          'text-color': ['match', ['get', 'direction'], 'upstream', '#d3b2f7', '#8fd7bb'],
          'text-halo-color': '#0b0c0e',
          'text-halo-width': 1.3,
        },
      });
      m.on('click', 'cascade-projects', (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as {
          name: string;
          stage: string;
          cap: string;
          direction: string;
          route: string;
          snap: string;
          range: string;
          source: string;
        };
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.name}</b><br/><span style="color:#9aa1a9">${p.stage}` +
              `${p.cap ? ` · ${p.cap} MW` : ''}</span>` +
              `<br/><span style="color:#9aa1a9">Candidate ${p.direction} relation · ${p.route} km directed route · ${p.snap} km midpoint snap</span>` +
              `<br/><span style="color:#9aa1a9">DoED range diagonal ${p.range} km. Midpoint topology is not a confirmed cascade, component location or legal overlap.</span>` +
              `<br/><a href="${p.source}" target="_blank" rel="noopener">current official DoED register ↗</a>`
          )
          .addTo(m);
      });

      // Collector conveyance: a secondary intake's water joins the headpond and
      // then runs the SAME waterway to the powerhouse, so a counted collector
      // is drawn in the waterway's own amber all the way down — dashed, because
      // the link is a straight-line placeholder for an unrouted canal. A
      // rejected collector gets a short red stub instead: it goes nowhere.
      m.addSource('collectors', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'collectors',
        type: 'line',
        source: 'collectors',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['case', ['==', ['get', 'ok'], 1], '#ffb454', '#e5534b'],
          'line-width': ['case', ['==', ['get', 'ok'], 1], 2, 1.6],
          'line-opacity': 0.9,
          'line-dasharray': [2, 1.8],
        },
      });
      // A ring around whatever the panel was last asked to locate. Evidence
      // should be findable on the map, not opened in another tab.
      m.addSource('focus', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'focus-ring',
        type: 'circle',
        source: 'focus',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 12, 15, 26],
          'circle-color': 'transparent',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 0.9,
        },
      });

      // The diverted reach of the selected scheme.
      m.addSource('scheme', { type: 'geojson', data: empty() });
      m.addSource('display-channel', { type: 'geojson', data: empty() });
      m.addLayer({ id: 'display-channel', type: 'line', source: 'display-channel', filter: ['==', ['get', 'traced'], true], paint: { 'line-color': '#4fc1d8', 'line-width': 2.5, 'line-opacity': 0.9 } });
      m.addLayer({ id: 'display-channel-approximate', type: 'line', source: 'display-channel', filter: ['==', ['get', 'traced'], false], paint: { 'line-color': '#4fc1d8', 'line-width': 2, 'line-dasharray': [2, 2] } });
      m.addSource('model-reference', { type: 'geojson', data: empty() });
      m.addLayer({ id: 'model-reference', type: 'line', source: 'model-reference', paint: { 'line-color': '#f4e4cb', 'line-width': 1.5, 'line-dasharray': [4, 3] } });
      m.addLayer({
        id: 'scheme-glow',
        type: 'line',
        source: 'scheme',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ffb454', 'line-width': 9, 'line-opacity': 0.22, 'line-blur': 3 },
      });
      m.addLayer({
        id: 'scheme-line',
        type: 'line',
        source: 'scheme',
        filter: ['!=', ['get', 'traced'], false],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ffb454', 'line-width': 3 },
      });
      m.addLayer({ id: 'scheme-approximate', type: 'line', source: 'scheme', filter: ['==', ['get', 'traced'], false], paint: { 'line-color': '#ffb454', 'line-width': 3, 'line-dasharray': [2, 2] } });

      // Connected level-pool cells behind the intake's inferred dam axis.
      // The fill sits under the selected waterway; the proposed axis remains
      // crisp above it. Both are empty until the two-dimensional DEM read lands.
      m.addSource('pondage', { type: 'geojson', data: empty() });
      m.addLayer(
        {
          id: 'pondage-fill',
          type: 'fill',
          source: 'pondage',
          filter: ['==', ['get', 'kind'], 'pondage'],
          paint: {
            'fill-color': '#38bde8',
            'fill-opacity': 0.36,
          },
        },
        'scheme-glow'
      );
      m.addLayer({
        id: 'pondage-dam',
        type: 'line',
        source: 'pondage',
        filter: ['==', ['get', 'kind'], 'dam-axis'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#eaf8ff',
          'line-width': 3,
          'line-opacity': 0.95,
        },
      });

      // Straight connector to the nearest segment accepted by an OSM car
      // routing profile. It is a proximity floor, not a designed access road.
      m.addSource('road-access', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'road-access-lines',
        type: 'line',
        source: 'road-access',
        filter: ['==', ['get', 'kind'], 'connector'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['match', ['get', 'role'], 'intake', '#38bde8', '#65c87a'],
          'line-width': 2,
          'line-opacity': 0.9,
          'line-dasharray': [1.5, 1.5],
        },
      });
      m.addLayer({
        id: 'road-access-points',
        type: 'circle',
        source: 'road-access',
        filter: ['==', ['get', 'kind'], 'road'],
        paint: {
          'circle-radius': 4,
          'circle-color': ['match', ['get', 'role'], 'intake', '#38bde8', '#65c87a'],
          'circle-stroke-color': '#0e0f11',
          'circle-stroke-width': 1.5,
        },
      });

      const maybeAddReaches = () => {
        if (m.getSource('reaches')) return;
        const c = m.getBounds().getCenter();
        if (!hasReachData(c.lat, c.lng)) return;
        riversGeoJson()
          .then((data) => {
            if (m.getSource('reaches')) return;
            m.addSource('reaches', { type: 'geojson', data });
            m.addLayer(
              {
                id: 'reaches',
                type: 'line',
                source: 'reaches',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                  'line-color': '#4fc1d8',
                  // Faded out at country scale: the bundled network only covers
                  // one window of the world, and at low zoom it rendered as a
                  // bright rectangle around Nepal — a data boundary masquerading
                  // as geography. The basemap's own worldwide waterways carry
                  // the country view; the detailed network arrives on approach.
                  'line-opacity': ['interpolate', ['linear'], ['zoom'], 6.5, 0, 7.5, 0.3, 9, 0.75],
                  'line-width': [
                    'interpolate',
                    ['exponential', 1.6],
                    ['zoom'],
                    6,
                    ['interpolate', ['linear'], ['get', 'd'], 1, 0.5, 1000, 2.4],
                    13,
                    ['interpolate', ['linear'], ['get', 'd'], 1, 2, 1000, 6],
                  ],
                },
              },
              'scheme-glow'
            );
          })
          .catch(() => {});
      };
      maybeAddReaches();
      m.on('moveend', maybeAddReaches);
      // Data may finish before the basemap style. Re-run the source-sync effect
      // once every custom source above actually exists.
      setMapReady(true);
    });

    m.on('click', (e) => {
      // Opening evidence must not also move the study point underneath it.
      const interactive = [
        'protected-area-line',
        'grid-substations',
        'grid-substation-labels',
        'geology-sheet-lines',
        'faults',
        'quakes',
        'upstream-sources',
        'hazards',
        'hazard-labels',
        'licences',
        'licence-labels',
        'cascade-projects',
        'cascade-labels',
      ].filter((id) => Boolean(m.getLayer(id)));
      if (interactive.length && m.queryRenderedFeatures(e.point, { layers: interactive }).length) return;
      // Ctrl-click with a scheme selected adds a collector intake on that
      // stream instead of restarting the study somewhere else.
      if ((e.originalEvent as MouseEvent).ctrlKey && schemeRef.current) {
        void addExtraIntake({ lat: e.lngLat.lat, lon: e.lngLat.lng });
        return;
      }
      void onClick(e.lngLat.lat, e.lngLat.lng);
    });
    m.on('moveend', () => {
      const c = m.getCenter();
      writeUrl({ lat: c.lat, lon: c.lng, zoom: m.getZoom() }, atRef.current);
    });

    const restoreLocation = () => {
      const saved = readUrl();
      m.jumpTo({ center: [saved.view.lon, saved.view.lat], zoom: saved.view.zoom, padding: { top: 0, right: 0, bottom: 0, left: 0 } });
      if (saved.at) {
        if (saved.at.lat !== atRef.current?.lat || saved.at.lon !== atRef.current?.lon) void onClick(saved.at.lat, saved.at.lon);
      } else {
        reset();
      }
    };
    window.addEventListener('hashchange', restoreLocation);

    return () => {
      window.removeEventListener('hashchange', restoreLocation);
      ro.disconnect();
      setMapReady(false);
      // Markers die with the map they were added to. Leaving stale Marker
      // objects in the ref meant the next mount kept "updating" a marker whose
      // DOM was destroyed — the intake pin silently never came back.
      markers.current.a?.remove();
      markers.current.b?.remove();
      markers.current = {};
      for (const mk of extraMarkers.current) mk.remove();
      extraMarkers.current = [];
      for (const mk of junctionMarkers.current) mk.remove();
      junctionMarkers.current = [];
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Pull a click onto a mapped watercourse using the basemap's own waterway
   * geometry, which is already loaded and covers the whole world via OSM.
   *
   * This matters more than it looks. Tracing terrain downhill from a point that
   * is NOT on a river runs straight down the hillside, which produced a
   * "scheme" with 773 m of drop in 900 m — a cliff, not a river reach. Starting
   * on the channel keeps the trace in the valley floor.
   */
  const snapToWaterway = useCallback((lat: number, lon: number): Pt => {
    const m = map.current;
    if (!m || !m.isStyleLoaded()) return { lat, lon };
    const pt = m.project([lon, lat]);
    const R = 22; // px
    const layers = (m.getStyle().layers ?? [])
      .filter((l) => l.type === 'line' && /water/i.test(l.id) && m.getLayer(l.id))
      .map((l) => l.id);
    if (layers.length === 0) return { lat, lon };
    let feats: maplibregl.MapGeoJSONFeature[] = [];
    try {
      feats = m.queryRenderedFeatures(
        [
          [pt.x - R, pt.y - R],
          [pt.x + R, pt.y + R],
        ],
        { layers }
      );
    } catch {
      return { lat, lon };
    }
    let best: Pt | null = null;
    let bestD = Infinity;
    const consider = (coords: GeoJSON.Position[]) => {
      for (let k = 1; k < coords.length; k++) {
        const a = m.project([coords[k - 1][0], coords[k - 1][1]]);
        const b = m.project([coords[k][0], coords[k][1]]);
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const p = { x: a.x + t * dx, y: a.y + t * dy };
        const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
        if (d < bestD) {
          bestD = d;
          const ll = m.unproject([p.x, p.y]);
          best = { lat: ll.lat, lon: ll.lng };
        }
      }
    };
    for (const f of feats) {
      const g = f.geometry;
      if (g.type === 'LineString') consider(g.coordinates);
      else if (g.type === 'MultiLineString') for (const l of g.coordinates) consider(l);
    }
    return best && bestD <= R * R ? best : { lat, lon };
  }, []);

  /**
   * Resolve a Ctrl-dropped point into a secondary intake: snap it to a
   * watercourse, read the network's flow there, and measure its elevation —
   * the three facts that decide whether a collector channel can work.
   */
  const addExtraIntake = useCallback(
    async (p: Pt, replaceIndex?: number) => {
      const snapped = snapToWaterway(p.lat, p.lon);
      const hit = await nearestReach(snapped.lat, snapped.lon).catch(() => null);
      const reach = hit?.nearest ?? null;
      const onNetwork = Boolean(reach && reach.distanceKm < COLLECTOR_SNAP_KM);
      const site = onNetwork ? reach!.point : snapped;
      let elevationM: number | null = null;
      try {
        const prof = await fetchProfile([site.lat, site.lon], [site.lat, site.lon], 2);
        elevationM = prof.points[0]?.elevationM ?? null;
      } catch {
        // Terrain service down — keep the intake, say nothing about head.
      }
      const route = await downstreamPath(site.lat, site.lon, 30, 0.5).catch(() => null);
      const entry: ExtraIntake = {
        lat: site.lat,
        lon: site.lon,
        elevationM,
        meanCms: onNetwork ? reach!.meanDischargeCms : null,
        uplandKm2: onNetwork ? reach!.uplandKm2 : null,
        snappedKm: onNetwork ? haversineKm([p.lat, p.lon], [site.lat, site.lon]) : 0,
        downstream: (route ?? []).map((q) => ({ lat: q.lat, lon: q.lon })),
      };
      setExtraIntakes((current) => {
        if (replaceIndex !== undefined && replaceIndex < current.length) {
          const next = [...current];
          next[replaceIndex] = entry;
          return next;
        }
        return [...current, entry];
      });
    },
    [snapToWaterway]
  );

  const clickSequence = useRef(0);
  const onClick = useCallback(async (lat: number, lon: number) => {
    const sequence = ++clickSequence.current;
    const hit = await nearestReach(lat, lon).catch(() => null);
    if (sequence !== clickSequence.current) return;
    setPick(null);
    setTweaked(false);
    setWideSearch(false);
    setNeighbours(null);
    /**
     * A borrowed or imported record belongs to the site it was loaded for.
     *
     * Only the full reset used to clear it, so clicking a different river kept
     * the previous river's observations, its station name and its catchment
     * transfer factor. A DHM record scaled 0.711× for a 1,785 km² Tamakoshi
     * site stayed live on a 5 km² stream whose own mapped mean is 0.21 m³/s,
     * and the page reported 851.5 MW while still describing the old scaling as
     * being "to this site". Revalidating against the new catchment is not
     * possible here — the study has not been built yet — so the record is
     * dropped and the engineer re-adopts it if it still applies.
     */
    setMeasured(null);
    setAudit(null);
    setAuditBusy(null);
    // Prefer the detailed network where it exists, otherwise the basemap's
    // waterways, otherwise the raw click.
    setAt(
      hit && hit.nearest.distanceKm <= SNAP_KM ? hit.nearest.point : snapToWaterway(lat, lon)
    );
  }, [snapToWaterway]);

  // ---------------- the study ----------------
  useEffect(() => {
    if (!at) {
      setStudy(null);
      return;
    }
    let dead = false;
    setError(null);
    setBusy('Reading the river…');

    (async () => {
      const reachHit = await nearestReach(at.lat, at.lon).catch(() => null);
      /**
       * THE PROMOTION HAS TO MOVE THE PATH, NOT JUST THE LABEL.
       *
       * `reachToRead` can decide the click landed on a rivulet beside a river a
       * hundred times its size and read the river instead. That decision used
       * to change only the displayed catchment and the provenance: the study
       * path, the network flow along it and every scheme were still traced from
       * the click, on the rivulet. So the panel described a 1,745 km² river
       * while the power came from a stream beside it, and the two cross-check
       * numbers sat 40× apart with nothing saying why.
       *
       * The path now starts from the reach that was actually read. The marker
       * still does not move — that is a deliberate promise about what a click
       * means — but the hydrology and the description are finally the same river.
       */
      const readFrom = reachHit ? reachToRead(reachHit) : null;
      const origin = readFrom?.overridden ? readFrom.reach.point : at;
      /**
       * A refused flow request must not take the terrain with it.
       *
       * Discharge is fetched for Nepal only — deliberately, so a donation-funded
       * service is not asked global questions it cannot afford. But both study
       * branches AWAITED that promise before committing an otherwise finished
       * terrain result, so a click on a Swiss valley traced the ground, found
       * the head, and then threw all of it away when the flow call rejected.
       * The app's own message says terrain and head still work there; now they
       * do. `flowError` carries the reason so the panel can say why there is no
       * hydrology rather than pretending none was wanted.
       */
      let flowError: string | null = null;
      const flowP = fetchDischarge(origin.lat, origin.lon).catch((e: unknown) => {
        flowError = e instanceof Error ? e.message : String(e);
        return null;
      });
      let river = await downstreamPath(origin.lat, origin.lon, SEARCH_KM, 0.12, { continuousStart: true }).catch(() => null);
      /**
       * Read the river, not the rivulet beside it (reachToRead in rivers.ts).
       * The marker stays exactly where it was put; only the hydrology moves,
       * and only when the neighbour drains a hundred times more. The ambiguity
       * banner below still fires, so the reader is told which channel was read.
       */
      const reachRead = readFrom;
      const reach = reachRead?.reach ?? null;
      /**
       * A much larger river beside the one that was picked.
       *
       * nearestReach only offers this when the neighbour drains at least five
       * times the catchment within a kilometre and a half, which is the exact
       * signature of a click that landed on stray mapped geometry rather than
       * on the river the user could see. Measured against DHM's gauge records,
       * this happens to about one location in eight, and it does not announce
       * itself: the study simply runs on a rivulet's flow and reports a
       * confident, tiny number. Snapping to the neighbour automatically was
       * tried and rejected — it moves the marker further than this app is ever
       * willing to move it — so the ambiguity is shown instead of resolved.
       */
      /**
       * Offer the OTHER river, and state the choice honestly.
       *
       * `nearestKm2` used to be read off the already-promoted reach, so once a
       * promotion had fired the banner compared the main stem with itself —
       * 1,745 against 1,753 km² — and a decision that had swapped the studied
       * river for one a hundred times larger looked like a rounding difference.
       * It is the NEAREST reach that is the alternative on offer.
       *
       * Nothing is offered once a promotion has happened and the two are the
       * same channel; the promotion notice covers that case instead.
       */
      setAmbiguity(
        reachHit?.mainStem && reachHit.nearest && !reachRead?.overridden
          ? {
              nearestKm2: reachHit.nearest.uplandKm2,
              mainKm2: reachHit.mainStem.uplandKm2,
              mainKm: reachHit.mainStem.distanceKm,
              lat: reachHit.mainStem.point.lat,
              lon: reachHit.mainStem.point.lon,
            }
          : null
      );

      if (river && river.length > 8) {
        /**
         * Restate the waterway at its traced length before anything is sized.
         *
         * The course itself is left alone — the terrain sampling is validated
         * on it, and swapping it wholesale was measured and rejected (see
         * osmLengthFactor). Only the along-course distance changes, because
         * HydroRIVERS cuts the corner off every meander and the canal does not.
         */
        const { factor } = await osmLengthFactor(river);
        if (factor !== 1) river = stretchPath(river, factor);
        if (!dead) setBusy('Reading the terrain along it…');
        const dem = await fetchPathProfile(river);
        if (!dead) setBusy('Reading the long-term river flow…');
        const flow = await flowP;
        if (dead) return;
        setStudy({
          path: river.map((p, k) => ({ ...p, elevationM: dem.points[k]?.elevationM ?? NaN })),
          flow: flow ?? emptyFlowAt(origin),
          flowUnavailable: flow ? null : flowError,
          dem,
          followsRiver: true,
          reach,
        });
      } else {
        // Anywhere without a bundled network: follow the valley down the DEM.
        // Same one-click search, worldwide.
        if (!dead) setBusy('Following the valley downhill…');
        const trace = await traceDownhill(at.lat, at.lon, SEARCH_KM);
        if (!dead) setBusy('Reading the long-term river flow…');
        const flow = await flowP;
        if (dead) return;
        if (!trace || trace.points.length < 8) {
          setStudy(null);
          setFlowOnly(flow);
          if (!flow && flowError) setError(flowError);
          return;
        }
        setStudy({
          // meanCms 0 = no mapped network here, so the flood model's own
          // magnitude is used unscaled and the panel says so. A terrain trace
          // carries no catchment either.
          // A terrain trace follows the DEM downhill and has no mapped channel
          // behind it, so drawn and computed positions are the same point.
          path: trace.points.map((p) => ({
            ...p,
            meanCms: 0,
            uplandKm2: 0,
            networkIndex: -1,
            drawnLat: p.lat,
            drawnLon: p.lon,
          })),
          flow: flow ?? emptyFlowAt(at),
          flowUnavailable: flow ? null : flowError,
          dem: {
            points: trace.points.map((p) => ({
              distanceKm: p.km,
              elevationM: p.elevationM,
              lat: p.lat,
              lon: p.lon,
            })),
            source: trace.source,
            zoom: trace.zoom,
            resolutionM: trace.resolutionM,
            tilesFetched: trace.tilesFetched,
          },
          followsRiver: true,
          tracedFromTerrain: true,
          reach,
        });
      }
    })()
      .catch((e: unknown) => !dead && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !dead && setBusy(null));

    return () => {
      dead = true;
    };
  }, [at]);

  /** Flow known but no scheme yet (outside river coverage, before the 2nd click). */
  const [flowOnly, setFlowOnly] = useState<DischargeSeries | null>(null);
  useEffect(() => {
    if (study || !at) setFlowOnly(null);
  }, [study, at]);

  /**
   * Which flow source gets to set the magnitude on this reach.
   *
   * Validation against built plants caught the network's discharge collapsing
   * up to 200× low in the high border valleys — the Tamakoshi at Lamabagar
   * carries 0.3 m³/s in the bundled data and 66 m³/s in the turbines of a
   * built 456 MW plant. Where the two global sources disagree beyond
   * rescaling range, HYDEST — fitted to Nepali gauges, independent of both —
   * picks the winner. See engine/flowchoice.ts.
   */
  /**
   * The reach as it applies AT THE SELECTED INTAKE, not at the click.
   *
   * `study.reach` describes where the user clicked. The engine may site the
   * intake downstream during corridor search or manual placement, past a confluence that is a
   * materially different catchment — the network flow the engine uses grows
   * there, while every independent check of that flow stayed frozen upstream.
   * Rescaling the catchment-derived fractions by the area ratio keeps the
   * hypsometry self-consistent: the fractions themselves change slowly, the
   * total area does not.
   */
  const intakeReach = useMemo(() => {
    const r = study?.reach;
    if (!r) return null;
    const here = pick ? study?.path[pick.i]?.uplandKm2 : null;
    if (!here || !(here > 0) || !(r.uplandKm2 > 0)) return r;
    // Under a 1% change this is noise in the per-vertex sampling, not growth.
    if (Math.abs(here / r.uplandKm2 - 1) < 0.01) return r;
    return { ...r, uplandKm2: here };
  }, [study, pick]);

  const flowChoice = useMemo(() => {
    if (!study) return null;
    const r = intakeReach;
    return chooseFlowMagnitude({
      dates: study.flow.dates,
      series: study.flow.values,
      networkMeanCms: study.path[0]?.meanCms ?? 0,
      hydest:
        isNepal && r && Number.isFinite(r.below5000Frac) && r.uplandKm2 > 0
          ? {
              totalKm2: r.uplandKm2,
              below5000Km2: r.below5000Frac * r.uplandKm2,
              below3000Km2: r.below3000Frac * r.uplandKm2,
              ...(Number.isFinite(r.monsoonMm) ? { monsoonMm: r.monsoonMm } : {}),
            }
          : null,
      modified:
        r && Number.isFinite(r.averageAltitudeM) && Number.isFinite(r.annualPrecipMm)
          ? {
              below3000Km2: r.below3000Frac * r.uplandKm2,
              below5000Km2: r.below5000Frac * r.uplandKm2,
              averageAltitudeM: r.averageAltitudeM,
              annualWetnessMm: r.annualPrecipMm,
            }
          : null,
    });
  }, [study, isNepal, intakeReach]);

  /**
   * Read the ground ACROSS the waterway, not along it.
   *
   * The profile the panel already draws follows the river; a headrace does not.
   * It benches along the hillside above, and whether that is a canal or a tunnel
   * is set by the cross-slope — a difference of an order of magnitude in cost
   * per metre, and the one terrain question this DEM can actually answer.
   *
   * Deliberately NOT an excavation quantity. A canal sits two to four metres in
   * cut and the terrain's absolute error spans -14 to +6 m, so a volume here
   * would be invented precision. A slope survives because it is a short-baseline
   * difference: two independent terrain products agree on it to a 2.9% sigma
   * (npm run probe:dem).
   */
  useEffect(() => {
    if (!study || !pick) {
      setCorridor(null);
      return;
    }
    let live = true;
    const pts = crossSectionPoints(study.path, pick.i, pick.j);
    if (!pts.length) {
      setCorridor(null);
      return;
    }
    void fetchPathProfile(pts)
      .then((profile) => {
        if (!live) return;
        // Every third point is a station centre; its chainage lets the classifier
        // report tunnelled LENGTH rather than a count of samples.
        const stationKm = pts.filter((_, k) => k % 3 === 0).map((p) => p.km);
        setCorridor(readCrossSlopes(profile.points.map((p) => p.elevationM), stationKm));
      })
      .catch(() => {
        // Terrain is best-effort here; the scheme stands without it.
        if (live) setCorridor(null);
      });
    return () => {
      live = false;
    };
  }, [study, pick]);

  // ---------------- discovery ----------------
  const input: SchemeInput | null = useMemo(() => {
    if (!study) return null;

    /**
     * A measured record, where the engineer has supplied one, replaces the
     * modelled series outright rather than being blended with it.
     *
     * Averaging a gauge against a global model would drag a measurement back
     * towards a guess, which is the wrong direction.
     *
     * `seriesMeanCms` is set to the network's mean AT THE HEAD, so the engine's
     * rescale is exactly 1 where the record applies and grows only as the
     * catchment does below it — a tributary joining above the intake is water
     * the record never saw. Note this is a growth factor, not a no-op: an
     * intake selected below a confluence legitimately carries more than the
     * record's own magnitude, and the panel reports that scaling.
     */
    const modelled = measured ? measured.series.values : study.flow.values;
    const dates = measured ? measured.series.dates : study.flow.dates;

    /**
     * The flood model's spread, checked against the spread Nepali rivers have.
     *
     * Design flow is a point on the flow-duration curve, so it depends entirely
     * on the SHAPE of the record — and the shape has never been validated, only
     * asserted (see engine/fdcshape.ts). Where it falls outside the range 81 DHM
     * gauges actually exhibit, the day order and the mean are kept and only the
     * spread is remapped onto the measured national curve. Inside that range
     * nothing happens, and a measured record supplied by the engineer is never
     * touched — it is the evidence, not a candidate for correction.
     */
    /**
     * Skipped outright where the DHM statistics are not bundled: the national
     * band is assembled from the gauges' own quantiles, so without them
     * `judgeShape` would return a verdict built from zero stations — a band of
     * undefineds that compares false, reads as "inside the measured range" and
     * silently leaves the design flow uncorrected. Not running it is the
     * honest version of the same outcome, and report.ts says the check did not
     * run. See src/dhm-statistics.ts.
     */
    const shape =
      measured || !isNepal || !DHM_STATISTICS_BUNDLED
        ? null
        : judgeShape(modelled, assume.exceedance);
    const series = shape?.implausible ? correctShape(modelled, assume.exceedance) : modelled;
    const seriesMean = meanOf(series);
    const minMonth = minMonthlyMean(dates, series);
    /**
     * When the network's magnitude lost the argument (flowchoice.ts), its
     * per-point means are stripped so the engine runs the record unscaled —
     * the same path it already takes where no network exists at all. This
     * also disables downstream growth, which is honest: relative growth from
     * broken absolute numbers is not information.
     */
    /**
     * WITH A MEASURED RECORD, THE MODEL ARBITRATION IS NOT CONSULTED AT ALL.
     *
     * `flowChoice` is computed from the two MODELLED sources, before anything
     * knows a measurement exists. Its verdict then rewrote the path — zeroing
     * every mean under `model` authority, flattening it to a constant under
     * `hydest` — and those rewrites decide whether a measured record grows
     * downstream. So the same gauge record, the same geometry and the same
     * intake produced 131 MW under one pre-measurement verdict and 12.8 MW
     * under another: a decision the page says it discarded was silently
     * choosing the answer.
     *
     * A measurement transports on CATCHMENT, which the mapped network carries
     * per reach and which no arbitration between two flow models affects. So
     * the raw path is used and the record scales by the network's own growth
     * from the intake — ratio 1 where it was measured, larger below a
     * confluence, which is the physical answer.
     */
    const path = measured
      ? study.path
      : flowChoice?.authority === 'model'
        ? study.path.map((p) => ({ ...p, meanCms: 0 }))
        : flowChoice?.authority === 'hydest' && flowChoice.targetMeanCms
          ? // Both global sources failed the regression; its annual mean sets
            // the magnitude at every point, and the record keeps only its shape.
            study.path.map((p) => ({ ...p, meanCms: flowChoice.targetMeanCms! }))
          : flowChoice?.magnitudeFactor && flowChoice.magnitudeFactor !== 1
            ? // The two global sources agree; the level is their geometric mean
              // with the regional regression, and downstream growth is kept.
              study.path.map((p) => ({ ...p, meanCms: p.meanCms * flowChoice.magnitudeFactor! }))
            : study.path;
    return {
      path,
      series,
      dates,
      // With a measured record, keep its magnitude: pass the network's own mean
      // so the rescale is a no-op instead of pulling it onto a modelled figure.
      seriesMeanCms: measured ? (path[0]?.meanCms || seriesMean) : seriesMean,
      /**
       * The environmental release, and two ways it used to go wrong.
       *
       * A NEGATIVE month made it negative, and the engine subtracts it — so a
       * sensor-flagged -100 turned a 1 m³/s river into 11 m³/s of design flow
       * and multiplied the energy twelvefold. Clamped at zero: a release can
       * never add water.
       *
       * NO DATES made `minMonthlyMean` non-finite and the release fell to zero,
       * silently bypassing the Nepal low-flow floor for exactly the date-free
       * import the parser advertises as supported. The fallback is now the same
       * fraction applied to the record's own mean, which is the assumption the
       * parser's note already promises the reader.
       */
      residualCms: Math.max(
        0,
        (Number.isFinite(minMonth) ? minMonth : seriesMean * NO_DATE_LOW_MONTH_FRAC) *
          effectiveResidualFrac
      ),
      exceedance: assume.exceedance,
      efficiency: assume.efficiency,
      headLossFrac: assume.headLossFrac,
      minFlowFrac: MIN_FLOW_FRAC,
      intakeWindowKm: wideSearch ? Number.POSITIVE_INFINITY : INTAKE_WINDOW_KM,
      maxWaterwayKm,
    };
  }, [study, assume, effectiveResidualFrac, wideSearch, maxWaterwayKm, measured, flowChoice]);

  // Who already holds or has applied for this river. The official DoED bundle
  // ships with the app, so this works offline and has an explicit source date.
  useEffect(() => {
    let dead = false;
    loadLicences()
      .then((all) => {
        if (!dead) setDoedProjects(all);
      })
      .catch(() => {
        if (!dead) setDoedProjects(null); // context is optional; never block the study
      });
    return () => {
      dead = true;
    };
  }, []);

  // Where a real measured record exists. Flow is the dominant error here, and
  // this is the only thing that would actually shrink it — so it is worth
  // saying which station to go and ask for, even though the values are gated.
  useEffect(() => {
    if (!study || !isNepal) {
      setGauges(null);
      return;
    }
    let dead = false;
    gaugesFor(study.path, study.reach?.uplandKm2 ?? null)
      .then((g) => {
        if (!dead) setGauges(g);
      })
      .catch(() => {
        if (!dead) setGauges(null); // context is optional; never block the study
      });
    return () => {
      dead = true;
    };
  }, [study, isNepal]);

  /**
   * Nepal's regional regression, run on this catchment.
   *
   * Every other flow figure here comes from a global model. This one is fitted
   * to Nepali gauge records, so it is an independent screening comparator.
   * Agreement is useful corroboration of magnitude, while disagreement is an
   * explicit reason to prioritize gauge transfer and field hydrology.
   */
  /**
   * MHSP (NEA 1997), the second Nepali regional method.
   *
   * Feasibility practice does not screen a site with one regression. Scored
   * against 64 DHM gauges with 10+ complete years, MHSP lands inside a factor
   * of two on 86% of them against WECS/DHM's 77% (checks/regional-vs-gauges.mjs),
   * so it is shown as a peer opinion rather than a footnote. Where they
   * disagree, that disagreement is the honest uncertainty at an ungauged site.
   */
  const mhsp = useMemo(() => {
    if (!isNepal) return null;
    const r = intakeReach;
    if (!r || !(r.uplandKm2 > 0)) return null;
    return mhspScreen(r.uplandKm2, Number.isFinite(r.monsoonMm) ? r.monsoonMm : undefined);
  }, [isNepal, intakeReach]);

  /**
   * The same shape verdict the engine acts on, exposed so the panel can say so.
   * A correction the reader cannot see is a correction they cannot argue with.
   */
  const flowShape = useMemo(() => {
    if (!study || measured || !isNepal || !DHM_STATISTICS_BUNDLED) return null;
    return judgeShape(study.flow.values, assume.exceedance);
  }, [study, measured, isNepal, assume.exceedance]);

  const hydest = useMemo<HydestScreen | null>(() => {
    if (!isNepal || !study) return null;
    const r = intakeReach;
    if (!r || !Number.isFinite(r.below5000Frac) || !(r.uplandKm2 > 0)) return null;
    const input = {
      totalKm2: r.uplandKm2,
      below5000Km2: r.below5000Frac * r.uplandKm2,
      below3000Km2: r.below3000Frac * r.uplandKm2,
      ...(Number.isFinite(r.monsoonMm) ? { monsoonMm: r.monsoonMm } : {}),
    };
    const driest = driestMonthFlow(input);
    if (!driest) return null;

    /**
     * Compare against the flow the app ACTUALLY uses, not the raw model.
     *
     * The engine takes its magnitude from the mapped network and only its
     * day-to-day shape from the flood model, because the model's ~5 km cell is
     * frequently not on this channel. Comparing HYDEST against the unscaled
     * series therefore compares it against a number this app has already
     * identified as wrong and thrown away — on the Marsyangdi that manufactured
     * a "15.7x disagreement" out of a cell reading 1.15 m3/s on a river carrying
     * a hundred. Same double-counting the uncertainty band had to be rescued
     * from earlier.
     */
    const seriesMean = meanOf(study.flow.values);
    const networkMean = study.path[0]?.meanCms ?? 0;
    // HYDEST is compared against the figure the engine is ACTUALLY using —
    // whichever authority won the magnitude.
    const ratio =
      flowChoice?.authority === 'model'
        ? 1
        : flowChoice?.authority === 'hydest' && flowChoice.targetMeanCms && seriesMean > 0
          ? flowChoice.targetMeanCms / seriesMean
          : networkMean > 0 && seriesMean > 0
            ? (networkMean * (flowChoice?.magnitudeFactor ?? 1)) / seriesMean
            : 1;
    const modelled = monthMean(study.flow.dates, study.flow.values, driest.month) * ratio;
    return {
      input,
      driest,
      months: allMonthlyFlows(input),
      modelledCms: modelled,
      agreement: Number.isFinite(modelled) ? drySeasonAgreement(driest.cms, modelled) : null,
      floods: RETURN_PERIODS.map((t) => ({ t: t as number, cms: regionalFloodEstimate(input, t) })).filter(
        (f): f is { t: number; cms: number } => f.cms !== null
      ),
      provenance: HYDEST_PROVENANCE,
    };
  }, [study, flowChoice, isNepal, intakeReach]);

  const found = useMemo(() => {
    if (!input || !study?.followsRiver) return null;
    return discover(input);
  }, [input, study?.followsRiver]);

  /**
   * KEEP THE SAME OBJECT WHEN THE ANSWER IS THE SAME. THIS WAS AN INFINITE LOOP.
   *
   * `setPick({ i, j })` built a fresh object every run. React bails out of a
   * state update only on `Object.is`, so a new object with identical contents is
   * still a change — and this effect depends on `found`, which is derived from
   * `pick`:
   *
   *   pick -> intakeReach -> flowChoice -> input -> found -> this effect -> pick
   *
   * Every turn of that ring re-ran `discover()` over 139 candidate layouts,
   * `evaluate()`, and `sweepDesignFlow()`'s seventeen further evaluations. The
   * ring never settled, so it ran forever: measured on a loaded site, the main
   * thread was blocked in 2.4-second tasks back to back, `requestAnimationFrame`
   * fired ZERO times in 4.7 seconds, and the app burned a core doing nothing but
   * recomputing the same scheme. Every pan, zoom and slider felt broken because
   * the browser genuinely never got the thread back.
   *
   * Returning the PREVIOUS reference when i and j are unchanged is what stops
   * it: React compares, sees the same object, and does not re-render. The ring
   * still exists — it is the natural shape of "search, then select the best
   * result" — but it now converges after one pass.
   */
  /**
   * THE RING HAS TWO FIXED POINTS AT SOME SITES, AND REFERENCE EQUALITY CANNOT SEE IT.
   *
   * The fix above stops the ring turning when i and j are UNCHANGED. It does
   * nothing when they genuinely alternate, and at some sites they do:
   *
   *   pick.i -> MERIT's per-vertex upland area there -> chooseFlowMagnitude ->
   *   design flow -> the best layout the search finds -> pick.i
   *
   * `intakeReach` rescales the catchment to the area MERIT samples AT THE
   * CURRENT INTAKE VERTEX, so the flow decision depends on which candidate the
   * search currently prefers. Measured at 29.2583 N, 81.9333 E: the app flips
   * every ~2.5 seconds between (i=12, j=120, authority "model", 12.48 m3/s,
   * 24.76 MW) and (i=0, j=104, authority "network", 0.43 m3/s, 0.82 MW) — a 29x
   * swing in flow and a 30x swing in capacity, 29 times in 75 seconds, with no
   * React warning because this is not a render loop. It is a genuine limit cycle
   * in the model, and MERIT's documented bleed across confluences is what makes
   * the two vertices disagree so violently.
   *
   * Whichever state the app happened to show was a coin toss, and two renders of
   * one coordinate produced 24.76 MW and 0.82 MW.
   *
   * SO: STOP, AND SAY SO. Revisiting a layout this study has already left is a
   * cycle, not an improvement. The pick is frozen at that point and the site is
   * flagged, because picking one of two answers 30x apart and printing it
   * without comment is the failure this whole project is built against. A site
   * that converges never reaches the guard, so no settled answer moves.
   */
  const visitedPicks = useRef<Set<string>>(new Set());
  const [pickCycle, setPickCycle] = useState<{ a: string; b: string } | null>(null);
  useEffect(() => {
    visitedPicks.current = new Set();
    setPickCycle(null);
  }, [study, maxWaterwayKm]);

  useEffect(() => {
    if (tweaked) return;
    const next =
      found && found.schemes.length > 0
        ? { i: found.schemes[0].i, j: found.schemes[0].j }
        : null;
    if (!next) {
      setPick(null);
      return;
    }
    const key = `${next.i}/${next.j}`;
    setPick((prev) => {
      if (prev && prev.i === next.i && prev.j === next.j) return prev;
      if (prev && visitedPicks.current.has(key)) {
        // Already been here and left. Freeze on what is on screen.
        setPickCycle({ a: `${prev.i}/${prev.j}`, b: key });
        return prev;
      }
      visitedPicks.current.add(key);
      return next;
    });
  }, [found, study, tweaked]);

  const scheme: Scheme | null = useMemo(
    () => (input && pick ? evaluate(input, pick.i, pick.j) : null),
    [input, pick]
  );

  /**
   * Design flow is the one parameter a developer controls, and the app used to
   * assume it. Seventeen more evaluations of the layout already on screen, so
   * the curve and the panel can never disagree about the same machine.
   */
  const designSweep: DesignFlowSweep | null = useMemo(
    () => (input && pick ? sweepDesignFlow(input, pick.i, pick.j) : null),
    [input, pick]
  );
  schemeRef.current = scheme;

  /**
   * Possible level-pool pondage immediately upstream of the selected intake.
   * The DEM window is cached in pondage.ts, so moving the height slider repeats
   * only the connected-cell arithmetic unless a taller level reaches the edge
   * and genuinely needs a wider terrain window.
   */
  useEffect(() => {
    if (!scheme || !study) {
      setPondageState({ result: null, busy: false, error: null });
      return;
    }
    const downstream = study.path[Math.min(study.path.length - 1, scheme.i + 2)];
    if (!downstream || (downstream.lat === scheme.intake.lat && downstream.lon === scheme.intake.lon)) {
      setPondageState({ result: null, busy: false, error: 'The river direction at the intake is unavailable.' });
      return;
    }
    let live = true;
    setPondageState({ result: null, busy: true, error: null });
    void screenPondage(scheme.intake, downstream, pondageHeightM)
      .then((result) => {
        if (live) setPondageState({ result, busy: false, error: null });
      })
      .catch((error: unknown) => {
        if (live) {
          setPondageState({
            result: null,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      live = false;
    };
  }, [study, scheme?.i, pondageHeightM]);

  /**
   * Where along the reach the storage is.
   *
   * The intake was chosen for head and flow and knows nothing about storage, so
   * this asks the same question at nine positions either side of it. The DEM
   * windows overlap almost entirely and pondage.ts caches them, so changing the
   * height afterwards repeats only the fills.
   */
  useEffect(() => {
    if (!scheme || !study) {
      setPondageSweep(null);
      return;
    }
    const controller = new AbortController();
    let live = true;
    setPondageSweep(null);
    void sweepPondagePosition(study.path, scheme.i, pondageHeightM, {
      signal: controller.signal,
    })
      .then((result) => {
        if (live) setPondageSweep(result);
      })
      .catch(() => {
        if (live) setPondageSweep(null);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [study, scheme?.i, pondageHeightM]);

  /** Nearest road in an OSM-derived car-routing graph, at both ends. */
  useEffect(() => {
    if (!scheme) {
      setRoadAccessState({ result: null, busy: false, error: null });
      return;
    }
    const controller = new AbortController();
    let live = true;
    setRoadAccessState({ result: null, busy: true, error: null });
    void screenRoadAccess(scheme.intake, scheme.power, controller.signal)
      .then((result) => {
        if (live) setRoadAccessState({ result, busy: false, error: null });
      })
      .catch((error: unknown) => {
        if (live && !controller.signal.aborted) {
          setRoadAccessState({
            result: null,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [scheme?.intake.lat, scheme?.intake.lon, scheme?.power.lat, scheme?.power.lon]);

  /**
   * Land cover along the chosen waterway, not the whole search corridor: the
   * consents this raises are triggered by the alignment that gets built.
   */
  useEffect(() => {
    if (!scheme || !study) {
      setLandcover(null);
      return;
    }
    let live = true;
    void screenLandcover(study.path.slice(scheme.i, scheme.j + 1))
      .then((result) => {
        if (live) setLandcover(result);
      })
      .catch(() => {
        if (live) setLandcover(null);
      });
    return () => {
      live = false;
    };
  }, [study, scheme?.i, scheme?.j]);

  /**
   * The units the waterway crosses, off Nepal's own 1:1,000,000 sheet.
   *
   * A memo rather than an effect, unlike land cover: these polygons are
   * bundled, so the answer is 130 point-in-polygon tests against 852 boxes and
   * arrives in the same tick. Same slice as land cover — the built alignment,
   * not the whole search corridor.
   */
  const geologyUnits = useMemo<GeologyTraverse | null>(
    () => (scheme && study ? geologyAlongPath(study.path.slice(scheme.i, scheme.j + 1)) : null),
    [study, scheme?.i, scheme?.j]
  );

  /** DoED range screening follows the chosen layout, not the full 22 km search corridor. */
  const licences = useMemo(
    () => isNepal && doedProjects && study
      ? licencesAlong(
          doedProjects,
          scheme ? study.path.slice(scheme.i, scheme.j + 1) : study.path
        )
      : null,
    [isNepal, doedProjects, study, scheme]
  );

  /** Historical reports near this exact intake-powerhouse reach, Nepal only. */
  const hazards = useMemo(
    () =>
      scheme && study && isNepal
        ? hazardsFor(study.path.slice(scheme.i, scheme.j + 1))
        : null,
    [scheme, study, isNepal]
  );

  /** Directed HydroRIVERS candidates from open upstream lakes and BIPAD reports. */
  const connectivityKey = useMemo(
    () => scheme && study && isNepal && !study.tracedFromTerrain
      ? `${scheme.intake.lat.toFixed(5)},${scheme.intake.lon.toFixed(5)}`
      : null,
    [scheme, study, isNepal]
  );
  const [connectivityResult, setConnectivityResult] = useState<{
    key: string;
    screen: UpstreamConnectivityScreen | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!connectivityKey || !scheme) {
      setConnectivityResult(null);
      return;
    }
    let dead = false;
    setConnectivityResult({ key: connectivityKey, screen: null, error: null });
    const intake = scheme.intake;
    upstreamConnectivityFor(intake)
      .then((screen) => {
        if (!dead) setConnectivityResult({
          key: connectivityKey,
          screen,
          error: screen ? null : 'selected intake could not be matched to the bundled directed river network',
        });
      })
      .catch((cause: unknown) => {
        if (dead) return;
        setConnectivityResult({
          key: connectivityKey,
          screen: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => { dead = true; };
  }, [connectivityKey]);
  const currentConnectivity = connectivityResult?.key === connectivityKey ? connectivityResult : null;
  const upstreamConnectivity = currentConnectivity?.screen ?? null;
  const connectivityError = currentConnectivity?.error ?? null;
  const connectivityBusy = Boolean(connectivityKey && currentConnectivity && !currentConnectivity.screen && !currentConnectivity.error);

  /**
   * The ice upstream, routed the same way the lakes are.
   *
   * Reuses `connectivityKey`: ice only matters where the lake screen also runs,
   * it is keyed on the same intake, and re-deriving the key would let the two
   * drift apart. Failure is silent by design — a site with no glaciers and a
   * site whose network could not be walked both end up with no ice, and neither
   * should stop the report.
   */
  const [glacierScreen, setGlacierScreen] = useState<{
    key: string;
    screen: GlacierScreen | null;
  } | null>(null);
  useEffect(() => {
    if (!connectivityKey || !schemeRef.current) {
      setGlacierScreen(null);
      return;
    }
    const s0 = schemeRef.current;
    let dead = false;
    const km2 = studyRef.current?.path[s0.i]?.uplandKm2 ?? null;
    glaciersUpstreamOf(s0.intake, km2)
      .then((screen) => {
        if (!dead) setGlacierScreen({ key: connectivityKey, screen });
      })
      .catch(() => {
        if (!dead) setGlacierScreen({ key: connectivityKey, screen: null });
      });
    return () => {
      dead = true;
    };
  }, [connectivityKey]);
  const glaciers = glacierScreen?.key === connectivityKey ? glacierScreen.screen : null;

  /** Upstream/downstream DoED project candidates on the directed network. */
  const cascadeKey = useMemo(
    () => scheme && study && isNepal && !study.tracedFromTerrain && doedProjects && licences
      ? `${scheme.intake.lat.toFixed(5)},${scheme.intake.lon.toFixed(5)}|${scheme.power.lat.toFixed(5)},${scheme.power.lon.toFixed(5)}|${doedProjects.length}`
      : null,
    [scheme, study, isNepal, doedProjects, licences]
  );
  const [cascadeResult, setCascadeResult] = useState<{
    key: string;
    screen: CascadeScreen | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!cascadeKey || !scheme || !doedProjects || !licences) {
      setCascadeResult(null);
      return;
    }
    let dead = false;
    const selected = { intake: scheme.intake, power: scheme.power };
    const direct = licences;
    setCascadeResult({ key: cascadeKey, screen: null, error: null });
    cascadeFor(selected, doedProjects, direct)
      .then((screen) => {
        if (!dead) setCascadeResult({
          key: cascadeKey,
          screen,
          error: screen ? null : 'selected layout could not be matched to the directed river network',
        });
      })
      .catch((cause: unknown) => {
        if (dead) return;
        setCascadeResult({
          key: cascadeKey,
          screen: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => { dead = true; };
  }, [cascadeKey]);
  const currentCascade = cascadeResult?.key === cascadeKey ? cascadeResult : null;
  const cascade = currentCascade?.screen ?? null;
  const cascadeError = currentCascade?.error ?? null;
  const cascadeBusy = Boolean(cascadeKey && currentCascade && !currentCascade.screen && !currentCascade.error);

  /** Regional mapped active-fault context for this exact river reach, Nepal only. */
  const faults = useMemo(
    () =>
      scheme && study && isNepal
        ? faultsFor(study.path.slice(scheme.i, scheme.j + 1))
        : null,
    [scheme, study, isNepal]
  );

  /**
   * The nearest defensible DHM record, and what it says about this site.
   *
   * Offered rather than applied: adopting a measured record changes the
   * headline number, and the engineer should be the one who decides that a
   * gauge 30 km away on a catchment twice the size is the better evidence.
   */
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  useEffect(() => {
    // Graded at the intake COORDINATE, so it must use the intake's catchment.
    const km2 = intakeReach?.uplandKm2;
    if (!scheme || !isNepal || !km2) {
      setTransfer(null);
      return;
    }
    let live = true;
    void bestTransfer(scheme.intake.lat, scheme.intake.lon, km2)
      .then((t) => live && setTransfer(t))
      .catch(() => live && setTransfer(null));
    return () => {
      live = false;
    };
  }, [scheme, study, isNepal, intakeReach]);

  const onAdoptGauge = useCallback(async () => {
    // The same bar the validation harness applies. Adopting below it let the
    // screen replace both models with evidence the harness would not score.
    if (!transfer || !transferMeetsBar(transfer)) return;
    setTransferBusy(true);
    try {
      const series = await loadStationSeries(transfer.station.id);
      if (!series) return;
      // Same gap policy as an imported record: short gaps filled and labelled,
      // long ones left open rather than invented.
      const { series: filled } = fillGaps(series);
      setMeasured({
        series: scaleSeries(filled, transfer.ratio),
        ratio: transfer.ratio,
        name: `DHM ${transfer.station.id} — ${transfer.station.river || 'river'} at ${transfer.station.location || 'gauge'}`,
      });
    } finally {
      setTransferBusy(false);
    }
  }, [transfer]);

  /** A far bigger river beside the one this study picked. See the study effect. */
  const [ambiguity, setAmbiguity] = useState<{
    nearestKm2: number;
    mainKm2: number;
    mainKm: number;
    lat: number;
    lon: number;
  } | null>(null);

  /** Design-level shaking and the instrumented record, at the powerhouse. */
  const seismic: SeismicScreen | null = useMemo(
    () => (scheme && isNepal ? seismicAt(scheme.power.lat, scheme.power.lon) : null),
    [scheme, isNepal]
  );

  /** Collector intakes, screened against the rules in src/collector.ts. */
  const collectors = useMemo(() => {
    if (!scheme || !study || extraIntakes.length === 0) return null;
    const mainPoint = study.path[scheme.i];
    const screen = assessCollectors(
      {
        elevationM: mainPoint?.elevationM ?? null,
        meanCms: mainPoint?.meanCms || null,
        uplandKm2: intakeReach?.uplandKm2 ?? null,
        grossHeadM: scheme.grossHeadM,
      },
      extraIntakes.map((x, index) => {
        // Where this stream rejoins the diverted reach, if it does: walk its
        // downstream route and take the first point that meets the main path
        // below the intake. That point is the confluence.
        // Where the link canal meets the main conveyance: the closest point on
        // the diverted reach, which is what a real alignment would aim for.
        let linkPathIndex = scheme.i;
        let linkKm = Infinity;
        for (let k = scheme.i; k <= scheme.j; k++) {
          const d = haversineKm([x.lat, x.lon], [study.path[k].lat, study.path[k].lon]);
          if (d < linkKm) {
            linkKm = d;
            linkPathIndex = k;
          }
        }
        // An engineer's placement outranks the nearest-point default.
        const override = junctionOverride[index];
        const placed = override != null && override >= scheme.i && override <= scheme.j;
        if (placed) {
          linkPathIndex = override;
          linkKm = haversineKm(
            [x.lat, x.lon],
            [study.path[override].lat, study.path[override].lon]
          );
        }

        /**
         * Route the link down the tributary's own valley instead of straight
         * across country.
         *
         * A link canal is not a chord drawn over a ridge — it is cut into the
         * valley side, and at map scale the valley floor is far closer to a
         * buildable alignment than a straight line. Following the stream's own
         * downstream trace also gives a length worth costing: on this reach it
         * is about a third longer than the chord.
         *
         * The canal itself would sit above the river at a far gentler grade;
         * this is the plan view of where it runs, not its long section.
         */
        const joinPt = study.path[linkPathIndex];
        let linkRoute: [number, number][] | undefined;
        if (x.downstream.length > 1) {
          let nearest = -1;
          let nearestKm = Infinity;
          for (let q = 0; q < x.downstream.length; q++) {
            const d = haversineKm([x.downstream[q].lat, x.downstream[q].lon], [joinPt.lat, joinPt.lon]);
            if (d < nearestKm) {
              nearestKm = d;
              nearest = q;
            }
          }
          // Only when the valley actually arrives at the junction; a stream
          // from another catchment keeps the honest straight-line placeholder.
          if (nearest > 0 && nearestKm < 1.5) {
            const pts = x.downstream.slice(0, nearest + 1);
            let along = 0;
            for (let q = 1; q < pts.length; q++) {
              along += haversineKm([pts[q - 1].lat, pts[q - 1].lon], [pts[q].lat, pts[q].lon]);
            }
            linkKm = along + nearestKm;
            linkRoute = [...pts.map((p) => [p.lon, p.lat] as [number, number]), [joinPt.lon, joinPt.lat]];
          }
        }

        let junctionPathIndex: number | null = null;
        let joinsMainBelowIntakeKm: number | null = null;
        const mainMeanCms = study.path[scheme.i]?.meanCms ?? 0;
        // The network must agree the water arrived, not merely that the two
        // channels came close on the map.
        const merged =
          x.meanCms && mainMeanCms > 0
            ? mainMeanCms + JUNCTION_FLOW_SHARE * x.meanCms
            : null;
        outer: for (const p of x.downstream) {
          for (let k = scheme.i + 1; k <= scheme.j; k++) {
            if (haversineKm([p.lat, p.lon], [study.path[k].lat, study.path[k].lon]) >= JUNCTION_KM) {
              continue;
            }
            if (merged != null && study.path[k].meanCms < merged) continue;
            junctionPathIndex = k;
            joinsMainBelowIntakeKm = study.path[k].km - study.path[scheme.i].km;
            break outer;
          }
        }
        return {
          lat: x.lat,
          lon: x.lon,
          elevationM: x.elevationM,
          meanCms: x.meanCms,
          uplandKm2: x.uplandKm2,
          snappedKm: x.snappedKm,
          /**
           * The link canal runs to the nearest point of the main conveyance,
           * not back to the headpond.
           *
           * A collector's water does not have to be carried up to the intake
           * structure — it only has to reach the headrace, and it joins it
           * wherever the two alignments come closest. That is both the shorter
           * canal and the layout an engineer would actually build. The headrace
           * runs at close to intake level, so the gravity test is unchanged.
           */
          channelKm: linkKm,
          linkPathIndex,
          linkRoute,
          // Re-tested here, not at drop time: moving the intake changes the answer.
          nestedUpstream: x.downstream.some(
            (p) => haversineKm([p.lat, p.lon], [scheme.intake.lat, scheme.intake.lon]) < NESTED_KM
          ),
          joinsMainBelowIntakeKm,
          junctionPathIndex,
          junctionMeanCms: junctionPathIndex != null ? study.path[junctionPathIndex].meanCms : null,
          mainMeanCms,
        };
      })
    );
    return {
      ...screen,
      combinedMW: scheme.capacityMW * (1 + screen.gainFrac),
      combinedGwh: scheme.energyGwh * (1 + screen.gainFrac),
    };
  }, [scheme, study, extraIntakes, junctionOverride]);

  const reachPath = useMemo(
    () => scheme && study ? study.path.slice(scheme.i, scheme.j + 1) : null,
    [scheme, study]
  );

  /** Official 1:50,000 publications available over this exact reach, Nepal only. */
  const dmgGeology = useMemo(
    () => reachPath && isNepal ? geologyMapsFor(reachPath) : null,
    [reachPath, isNepal]
  );

  /**
   * Restrained open global context: three point samples, never a drawn contact.
   * Keying the result prevents a previous scheme's geology flashing under a new
   * selection while the current request is still in flight.
   */
  const regionalKey = useMemo(() => reachPath
    ? [reachPath[0], reachPath[Math.floor((reachPath.length - 1) / 2)], reachPath[reachPath.length - 1]]
        .map((point) => `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`)
        .join('|')
    : null, [reachPath]);
  const [regionalResult, setRegionalResult] = useState<{
    key: string;
    screen: RegionalGeologyScreen | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!reachPath || !regionalKey) {
      setRegionalResult(null);
      return;
    }
    const controller = new AbortController();
    setRegionalResult({ key: regionalKey, screen: null, error: null });
    fetchRegionalGeology(reachPath, controller.signal)
      .then((screen) => setRegionalResult({ key: regionalKey, screen, error: null }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setRegionalResult({
          key: regionalKey,
          screen: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => controller.abort();
  }, [reachPath, regionalKey]);
  const geology = useMemo((): GeologyScreen | null => {
    if (!scheme) return null;
    const current = regionalResult?.key === regionalKey ? regionalResult : null;
    return {
      dmg: dmgGeology,
      regional: current?.screen ?? null,
      regionalError: current?.error ?? null,
    };
  }, [scheme, dmgGeology, regionalResult, regionalKey]);

  // How much to trust it, computed by rerunning the engine on perturbed inputs.
  /**
   * Getting the power out. Measured from the powerhouse, where the switchyard
   * goes, and sized against the scheme's own capacity — a nearby 66 kV line is
   * not a connection for a 150 MW plant.
   */
  const grid = useMemo(
    () => (scheme && isNepal ? gridLink(scheme.power.lat, scheme.power.lon, scheme.capacityMW) : null),
    [scheme, isNepal]
  );

  /**
   * Whether this scheme sits inside a protected area.
   *
   * Tested at BOTH ends: an intake outside a park with its powerhouse inside is
   * still a park problem, and so is the reverse. Near-misses are reported too,
   * because a boundary simplified to 200 m cannot settle a site 300 m outside one.
   */
  const conservation = useMemo(() => {
    if (!scheme || !isNepal) return null;
    const hits = [
      ...protectedAt(scheme.intake.lat, scheme.intake.lon),
      ...protectedAt(scheme.power.lat, scheme.power.lon),
    ];
    const seen = new Set<string>();
    const inside = hits.filter((h) => !seen.has(h.name) && seen.add(h.name));
    /**
     * Proximity at BOTH ends, and even when one end is already inside.
     *
     * A powerhouse can sit a kilometre outside a reserve the intake never goes
     * near — Koshi Tappu is the worked example — and checking only the intake
     * returned no conservation warning at all. Being inside area A also does
     * not stop area B from being 300 m away.
     */
    const nearSeen = new Set(inside.map((h) => h.name));
    const near = [
      ...protectedNear(scheme.intake.lat, scheme.intake.lon, 3),
      ...protectedNear(scheme.power.lat, scheme.power.lon, 3),
    ].filter((h) => !nearSeen.has(h.name) && nearSeen.add(h.name));
    return inside.length || near.length
      ? { inside, near, hard: isHardStop(inside) }
      : null;
  }, [scheme, isNepal]);

  /**
   * The private Nepali layers, when they are installed.
   *
   * Survey sheet number, Nepal's own annual rainfall, buffer zone and
   * municipality — none of which any open global dataset carries. Fetched
   * rather than imported so their absence is a 404 and not a build failure:
   * sources/local/ is gitignored, so a clone simply has none of this and the
   * section below never renders. See src/local-gis.ts.
   */
  const [localGis, setLocalGis] = useState<LocalContext | null>(null);
  useEffect(() => {
    if (!scheme || !isNepal) {
      setLocalGis(null);
      return;
    }
    let dead = false;
    localContextAt(scheme.intake.lat, scheme.intake.lon)
      .then((c) => {
        if (!dead) setLocalGis(c);
      })
      .catch(() => {
        if (!dead) setLocalGis(null);
      });
    return () => {
      dead = true;
    };
  }, [scheme, isNepal]);

  /**
   * Nepal's surveyed 1:25,000 sheets, drawn under the scheme.
   *
   * Off by default: each scan is about 10 MB and only 40 of them are
   * georeferenced, so this is a deliberate act, not something that happens to
   * you. `topoCount` is 0 when the private layer is not installed, and the
   * control never appears. See src/topo-overlay.ts.
   */
  const [topoCount, setTopoCount] = useState(0);
  const [topoOn, setTopoOn] = useState(false);
  useEffect(() => {
    topoAvailable().then(setTopoCount).catch(() => setTopoCount(0));
  }, []);

  /**
   * Show me where that is.
   *
   * Every list in the panel names something that exists at a coordinate, and
   * the only way to see it was to open a government website in another tab.
   * Locating it on the map is what the reader actually wants; the source link
   * stays, but as a secondary action.
   */
  const [focus, setFocus] = useState<Pt | null>(null);
  const onLocate = useCallback((lat: number, lon: number) => {
    const m = map.current;
    if (!m) return;
    setFocus({ lat, lon });
    m.flyTo({ center: [lon, lat], zoom: Math.max(m.getZoom(), 12.5), padding: mapPadding(), duration: 900 });
  }, []);
  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    const src = m.getSource('focus') as maplibregl.GeoJSONSource | undefined;
    src?.setData(
      focus
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'Point', coordinates: [focus.lon, focus.lat] },
              },
            ],
          }
        : empty()
    );
  }, [focus, mapReady]);

  /**
   * Which basemap is under the analysis. Remembered, because someone who works
   * on imagery works on imagery every session and should not re-pick it.
   */
  const [basemap, setBasemap] = useState<BasemapId>(
    () => {
      try { const id = localStorage.getItem('hydrorecon.basemap'); return BASEMAPS.find((b) => b.id === id)?.id ?? 'dark'; }
      catch { return 'dark'; }
    }
  );
  useEffect(() => {
    savePreference('hydrorecon.basemap', basemap);
    const m = map.current;
    if (!m || !mapReady) return;
    for (const b of BASEMAPS) {
      if (!b.tiles || !m.getLayer(`basemap-${b.id}`)) continue;
      m.setLayoutProperty(`basemap-${b.id}`, 'visibility', b.id === basemap ? 'visible' : 'none');
    }
    /**
     * Stop shading terrain nobody can see. A raster basemap covers the
     * hillshade completely and carries its own relief, and the DEM tiles that
     * feed it were measured at 84% of the bytes spent on a zoom.
     */
    if (m.getLayer('hillshade')) {
      m.setLayoutProperty('hillshade', 'visibility', basemap === 'dark' ? 'visible' : 'none');
    }
  }, [basemap, mapReady]);

  /** Legend toggles — visibility only, so switching costs nothing and loses nothing. */
  const [layersOn, setLayersOn] = useState<LayerToggles>(() => readPreference('hydrorecon.layers', DEFAULT_LAYERS));
  useEffect(() => {
    savePreference('hydrorecon.layers', JSON.stringify(layersOn));
    const m = map.current;
    if (!m || !mapReady) return;
    for (const [group, ids] of Object.entries(LAYER_GROUPS)) {
      const on = layersOn[group as keyof LayerToggles];
      for (const id of ids) {
        if (!m.getLayer(id)) continue;
        m.setLayoutProperty(
          id,
          'visibility',
          on && (layersOn.labels || !LABEL_LAYERS.has(id)) ? 'visible' : 'none'
        );
      }
    }
  }, [layersOn, mapReady]);
  /**
   * The DMG geological sheets. Driven like the topo scans — image sources added
   * and removed as the view moves — rather than through LAYER_GROUPS, which
   * only toggles visibility on layers that already exist.
   */
  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    const sync = () => void syncGeologyOverlay(m, layersOn.geology);
    sync();
    m.on('moveend', sync);
    return () => {
      m.off('moveend', sync);
      void syncGeologyOverlay(m, false);
    };
  }, [layersOn.geology, mapReady]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const sync = () => void syncTopoOverlay(m, topoOn);
    sync();
    m.on('moveend', sync);
    return () => {
      m.off('moveend', sync);
    };
  }, [topoOn]);

  /**
   * Sediment: the desanding basin this duty point needs, and what the catchment
   * is going to throw at it.
   *
   * Pure arithmetic, so it sits with the other memos. Whether the valley has
   * room for the basin needs terrain and is fetched below.
   */
  const sediment = useMemo(() => {
    if (!scheme) return null;
    const basin = desander({
      designFlowCms: scheme.designFlowCms,
      netHeadM: scheme.netHeadM,
    });
    return basin
      ? { basin, source: sedimentSource(intakeReach?.below3000Frac ?? NaN) }
      : null;
  }, [scheme, study]);

  /**
   * Is there flat ground beside the intake to put the basin on?
   *
   * A cross-section cut perpendicular to the channel, 500 m wide, sampled at
   * roughly the DEM's own posting — sampling finer would smooth the very gorge
   * walls the test exists to detect. The tiles are cached module-side, so
   * dragging the intake around a valley re-fetches almost nothing.
   *
   * This never blocks: no terrain, no answer, and the panel simply says the
   * question is open.
   */
  const [bench, setBench] = useState<BenchFit | null>(null);
  const intakeLat = scheme?.intake.lat;
  const intakeLon = scheme?.intake.lon;
  const benchNeededM = sediment?.basin.benchNeededM;
  useEffect(() => {
    const i = scheme?.i;
    if (!study || i === undefined || !benchNeededM || intakeLat === undefined || intakeLon === undefined) {
      setBench(null);
      return;
    }
    // River direction from this point to the next, as east/north components.
    const next = study.path[Math.min(study.path.length - 1, i + 1)];
    const cos = Math.cos((intakeLat * Math.PI) / 180) || 1;
    const dy = next.lat - intakeLat;
    const dx = (next.lon - intakeLon) * cos;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) {
      setBench(null);
      return;
    }
    const halfDeg = HALF_SECTION_M / 111320;
    // Rotate the flow direction a quarter turn to cut across the valley.
    const px = (-dy / len) * halfDeg;
    const py = (dx / len) * halfDeg;
    let dead = false;
    fetchProfile(
      [intakeLat - py, intakeLon - px / cos],
      [intakeLat + py, intakeLon + px / cos],
      SECTION_SAMPLES
    )
      .then((prof) => {
        if (dead) return;
        setBench(
          benchFit(
            prof.points.map((p) => ({
              offsetM: p.distanceKm * 1000 - HALF_SECTION_M,
              elevationM: p.elevationM,
            })),
            benchNeededM,
            prof.resolutionM
          )
        );
      })
      .catch(() => {
        if (!dead) setBench(null);
      });
    return () => {
      dead = true;
    };
  }, [study, scheme?.i, intakeLat, intakeLon, benchNeededM]);

  // A new pair or a new click invalidates the audit: the head was measured for
  // one specific intake/powerhouse pair. An upgraded flow record lives inside
  // `study` and rightly survives — it belongs to the click, not the pair.
  useEffect(() => {
    auditGeneration.current++;
    setAudit(null);
    setAuditBusy(null);
  }, [pick?.i, pick?.j, at, measured]);

  const uncertainty = useMemo(() => {
    if (!input || !scheme || !study) return null;
    return uncertaintyFor(
      input,
      scheme,
      meanOf(study.flow.values),
      study.reach?.meanDischargeCms ?? null,
      // A supplied record replaces the model-disagreement logic entirely.
      measured ? measuredSpread(measured.ratio) : undefined,
      flowChoice?.authority,
      audit?.head?.errM
    );
  }, [input, scheme, study, measured, flowChoice, audit]);

  const readiness = useMemo(
    () =>
      assessReadiness({
        region,
        borderKm,
        scheme,
        flowYears: study ? new Set(study.flow.dates.map((d) => d.slice(0, 4))).size : 0,
        measured: Boolean(measured),
        flowChoice,
        hydest,
        residualFraction: effectiveResidualFrac,
        headAudit: audit?.head ?? null,
        auditYears: audit?.years ?? null,
        licences,
        gauges,
        grid,
        hazards,
        upstreamConnectivity,
        cascade,
        faults,
        geology,
        conservation,
        sediment,
        bench,
        landcover,
      }),
    [
      region,
      borderKm,
      scheme,
      study,
      measured,
      flowChoice,
      hydest,
      effectiveResidualFrac,
      audit,
      licences,
      gauges,
      grid,
      hazards,
      upstreamConnectivity,
      cascade,
      faults,
      geology,
      conservation,
      sediment,
      bench,
      landcover,
    ]
  );

  /**
   * Take a record file from the engineer.
   *
   * Scaled here rather than in the parser so the raw file is never mutated, and
   * so the scale factor stays visible next to the result.
   */
  const onImport = useCallback(
    async (file: File) => {
      setError(null);
      const text = await file.text();
      const parsed = parseMeasured(text);
      if (!parsed.ok) {
        setError(`${parsed.error}${parsed.hint ? ` ${parsed.hint}` : ''}`);
        return;
      }
      /**
       * AN IMPORTED FILE IS TAKEN AT FACE VALUE. It is not scaled.
       *
       * This used to pre-fill a catchment ratio from whichever nearby gauge
       * looked trustworthy and multiply every value by it, with no station
       * match, no confirmation and no way to tell from the number that it had
       * happened. That is right for a borrowed DHM record — which arrives
       * through `onAdoptGauge`, where the donor and its ratio are both known —
       * and wrong for everything else. An engineer importing their own gauging
       * at the intake would have had it silently multiplied by the area ratio
       * of someone else's station.
       *
       * If a file does need transferring, the ratio control beside it does that
       * explicitly, which is the only way it can be reviewed.
       */
      const suggested = 1;
      /**
       * Close short holes before anything else touches the record.
       *
       * Missing days in a gauge record are not missing at random: Nepali
       * stations lose readings when the river is in flood, so the absences sit
       * in the monsoon. Dropping them, which is what happened before, removes
       * high flows preferentially and understates the flood tail and the energy
       * with it. Filled days are labelled as estimates in the notes the panel
       * shows, and long gaps are still left open.
       */
      const { series } = fillGaps(parsed.series);
      setMeasured({
        series: scaleSeries(series, suggested),
        ratio: suggested,
        name: file.name,
      });
    },
    [gauges]
  );

  // ---------------- markers + highlight ----------------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const place = (
      key: 'a' | 'b',
      pt: Pt | null,
      color: string,
      label: string,
      title: string,
      onDrop: (p: Pt, ctrl: boolean) => void
    ) => {
      // Rebound every run: the dragend listener is bound once at creation, so
      // reading the handler through this ref is what keeps it seeing current
      // state instead of the state from the render that created the marker.
      dropHandlers.current[key] = onDrop;
      const existing = markers.current[key];
      if (!pt) {
        existing?.remove();
        delete markers.current[key];
        return;
      }
      if (existing) {
        existing.setLngLat([pt.lon, pt.lat]);
        return;
      }
      const el = document.createElement('div');
      el.className = 'marker';
      el.dataset.tour = key === 'a' ? 'intake' : 'powerhouse';
      el.style.setProperty('--c', color);
      el.title = title;
      const tag = document.createElement('span');
      tag.className = 'marker-tag';
      tag.textContent = label;
      el.appendChild(tag);
      // Whether Ctrl was down when the drag began — read at dragend.
      let ctrlAtStart = false;
      el.addEventListener('pointerdown', (ev) => {
        ctrlAtStart = ev.ctrlKey || ev.metaKey;
      });
      const mk = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([pt.lon, pt.lat])
        .addTo(m);
      mk.on('dragend', () => {
        const l = mk.getLngLat();
        dropHandlers.current[key]?.({ lat: l.lat, lon: l.lng }, ctrlAtStart);
        ctrlAtStart = false;
      });
      markers.current[key] = mk;
    };

    // Dragging slides the end along the studied river — no refetch needed.
    const slide = (which: 'i' | 'j') => (p: Pt) => {
      if (!study || !pick) return;
      let best = which === 'i' ? pick.i : pick.j;
      let bd = Infinity;
      for (let k = 0; k < study.path.length; k++) {
        const i = which === 'i' ? k : pick.i;
        const j = which === 'j' ? k : pick.j;
        if (j <= i || study.path[j].km - study.path[i].km > maxWaterwayKm + 1e-9) continue;
        /**
         * Match against the DRAWN position, not the modelled one.
         *
         * The display geometry keeps a matched point for every model sample.
         * Matching a drop against the modelled positions meant dropping the
         * marker on the visible blue river picked whichever vertex happened to
         * be nearest a line the user cannot see — the marker then re-rendered
         * somewhere else, which reads exactly like the app refusing the
         * position. Aim at what is on screen.
         */
        const displayed = riverDisplay?.points[k] ?? study.path[k];
        const d = haversineKm([p.lat, p.lon], [displayed.lat, displayed.lon]);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      setTweaked(true);
      setPick(
        which === 'i'
          ? { i: Math.min(best, pick.j - 1), j: pick.j }
          : { i: pick.i, j: Math.max(best, pick.i + 1) }
      );
    };

    /**
     * Draw each end on the same display geometry as the highlighted course.
     * Nothing numeric moves: `scheme.intake`
     * and `scheme.power` are still the modelled positions, and every elevation,
     * catchment and flow figure is still read there.
     */
    const drawnAt = (k: number | undefined) => {
      if (k == null || !study?.path[k]) return null;
      const p = riverDisplay?.points[k] ?? study.path[k];
      return { lat: p.lat, lon: p.lon };
    };
    place(
      'a',
      drawnAt(pick?.i) ?? scheme?.intake ?? at,
      '#4db8ff',
      'intake',
      'Intake — drag along the river · Ctrl-drag onto another stream to add a collector intake',
      (p, ctrl) => {
        /**
         * Ctrl, and only Ctrl, spawns a collector.
         *
         * This used to also trigger on distance — drop far enough from the
         * studied river and it assumed you meant a second intake. That guessed
         * wrong constantly: dragging the intake anywhere the mapped centreline
         * happens to be coarse silently created an intake 2 instead of moving
         * the one you were holding. A modifier key is a decision; a distance
         * threshold is a guess about intent.
         */
        if (scheme && ctrl) {
          const shown = drawnAt(pick?.i) ?? scheme.intake;
          markers.current.a?.setLngLat([shown.lon, shown.lat]);
          void addExtraIntake(p);
        } else {
          slide('i')(p);
        }
      }
    );
    place('b', drawnAt(pick?.j) ?? scheme?.power ?? null, '#3fb950', 'powerhouse', 'Powerhouse — drag along the river', (p) =>
      slide('j')(p)
    );

    // Collector intake pins — few and cheap, so rebuilt on every change.
    for (const mk of extraMarkers.current) mk.remove();
    extraMarkers.current = extraIntakes.map((x, index) => {
      const assessed = collectors?.items[index];
      const ok = assessed?.verdict === 'ok';
      const el = document.createElement('div');
      el.className = 'marker';
      // A rejected collector is red on the map, not a hopeful blue.
      el.style.setProperty('--c', ok ? '#4db8ff' : '#e5534b');
      el.title = assessed
        ? `Collector intake — ${assessed.reason} Drag to move it, double-click to remove it.`
        : 'Collector intake — drag to move it, double-click to remove it';
      const tag = document.createElement('span');
      tag.className = 'marker-tag';
      tag.textContent = ok ? `intake ${index + 2}` : `intake ${index + 2} ✕`;
      el.appendChild(tag);
      el.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        setExtraIntakes((current) => current.filter((_, i2) => i2 !== index));
      });
      const mk = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([x.lon, x.lat])
        .addTo(m);
      mk.on('dragend', () => {
        const l = mk.getLngLat();
        void addExtraIntake({ lat: l.lat, lon: l.lng }, index);
      });
      return mk;
    });

    const collectorsSrc = m.getSource('collectors') as maplibregl.GeoJSONSource | undefined;
    if (collectorsSrc) {
      /**
       * Just the link canal: collector intake to the point where it meets the
       * main waterway. Past that point the two are one flow, and the solid
       * waterway line already carries it to the powerhouse — drawing a second
       * line along the same route only made it look like the collector was
       * plumbed into the intake structure.
       */
      collectorsSrc.setData(
        scheme && study && collectors && collectors.items.length
          ? {
              type: 'FeatureCollection',
              features: collectors.items.map((c) => {
                const ok = c.verdict === 'ok';
                const join = study.path[c.linkPathIndex ?? scheme.i] ?? scheme.intake;
                return {
                  type: 'Feature' as const,
                  properties: { ok: ok ? 1 : 0, verdict: c.verdict },
                  geometry: {
                    type: 'LineString' as const,
                    coordinates: c.linkRoute?.length
                      ? c.linkRoute
                      : [
                          [c.lon, c.lat] as [number, number],
                          [join.lon, join.lat] as [number, number],
                        ],
                  },
                };
              }),
            }
          : empty()
      );
    }

    /**
     * The junction, as something you can move.
     *
     * The default is the closest point on the waterway, which is the shortest
     * canal but not always a buildable one — the straight line from a tributary
     * to the headrace can cross a spur. Dragging this pin slides the junction
     * along the waterway; the link length and its gradient re-derive from
     * wherever it lands, so a longer, gentler route can be priced against a
     * short steep one.
     */
    for (const mk of junctionMarkers.current) mk.remove();
    junctionMarkers.current = [];
    if (scheme && study && collectors) {
      collectors.items.forEach((c, index) => {
        if (c.verdict !== 'ok' || c.linkPathIndex == null) return;
        const join = study.path[c.linkPathIndex];
        const el = document.createElement('div');
        el.className = 'marker marker-junction';
        el.style.setProperty('--c', '#ffb454');
        el.title = 'Junction — drag along the waterway to move where the link canal joins';
        const tag = document.createElement('span');
        tag.className = 'marker-tag';
        tag.textContent = 'junction';
        el.appendChild(tag);
        const marker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat([join.lon, join.lat])
          .addTo(m);
        marker.on('dragend', () => {
          const l = marker.getLngLat();
          // Snap to the nearest point of the diverted reach: a junction that is
          // not on the waterway is not a junction.
          let bestK = scheme.i;
          let bestD = Infinity;
          for (let k = scheme.i; k <= scheme.j; k++) {
            const d = haversineKm([l.lat, l.lng], [study.path[k].lat, study.path[k].lon]);
            if (d < bestD) {
              bestD = d;
              bestK = k;
            }
          }
          setJunctionOverride((current) => ({ ...current, [index]: bestK }));
        });
        junctionMarkers.current.push(marker);
      });
    }

    const lic = m.getSource('licences') as maplibregl.GeoJSONSource | undefined;
    if (lic) {
      lic.setData({
        type: 'FeatureCollection',
        features: (doedProjects ?? []).map((l) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
          properties: {
            name: l.name,
            stage: l.stage,
            cap: l.capacityMW ?? '',
            capN: l.capacityMW ?? 0,
            label: `${l.name}${l.capacityMW ? ` · ${l.capacityMW} MW` : ''}`,
            promoter: l.promoter,
            rangeKm: l.bounds
              ? haversineKm([l.bounds[0], l.bounds[1]], [l.bounds[2], l.bounds[3]]).toFixed(1)
              : '?',
          },
        })),
      });
    }

    const licAreas = m.getSource('licence-areas') as maplibregl.GeoJSONSource | undefined;
    if (licAreas) {
      licAreas.setData({
        type: 'FeatureCollection',
        features: (doedProjects ?? [])
          .filter((l) => l.bounds)
          .map((l) => {
            // Published as [south, west, north, east].
            const [s0, w0, n0, e0] = l.bounds as [number, number, number, number];
            return {
              type: 'Feature' as const,
              geometry: {
                type: 'Polygon' as const,
                coordinates: [[[w0, s0], [e0, s0], [e0, n0], [w0, n0], [w0, s0]]],
              },
              properties: {
                name: l.name,
                stage: l.stage,
                label: `${l.name}${l.capacityMW ? ` · ${l.capacityMW} MW` : ''}`,
                promoter: l.promoter,
              },
            };
          }),
      });
    }

    const hazardSource = m.getSource('hazards') as maplibregl.GeoJSONSource | undefined;
    if (hazardSource) {
      hazardSource.setData({
        type: 'FeatureCollection',
        features: hazardInventory().map((record) => {
          const year = Number(record.date.slice(0, 4));
          return {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [record.lon, record.lat] },
            properties: {
              id: record.id,
              kind: record.kind,
              title: record.title,
              date: record.date,
              distance: hazards?.records.find((h) => h.id === record.id)?.distanceKm.toFixed(1) ?? '',
              label: `${record.title} · ${record.date.slice(0, 4)}`,
              age: Number.isFinite(year) ? Math.max(0, new Date().getFullYear() - year) : 5,
            },
          };
        }),
      });
    }

    const upstreamRoutes = m.getSource('upstream-routes') as maplibregl.GeoJSONSource | undefined;
    if (upstreamRoutes) {
      upstreamRoutes.setData({
        type: 'FeatureCollection',
        features: [
          ...(upstreamConnectivity?.lakes ?? []),
          ...(upstreamConnectivity?.incidents ?? []),
        ].filter((source) => source.route.length > 1).map((source) => ({
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: source.route },
          properties: {
            sourceType: 'expansionRateKm2Yr' in source ? 'lake' : 'incident',
            id: source.id,
          },
        })),
      });
    }
    const upstreamSources = m.getSource('upstream-sources') as maplibregl.GeoJSONSource | undefined;
    if (upstreamSources) {
      upstreamSources.setData({
        type: 'FeatureCollection',
        features: [
          ...(upstreamConnectivity?.lakes ?? []).map((lake) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [lake.lon, lake.lat] },
            properties: {
              sourceType: 'lake', id: lake.id, kind: 'lake',
              pdgl: lake.pdgl ? 1 : 0,
              title: lake.pdgl
                ? `Potentially dangerous glacial lake${lake.pdgl.name ? ` — ${lake.pdgl.name}` : ''}`
                : 'Mapped glacial lake',
              detail:
                `${lake.basin} · ${lake.country} · ${Math.round(lake.elevationM)} m` +
                (lake.pdgl ? ` · ICIMOD Rank ${'I'.repeat(lake.pdgl.rank)} of III (2020)` : ''),
              pdglName: lake.pdgl?.name ?? 'ICIMOD danger list',
              route: lake.routeKm.toFixed(1), snap: lake.snapKm.toFixed(2),
              url: upstreamConnectivity?.lakeInventory.source ?? '',
            },
          })),
          ...(upstreamConnectivity?.incidents ?? []).map((incident) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [incident.lon, incident.lat] },
            properties: {
              sourceType: 'incident', id: incident.id, kind: incident.kind, title: incident.title,
              detail: incident.date, route: incident.routeKm.toFixed(1), snap: incident.snapKm.toFixed(2),
              url: incident.url,
            },
          })),
        ],
      });
    }

    const glacierSource = m.getSource('glaciers-upstream') as maplibregl.GeoJSONSource | undefined;
    if (glacierSource) {
      glacierSource.setData({
        type: 'FeatureCollection',
        features: (glaciers?.connected ?? []).map((g) => ({
          type: 'Feature' as const,
          geometry: { type: 'Polygon' as const, coordinates: g.rings },
          properties: { id: g.id, name: g.name ?? '', areaKm2: g.areaKm2, routeKm: g.routeKm },
        })),
      });
    }

    const cascadeRoutes = m.getSource('cascade-routes') as maplibregl.GeoJSONSource | undefined;
    if (cascadeRoutes) {
      cascadeRoutes.setData({
        type: 'FeatureCollection',
        features: [
          ...(cascade?.upstream ?? []),
          ...(cascade?.downstream ?? []),
        ].filter((project) => project.routeGeometryIncluded && project.route.length > 1).map((project) => ({
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: project.route },
          properties: {
            direction: project.direction,
            name: project.name,
            stage: project.stage,
          },
        })),
      });
    }
    const cascadeProjects = m.getSource('cascade-projects') as maplibregl.GeoJSONSource | undefined;
    if (cascadeProjects) {
      cascadeProjects.setData({
        type: 'FeatureCollection',
        features: [
          ...(cascade?.upstream ?? []),
          ...(cascade?.downstream ?? []),
        ].map((project) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [project.lon, project.lat] },
          properties: {
            name: project.name,
            stage: project.stage,
            cap: project.capacityMW ?? '',
            label: `${project.name}${project.capacityMW ? ` · ${project.capacityMW} MW` : ''}`,
            direction: project.direction,
            advanced: project.stage === 'Operating' || project.stage === 'Construction licence' ? 'yes' : 'no',
            route: project.routeKm.toFixed(1),
            snap: project.snapKm.toFixed(2),
            range: project.publishedRangeDiagonalKm.toFixed(1),
            source: cascade?.registry.source ?? '',
          },
        })),
      });
    }

    const faultSource = m.getSource('faults') as maplibregl.GeoJSONSource | undefined;
    if (faultSource) {
      faultSource.setData({
        type: 'FeatureCollection',
        features: (faults?.nearby ?? []).map((fault) => ({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: fault.points.map(([lon, lat]) => [lon, lat]),
          },
          properties: {
            id: fault.id,
            sourceId: fault.sourceId,
            name: fault.name ?? '',
            type: fault.type,
            distance: fault.distanceKm.toFixed(1),
            intersection: fault.intersectsReach ? 'yes' : 'no',
          },
        })),
      });
    }

    const geologySource = m.getSource('geology-sheets') as maplibregl.GeoJSONSource | undefined;
    if (geologySource) {
      geologySource.setData({
        type: 'FeatureCollection',
        features: (geology?.dmg?.maps ?? []).flatMap((publication) =>
          publication.sheets.map((sheet) => {
            const [west, south, east, north] = sheet.bounds;
            return {
              type: 'Feature' as const,
              geometry: {
                type: 'Polygon' as const,
                coordinates: [[
                  [west, south], [east, south], [east, north], [west, north], [west, south],
                ]],
              },
              properties: {
                id: publication.id,
                title: publication.title,
                year: publication.published.slice(0, 4),
                sheet: sheet.code,
                previewUrl: publication.previewUrl,
                label: `DMG geological map · sheet ${sheet.code} (${publication.published.slice(0, 4)})`,
              },
            };
          })
        ),
      });
    }

    const pondageSource = m.getSource('pondage') as maplibregl.GeoJSONSource | undefined;
    if (pondageSource) {
      pondageSource.setData(
        pondageState.result ? pondageGeoJson(pondageState.result) : empty()
      );
    }

    const roadSource = m.getSource('road-access') as maplibregl.GeoJSONSource | undefined;
    if (roadSource) {
      roadSource.setData(
        roadAccessState.result ? roadAccessGeoJson(roadAccessState.result) : empty()
      );
    }

    const src = m.getSource('scheme') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(
        study && scheme
          ? riverDisplay ? displayGeoJson(riverDisplay, scheme.i, scheme.j) : {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: {},
                  geometry: {
                    type: 'LineString',
                    coordinates: study.path
                      .slice(scheme.i, scheme.j + 1)
                      .map((p) => [p.lon, p.lat]),
                  },
                },
              ],
            }
          : empty()
      );
    }
  }, [scheme, at, study, pick, riverDisplay, maxWaterwayKm, licences, doedProjects, hazards, upstreamConnectivity, cascade, faults, geology, mapReady, extraIntakes, collectors, addExtraIntake, pondageState.result, roadAccessState.result]);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    (m.getSource('display-channel') as maplibregl.GeoJSONSource)?.setData(riverDisplay ? displayGeoJson(riverDisplay) : empty());
    (m.getSource('model-reference') as maplibregl.GeoJSONSource)?.setData(showModelGeometry && study ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: study.path.map((p) => [p.lon, p.lat]) } }] } : empty());
    const sync = () => {
      const visibility = !riverDisplay || showModelGeometry ? 'visible' : 'none';
      if (m.getLayer('reaches') && m.getLayoutProperty('reaches', 'visibility') !== visibility) m.setLayoutProperty('reaches', 'visibility', visibility);
    };
    sync();
    // The network can finish loading after the display geometry.
    const onSource = (e: maplibregl.MapSourceDataEvent) => { if (e.sourceId === 'reaches') sync(); };
    m.on('sourcedata', onSource);
    return () => { m.off('sourcedata', onSource); };
  }, [riverDisplay, showModelGeometry, study, mapReady]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const c = m.getCenter();
    writeUrl({ lat: c.lat, lon: c.lng, zoom: m.getZoom() }, at);
  }, [at]);

  const runProbe = useCallback(async () => {
    if (!at) return;
    setBusy('Checking neighbouring cells…');
    setNeighbours(await probeNeighbours(at.lat, at.lon));
    setBusy(null);
  }, [at]);

  /** Everything a downloaded file needs to explain itself. */
  const exportCtx = useMemo((): ExportContext | null => {
    if (!at || !study || !found) return null;
    return {
      at,
      region,
      boundaryDistanceKm: borderKm,
      readiness,
      hazards,
      upstreamConnectivity,
      cascade,
      faults,
      geology,
      hydest,
      glaciers,
      flowChoice,
      pondage: pondageState.result,
      pondageSweep,
      roadAccess: roadAccessState.result,
      landcover,
      geologyUnits,
      ambiguity,
      designSweep,
      /**
       * The scheme on screen is always in the exported list.
       *
       * Exports iterate this collection, and the selected pair was passed only
       * alongside it. Drag an intake and the evaluated result is no longer one
       * of the retained top eight, so the CSV held rows for eight layouts the
       * user was not looking at, no row was marked selected, and the GeoJSON
       * had no geometry for the result on screen — while the pondage and access
       * objects appended to it described that missing layout.
       */
      schemes:
        scheme && !found.schemes.some((s) => s.i === scheme.i && s.j === scheme.j)
          ? [scheme, ...found.schemes]
          : found.schemes,
      selected: scheme,
      /**
       * Set when the scheme search and the flow arbitration disagree in a loop
       * and the pick had to be frozen. Two layouts, two flow authorities, and
       * no basis in the data for preferring either — a reader must be told that
       * rather than handed whichever one the race stopped on.
       */
      pickUnstable: pickCycle,
      path: study.path,
      demSource: study.dem.source,
      demResolutionM: study.dem.resolutionM,
      flowYears: new Set(study.flow.dates.map((d) => d.slice(0, 4))).size,
      flowMeanCms: meanOf(study.flow.values),
      networkMeanCms: study.reach?.meanDischargeCms ?? null,
      catchmentRainMm:
        study.reach && Number.isFinite(study.reach.annualPrecipMm) ? study.reach.annualPrecipMm : null,
      mhsp,
      flowShape,
      uncertainty,
      flow: { dates: study.flow.dates, values: study.flow.values },
      band: uncertainty
        ? {
            capLow: uncertainty.capacityMW.low,
            capHigh: uncertainty.capacityMW.high,
            energyLow: uncertainty.energyGwh.low,
            energyHigh: uncertainty.energyGwh.high,
          }
        : null,
      tracedFromTerrain: Boolean(study.tracedFromTerrain),
      evaluated: found.evaluated,
      licences: licences ?? [],
      gauges: gauges ?? [],
      grid,
      sediment: sediment ? { source: sediment.source, bench } : null,
      // Evidence the panel shows and the file used to drop entirely.
      seismic: seismic
        ? {
            pga475g: seismic.pgaG,
            quakeCount: seismic.within50,
            largest: seismic.largest
              ? `M${seismic.largest.mag.toFixed(1)} in ${seismic.largest.year}, ` +
                `${seismic.largest.km.toFixed(0)} km away at ${seismic.largest.depthKm.toFixed(0)} km depth`
              : null,
          }
        : null,
      conservation: conservation
        ? {
            inside: conservation.inside.map((a) => ({ name: a.name, regime: a.regime })),
            near: conservation.near.map((a) => ({
              name: a.name,
              regime: a.regime,
              distanceKm: a.distanceKm ?? 3,
            })),
            hard: conservation.hard,
          }
        : null,
      localGis: localGis
        ? {
            municipality: localGis.unit
              ? `${localGis.unit.name}, ${localGis.unit.district} (${localGis.unit.province})`
              : null,
            sheet: localGis.sheet,
            isohyetMm: localGis.annualRainMm,
          }
        : null,
      collectors: collectors
        ? {
            gainFrac: collectors.gainFrac,
            counted: collectors.items
              .filter((k) => k.verdict === 'ok')
              .map((k) => ({ name: null, lat: k.lat, lon: k.lon, flowFrac: k.ratio })),
          }
        : null,
      measured: measured
        ? {
            name: measured.name,
            values: measured.series.values.length,
            from: measured.series.from,
            to: measured.series.to,
            ratio: measured.ratio,
            notes: measured.series.notes,
          }
        : null,
      assumptions: {
        exceedance: assume.exceedance,
        efficiency: assume.efficiency,
        headLossFrac: assume.headLossFrac,
        residualFrac: effectiveResidualFrac,
      },
    };
  }, [at, region, borderKm, readiness, hazards, upstreamConnectivity, cascade, faults, geology, hydest, flowChoice, pondageState.result, pondageSweep, roadAccessState.result, landcover, geologyUnits, ambiguity, designSweep, study, found, scheme, licences, gauges, grid, sediment, bench, measured, assume, effectiveResidualFrac, uncertainty, pickCycle]);

  /**
   * The assembled export context, for harnesses and for checking the printed
   * report against a real study. Development only — `window.__map` above is the
   * same idea, and neither belongs in a build someone else loads.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __exportCtx: typeof exportCtx }).__exportCtx = exportCtx;
  }, [exportCtx]);

  /**
   * Pin the intake and powerhouse from outside, for rendering a report at a
   * layout somebody else chose.
   *
   * The app's own answer to "where does this scheme go" is `discover()`, and a
   * user overrides it by DRAGGING a marker. A caller with two coordinates — a
   * developer's own bounding box, a licence application, a report being
   * reproduced — has no way to say so, and `setPick` is component state that
   * nothing outside can reach.
   *
   * This is exactly what `slide()` does on a drag, for both ends at once,
   * including `setTweaked(true)` — without it the auto-select effect above
   * overwrites the pinned layout on its next pass and the report silently
   * describes a different scheme.
   *
   * It RETURNS THE SNAP DISTANCE because the ends can only sit on vertices of
   * the studied river: a coordinate 300 m up a hillside becomes the nearest
   * point on the channel, and a caller who is not told that will read the
   * report as describing the point they asked for. Development only, like the
   * two hooks above.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const nearest = (p: { lat: number; lon: number }) => {
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < (study?.path.length ?? 0); k++) {
        const d = haversineKm([p.lat, p.lon], [study!.path[k].lat, study!.path[k].lon]);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      return { index: best, snapKm: bd };
    };
    (
      window as unknown as {
        __placeScheme: (
          intake: { lat: number; lon: number },
          powerhouse: { lat: number; lon: number }
        ) => unknown;
      }
    ).__placeScheme = (intake, powerhouse) => {
      if (!study || study.path.length < 2) return { ok: false, why: 'no studied river yet' };
      const a = nearest(intake);
      const b = nearest(powerhouse);
      if (a.index === b.index) {
        return { ok: false, why: 'both points snap to the same river vertex', a, b };
      }
      // The engine requires the intake upstream of the powerhouse. If the two
      // arrive the other way round the caller has them reversed, or the river
      // runs the other way; say so rather than silently swapping.
      if (a.index > b.index) {
        return {
          ok: false,
          why: 'the intake snaps DOWNSTREAM of the powerhouse on this river',
          a,
          b,
        };
      }
      if (study.path[b.index].km - study.path[a.index].km > maxWaterwayKm + 1e-9) {
        return { ok: false, why: `layout exceeds the selected ${maxWaterwayKm} km limit`, a, b };
      }
      setTweaked(true);
      setPick({ i: a.index, j: b.index });
      return {
        ok: true,
        intake: { ...study.path[a.index], index: a.index, snapKm: a.snapKm },
        powerhouse: { ...study.path[b.index], index: b.index, snapKm: b.snapKm },
        pathLength: study.path.length,
      };
    };
  }, [study, maxWaterwayKm]);

  /**
   * Who the desk study is from. Nothing in the hydrology knows the project's
   * name, the developer or the consultancy, and a DoED submission is not a
   * document without all three — so they are typed once and remembered rather
   * than asked for on every export.
   */
  const [reportMeta, setReportMeta] = useState<ReportMeta>(() => {
    // The rename moved these keys. Falling back to the old ones means a user who
    // had already typed their developer and consultant does not lose them to a
    // change of name they had no part in.
    const saved = (field: string) =>
      localStorage.getItem(`hydrorecon.report.${field}`) ??
      localStorage.getItem(`ghatta.report.${field}`) ??
      '';
    return {
      projectName: saved('project'),
      developer: saved('developer'),
      consultant: saved('consultant'),
    };
  });
  const onReportMeta = useCallback((m: ReportMeta) => {
    setReportMeta(m);
    localStorage.setItem('hydrorecon.report.project', m.projectName);
    localStorage.setItem('hydrorecon.report.developer', m.developer);
    localStorage.setItem('hydrorecon.report.consultant', m.consultant);
  }, []);

  /**
   * Photograph the map for the report.
   *
   * Basemap and layer visibility are driven straight on the map object rather
   * than through React state: a capture has to finish before the next one
   * starts, and routing four of them through a re-render would race. Prior
   * visibility is saved and put back, so the screen is exactly as the user left
   * it once the export is done.
   *
   * `idle` is the only honest signal that tiles have finished — `load` fires
   * before a basemap swap has fetched anything, and capturing then gives a grey
   * rectangle.
   */
  const captureFigures = useCallback(async (): Promise<ReportFigures> => {
    const m = map.current;
    if (!m) return {};

    /**
     * FRAME THE SCHEME, don't photograph the viewport.
     *
     * The first version captured whatever the user happened to be looking at,
     * so the "project layout" figure was centred whereever the map was left and
     * the powerhouse fell outside the frame entirely. A layout figure that does
     * not contain both ends of the layout is worse than no figure.
     *
     * Padding is SYMMETRIC here, unlike the `fit` button. That button offsets
     * right because the reading panel covers a third of the screen — but the
     * canvas underneath spans the full width and that is what toDataURL
     * returns, so an offset fit would print the scheme pushed to the left.
     */
    const camera = {
      center: m.getCenter(),
      zoom: m.getZoom(),
      bearing: m.getBearing(),
      pitch: m.getPitch(),
      padding: m.getPadding(),
    };
    const frame = (extra: [number, number][] = []) => {
      const pts: [number, number][] = [...extra];
      if (scheme && study) {
        pts.push([scheme.intake.lon, scheme.intake.lat], [scheme.power.lon, scheme.power.lat]);
        // The waterway bends; its vertices keep the whole alignment in frame.
        for (const q of study.path.slice(scheme.i, scheme.j + 1)) pts.push([q.lon, q.lat]);
      }
      if (pts.length < 2) return false;
      const b = pts.reduce(
        (box, q) => box.extend(q),
        new maplibregl.LngLatBounds(pts[0], pts[0])
      );
      // Generous padding so a labelled endpoint never sits on the frame edge.
      m.fitBounds(b, { padding: 90, duration: 0, maxZoom: 15 });
      return true;
    };

    /**
     * Frame a box of a given radius around the works.
     *
     * The seismic and grid figures are about a DISTANCE — how far the nearest
     * fault or substation is — and neither screen carries the coordinates that
     * distance was measured to. Building four corners at the radius puts the
     * subject inside the frame without needing them, and the caption states the
     * width so the reader measures rather than guesses.
     */
    /**
     * Read a paint property that the layer may never have declared.
     *
     * MapLibre throws rather than returning undefined when a layer has no value
     * set for the property at all — `text-halo-color` on a symbol layer that
     * never asked for a halo, for instance. The report figures deliberately
     * repaint layers styled for the dark basemap, which means asking for
     * properties they were never given. Undefined restores the default, which
     * is exactly what "it had no value" should restore to.
     */
    const readPaint = (layer: string, prop: string): unknown => {
      try {
        return m.getPaintProperty(layer, prop);
      } catch {
        return undefined;
      }
    };
    /**
     * And the write, which throws for the same reason — MapLibre reads the old
     * value to diff against before it sets the new one. A figure repainting a
     * layer that turns out not to carry the property should lose that one
     * flourish, not abort the whole capture and leave the report with no maps.
     */
    const writePaint = (layer: string, prop: string, value: unknown) => {
      try {
        m.setPaintProperty(layer, prop, value as never);
      } catch {
        /* layer does not carry this property; nothing to restore either */
      }
    };

    const frameRadius = (km: number) => {
      if (!scheme) return false;
      const lat = (scheme.intake.lat + scheme.power.lat) / 2;
      const lon = (scheme.intake.lon + scheme.power.lon) / 2;
      const dLat = km / 111.32;
      const dLon = km / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
      return frame([
        [lon - dLon, lat - dLat],
        [lon + dLon, lat + dLat],
      ]);
    };

    const ids = [
      'display-channel', 'display-channel-approximate', 'model-reference', 'scheme-approximate',
      'inventory-gauges', 'inventory-gauges-labels', 'inventory-lakes', 'inventory-lakes-labels',
      'explorer-area-fill', 'explorer-area-line',
      ...BASEMAPS.filter((b) => b.tiles).map((b) => `basemap-${b.id}`),
      'hillshade',
      'report-ends-dot',
      'report-ends-label',
      'report-gauges-dot',
      'report-gauges-label',
      ...Object.values(LAYER_GROUPS).flat(),
    ];
    const saved = new Map<string, string>();
    for (const id of ids) {
      if (m.getLayer(id)) saved.set(id, (m.getLayoutProperty(id, 'visibility') as string) ?? 'visible');
    }
    const show = (id: string, on: boolean) => {
      if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    };
    const setBase = (want: string | null) => {
      for (const b of BASEMAPS) {
        if (b.tiles) show(`basemap-${b.id}`, b.id === want);
      }
      show('hillshade', want === null);
    };
    /**
     * INVERT THE INK FOR A LIGHT GROUND.
     *
     * Every scheme layer is styled for the dark basemap: a pale orange
     * alignment, a soft glow behind it, and white labels with a near-black
     * halo. Dropped onto white relief or a printed geological sheet the
     * alignment goes faint, the glow does nothing, and the labels read as grey
     * smudges — the figure ends up showing its background clearly and the
     * project poorly, which is backwards. Returns its own undo.
     */
    const lightGroundInk = () => {
      const saved: [string, string, unknown][] = [];
      const repaint = (layer: string, prop: string, value: unknown) => {
        if (!m.getLayer(layer)) return;
        saved.push([layer, prop, m.getPaintProperty(layer, prop) as unknown]);
        m.setPaintProperty(layer, prop, value as never);
      };
      repaint('scheme-line', 'line-color', '#c2410c');
      repaint('scheme-line', 'line-width', 4);
      repaint('scheme-glow', 'line-color', '#ffffff');
      repaint('scheme-glow', 'line-opacity', 0.9);
      repaint('report-ends-dot', 'circle-stroke-color', '#ffffff');
      repaint('report-ends-label', 'text-color', '#111827');
      repaint('report-ends-label', 'text-halo-color', '#ffffff');
      repaint('report-ends-label', 'text-halo-width', 2.4);
      /**
       * AND THE RELIEF ITSELF.
       *
       * The hillshade is painted for the dark basemap — near-black shadows, a
       * mid-grey highlight, a near-black accent. Lit that way on white it comes
       * out as heavy grey mud: the ridges are all shadow, there is no white
       * anywhere, and everything drawn on top has to fight it. Inverting the
       * three colours gives the pale shaded relief a printed map uses, where
       * the paper IS the highlight, and it is the single change that makes both
       * light figures read.
       *
       * The exaggeration is pinned flat as well; the zoom ramp dips to 0.22 at
       * z14 and washed the terrain out completely at site scale.
       */
      repaint('hillshade', 'hillshade-shadow-color', '#6b757d');
      repaint('hillshade', 'hillshade-highlight-color', '#ffffff');
      repaint('hillshade', 'hillshade-accent-color', '#a7b1b8');
      // 0.45 was pale to the point of being decorative — the valleys were there
      // but a reader could not follow one. 0.62 keeps the paper white and puts
      // the ridges back.
      repaint('hillshade', 'hillshade-exaggeration', 0.62);
      return () => {
        for (const [layer, prop, value] of saved) {
          if (m.getLayer(layer)) m.setPaintProperty(layer, prop, value as never);
        }
      };
    };

    /**
     * White ground, and nothing on it but what was asked for.
     *
     * Hides every layer the style brings — tiles, water fills, roads, labels —
     * and lays a white background under the lot, so a figure is built from a
     * chosen handful of layers rather than from whatever the basemap felt like
     * drawing. The hazard map uses it to get grey relief on white; the
     * geological sheet uses it so a translucent sheet has white behind it
     * instead of a dark basemap turning its colours to mud. Returns its own undo.
     */
    const monoGround = (keep: Iterable<string>) => {
      const keepSet = new Set(keep);
      const hidden: string[] = [];
      const styleLayers = m.getStyle().layers ?? [];
      for (const l of styleLayers) {
        if (keepSet.has(l.id) || l.id.startsWith('dmg-sheet-')) continue;
        if ((m.getLayoutProperty(l.id, 'visibility') as string) === 'none') continue;
        m.setLayoutProperty(l.id, 'visibility', 'none');
        hidden.push(l.id);
      }
      if (!m.getLayer('report-ground') && styleLayers.length) {
        m.addLayer(
          { id: 'report-ground', type: 'background', paint: { 'background-color': '#ffffff' } },
          styleLayers[0].id
        );
      }
      return () => {
        if (m.getLayer('report-ground')) m.removeLayer('report-ground');
        for (const id of hidden) {
          if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', 'visible');
        }
      };
    };

    /**
     * Wait for tiles, but never wait forever.
     *
     * `idle` is the only honest signal that a basemap swap has finished
     * fetching, and it is not guaranteed to arrive: a throttled background tab
     * stops rendering, and a tile host that stalls never completes the frame.
     * Without the deadline the export button hangs with no feedback, which is
     * how this was found. A capture taken early is a slightly emptier map; a
     * capture that never returns is a broken button.
     */
    const SETTLE_MS = 5000;
    const settle = (force = false) =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const timer = setTimeout(finish, SETTLE_MS);
        const ok = () => {
          clearTimeout(timer);
          setTimeout(finish, 250);
        };
        // areTilesLoaded() knows nothing about an image source that has not
        // decoded yet, so a figure laid on image sources must wait for a real
        // `idle` rather than take the fast path.
        if (!force && m.loaded() && !m.isMoving() && m.areTilesLoaded()) ok();
        else m.once('idle', ok);
      });
    // JPEG, not PNG: a 1200 px map as PNG runs to several megabytes per figure
    // and four of them made the print dialog crawl.
    const shoot = async (force = false) => {
      await settle(force);
      try {
        return m.getCanvas().toDataURL('image/jpeg', 0.82);
      } catch {
        return null;
      }
    };

    const ends = m.getSource('report-ends') as maplibregl.GeoJSONSource | undefined;
    if (ends && scheme) {
      ends.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [scheme.intake.lon, scheme.intake.lat] },
            properties: { role: 'intake', label: 'INTAKE' },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [scheme.power.lon, scheme.power.lat] },
            properties: { role: 'power', label: 'POWERHOUSE' },
          },
        ],
      });
    }

    const out: ReportFigures = {};
    const schemeSource = m.getSource('scheme') as maplibregl.GeoJSONSource | undefined;
    const interactiveScheme = schemeSource?.serialize().data;
    try {
      // Reports and their endpoint labels describe calculation coordinates.
      // Keep the display-only OSM trace out of those figures and restore it after.
      for (const id of ['display-channel', 'display-channel-approximate', 'model-reference', 'scheme-approximate']) show(id, false);
      if (study && scheme) schemeSource?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: study.path.slice(scheme.i, scheme.j + 1).map((p) => [p.lon, p.lat]) } }] });
      for (const id of ['inventory-gauges', 'inventory-gauges-labels', 'inventory-lakes', 'inventory-lakes-labels', 'explorer-area-fill', 'explorer-area-line']) show(id, false);
      frame();
      show('report-ends-dot', true);
      show('report-ends-label', true);
      const hazardLayers = new Set([...LAYER_GROUPS.hazards, ...LAYER_GROUPS.lakes]);
      const siteLayers = new Set([...LAYER_GROUPS.site, ...LAYER_GROUPS.access]);

      // 1. Layout on the dark basemap, hazards off so the scheme reads clearly.
      //    Licence areas ON regardless of the legend: a reviewer looking at the
      //    layout needs to see whose claims it sits inside, and a figure that
      //    silently depended on a toggle would differ between two exports of
      //    the same site.
      setBase(null);
      for (const id of hazardLayers) show(id, false);
      for (const id of siteLayers) show(id, true);
      for (const id of LAYER_GROUPS.areas) show(id, true);
      out.site = await shoot();

      // 2. The same frame on imagery, which is what a reviewer wants to see.
      setBase('satellite');
      out.satellite = await shoot();

      // 3. Topographic sheet, for contours and named ground.
      setBase('topo');
      out.topo = await shoot();

      /**
       * REVERTED: the same sheet closed up at the intake and the powerhouse.
       *
       * The argument was that a 20 m contour interval is a grey hatch at the
       * wide framing, and that the two structures are where the ground actually
       * has to be read. Both halves of that are true. It was still cut, because
       * two more near-identical topographic tiles is not what the reader wanted
       * — the wide sheet already places the works, and the pair pushed the
       * document toward being a picture album. Contour detail at a structure is
       * a survey question, not a screening one.
       *
       * Do not re-add without a reason that is not "the contours are small".
       */

      // 4. The published geological sheet, under the alignment.
      //
      //    Only when a sheet actually covers the site: Karnali is unplaced and
      //    a production build has no tile route at all, and a figure that is
      //    silently the layout shot again is worse than an absent one.
      await loadGeologyIndex();
      const sheet = scheme ? geologySheetAt(scheme.intake.lat, scheme.intake.lon) : null;
      if (sheet) {
        setBase(null);
        // The catalogue footprints are rectangles drawn over the map they are
        // cataloguing; on this figure they are noise. So are the neighbouring
        // licence badges, whose labels are illegible at this scale anyway.
        for (const id of LAYER_GROUPS.geo) show(id, false);
        for (const id of LAYER_GROUPS.projects) show(id, false);
        for (const id of LAYER_GROUPS.areas) show(id, false);

        /**
         * PULL BACK. A 1:350,000 SHEET HAS NOTHING TO SAY AT 14 km.
         *
         * Framed on the scheme, this figure was a blow-up of one polygon: a
         * single flat green field with the sheet's own labels rendered three
         * times the size of the report's own type, jagged at the edges because
         * a 200 dpi tile was being magnified perhaps eightfold past what its
         * printed line width can support. It looked bad because it WAS bad —
         * the resolution on the page was not in the source.
         *
         * The sheet's information is structure: the belt, its thrusts, where
         * one unit gives way to the next. That needs tens of kilometres to be
         * visible, and at that width the tiles are also near their own native
         * resolution, so the figure is sharp for the same reason it is useful.
         */
        m.zoomTo(m.getZoom() - GEOLOGY_ZOOM_OUT, { duration: 0 });
        /**
         * THE SHEET CARRIES DMG'S OWN WATERMARK, AND IT STAYS.
         *
         * A diagonal "Department of Mines and Geology, Government of Nepal"
         * crosses the whole sheet, so no framing avoids it, and it is an
         * attribution mark on an official publication — stripping it out of a
         * reproduction is not something this tool will do, however private the
         * tool is. What CAN be fixed is how much it dominates.
         *
         * At full opacity over the app's dark basemap the mark reads as a heavy
         * black smear. Laid on white at 0.82 the whole sheet lightens together:
         * the mark drops to a pale grey that is still legible as the credit it
         * is, the mapped units stay clearly separable, and the alignment drawn
         * over the top is the darkest thing on the figure — which is the right
         * order of priority for a report about the scheme.
         */
        const restoreGeoGround = monoGround([
          'scheme-glow',
          'scheme-line',
          'report-ends-dot',
          'report-ends-label',
        ]);
        // The frame is deliberately wide here, so the pan-time cap would leave
        // a bare strip along the bottom of the printed figure.
        await syncGeologyOverlay(m, true, 0.82, 48);
        const restoreGeoInk = lightGroundInk();
        out.geology = await shoot(true);
        restoreGeoInk();
        restoreGeoGround();
        out.geologySheet = sheet;
        {
          const b = m.getBounds();
          const midLat = ((b.getNorth() + b.getSouth()) / 2) * (Math.PI / 180);
          out.geologyFrameKm = (b.getEast() - b.getWest()) * 111.32 * Math.cos(midLat);
        }
        // Every later figure frames itself, but the hazard shot below reframes
        // from here and would inherit the pull-back.
        frame();
      }

      /**
       * 4b. THE UPSTREAM LAKES, WITH EVERYTHING ELSE TURNED OFF.
       *
       * The GLOF screen says a number of lakes drain through this site and puts
       * the inventory in an appendix, which leaves a reader no way to see the
       * drainage relationship that the whole screen rests on — where the lakes
       * sit, how far up the flow path, and whether they are above the intake at
       * all. Every other layer is off: this figure has one subject.
       *
       * FRAMED ON THE LAKES THAT DECIDE THE VERDICT, NOT ON ALL OF THEM.
       *
       * Framing on every connected lake put 151 km on the page: 43 anonymous
       * three-pixel dots scattered across Tibet with the alignment reduced to a
       * squiggle in one corner. It proved lakes exist upstream and answered
       * nothing a reader would ask — which lake, how far, and does it matter.
       *
       * The GLOF finding is formed on the lakes within 60 km of flow path, so
       * that is what the figure shows. Where none qualifies the nearest six
       * stand in, because a figure of the lakes that were CONSIDERED is still
       * the subject; a figure of every lake in the basin is a different picture
       * with the same title. The count that was dropped is reported in the
       * caption rather than quietly lost — the same rule the hazard figure
       * learned when one distant geocoding centroid turned out to carry 39 of
       * 103 landslides.
       *
       * The labels come on here and nowhere else: at this framing the flow-path
       * distance is the finding, and a dot without it says nothing.
       */
      if (upstreamConnectivity?.lakes?.length && scheme) {
        setBase(null);
        for (const id of hazardLayers) show(id, false);
        for (const id of LAYER_GROUPS.lakes) show(id, true);
        const sited = upstreamConnectivity.lakes.filter(
          (l) => Number.isFinite(l.lat) && Number.isFinite(l.lon)
        );
        const GLOF_ROUTE_KM = 60;
        const near = sited.filter((l) => l.routeKm <= GLOF_ROUTE_KM);
        const subject = (near.length ? near : [...sited].sort((a, b) => a.routeKm - b.routeKm).slice(0, 6));
        out.lakesShown = subject.length;
        out.lakesTotal = sited.length;
        out.lakesWithinKm = near.length ? GLOF_ROUTE_KM : null;
        const lakePts = subject.map((l) => [l.lon, l.lat] as [number, number]);
        if (lakePts.length) {
          // The works anchor the frame, so the reader can see where the chain
          // arrives rather than only where it starts.
          lakePts.push([scheme.intake.lon, scheme.intake.lat]);
          /**
           * And the ice, or it sits half off the top edge.
           *
           * The first version framed on lakes and works only, and the connected
           * glaciers — the thing a reader is looking at this figure to find —
           * were clipped by the neat line. The ice is upstream of the lakes by
           * definition, so it never fits by accident; it has to be asked for.
           *
           * Only the ice that shares the frame's own scale: glaciers within
           * twice the furthest lake's flow path. A 90 km² glacier 150 km up a
           * Tibetan headwater is connected and would pull the frame back to the
           * useless width this figure was rebuilt to escape.
           */
          const reach = Math.max(...subject.map((l) => l.routeKm), 10) * 2;
          for (const g of glaciers?.connected ?? []) {
            if (g.routeKm > reach) continue;
            // The OUTLINE, not the centroid. Framing on centroids put the ice
            // half off the top edge: a glacier is kilometres long and its
            // centre of area says nothing about where its tongue ends.
            for (const ring of g.rings) for (const [lon, lat] of ring) lakePts.push([lon, lat]);
          }
          frame(lakePts);
          const restoreLakeGround = monoGround([
            'hillshade',
            'reaches',
            'scheme-glow',
            'scheme-line',
            'report-ends-dot',
            'report-ends-label',
            ...LAYER_GROUPS.lakes,
          ]);
          const restoreLakeInk = lightGroundInk();
          out.lakes = await shoot(true);
          {
            const b = m.getBounds();
            const midLat = ((b.getNorth() + b.getSouth()) / 2) * (Math.PI / 180);
            out.lakeFrameKm = (b.getEast() - b.getWest()) * 111.32 * Math.cos(midLat);
          }
          restoreLakeInk();
          restoreLakeGround();
        }
        for (const id of LAYER_GROUPS.lakes) show(id, false);
      }

      /**
       * 5. THE GAUGING STATIONS, WHERE THEY ACTUALLY ARE.
       *
       * The report could say a station is "0.1 km from the reach" and a reader
       * still could not tell whether that meant beside the intake, beside the
       * tailrace, or a hundred metres up a tributary that never sees the water
       * the scheme diverts. Those are three different pieces of evidence. Same
       * monochrome relief as the hazard figure, framed on the scheme and the
       * stations together.
       */
      if (gauges?.length && scheme) {
        const near = gauges.slice(0, 8);
        const src = m.getSource('report-gauges') as maplibregl.GeoJSONSource | undefined;
        src?.setData({
          type: 'FeatureCollection',
          features: near.map((g) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [g.lon, g.lat] },
            properties: {
              label: g.name,
              usable: Boolean(g.measuresDischarge && g.trustworthy),
            },
          })),
        });
        setBase(null);
        for (const id of LAYER_GROUPS.lakes) show(id, false);
        for (const id of hazardLayers) show(id, false);
        show('report-gauges-dot', true);
        show('report-gauges-label', true);
        /**
         * SIZED FOR A PAGE, NOT FOR A SCREEN.
         *
         * A 12 px label in a 1400 px capture is about 1 pt once the figure is
         * printed 143 mm wide — the first render had four station names on it
         * that no reader could make out. Everything here is scaled for the
         * page and put back afterwards.
         */
        const gaugeSizes: [string, string, unknown][] = [];
        const resize = (layer: string, prop: string, value: unknown) => {
          if (!m.getLayer(layer)) return;
          gaugeSizes.push([layer, prop, m.getLayoutProperty(layer, prop) as unknown]);
          m.setLayoutProperty(layer, prop, value as never);
        };
        resize('report-gauges-label', 'text-size', 21);
        // The best station sits ON the intake, so the two labels are at the
        // same point. Sending the scheme's own above its dot and leaving the
        // station's below separates them without hiding either.
        resize('report-ends-label', 'text-anchor', 'bottom');
        resize('report-ends-label', 'text-offset', [0, -0.9]);
        const gaugeRadius = m.getLayer('report-gauges-dot')
          ? (m.getPaintProperty('report-gauges-dot', 'circle-radius') as unknown)
          : null;
        // Wide enough to show as a ring around the scheme's own marker: the
        // best station on this site is 0.1 km from the intake, which is the same
        // point at this scale, and at 11 the intake dot covered it completely.
        if (m.getLayer('report-gauges-dot')) {
          m.setPaintProperty('report-gauges-dot', 'circle-radius', 14);
        }
        /**
         * EIGHT KILOMETRES, OR THE NEAREST THREE, WHICHEVER GIVES A FIGURE.
         *
         * Stations past eight kilometres stretch the frame until the scheme is
         * a thumbnail. But on a small tributary every gauge sits on the big
         * river kilometres away, and the flat rule then produced a figure with
         * ONE station in the corner — which is exactly what a reader saw and
         * rightly called useless. The rule now guarantees the figure has
         * something on it: the close ones where there are three, otherwise the
         * three nearest however far they sit. The caption states the frame
         * width, so the distance is read rather than guessed.
         */
        const closeBy = near.filter((g) => g.distanceKm <= 8);
        const shown = closeBy.length >= 3 ? closeBy : near.slice(0, Math.min(3, near.length));
        out.gaugesShown = shown.length;
        out.gaugesTotal = gauges.length;
        frame(shown.map((g) => [g.lon, g.lat] as [number, number]));
        const restoreGaugeGround = monoGround([
          'hillshade',
          'reaches',
          'scheme-glow',
          'scheme-line',
          'report-ends-dot',
          'report-ends-label',
          'report-gauges-dot',
          'report-gauges-label',
        ]);
        const restoreGaugeInk = lightGroundInk();
        const reachInkG = m.getLayer('reaches')
          ? (m.getPaintProperty('reaches', 'line-color') as unknown)
          : null;
        if (m.getLayer('reaches')) m.setPaintProperty('reaches', 'line-color', '#9fb0ba');
        out.gauges = await shoot(true);
        {
          const b = m.getBounds();
          const midLat = ((b.getNorth() + b.getSouth()) / 2) * (Math.PI / 180);
          out.gaugeFrameKm = (b.getEast() - b.getWest()) * 111.32 * Math.cos(midLat);
        }
        for (const [layer, prop, value] of gaugeSizes) {
          if (m.getLayer(layer)) m.setLayoutProperty(layer, prop, value as never);
        }
        if (m.getLayer('report-gauges-dot') && gaugeRadius !== null) {
          m.setPaintProperty('report-gauges-dot', 'circle-radius', gaugeRadius as never);
        }
        if (m.getLayer('reaches') && reachInkG !== null) {
          m.setPaintProperty('reaches', 'line-color', reachInkG as never);
        }
        restoreGaugeInk();
        restoreGaugeGround();
        show('report-gauges-dot', false);
        show('report-gauges-label', false);
      }

      /**
       * 5b. SEISMICITY AND THE MAPPED FAULTS.
       *
       * The seismic section was five numbers in a table - 0.49 g, 237 quakes,
       * an M7.3 at 36 km, the Main Frontal Thrust at 51.9 km - and a reader
       * asked for a picture, because a distance to a fault means nothing
       * without knowing which side of the scheme it lies on, or how the
       * epicentres sit around it. Same monochrome relief as the hazard figure
       * so the two read as a pair.
       *
       * Framed on the faults and the quakes rather than on the works: the
       * subject is the regional setting, and a frame tight on the scheme would
       * answer the question by cropping it out.
       */
      if (scheme && (faults?.nearby?.length || (seismic?.within50 ?? 0) > 0)) {
        setBase(null);
        for (const id of LAYER_GROUPS.lakes) show(id, false);
        for (const id of hazardLayers) show(id, false);
        show('faults', true);
        show('quakes', true);
        /**
         * A REGIONAL FRAME, NOT ONE STRETCHED TO REACH THE NEAREST FAULT.
         *
         * Sizing this to hold the nearest mapped fault put 253 km on the page:
         * the alignment was a speck, the fault traces were hairlines and the
         * figure said less than the table it was meant to illustrate. When the
         * nearest fault is 50 km away it does not belong in the same frame as a
         * 13 km waterway, and the distance to it is already stated as a number.
         * What the figure is for is the structural grain around the works and
         * where the epicentres actually sit, which needs about 100 km.
         */
        frameRadius(Math.min(30, Math.max(10, (faults?.nearest?.distanceKm ?? 25) * 0.6)));
        const restoreSeisGround = monoGround([
          'hillshade',
          'reaches',
          'scheme-glow',
          'scheme-line',
          'report-ends-dot',
          'report-ends-label',
          'faults',
          'quakes',
        ]);
        const restoreSeisInk = lightGroundInk();
        const seisReach = m.getLayer('reaches')
          ? (m.getPaintProperty('reaches', 'line-color') as unknown)
          : null;
        if (m.getLayer('reaches')) m.setPaintProperty('reaches', 'line-color', '#b3bfc7');
        // Both layers are styled for the dark basemap and vanish on white.
        const seisPaint: [string, string, unknown][] = [];
        const repaint = (layer: string, prop: string, value: unknown) => {
          if (!m.getLayer(layer)) return;
          seisPaint.push([layer, prop, readPaint(layer, prop)]);
          writePaint(layer, prop, value);
        };
        repaint('faults', 'line-color', '#7a1f1f');
        repaint('faults', 'line-width', 3.4);
        repaint('faults', 'line-opacity', 0.95);
        repaint('quakes', 'circle-color', '#b45309');
        repaint('quakes', 'circle-opacity', 0.55);
        repaint('quakes', 'circle-stroke-color', '#ffffff');
        repaint('quakes', 'circle-stroke-width', 0.8);
        out.seismic = await shoot(true);
        {
          const b = m.getBounds();
          const midLat = ((b.getNorth() + b.getSouth()) / 2) * (Math.PI / 180);
          out.seismicFrameKm = (b.getEast() - b.getWest()) * 111.32 * Math.cos(midLat);
        }
        for (const [layer, prop, value] of seisPaint) {
          if (m.getLayer(layer)) writePaint(layer, prop, value);
        }
        if (m.getLayer('reaches') && seisReach !== null) {
          m.setPaintProperty('reaches', 'line-color', seisReach as never);
        }
        restoreSeisInk();
        restoreSeisGround();
        show('faults', false);
        show('quakes', false);
      }

      /**
       * 5c. THE GRID, WHICH IS A COST AND WAS ONLY EVER A TABLE ROW.
       *
       * "15.4 km at 132 kV" and "Lamosangu, 20.2 km" are among the numbers most
       * likely to decide whether a scheme is worth building, and they sat in a
       * four-row table a reader scrolled straight past - one said so. Where the
       * line runs relative to the works, and whether the substation is up the
       * valley or over a ridge, is a ROUTE question, and a route question needs
       * a map rather than a distance.
       */
      if (scheme && grid && (grid.nearestSub || Number.isFinite(grid.nearestKm))) {
        setBase(null);
        for (const id of LAYER_GROUPS.lakes) show(id, false);
        for (const id of hazardLayers) show(id, false);
        for (const id of LAYER_GROUPS.grid) show(id, true);
        // Hold whichever is further: the connection point or the nearest line.
        frameRadius(
          Math.min(60, Math.max(8, Math.max(grid.nearestSub?.km ?? 0, grid.adequateKm ?? grid.nearestKm) * 1.3))
        );
        const restoreGridGround = monoGround([
          'hillshade',
          'reaches',
          'scheme-glow',
          'scheme-line',
          'report-ends-dot',
          'report-ends-label',
          ...LAYER_GROUPS.grid,
        ]);
        const restoreGridInk = lightGroundInk();
        const gridReach = m.getLayer('reaches')
          ? (m.getPaintProperty('reaches', 'line-color') as unknown)
          : null;
        if (m.getLayer('reaches')) m.setPaintProperty('reaches', 'line-color', '#b3bfc7');
        const gridPaint: [string, string, unknown][] = [];
        const gpaint = (layer: string, prop: string, value: unknown) => {
          if (!m.getLayer(layer)) return;
          gridPaint.push([layer, prop, readPaint(layer, prop)]);
          writePaint(layer, prop, value);
        };
        gpaint('grid-lines', 'line-color', '#6d28d9');
        gpaint('grid-lines', 'line-width', 2.4);
        gpaint('grid-lines', 'line-opacity', 0.95);
        gpaint('grid-substations', 'circle-color', '#6d28d9');
        gpaint('grid-substations', 'circle-radius', 9);
        gpaint('grid-substations', 'circle-stroke-color', '#ffffff');
        gpaint('grid-substations', 'circle-stroke-width', 2.6);
        const gridLbl: [string, string, unknown][] = [];
        for (const id of ['grid-line-labels', 'grid-substation-labels']) {
          if (!m.getLayer(id)) continue;
          gridLbl.push([id, 'text-size', m.getLayoutProperty(id, 'text-size') as unknown]);
          m.setLayoutProperty(id, 'text-size', 19 as never);
          gpaint(id, 'text-color', '#3b1d78');
          gpaint(id, 'text-halo-color', '#ffffff');
          gpaint(id, 'text-halo-width', 2.6);
        }
        out.grid = await shoot(true);
        {
          const b = m.getBounds();
          const midLat = ((b.getNorth() + b.getSouth()) / 2) * (Math.PI / 180);
          out.gridFrameKm = (b.getEast() - b.getWest()) * 111.32 * Math.cos(midLat);
        }
        for (const [id, prop, value] of gridLbl) {
          if (m.getLayer(id)) m.setLayoutProperty(id, prop, value as never);
        }
        for (const [layer, prop, value] of gridPaint) {
          if (m.getLayer(layer)) writePaint(layer, prop, value);
        }
        if (m.getLayer('reaches') && gridReach !== null) {
          m.setPaintProperty('reaches', 'line-color', gridReach as never);
        }
        restoreGridInk();
        restoreGridGround();
        for (const id of LAYER_GROUPS.grid) show(id, false);
      }

      /**
       * 6. HAZARDS, ON A MONOCHROME RELIEF MAP.
       *
       * This was a screenshot of the dark satellite basemap with a hundred
       * three-pixel triangles on it, and in print it was unreadable — dark on
       * dark, markers below the size a page can resolve. A reader could tell
       * that records existed and nothing else.
       *
       * So the basemap is taken away entirely. A white ground with the DEM's
       * own hillshade over it is a grey relief map of the real valley: it
       * carries the ridges and the side valleys, which is the context a slope
       * question actually needs, and it prints. Every tile layer, label and
       * vector fill from the style is hidden for the shot and put back
       * afterwards; the river network is greyed so it reads as drainage rather
       * than competing with the scheme; the hazard icons are enlarged, because
       * a symbol sized for a screen at arm's length is not sized for a page.
       *
       * Colour is then spent only where it means something — the alignment and
       * the hazard badges — against grey ground.
       */
      setBase(null);
      // Hazards only. `hazardLayers` also carries the glacial-lake drainage
      // routes, which are the NEXT section's subject: on this figure they draw
      // unexplained tan lines through the valleys and a reader has no legend to
      // resolve them against.
      for (const id of LAYER_GROUPS.lakes) show(id, false);
      for (const id of LAYER_GROUPS.hazards) show(id, true);
      show('hazard-labels', false);
      // Six kilometres, not eight. The frame is set by the furthest record it
      // must hold, and at the first real site eight put 43 km on the page with
      // the alignment a thumbnail in the middle of it. What this figure is for
      // is the ground the works occupy; the wider count is in the verdict above
      // and every record is in the appendix.
      frame(
        (hazards?.records ?? [])
          .filter((r) => r.distanceKm <= 6)
          .map((r) => [r.lon, r.lat] as [number, number])
      );

      const restoreGround = monoGround([
        'hillshade',
        'reaches',
        'scheme-glow',
        'scheme-line',
        'report-ends-dot',
        'report-ends-label',
        ...hazardLayers,
      ]);
      const reachInk = m.getLayer('reaches')
        ? (m.getPaintProperty('reaches', 'line-color') as unknown)
        : null;
      if (m.getLayer('reaches')) m.setPaintProperty('reaches', 'line-color', '#9fb0ba');
      const iconSize = m.getLayer('hazards')
        ? (m.getLayoutProperty('hazards', 'icon-size') as unknown)
        : null;
      if (m.getLayer('hazards')) m.setLayoutProperty('hazards', 'icon-size', 1.5);

      const restoreInk = lightGroundInk();
      out.hazards = await shoot(true);
      // A printed map with no scale is a picture. This was lost when the ink
      // inversion was hoisted into its own helper.
      {
        const b = m.getBounds();
        const midLat = ((b.getNorth() + b.getSouth()) / 2) * (Math.PI / 180);
        out.hazardFrameKm = (b.getEast() - b.getWest()) * 111.32 * Math.cos(midLat);
      }
      restoreInk();

      if (m.getLayer('reaches') && reachInk !== null) {
        m.setPaintProperty('reaches', 'line-color', reachInk as never);
      }
      if (m.getLayer('hazards') && iconSize !== null) {
        m.setLayoutProperty('hazards', 'icon-size', iconSize as never);
      }
      restoreGround();
    } finally {
      if (interactiveScheme) schemeSource?.setData(interactiveScheme);
      void syncGeologyOverlay(m, layersOn.geology);
      show('report-ends-dot', false);
      show('report-ends-label', false);
      m.jumpTo(camera);
      for (const [id, v] of saved) {
        if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', v);
      }
    }
    return out;
  }, [scheme, study, hazards, gauges, upstreamConnectivity, glaciers, faults, seismic, grid, layersOn.geology]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __captureFigures: typeof captureFigures }).__captureFigures =
      captureFigures;
  }, [captureFigures]);

  const onExport = useCallback(
    (kind: 'csv' | 'geojson' | 'field-plan' | 'report') => {
      if (!exportCtx) return;
      const stem = fileStem(exportCtx.at);
      if (kind === 'csv') {
        download(`${stem}.csv`, 'text/csv;charset=utf-8', schemesToCsv(exportCtx));
      } else if (kind === 'geojson') {
        download(`${stem}.geojson`, 'application/geo+json', schemesToGeoJson(exportCtx));
      } else if (kind === 'report') {
        void captureFigures().then((figures) =>
          printDeskStudy(
            exportCtx,
            {
              ...reportMeta,
              projectName: reportMeta.projectName.trim() || 'Proposed Hydropower Project',
            },
            figures
          )
        );
      } else {
        download(`${stem}_field_plan.csv`, 'text/csv;charset=utf-8', fieldPlanToCsv(exportCtx));
      }
    },
    [exportCtx, reportMeta, captureFigures]
  );

  const reset = useCallback(() => {
    setAt(null);
    setStudy(null);
    setPick(null);
    setTweaked(false);
    setNeighbours(null);
    setError(null);
    setFlowOnly(null);
    setGauges(null);
    setMeasured(null);
    setWideSearch(false);
    setAudit(null);
    setAuditBusy(null);
  }, []);

  /**
   * The site audit — the "work this site harder" button.
   *
   * Three measurements, none of which run by default because together they
   * cost a dozen requests against shared free services: the head re-measured
   * on the second terrain product, all nine flood-model cells scored against
   * HYDEST's seasonal regime, and up to forty years requested for
   * whichever cell wins. Nothing here interpolates or smooths — every step
   * replaces an assumption with a measurement, which is the only honest way
   * an estimate gets tighter. Partial failure is fine: whatever measured,
   * counts; whatever failed, says so.
   */
  const onAudit = useCallback(async () => {
    if (!study || !pick || auditBusy) return;
    /**
     * Bind the result to the site that asked for it.
     *
     * The audit awaits a dozen requests over tens of seconds and then wrote its
     * answer unconditionally, with no abort and no identity check. Starting one
     * and immediately choosing the main river attached a 687.9 m two-terrain
     * head difference to the promoted site, whose own audit says 590.3 m — so
     * the page's most independent-looking evidence belonged to the river the
     * user had just navigated away from. Worse, the long-record branch MERGES
     * into the study, so a stale cell's hydrograph could land on the new river.
     *
     * `study` is the identity: every site change replaces the object.
     */
    const forStudy = study;
    const generation = ++auditGeneration.current;
    const live = () => auditGeneration.current === generation &&
      auditTarget.current.study === forStudy && auditTarget.current.i === pick.i &&
      auditTarget.current.j === pick.j && auditTarget.current.measured === measured;
    setAuditBusy('measuring the head on the second terrain product…');
    let head: HeadAudit | null = null;
    let shape: ShapeAudit | null = null;
    let years: number | null = null;
    let auditError: string | null = null;
    try {
      head = await auditHead(forStudy.path, pick.i, pick.j, forStudy.dem.source).catch(() => null);
      if (!live()) return;
      if (!measured) {
        if (isNepal) {
          setAuditBusy('scoring the nine flow cells against Nepal’s seasonal regime…');
          shape = await auditShape(forStudy.flow, hydest?.months ?? []).catch(() => null);
          if (!live()) return;
        }
        setAuditBusy('requesting up to 40 years of complete flow…');
        const cell = shape?.better?.cell ?? forStudy.flow.cell;
        const long = await fetchDischargeYears(cell.lat, cell.lon).catch(() => null);
        if (!live()) return;
        if (long) {
          years = new Set(long.dates.map((d) => d.slice(0, 4))).size;
          setStudy((s) => (s === forStudy ? { ...s, flow: long } : s));
        } else if (shape?.better) {
          // No long record, but a decisively better cell still counts.
          const better = shape.better;
          setStudy((s) => (s === forStudy ? { ...s, flow: better } : s));
        }
      }
      if (!head && !shape && years === null) {
        auditError = 'nothing could be measured — the public services may be rate-limiting; try again in a few minutes';
      }
    } catch (e) {
      auditError = e instanceof Error ? e.message : String(e);
    } finally {
      if (auditGeneration.current === generation) setAuditBusy(null);
    }
    if (!live()) return;
    setAudit({ head, shape, years, error: auditError });
  }, [study, pick, auditBusy, measured, hydest, isNepal]);

  const focusEvidence = useCallback(() => {
    const m = map.current;
    if (!m || !at) return;
    const points: [number, number][] = [[at.lon, at.lat]];
    if (study && scheme) {
      for (const point of study.path.slice(scheme.i, scheme.j + 1)) points.push([point.lon, point.lat]);
    }
    for (const record of hazards?.records ?? []) points.push([record.lon, record.lat]);
    for (const project of licences ?? []) points.push([project.lon, project.lat]);
    for (const project of [...(cascade?.upstream ?? []), ...(cascade?.downstream ?? [])]) {
      points.push([project.lon, project.lat]);
    }
    for (const source of [
      ...(upstreamConnectivity?.lakes ?? []),
      ...(upstreamConnectivity?.incidents ?? []),
    ]) points.push([source.lon, source.lat]);
    const pondBounds = pondageState.result?.floodedBounds;
    if (pondBounds) {
      points.push(
        [pondBounds.west, pondBounds.north],
        [pondBounds.east, pondBounds.south]
      );
    }
    for (const hit of [roadAccessState.result?.intake, roadAccessState.result?.powerhouse]) {
      if (hit) points.push([hit.road.lon, hit.road.lat]);
    }
    const bounds = points.reduce(
      (box, point) => box.extend(point),
      new maplibregl.LngLatBounds(points[0], points[0])
    );
    m.fitBounds(bounds, {
      padding: {
        top: 72,
        // The reading panel covers the right third of a wide screen, so the map
        // keeps its evidence clear of it rather than centring on a viewport
        // part of which is hidden. Kept in step with the panel's own width in
        // Reading.tsx — they were 50vw and half-width together, and the panel
        // has since narrowed.
        right: window.innerWidth >= 1024 ? Math.round(window.innerWidth * 0.34) + 36 : 36,
        bottom: 54,
        left: window.innerWidth >= 1024 ? 334 : 36,
      },
      maxZoom: 11.8,
      duration: 500,
    });
  }, [at, study, scheme, hazards, licences, cascade, upstreamConnectivity, pondageState.result, roadAccessState.result]);

  return (
    <div className="flex h-full flex-col lg:block">
      <div ref={mapEl} data-tour="map" className="h-[46vh] w-full shrink-0 lg:absolute lg:inset-0 lg:h-full" />

      <header className="pointer-events-none absolute left-3 top-3 z-10 hidden lg:block">
        <div className="flex items-center gap-2 rounded-full border border-line bg-bg/75 py-1.5 pl-3 pr-4 backdrop-blur-md">
          <Mark />
          <span className="text-[13.5px] font-semibold tracking-tight">HydroRecon</span>
          <span className="mt-px text-[11px] text-muted">hydropower scheme finder</span>
          <button type="button" onClick={() => setTourOpen(true)} className="pointer-events-auto ml-1 border-l border-line pl-2.5 text-[11px] text-faint hover:text-river">Take the tour</button>
        </div>
      </header>
      <Tour open={tourOpen} onClose={closeTour} />

      <div className="map-credit">
        <span>Built by <a href="https://www.linkedin.com/in/bijay-karki-/" target="_blank" rel="noopener noreferrer">Bijay Karki</a></span>
        <a href="mailto:bijay.karki.work@gmail.com" title="bijay.karki.work@gmail.com">mail</a>
      </div>

      <MapExplorer map={mapReady ? map.current : null} at={at} projects={doedProjects}
        gaugesOn={layersOn.gauges} lakesOn={layersOn.lakes} labelsOn={layersOn.labels}
        onStudy={(lat, lon) => { void onClick(lat, lon); }} onLocate={onLocate}>
        <MapLegend
          onFit={focusEvidence}
          hasStudy={!!at}
          onReset={() => setLayersOn({ ...DEFAULT_LAYERS })}
          topoCount={topoCount} topoOn={topoOn} onTopo={() => setTopoOn((on) => !on)}
          layers={layersOn}
          onToggle={(key) => setLayersOn((s) => ({ ...s, [key]: !s[key] }))}
          basemap={basemap}
          onBasemap={setBasemap}
        />
      </MapExplorer>

      {at && <Reading
        methodComparison={isNepal && input && scheme && study ? <HydrologyComparison input={input} scheme={scheme} reach={intakeReach} networkMeanCms={study.path[scheme.i]?.meanCms ?? 0} flowChoice={flowChoice} measured={!!measured} head={audit?.head ?? null} auditBusy={auditBusy} auditCompleted={!!audit} auditError={audit?.error ?? null} auditYears={audit?.years ?? null} onAudit={onAudit} terrainSource={study.dem.source} /> : null}
        mapAlignment={study && <div className="border-b border-line px-4 py-3 text-[11px] leading-relaxed text-muted" aria-label="River alignment">
          <label className="mb-2 flex items-center justify-between gap-2 text-ink">Maximum layout length
            <select aria-label="Maximum layout length" className="rounded border border-line bg-bg px-2 py-1" value={maxWaterwayKm} onChange={(e) => { setTweaked(false); setMaxWaterwayKm(Number(e.target.value)); }}>
              <option value={5}>5 km · compact</option><option value={6}>6 km · default</option><option value={10}>10 km · extended</option>
            </select>
          </label>
          <p className="mb-2">Distance along the river between intake and powerhouse. Actual tunnel routing may be shorter. {wideSearch ? 'Corridor search may move the intake.' : 'Intake held at the selected model river position.'}</p>
          {!scheme && !busy && <p className="mb-2 text-amber">No viable layout found within {maxWaterwayKm} km. Try a different intake or a longer limit.</p>}
          <strong className="text-ink">{riverDisplay ? 'River alignment · OpenStreetMap trace' : 'River alignment · model geometry'}</strong>
          {riverDisplay && scheme ? <>
            <p className="mt-1">Intake display offset: <b className="text-river">{Math.round(riverDisplay.points[scheme.i].offsetM)} m</b> from the calculation point. Powerhouse: {Math.round(riverDisplay.points[scheme.j].offsetM)} m.</p>
            <p className="mt-1">Solid lines follow a matched channel; dashed connectors are approximate. {Math.round(100 * riverDisplay.points.filter((p) => p.traced).length / riverDisplay.points.length)}% of sample positions matched.</p>
            <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={showModelGeometry} onChange={(e) => setShowModelGeometry(e.target.checked)} />Show model reference geometry</label>
            <details className="mt-2"><summary className="cursor-pointer text-river">Coordinates and source limits</summary>
              <p>Displayed intake: {riverDisplay.points[scheme.i].lat.toFixed(6)}, {riverDisplay.points[scheme.i].lon.toFixed(6)}<br/>Calculation point: {scheme.intake.lat.toFixed(6)}, {scheme.intake.lon.toFixed(6)}</p>
              <p className="mt-1">This is a map alignment correction, not a surveyed relocation. Head, flow, pondage, engineering exports and report figures retain their model coordinates. Confirm positions before engineering use.</p>
              <a className="text-river" href="https://www.hydrosheds.org/products/hydrorivers" target="_blank" rel="noopener noreferrer">HydroRIVERS model source ↗</a><span> · </span><a className="text-river" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OSM channel trace · ODbL ↗</a>
            </details>
          </> : <p className="mt-1">{study.tracedFromTerrain ? 'The course was inferred from terrain.' : displayResult?.path === study.path ? 'A channel trace is unavailable; the displayed positions are approximate model coordinates.' : 'Checking the available channel trace…'}</p>}
        </div>}
        at={at}
        region={region}
        borderKm={borderKm}
        readiness={readiness}
        hazards={hazards}
        upstreamConnectivity={upstreamConnectivity}
        connectivityBusy={connectivityBusy}
        connectivityError={connectivityError}
        cascade={cascade}
        cascadeBusy={cascadeBusy}
        cascadeError={cascadeError}
        faults={faults}
        seismic={seismic}
        collectors={collectors}
        onMoveIntakeTo={(pathIndex, collectorIndex) => {
          if (!pick) return;
          // Below the junction, but never past the powerhouse.
          setTweaked(true);
          setPick({ i: Math.min(pathIndex, pick.j - 1), j: pick.j });
          // The main intake now takes this water, so the collector pin would
          // only re-appear as "already counted". Retire it.
          setExtraIntakes((current) => current.filter((_, i) => i !== collectorIndex));
        }}
        onLocate={onLocate}
        ambiguity={ambiguity}
        transfer={transfer}
        transferBusy={transferBusy}
        onAdoptGauge={onAdoptGauge}
        onStudyHere={(lat, lon) => {
          setAt({ lat, lon });
          void onClick(lat, lon);
        }}
        geology={geology}
        study={study}
        flowOnly={flowOnly}
        found={found}
        scheme={scheme}
        uncertainty={uncertainty}
        pick={pick}
        onPick={(s) => {
          setTweaked(false);
          setPick({ i: s.i, j: s.j });
        }}
        assume={effectiveAssume}
        setAssume={setAssume}
        busy={busy}
        error={error}
        licences={licences}
        gauges={gauges}
        hydest={hydest}
        mhsp={mhsp}
        flowShape={flowShape}
        grid={grid}
        conservation={conservation}
        localGis={localGis}
        topoCount={topoCount}
        topoOn={topoOn}
        onTopo={setTopoOn}
        corridor={corridor}
        pondage={pondageState.result}
        pondageBusy={pondageState.busy}
        pondageError={pondageState.error}
        pondageHeightM={pondageHeightM}
        onPondageHeight={setPondageHeightM}
        roadAccess={roadAccessState.result}
        roadAccessBusy={roadAccessState.busy}
        roadAccessError={roadAccessState.error}
        landcover={landcover}
        geologyUnits={geologyUnits}
        designSweep={designSweep}
        pondageSweep={pondageSweep}
        flowChoice={flowChoice}
        sediment={sediment}
        bench={bench}
        measured={measured}
        audit={audit}
        auditBusy={auditBusy}
        onAudit={onAudit}
        onImport={onImport}
        onClearMeasured={() => setMeasured(null)}
        wideSearch={wideSearch}
        onWideSearch={setWideSearch}
        canExport={Boolean(exportCtx && exportCtx.schemes.length > 0)}
        onExport={onExport}
        reportMeta={reportMeta}
        onReportMeta={onReportMeta}
        neighbours={neighbours}
        onProbe={runProbe}
        onReset={reset}
        tweaked={tweaked}
      />}
    </div>
  );
}

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

function Mark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="8" fill="none" stroke="#4fc1d8" strokeWidth="1.6" />
      {[0, 120, 240].map((r) => (
        <path
          key={r}
          d="M9 3.2C10.4 5.4 10.4 7 9 9C7.6 7 7.6 5.4 9 3.2Z"
          fill="#4fc1d8"
          transform={`rotate(${r} 9 9)`}
        />
      ))}
    </svg>
  );
}

function MapLegend({
  onFit,
  layers,
  onToggle,
  basemap,
  onBasemap,
  hasStudy,
  onReset,
  topoCount,
  topoOn,
  onTopo,
}: {
  onFit: () => void;
  layers: LayerToggles;
  // Functional toggle by key — a spread of a stale snapshot here would make
  // two quick clicks undo each other.
  onToggle: (key: keyof LayerToggles) => void;
  basemap: BasemapId;
  onBasemap: (id: BasemapId) => void;
  hasStudy: boolean;
  onReset: () => void;
  topoCount: number;
  topoOn: boolean;
  onTopo: () => void;
}) {
  const badge = (label: string, color: string, shape = 'rounded-sm') => (
    <span
      className={`flex size-4 shrink-0 items-center justify-center ${shape} border border-bg text-[8px] font-bold text-white shadow-sm`}
      style={{ background: color }}
      aria-hidden
    >
      {label}
    </span>
  );
  // Each row is the switch for its own layer group: what you see is what you
  // can turn off, in the same place you learned what it means.
  const row = (key: Exclude<keyof LayerToggles, 'labels'>, icons: ReactNode, text: string) => {
    const on = layers[key];
    const needsStudy = (key === 'site' || key === 'access' || key === 'geo') && !hasStudy;
    return (
      <button
        type="button"
        onClick={() => onToggle(key)}
        title={on ? `hide ${text}` : `show ${text}`}
        aria-label={text}
        aria-pressed={on}
        disabled={needsStudy}
        className={`layer-toggle flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-left hover:bg-white/[0.06] ${on ? 'text-ink' : 'text-muted'}`}
      >
        {icons}
        <span className="min-w-0 flex-1">{text}{needsStudy && <small className="block text-faint">Select a river first</small>}</span>
        {/* A real switch, so nobody has to guess these rows are clickable. */}
        <span
          className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors ${on ? 'bg-river/40' : 'bg-line'}`}
          aria-hidden
        >
          <i
            className={`absolute top-[2px] size-2.5 rounded-full transition-[left] duration-150 ${on ? 'left-[12px] bg-river' : 'left-[2px] bg-bg'}`}
          />
        </span>
      </button>
    );
  };
  return (
    <details className="explorer-section map-layer-controls" open>
      <summary>Map layers <span>{Object.values(layers).filter(Boolean).length} enabled</span></summary>
      <div className="mb-1.5 flex items-center justify-between gap-2 px-1.5">
        <button type="button" onClick={onReset} className="text-[11px] text-muted">Reset layers</button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onToggle('labels')}
            aria-pressed={layers.labels}
            title="show or hide overlay labels; basemap place names remain"
            className={`rounded-full border px-2 py-px text-[9.5px] leading-4 transition-colors ${
              layers.labels ? 'border-river/50 bg-river/10 text-river' : 'border-line text-faint'
            }`}
          >
            overlay labels
          </button>
          {hasStudy && <button type="button" onClick={onFit} className="text-[10.5px] text-river hover:text-ink">Fit study</button>}
        </div>
      </div>
      {/* Mutually exclusive, so a segmented row rather than the switches below. */}
      <div className="basemap-options" aria-label="Basemap">
        {BASEMAPS.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onBasemap(b.id)}
            aria-pressed={basemap === b.id}
            title={`draw the map on ${b.label}`}
            className={`flex-1 px-1 py-1 text-[9.5px] leading-4 transition-colors ${
              basemap === b.id ? 'bg-river/15 text-river' : 'text-faint hover:bg-white/[0.06]'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col text-[10.5px] text-muted">
        {row('gauges', badge('Q', '#63b981', 'rounded-full'), 'DHM river gauges')}
        {row(
          'site',
          <>
            <i className="size-4 shrink-0 rounded-sm border border-[#38bde8] bg-[#38bde8]/35" />
          </>,
          'Pondage footprint'
        )}
        {row('access', <i className="w-4 shrink-0 border-t-2 border-dashed border-[#65c87a]" />, 'Road-access gaps')}
        {row(
          'hazards',
          <>
            {badge('L', HAZARD_COLORS.landslide, '[clip-path:polygon(50%_0,100%_100%,0_100%)]')}
            {badge('F', HAZARD_COLORS.flood)}
            {badge('E', HAZARD_COLORS.earthquake, 'rotate-45')}
          </>,
          'hazard reports'
        )}
        {row('lakes', badge('G', HAZARD_COLORS.glof, 'rounded-full'), 'GLOF · glacial lakes')}
        {row(
          'projects',
          <>
            {badge('H', '#e06552')}
            {badge('U', '#c58af9', 'rotate-45')}
          </>,
          'hydropower projects'
        )}
        {row(
          'areas',
          <i className="size-4 shrink-0 border border-dashed border-[#ddb072] bg-[#ddb072]/10" />,
          'licence areas, as published'
        )}
        {row(
          'geology',
          <i className="size-4 shrink-0 rounded-sm border border-[#b06a4f] bg-[linear-gradient(135deg,#7fb069_50%,#c9a227_50%)]" />,
          'geological map, 1:350,000'
        )}
        {row(
          'grid',
          <i className="h-0.5 w-4 shrink-0 bg-gradient-to-r from-[#b5a46a] via-[#e0bd55] to-[#e8794f]" />,
          'grid, warm = high kV'
        )}
        {row('protected', <i className="size-4 shrink-0 border border-dashed border-green bg-green/10" />, 'protected areas')}
        {row(
          'quakes',
          <i
            className="size-3 shrink-0 rounded-full border border-bg shadow-sm"
            style={{ background: HAZARD_COLORS.earthquake }}
          />,
          'earthquakes since 1900'
        )}
        {row(
          'geo',
          <i className="w-4 shrink-0 border-t border-dashed" style={{ borderColor: FAULT_COLOR }} />,
          'faults · geology sheets'
        )}
      </div>
      {topoCount > 0 && <button className="survey-toggle" aria-pressed={topoOn} onClick={onTopo}>Survey topo sheets · {topoOn ? 'On' : 'Off'}<small>{topoCount} locally installed sheets</small></button>}
      <div className="mt-1.5 border-t border-line px-1.5 pt-1.5 text-[9.5px] leading-snug text-faint">
        Layers stay available while browsing. Overlay labels appear as you zoom; basemap place names are separate.
      </div>
    </details>
  );
}
