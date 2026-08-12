import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  fetchDischarge,
  fetchPathProfile,
  meanOf,
  probeNeighbours,
  reanchorToRiver,
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
import { haversineKm, minMonthlyMean, wetDryEnergy, type PlantParams } from './engine/hydro.ts';
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
  clickMeanCms: number;
  dem: ElevationProfile;
  /** False when the river had to be approximated by a straight line. */
  followsRiver: boolean;
  /** True when the course came from tracing terrain, not a mapped river network. */
  tracedFromTerrain?: boolean;
  reach: Reach | null;
  /** Set when the flow query had to be moved onto the right channel. */
  movedKm?: number;
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

  const onClick = useCallback(async (lat: number, lon: number) => {
    const hit = await nearestReach(lat, lon).catch(() => null);
    setPick(null);
    setTweaked(false);
    setNeighbours(null);
    setAt(hit && hit.nearest.distanceKm <= SNAP_KM ? hit.nearest.point : { lat, lon });
  }, []);

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
        let flow = await flowP;
        let movedKm: number | undefined;

        // The flood model's grid cell can miss the channel. Where the mapped
        // network gives an independent mean, use it to referee — but only when
        // the two already disagree, since the check costs 8 requests.
        const target = reach?.meanDischargeCms ?? 0;
        const mean = meanOf(flow.values);
        if (target > 0 && mean > 0 && Math.max(target / mean, mean / target) > 2) {
          if (!dead) setBusy('Flow looks off-channel — finding the right cell…');
          const fixed = await reanchorToRiver(river, target, flow).catch(() => null);
          if (fixed) {
            flow = fixed.series;
            movedKm = fixed.movedKm;
          }
        }
        if (dead) return;
        setStudy({
          path: river.map((p, k) => ({ ...p, elevationM: dem.points[k]?.elevationM ?? NaN })),
          flow,
          clickMeanCms: river[0].meanCms,
          dem,
          followsRiver: true,
          reach,
          movedKm,
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
          // No catchment data out here, so flow is held constant along the
          // reach rather than invented. Stated in the panel.
          path: traced.map((p) => ({ ...p, meanCms: 1 })),
          flow,
          clickMeanCms: 1,
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
    const minMonth = minMonthlyMean(study.flow.dates, study.flow.values);
    return {
      path: study.path,
      series: study.flow.values,
      clickMeanCms: study.clickMeanCms,
      residualCms: Number.isFinite(minMonth) ? minMonth * assume.residualFrac : 0,
      exceedance: assume.exceedance,
      efficiency: assume.efficiency,
      headLossFrac: assume.headLossFrac,
      minFlowFrac: MIN_FLOW_FRAC,
    };
  }, [study, assume]);

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

  const seasons = useMemo(() => {
    if (!study || !scheme) return null;
    const ratio = study.clickMeanCms > 0 ? study.path[scheme.i].meanCms / study.clickMeanCms : 1;
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
  }, [scheme, at, study, pick]);

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

  const reset = useCallback(() => {
    setAt(null);
    setStudy(null);
    setPick(null);
    setTweaked(false);
    setNeighbours(null);
    setError(null);
    setFlowOnly(null);
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
        pick={pick}
        onPick={(s) => {
          setTweaked(false);
          setPick({ i: s.i, j: s.j });
        }}
        assume={assume}
        setAssume={setAssume}
        busy={busy}
        error={error}
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
