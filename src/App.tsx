import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  fetchDischarge,
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
import { uncertaintyFor } from './engine/uncertainty.ts';
import { haversineKm, minMonthlyMean, wetDryEnergy, type PlantParams } from './engine/hydro.ts';
import { licencesAlong, loadLicences, type Licence } from './context.ts';
import { gaugesFor, type Gauge } from './gauges.ts';
import { gridLink } from './grid.ts';
import { isHardStop, protectedAt, protectedNear } from './protected.ts';
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
  designFlood,
  driestMonthFlow,
  drySeasonAgreement,
  drySeasonFlows,
  monthMean,
} from './engine/hydest.ts';
import {
  download,
  fileStem,
  schemesToCsv,
  schemesToGeoJson,
  type ExportContext,
} from './export.ts';
import { Reading } from './Reading.tsx';

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
  residualFrac: 0.1,
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

// ---------------------------------------------------------------------------

export default function App() {
  const initial = useMemo(readUrl, []);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<{ a?: maplibregl.Marker; b?: maplibregl.Marker }>({});

  /** Where the user clicked on the river. The only input the app needs. */
  const [at, setAt] = useState<Pt | null>(initial.at);

  const [study, setStudy] = useState<Study | null>(null);
  const [assume, setAssume] = useState<Assumptions>(DEFAULTS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [neighbours, setNeighbours] = useState<{ lat: number; lon: number; meanCms: number }[] | null>(null);
  /** Chosen intake/powerhouse indices into study.path. */
  const [pick, setPick] = useState<{ i: number; j: number } | null>(null);
  const [tweaked, setTweaked] = useState(false);
  /** Sweep the whole downstream reach instead of anchoring to the click. */
  const [wideSearch, setWideSearch] = useState(false);
  /** Licensed and operating projects sitting on the studied reach. */
  const [licences, setLicences] = useState<Licence[] | null>(null);
  const [gauges, setGauges] = useState<Gauge[] | null>(null);
  /** A gauge record the engineer supplied, which outranks every model here. */
  const [measured, setMeasured] = useState<{ series: MeasuredSeries; ratio: number; name: string } | null>(null);

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

      // Licensed and operating projects already on this river.
      m.addSource('licences', { type: 'geojson', data: empty() });
      m.addLayer({
        id: 'licences',
        type: 'circle',
        source: 'licences',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 13, 6],
          // Operating plants are a hard constraint; a survey licence is a soft one.
          'circle-color': ['match', ['get', 'stage'], 'Operation', '#e06552', 'Generation', '#d2a04a', '#9aa1a9'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#0e0f11',
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
                  'line-opacity': 0.75,
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
    });

    m.on('click', (e) => void onClick(e.lngLat.lat, e.lngLat.lng));
    m.on('moveend', () => {
      const c = m.getCenter();
      writeUrl({ lat: c.lat, lon: c.lng, zoom: m.getZoom() }, atRef.current);
    });

    return () => {
      ro.disconnect();
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
        const traced = await traceDownhill(at.lat, at.lon, SEARCH_KM);
        const flow = await flowP;
        if (dead) return;
        if (traced.length < 8) {
          setStudy(null);
          setFlowOnly(flow);
          return;
        }
        setStudy({
          // meanCms 0 = no mapped network here, so the flood model's own
          // magnitude is used unscaled and the panel says so.
          path: traced.map((p) => ({ ...p, meanCms: 0 })),
          flow,
          dem: {
            points: traced.map((p) => ({
              distanceKm: p.km,
              elevationM: p.elevationM,
              lat: p.lat,
              lon: p.lon,
            })),
            source: 'Re:Earth Mapterhorn (valley trace)',
            zoom: 0,
            resolutionM: NaN,
            tilesFetched: 0,
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
    return {
      path: study.path,
      series,
      // With a measured record, keep its magnitude: pass the network's own mean
      // so the rescale is a no-op instead of pulling it onto a modelled figure.
      seriesMeanCms: measured ? (study.path[0]?.meanCms || seriesMean) : seriesMean,
      residualCms: Number.isFinite(minMonth) ? minMonth * assume.residualFrac : 0,
      exceedance: assume.exceedance,
      efficiency: assume.efficiency,
      headLossFrac: assume.headLossFrac,
      minFlowFrac: MIN_FLOW_FRAC,
      intakeWindowKm: wideSearch ? Number.POSITIVE_INFINITY : INTAKE_WINDOW_KM,
    };
  }, [study, assume, wideSearch, measured]);

  // Who already holds this river. The registry is one 128 KB download, cached
  // for the session, so this costs nothing after the first study.
  useEffect(() => {
    if (!study) {
      setLicences(null);
      return;
    }
    let dead = false;
    loadLicences()
      .then((all) => {
        if (!dead) setLicences(licencesAlong(all, study.path));
      })
      .catch(() => {
        if (!dead) setLicences(null); // context is optional; never block the study
      });
    return () => {
      dead = true;
    };
  }, [study]);

  // Where a real measured record exists. Flow is the dominant error here, and
  // this is the only thing that would actually shrink it — so it is worth
  // saying which station to go and ask for, even though the values are gated.
  useEffect(() => {
    if (!study) {
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
  }, [study]);

  /**
   * Nepal's own regression, run on this catchment.
   *
   * Every other flow figure here comes from a global model. This one is fitted
   * to Nepali gauge records, so where it agrees the estimate is genuinely
   * corroborated, and where it does not the engineer should know before
   * anything is built on the number.
   */
  const hydest = useMemo(() => {
    const r = study?.reach;
    if (!r || !Number.isFinite(r.below5000Frac) || !(r.uplandKm2 > 0)) return null;
    const input = {
      totalKm2: r.uplandKm2,
      below5000Km2: r.below5000Frac * r.uplandKm2,
      below3000Km2: r.below3000Frac * r.uplandKm2,
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
    const ratio = networkMean > 0 && seriesMean > 0 ? networkMean / seriesMean : 1;
    const modelled = monthMean(study.flow.dates, study.flow.values, driest.month) * ratio;
    return {
      input,
      driest,
      months: drySeasonFlows(input),
      modelledCms: modelled,
      agreement: Number.isFinite(modelled) ? drySeasonAgreement(driest.cms, modelled) : null,
      floods: RETURN_PERIODS.map((t) => ({ t: t as number, cms: designFlood(input, t) })).filter(
        (f): f is { t: number; cms: number } => f.cms !== null
      ),
    };
  }, [study]);

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

  // How much to trust it, computed by rerunning the engine on perturbed inputs.
  /**
   * Getting the power out. Measured from the powerhouse, where the switchyard
   * goes, and sized against the scheme's own capacity — a nearby 66 kV line is
   * not a connection for a 150 MW plant.
   */
  const grid = useMemo(
    () => (scheme ? gridLink(scheme.power.lat, scheme.power.lon, scheme.capacityMW) : null),
    [scheme]
  );

  /**
   * Whether this scheme sits inside a protected area.
   *
   * Tested at BOTH ends: an intake outside a park with its powerhouse inside is
   * still a park problem, and so is the reverse. Near-misses are reported too,
   * because a boundary simplified to 200 m cannot settle a site 300 m outside one.
   */
  const conservation = useMemo(() => {
    if (!scheme) return null;
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
  }, [scheme]);

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

  const uncertainty = useMemo(() => {
    if (!input || !scheme || !study) return null;
    return uncertaintyFor(
      input,
      scheme,
      meanOf(study.flow.values),
      study.reach?.meanDischargeCms ?? null,
      // A supplied record replaces the model-disagreement logic entirely.
      measured ? measuredSpread(measured.ratio) : undefined
    );
  }, [input, scheme, study, measured]);

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

  const seasons = useMemo(() => {
    if (!study || !scheme) return null;
    const gm = meanOf(study.flow.values);
    const ratio = study.path[scheme.i].meanCms > 0 && gm > 0 ? study.path[scheme.i].meanCms / gm : 1;
    const p: PlantParams = {
      grossHeadM: Math.max(0, scheme.grossHeadM),
      headLossFrac: assume.headLossFrac,
      efficiency: assume.efficiency,
      designFlowCms: scheme.designFlowCms,
      residualFlowCms: scheme.residualCms,
      minFlowFrac: MIN_FLOW_FRAC,
    };
    return wetDryEnergy(study.flow.dates, study.flow.values.map((v) => v * ratio), p);
  }, [study, scheme, assume]);

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
  }, [scheme, at, study, pick, licences]);

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
      schemes: found.schemes,
      selected: scheme,
      path: study.path,
      demSource: study.dem.source,
      demResolutionM: study.dem.resolutionM,
      flowYears: study.flow.dates.length / 365.25,
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
        residualFrac: assume.residualFrac,
      },
    };
  }, [at, study, found, scheme, licences, gauges, grid, sediment, bench, measured, assume, uncertainty]);

  const onExport = useCallback(
    (kind: 'csv' | 'geojson') => {
      if (!exportCtx) return;
      const stem = fileStem(exportCtx.at);
      if (kind === 'csv') {
        download(`${stem}.csv`, 'text/csv;charset=utf-8', schemesToCsv(exportCtx));
      } else {
        download(`${stem}.geojson`, 'application/geo+json', schemesToGeoJson(exportCtx));
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
    setLicences(null);
    setGauges(null);
    setMeasured(null);
    setWideSearch(false);
  }, []);

  return (
    <div className="flex h-full flex-col lg:block">
      <div ref={mapEl} className="h-[46vh] w-full shrink-0 lg:absolute lg:inset-0 lg:h-full" />

      <header className="pointer-events-none absolute left-3 top-3 z-10 hidden lg:block">
        <div className="flex items-center gap-2 rounded-full border border-line bg-bg/75 py-1.5 pl-3 pr-4 backdrop-blur-md">
          <Mark />
          <span className="text-[13.5px] font-semibold tracking-tight">Ghatta</span>
          <span className="mt-px text-[11px] text-muted">hydropower scheme finder</span>
        </div>
      </header>

      <Reading
        at={at}
        study={study}
        flowOnly={flowOnly}
        found={found}
        scheme={scheme}
        seasons={seasons}
        uncertainty={uncertainty}
        pick={pick}
        onPick={(s) => {
          setTweaked(false);
          setPick({ i: s.i, j: s.j });
        }}
        assume={assume}
        setAssume={setAssume}
        busy={busy}
        error={error}
        licences={licences}
        gauges={gauges}
        hydest={hydest}
        grid={grid}
        conservation={conservation}
        sediment={sediment}
        bench={bench}
        measured={measured}
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
