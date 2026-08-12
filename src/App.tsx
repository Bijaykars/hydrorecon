import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  fetchDischarge,
  fetchPathProfile,
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
import { measuredSpread, parseMeasured, scaleSeries, type MeasuredSeries } from './measured.ts';
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
            'hillshade-shadow-color': '#000914',
            'hillshade-highlight-color': '#43617d',
            'hillshade-accent-color': '#0d1a26',
          },
        },
        firstWater
      );
      if (m.getLayer('water')) m.setPaintProperty('water', 'fill-color', '#12456b');
      if (m.getLayer('waterway')) {
        m.setPaintProperty('waterway', 'line-color', '#4db8ff');
        m.setPaintProperty('waterway', 'line-opacity', 0.85);
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
          'circle-color': ['match', ['get', 'stage'], 'Operation', '#f85149', 'Generation', '#d29922', '#8fa3b5'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#0b0f14',
        },
      });
      m.on('click', 'licences', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { name: string; stage: string; cap: string; promoter: string };
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.name}</b><br/><span style="color:#8fa3b5">${p.stage}` +
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
                  'line-color': '#4db8ff',
                  'line-opacity': 0.8,
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
      setMeasured({
        series: scaleSeries(parsed.series, suggested),
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
  }, [at, study, found, scheme, licences, gauges, grid, measured, assume, uncertainty]);

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

      <header className="pointer-events-none absolute left-0 right-0 top-0 z-10 hidden items-center gap-2 px-4 py-3 lg:flex">
        <Mark />
        <span className="text-[13px] font-semibold tracking-tight">Ghatta</span>
        <span className="text-[11px] text-muted">hydropower scheme finder</span>
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
      <circle cx="9" cy="9" r="8" fill="none" stroke="#4db8ff" strokeWidth="1.6" />
      {[0, 120, 240].map((r) => (
        <path
          key={r}
          d="M9 3.2C10.4 5.4 10.4 7 9 9C7.6 7 7.6 5.4 9 3.2Z"
          fill="#4db8ff"
          transform={`rotate(${r} 9 9)`}
        />
      ))}
    </svg>
  );
}
