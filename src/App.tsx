import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
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
  riversGeoJson,
  SNAP_KM,
  type Reach,
} from './rivers.ts';
import { discover, evaluate, type Scheme, type SchemeInput } from './engine/discover.ts';
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
import { HAZARD_COLORS, hazardsFor } from './hazards.ts';
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
/** How far downstream to look for schemes. */
const SEARCH_KM = 22;
/**
 * Keep the intake near where the user actually clicked. Two kilometres lets the
 * search slide onto a better sill without the marker teleporting down the
 * valley, which is what it used to do.
 */
const INTAKE_WINDOW_KM = 2;

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
  elevationM: number;
  meanCms: number;
};

export type Study = {
  path: StudyPoint[];
  flow: DischargeSeries;
  dem: ElevationProfile;
  /** False when the river had to be approximated by a straight line. */
  followsRiver: boolean;
  /** True when the course came from tracing terrain, not a mapped river network. */
  tracedFromTerrain?: boolean;
  reach: Reach | null;
};

// ---------------------------------------------------------------------------

type UrlState = { view: { lat: number; lon: number; zoom: number }; at: Pt | null };

function readUrl(): UrlState {
  const p = new URLSearchParams(location.hash.slice(1));
  const m = p.get('at')?.split(',').map(Number);
  const v = p.get('map')?.split('/').map(Number);
  return {
    view:
      v && v.length === 3 && v.every(Number.isFinite)
        ? { zoom: v[0], lat: v[1], lon: v[2] }
        : { zoom: 3.2, lat: 22, lon: 20 },
    at: m && m.length === 2 && m.every(Number.isFinite) ? { lat: m[0], lon: m[1] } : null,
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

  /** Where the user clicked on the river. The only input the app needs. */
  const [at, setAt] = useState<Pt | null>(initial.at);
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

  const atRef = useRef(at);
  atRef.current = at;

  // ---------------- map ----------------
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapEl.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [initial.view.lon, initial.view.lat],
      zoom: initial.view.zoom,
      attributionControl: { compact: true },
      refreshExpiredTiles: false,
      fadeDuration: 0,
      maxTileCacheZoomLevels: 10,
    });
    map.current = m;
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
        ['grid-substation', '+', '#f4c95d', 'square'],
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
            `<b>${p.name}</b><br/><span style="color:#9aa1a9">${p.regime} Â· ${Math.round(p.areaKm2).toLocaleString()} kmÂ²</span>` +
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
      m.addSource('grid-substations', { type: 'geojson', data: gridSubstationsGeoJson() });
      m.addLayer({
        id: 'grid-substations',
        type: 'symbol',
        source: 'grid-substations',
        minzoom: 8,
        layout: {
          'icon-image': 'grid-substation',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 13, 1],
          'icon-allow-overlap': false,
        },
      });
      m.on('click', 'grid-substations', (e) => {
        const p = e.features?.[0]?.properties as { name: string; kv: number } | undefined;
        if (!p) return;
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(`<b>${p.name}</b><br/><span style="color:#9aa1a9">${p.kv || 'voltage not tagged'}${p.kv ? ' kV' : ''} Â· OSM/NEA context</span>`)
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
      m.addLayer({
        id: 'geology-sheet-fill',
        type: 'fill',
        source: 'geology-sheets',
        paint: {
          'fill-color': '#b79bdb',
          'fill-opacity': 0.035,
        },
      });
      m.addLayer({
        id: 'geology-sheet-lines',
        type: 'line',
        source: 'geology-sheets',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#b79bdb',
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1, 13, 2.2],
          'line-opacity': 0.82,
          'line-dasharray': [3, 2],
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
      m.addSource('upstream-sources', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'upstream-sources',
        type: 'symbol',
        source: 'upstream-sources',
        layout: {
          'icon-image': [
            'case',
            ['==', ['get', 'sourceType'], 'lake'], 'glacial-lake',
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
            `<b>${p.title}</b><br/><span style="color:#9aa1a9">${p.date} · ${p.distance} km from reach</span>` +
              `<br/><a href="https://bipadportal.gov.np/incidents/${p.id}/response" target="_blank" rel="noopener">official BIPAD record ↗</a>`
          )
          .addTo(m);
      });

      // Official DoED records already on or proposed for this river.
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
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.72, 13, 1.05],
          'icon-allow-overlap': true,
        },
      });
      m.on('click', 'licences', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { name: string; stage: string; cap: string; promoter: string };
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.name}</b><br/><span style="color:#9aa1a9">${p.stage}` +
              `${p.cap ? ` · ${p.cap} MW` : ''}${p.promoter ? `<br/>${p.promoter}` : ''}</span>`
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

      // The diverted reach of the selected scheme.
      m.addSource('scheme', { type: 'geojson', data: empty() });
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
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ffb454', 'line-width': 3 },
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
        'geology-sheet-lines',
        'faults',
        'upstream-sources',
        'hazards',
        'licences',
        'cascade-projects',
      ].filter((id) => Boolean(m.getLayer(id)));
      if (interactive.length && m.queryRenderedFeatures(e.point, { layers: interactive }).length) return;
      void onClick(e.lngLat.lat, e.lngLat.lng);
    });
    m.on('moveend', () => {
      const c = m.getCenter();
      writeUrl({ lat: c.lat, lon: c.lng, zoom: m.getZoom() }, atRef.current);
    });

    return () => {
      ro.disconnect();
      setMapReady(false);
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
      for (const c of coords) {
        const p = m.project([c[0], c[1]]);
        const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { lat: c[1], lon: c[0] };
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

  const onClick = useCallback(async (lat: number, lon: number) => {
    const hit = await nearestReach(lat, lon).catch(() => null);
    setPick(null);
    setTweaked(false);
    setWideSearch(false);
    setNeighbours(null);
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
      const flowP = fetchDischarge(at.lat, at.lon);
      const river = await downstreamPath(at.lat, at.lon, SEARCH_KM).catch(() => null);
      const reach = await nearestReach(at.lat, at.lon)
        .then((h) => h?.nearest ?? null)
        .catch(() => null);

      if (river && river.length > 8) {
        if (!dead) setBusy('Reading the terrain along it…');
        const dem = await fetchPathProfile(river);
        if (!dead) setBusy('Reading the long-term river flow…');
        const flow = await flowP;
        if (dead) return;
        setStudy({
          path: river.map((p, k) => ({ ...p, elevationM: dem.points[k]?.elevationM ?? NaN })),
          flow,
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
          return;
        }
        setStudy({
          // meanCms 0 = no mapped network here, so the flood model's own
          // magnitude is used unscaled and the panel says so.
          path: trace.points.map((p) => ({ ...p, meanCms: 0 })),
          flow,
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
  const flowChoice = useMemo(() => {
    if (!study) return null;
    const r = study.reach;
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
    });
  }, [study, isNepal]);

  // ---------------- discovery ----------------
  const input: SchemeInput | null = useMemo(() => {
    if (!study) return null;

    /**
     * A measured record, where the engineer has supplied one, replaces the
     * modelled series outright rather than being blended with it.
     *
     * Averaging a gauge against a global model would drag a measurement back
     * towards a guess, which is the wrong direction. It also switches off the
     * network rescaling downstream: that exists to correct a model cell that is
     * not on this channel, and a record measured in this river needs no such
     * correction — `seriesMeanCms` is set to the record's own mean so the
     * engine's ratio comes out at 1.
     */
    const series = measured ? measured.series.values : study.flow.values;
    const dates = measured ? measured.series.dates : study.flow.dates;
    const seriesMean = meanOf(series);
    const minMonth = minMonthlyMean(dates, series);
    /**
     * When the network's magnitude lost the argument (flowchoice.ts), its
     * per-point means are stripped so the engine runs the record unscaled —
     * the same path it already takes where no network exists at all. This
     * also disables downstream growth, which is honest: relative growth from
     * broken absolute numbers is not information.
     */
    const path =
      flowChoice?.authority === 'model'
        ? study.path.map((p) => ({ ...p, meanCms: 0 }))
        : flowChoice?.authority === 'hydest' && flowChoice.targetMeanCms
          ? // Both global sources failed the regression; its annual mean sets
            // the magnitude at every point, and the record keeps only its shape.
            study.path.map((p) => ({ ...p, meanCms: flowChoice.targetMeanCms! }))
          : study.path;
    return {
      path,
      series,
      dates,
      // With a measured record, keep its magnitude: pass the network's own mean
      // so the rescale is a no-op instead of pulling it onto a modelled figure.
      seriesMeanCms: measured ? (path[0]?.meanCms || seriesMean) : seriesMean,
      residualCms: Number.isFinite(minMonth) ? minMonth * effectiveResidualFrac : 0,
      exceedance: assume.exceedance,
      efficiency: assume.efficiency,
      headLossFrac: assume.headLossFrac,
      minFlowFrac: MIN_FLOW_FRAC,
      intakeWindowKm: wideSearch ? Number.POSITIVE_INFINITY : INTAKE_WINDOW_KM,
    };
  }, [study, assume, effectiveResidualFrac, wideSearch, measured, flowChoice]);

  // Who already holds or has applied for this river. The official DoED bundle
  // ships with the app, so this works offline and has an explicit source date.
  useEffect(() => {
    if (!study || !isNepal) {
      setDoedProjects(null);
      return;
    }
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
  }, [study, isNepal]);

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
  const hydest = useMemo<HydestScreen | null>(() => {
    if (!isNepal) return null;
    const r = study?.reach;
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
            ? networkMean / seriesMean
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
  }, [study, flowChoice, isNepal]);

  const found = useMemo(() => {
    if (!input || !study?.followsRiver) return null;
    return discover(input);
  }, [input, study?.followsRiver]);

  // Show the strongest alternative straight away — one click, an answer.
  useEffect(() => {
    if (tweaked) return;
    if (found && found.schemes.length > 0) {
      setPick({ i: found.schemes[0].i, j: found.schemes[0].j });
    } else if (study && !study.followsRiver && study.path.length > 1) {
      setPick({ i: 0, j: study.path.length - 1 });
    } else {
      setPick(null);
    }
  }, [found, study, tweaked]);

  const scheme: Scheme | null = useMemo(
    () => (input && pick ? evaluate(input, pick.i, pick.j) : null),
    [input, pick]
  );

  /** DoED range screening follows the chosen layout, not the full 22 km search corridor. */
  const licences = useMemo(
    () => doedProjects && study
      ? licencesAlong(
          doedProjects,
          scheme ? study.path.slice(scheme.i, scheme.j + 1) : study.path
        )
      : null,
    [doedProjects, study, scheme]
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
    const near = inside.length
      ? []
      : protectedNear(scheme.intake.lat, scheme.intake.lon, 3);
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
   * public/local/ is gitignored, so a clone simply has none of this and the
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
      ? { basin, source: sedimentSource(study?.reach?.below3000Frac ?? NaN) }
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
    setAudit(null);
  }, [pick?.i, pick?.j, at]);

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
      // Pre-fill the transfer factor from the best connected gauge, when it has
      // a defensible one — that is exactly what this record is likely to be.
      const suggested = gauges?.find((g) => g.trustworthy && g.areaRatio)?.areaRatio ?? 1;
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
      title: string,
      onDrop: (p: Pt) => void
    ) => {
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
      el.style.setProperty('--c', color);
      el.title = title;
      const mk = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([pt.lon, pt.lat])
        .addTo(m);
      mk.on('dragend', () => {
        const l = mk.getLngLat();
        onDrop({ lat: l.lat, lon: l.lng });
      });
      markers.current[key] = mk;
    };

    // Dragging slides the end along the studied river — no refetch needed.
    const slide = (which: 'i' | 'j') => (p: Pt) => {
      if (!study || !pick) return;
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < study.path.length; k++) {
        const d = haversineKm([p.lat, p.lon], [study.path[k].lat, study.path[k].lon]);
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

    place('a', scheme?.intake ?? at, '#4db8ff', 'Intake — drag along the river', slide('i'));
    place('b', scheme?.power ?? null, '#3fb950', 'Powerhouse — drag along the river', slide('j'));

    const lic = m.getSource('licences') as maplibregl.GeoJSONSource | undefined;
    if (lic) {
      lic.setData({
        type: 'FeatureCollection',
        features: (licences ?? []).map((l) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
          properties: {
            name: l.name,
            stage: l.stage,
            cap: l.capacityMW ?? '',
            promoter: l.promoter,
          },
        })),
      });
    }

    const hazardSource = m.getSource('hazards') as maplibregl.GeoJSONSource | undefined;
    if (hazardSource) {
      hazardSource.setData({
        type: 'FeatureCollection',
        features: (hazards?.records ?? []).map((record) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [record.lon, record.lat] },
          properties: {
            id: record.id,
            kind: record.kind,
            title: record.title,
            date: record.date,
            distance: record.distanceKm.toFixed(1),
          },
        })),
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
              sourceType: 'lake', id: lake.id, kind: 'lake', title: 'Mapped glacial lake',
              detail: `${lake.basin} · ${lake.country} · ${Math.round(lake.elevationM)} m`,
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
              },
            };
          })
        ),
      });
    }

    const src = m.getSource('scheme') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(
        study && scheme
          ? {
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
  }, [scheme, at, study, pick, licences, hazards, upstreamConnectivity, cascade, faults, geology, mapReady]);

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
      flowChoice,
      schemes: found.schemes,
      selected: scheme,
      path: study.path,
      demSource: study.dem.source,
      demResolutionM: study.dem.resolutionM,
      flowYears: new Set(study.flow.dates.map((d) => d.slice(0, 4))).size,
      flowMeanCms: meanOf(study.flow.values),
      networkMeanCms: study.reach?.meanDischargeCms ?? null,
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
  }, [at, region, borderKm, readiness, hazards, upstreamConnectivity, cascade, faults, geology, hydest, flowChoice, study, found, scheme, licences, gauges, grid, sediment, bench, measured, assume, effectiveResidualFrac, uncertainty]);

  const onExport = useCallback(
    (kind: 'csv' | 'geojson' | 'field-plan') => {
      if (!exportCtx) return;
      const stem = fileStem(exportCtx.at);
      if (kind === 'csv') {
        download(`${stem}.csv`, 'text/csv;charset=utf-8', schemesToCsv(exportCtx));
      } else if (kind === 'geojson') {
        download(`${stem}.geojson`, 'application/geo+json', schemesToGeoJson(exportCtx));
      } else {
        download(`${stem}_field_plan.csv`, 'text/csv;charset=utf-8', fieldPlanToCsv(exportCtx));
      }
    },
    [exportCtx]
  );

  const reset = useCallback(() => {
    setAt(null);
    setStudy(null);
    setPick(null);
    setTweaked(false);
    setNeighbours(null);
    setError(null);
    setFlowOnly(null);
    setDoedProjects(null);
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
    setAuditBusy('measuring the head on the second terrain product…');
    let head: HeadAudit | null = null;
    let shape: ShapeAudit | null = null;
    let years: number | null = null;
    let auditError: string | null = null;
    try {
      head = await auditHead(study.path, pick.i, pick.j).catch(() => null);
      if (!measured) {
        if (isNepal) {
          setAuditBusy('scoring the nine flow cells against Nepal’s seasonal regime…');
          shape = await auditShape(study.flow, hydest?.months ?? []).catch(() => null);
        }
        setAuditBusy('requesting up to 40 years of complete flow…');
        const cell = shape?.better?.cell ?? study.flow.cell;
        const long = await fetchDischargeYears(cell.lat, cell.lon).catch(() => null);
        if (long) {
          years = new Set(long.dates.map((d) => d.slice(0, 4))).size;
          setStudy((s) => (s ? { ...s, flow: long } : s));
        } else if (shape?.better) {
          // No long record, but a decisively better cell still counts.
          const better = shape.better;
          setStudy((s) => (s ? { ...s, flow: better } : s));
        }
      }
      if (!head && !shape && years === null) {
        auditError = 'nothing could be measured — the public services may be rate-limiting; try again in a few minutes';
      }
    } catch (e) {
      auditError = e instanceof Error ? e.message : String(e);
    }
    setAudit({ head, shape, years, error: auditError });
    setAuditBusy(null);
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
    const bounds = points.reduce(
      (box, point) => box.extend(point),
      new maplibregl.LngLatBounds(points[0], points[0])
    );
    m.fitBounds(bounds, {
      padding: {
        top: 72,
        right: 36,
        bottom: 54,
        left: window.innerWidth >= 1024 ? Math.round(window.innerWidth / 2) + 36 : 36,
      },
      maxZoom: 11.8,
      duration: 500,
    });
  }, [at, study, scheme, hazards, licences, cascade, upstreamConnectivity]);

  return (
    <div className="flex h-full flex-col lg:block">
      <div ref={mapEl} className="h-[46vh] w-full shrink-0 lg:absolute lg:inset-0 lg:h-full" />

      <header className="pointer-events-none absolute right-3 top-3 z-10 hidden lg:block">
        <div className="flex items-center gap-2 rounded-full border border-line bg-bg/75 py-1.5 pl-3 pr-4 backdrop-blur-md">
          <Mark />
          <span className="text-[13.5px] font-semibold tracking-tight">Ghatta</span>
          <span className="mt-px text-[11px] text-muted">hydropower scheme finder</span>
        </div>
      </header>

      {isNepal && at && <MapLegend onFit={focusEvidence} />}

      <Reading
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
        grid={grid}
        conservation={conservation}
        localGis={localGis}
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
        neighbours={neighbours}
        onProbe={runProbe}
        onReset={reset}
        tweaked={tweaked}
      />
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

function MapLegend({ onFit }: { onFit: () => void }) {
  const badge = (label: string, color: string, shape = 'rounded-sm') => (
    <span
      className={`flex size-4 shrink-0 items-center justify-center ${shape} border border-bg text-[8px] font-bold text-white shadow-sm`}
      style={{ background: color }}
      aria-hidden
    >
      {label}
    </span>
  );
  return (
    <div className="absolute right-3 top-14 z-10 hidden w-[220px] rounded-xl border border-line bg-bg/88 p-3 shadow-[0_14px_40px_rgba(0,0,0,0.45)] backdrop-blur-md lg:block">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">map evidence</span>
        <button type="button" onClick={onFit} className="text-[10.5px] text-river hover:text-ink">
          fit evidence
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px] text-muted">
        <span className="flex items-center gap-1.5">{badge('L', HAZARD_COLORS.landslide, '[clip-path:polygon(50%_0,100%_100%,0_100%)]')}landslide</span>
        <span className="flex items-center gap-1.5">{badge('F', HAZARD_COLORS.flood)}flood</span>
        <span className="flex items-center gap-1.5">{badge('E', HAZARD_COLORS.earthquake, 'rotate-45')}<span>earthquake</span></span>
        <span className="flex items-center gap-1.5">{badge('G', HAZARD_COLORS.glof, 'rounded-full')}GLOF / lake</span>
        <span className="flex items-center gap-1.5">{badge('H', '#e06552')}DoED project</span>
        <span className="flex items-center gap-1.5">{badge('U', '#c58af9', 'rotate-45')}<span>project link</span></span>
        <span className="flex items-center gap-1.5"><i className="h-0.5 w-4 bg-[#e0bd55]" />transmission</span>
        <span className="flex items-center gap-1.5"><i className="size-4 border border-dashed border-green bg-green/10" />protected area</span>
        <span className="col-span-2 flex items-center gap-1.5"><i className="w-4 border-t border-dashed" style={{ borderColor: FAULT_COLOR }} />active fault trace</span>
      </div>
      <div className="mt-2 border-t border-line pt-2 text-[9.5px] leading-snug text-faint">
        Select any symbol for its source and meaning.
      </div>
    </div>
  );
}
