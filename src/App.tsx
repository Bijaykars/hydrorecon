import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  fetchDischarge,
  fetchProfile,
  probeNeighbours,
  type DischargeSeries,
  type ElevationProfile,
} from './api.ts';
import { hasReachData, nearestReach, riversGeoJson, SNAP_KM, type Reach } from './rivers.ts';
import {
  annualEnergy,
  buildFdc,
  flowAtExceedance,
  haversineKm,
  minMonthlyMean,
  netHead,
  wetDryEnergy,
  type PlantParams,
} from './engine/hydro.ts';
import { Reading } from './Reading.tsx';

export type Pt = { lat: number; lon: number };

export type Assumptions = {
  /** Design flow taken at this exceedance on the FDC. */
  exceedance: number;
  /** Turbine × generator × transformer. */
  efficiency: number;
  /** Hydraulic losses as a fraction of gross head. */
  headLossFrac: number;
  /** Residual flow as a fraction of the lowest monthly mean. */
  residualFrac: number;
  /** Annual household consumption used for the plain-language comparison. */
  householdKwh: number;
};

const DEFAULTS: Assumptions = {
  exceedance: 0.4,
  efficiency: 0.85,
  headLossFrac: 0.05,
  residualFrac: 0.1,
  householdKwh: 900,
};

/** Turbine stops below this share of design flow. Not worth a control. */
const MIN_FLOW_FRAC = 0.2;

// ---------------------------------------------------------------------------
// URL state — the whole session is one shareable link.
// ---------------------------------------------------------------------------

type UrlState = { view: { lat: number; lon: number; zoom: number }; intake: Pt | null; power: Pt | null };

function readUrl(): UrlState {
  const p = new URLSearchParams(location.hash.slice(1));
  const pt = (s: string | null): Pt | null => {
    const m = s?.split(',').map(Number);
    return m && m.length === 2 && m.every(Number.isFinite) ? { lat: m[0], lon: m[1] } : null;
  };
  const v = p.get('map')?.split('/').map(Number);
  return {
    view:
      v && v.length === 3 && v.every(Number.isFinite)
        ? { zoom: v[0], lat: v[1], lon: v[2] }
        : { zoom: 3.2, lat: 22, lon: 20 },
    intake: pt(p.get('i')),
    power: pt(p.get('p')),
  };
}

function writeUrl(view: { lat: number; lon: number; zoom: number }, intake: Pt | null, power: Pt | null) {
  const p = new URLSearchParams();
  p.set('map', `${view.zoom.toFixed(2)}/${view.lat.toFixed(4)}/${view.lon.toFixed(4)}`);
  if (intake) p.set('i', `${intake.lat.toFixed(5)},${intake.lon.toFixed(5)}`);
  if (power) p.set('p', `${power.lat.toFixed(5)},${power.lon.toFixed(5)}`);
  history.replaceState(null, '', `#${p}`);
}

// ---------------------------------------------------------------------------

export default function App() {
  const initial = useMemo(readUrl, []);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<{ intake?: maplibregl.Marker; power?: maplibregl.Marker }>({});

  const [intake, setIntake] = useState<Pt | null>(initial.intake);
  const [power, setPower] = useState<Pt | null>(initial.power);
  const [reach, setReach] = useState<Reach | null>(null);
  const [bigger, setBigger] = useState<Reach | null>(null);
  const [flow, setFlow] = useState<DischargeSeries | null>(null);
  const [profile, setProfile] = useState<ElevationProfile | null>(null);
  const [assume, setAssume] = useState<Assumptions>(DEFAULTS);
  const [busy, setBusy] = useState<'flow' | 'terrain' | 'probe' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [neighbours, setNeighbours] = useState<{ lat: number; lon: number; meanCms: number }[] | null>(null);
  const [swapped, setSwapped] = useState(false);

  // ---------------- map ----------------
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapEl.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [initial.view.lon, initial.view.lat],
      zoom: initial.view.zoom,
      attributionControl: { compact: true },
      refreshExpiredTiles: false, // terrain tiles ship no Cache-Control but are static
      fadeDuration: 0,
      maxTileCacheZoomLevels: 10,
    });
    map.current = m;
    // Handy for verification scripts and for debugging in the console.
    (window as unknown as { __map: maplibregl.Map }).__map = m;
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // The panel library and flex both settle a frame after mount; MapLibre's own
    // observer can measure mid-layout and pin the canvas at its 400 px fallback.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(mapEl.current);
    requestAnimationFrame(() => m.resize());

    m.on('styleimagemissing', (e) => {
      if (m.hasImage(e.id)) return;
      const size = 8;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#26352f';
      ctx.fillRect(0, 0, size, size);
      m.addImage(e.id, ctx.getImageData(0, 0, size, size));
    });

    m.on('load', () => {
      const firstWater = m.getStyle().layers?.find((l) => l.id === 'water')?.id;
      m.addSource('dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 12, // measured: DEM was 84% of bytes on zoom; relief is a basin-scale cue
        attribution: 'Terrain: AWS Terrain Tiles',
      });
      m.addLayer(
        {
          id: 'hillshade',
          type: 'hillshade',
          source: 'dem',
          minzoom: 5,
          // Deliberately higher than the source's maxzoom: MapLibre overzooms the
          // z12 tiles instead of downloading finer ones, so relief keeps drawing
          // at site scale without costing a single extra byte. Capping the LAYER
          // at 12 instead leaves a dead black map the moment you zoom in.
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
      // The stock dark style paints water almost invisibly. Here rivers are the subject.
      if (m.getLayer('water')) m.setPaintProperty('water', 'fill-color', '#12456b');
      if (m.getLayer('waterway')) {
        m.setPaintProperty('waterway', 'line-color', '#4db8ff');
        m.setPaintProperty('waterway', 'line-opacity', 0.85);
      }
      // Detailed centrelines exist for part of the world; add them when in view.
      const maybeAddReaches = () => {
        if (m.getSource('reaches')) return;
        const b = m.getBounds();
        if (!hasReachData(b.getCenter().lat, b.getCenter().lng)) return;
        riversGeoJson()
          .then((data) => {
            if (m.getSource('reaches')) return;
            m.addSource('reaches', { type: 'geojson', data });
            m.addLayer({
              id: 'reaches',
              type: 'line',
              source: 'reaches',
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: {
                // Bright and thick enough to aim at: the flow figure is only as
                // good as how close the click lands to the actual channel.
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
            });
          })
          .catch(() => {
            /* the app works without the overlay */
          });
      };
      maybeAddReaches();
      m.on('moveend', maybeAddReaches);
    });

    m.on('click', (e) => void place(e.lngLat.lat, e.lngLat.lng));
    m.on('moveend', () => {
      const c = m.getCenter();
      writeUrl({ lat: c.lat, lon: c.lng, zoom: m.getZoom() }, intakeRef.current, powerRef.current);
    });

    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refs so the map's long-lived listeners see current values.
  const intakeRef = useRef(intake);
  const powerRef = useRef(power);
  intakeRef.current = intake;
  powerRef.current = power;

  /** Snap onto a mapped centreline, but only if the click was plausibly aimed at one. */
  const snap = useCallback(async (lat: number, lon: number) => {
    const hit = await nearestReach(lat, lon).catch(() => null);
    if (!hit || hit.nearest.distanceKm > SNAP_KM) return { pt: { lat, lon }, hit: null };
    return { pt: hit.nearest.point, hit };
  }, []);

  const place = useCallback(
    async (lat: number, lon: number) => {
      if (!intakeRef.current || powerRef.current) {
        // First click, or a third click that starts over.
        setPower(null);
        setProfile(null);
        setNeighbours(null);
        setSwapped(false);
        setIntake((await snap(lat, lon)).pt);
      } else {
        setPower((await snap(lat, lon)).pt);
      }
    },
    [snap]
  );

  const useBigger = useCallback(() => {
    if (!bigger) return;
    setReach(bigger);
    setBigger(null);
    setIntake(bigger.point);
  }, [bigger]);

  // ---------------- markers ----------------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const sync = (kind: 'intake' | 'power', pt: Pt | null, color: string, set: (p: Pt) => void) => {
      const existing = markers.current[kind];
      if (!pt) {
        existing?.remove();
        delete markers.current[kind];
        return;
      }
      if (existing) {
        existing.setLngLat([pt.lon, pt.lat]);
        return;
      }
      const el = document.createElement('div');
      el.className = 'marker';
      el.style.setProperty('--c', color);
      el.title = kind === 'intake' ? 'Intake — drag to move' : 'Powerhouse — drag to move';
      const mk = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([pt.lon, pt.lat])
        .addTo(m);
      mk.on('dragend', () => {
        const l = mk.getLngLat();
        set({ lat: l.lat, lon: l.lng });
      });
      markers.current[kind] = mk;
    };
    sync('intake', intake, '#4db8ff', setIntake);
    sync('power', power, '#3fb950', setPower);
  }, [intake, power]);

  // ---------------- data ----------------
  // Derived from the intake rather than captured on click, so dragging the
  // marker and the automatic swap both keep the catchment figures truthful.
  useEffect(() => {
    if (!intake) {
      setReach(null);
      setBigger(null);
      return;
    }
    let dead = false;
    nearestReach(intake.lat, intake.lon)
      .then((hit) => {
        if (dead) return;
        // Reported whatever the distance — the catchment is useful context even
        // when the click was too far off the centreline to justify moving the
        // marker. The panel states how far away that centreline is.
        setReach(hit?.nearest ?? null);
        setBigger(hit?.mainStem ?? null);
      })
      .catch(() => {
        /* the app works without it */
      });
    return () => {
      dead = true;
    };
  }, [intake]);

  useEffect(() => {
    if (!intake) {
      setFlow(null);
      return;
    }
    const ac = new AbortController();
    setBusy('flow');
    setError(null);
    fetchDischarge(intake.lat, intake.lon, ac.signal)
      .then(setFlow)
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setFlow(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => !ac.signal.aborted && setBusy(null));
    return () => ac.abort();
  }, [intake]);

  useEffect(() => {
    if (!intake || !power) {
      setProfile(null);
      return;
    }
    let dead = false;
    setBusy('terrain');
    fetchProfile([intake.lat, intake.lon], [power.lat, power.lon])
      .then((p) => {
        if (dead) return;
        // Water runs downhill, so which point was clicked first carries no
        // engineering meaning. If the terrain says the powerhouse is the higher
        // of the two, the roles are simply the other way round — swap them
        // instead of stranding the user in an error they have to fix by hand.
        const a = p.points[0].elevationM;
        const b = p.points[p.points.length - 1].elevationM;
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
          setSwapped(true);
          setIntake(power);
          setPower(intake);
          return; // the effect reruns with the corrected order
        }
        setProfile(p);
      })
      .catch((e: unknown) => !dead && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !dead && setBusy(null));
    return () => {
      dead = true;
    };
  }, [intake, power]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const c = m.getCenter();
    writeUrl({ lat: c.lat, lon: c.lng, zoom: m.getZoom() }, intake, power);
  }, [intake, power]);

  const runProbe = useCallback(async () => {
    if (!intake) return;
    setBusy('probe');
    setNeighbours(await probeNeighbours(intake.lat, intake.lon));
    setBusy(null);
  }, [intake]);

  // ---------------- the computation ----------------
  const result = useMemo(() => {
    if (!flow) return null;
    const fdc = buildFdc(flow.values);
    const minMonth = minMonthlyMean(flow.dates, flow.values);
    const residualCms = Number.isFinite(minMonth) ? minMonth * assume.residualFrac : 0;
    const atExceedance = flowAtExceedance(fdc, assume.exceedance);
    const designFlowCms = Math.max(0, atExceedance - residualCms);

    const grossHeadM = profile
      ? profile.points[0].elevationM - profile.points[profile.points.length - 1].elevationM
      : 0;

    const params: PlantParams = {
      grossHeadM: Math.max(0, grossHeadM),
      headLossFrac: assume.headLossFrac,
      efficiency: assume.efficiency,
      designFlowCms,
      residualFlowCms: residualCms,
      minFlowFrac: MIN_FLOW_FRAC,
    };
    const energy = annualEnergy(flow.values, params);
    const seasons = wetDryEnergy(flow.dates, flow.values, params);
    const meanCms = flow.values.reduce((a, b) => a + b, 0) / flow.values.length;

    return {
      fdc,
      minMonth,
      residualCms,
      designFlowCms,
      grossHeadM,
      netHeadM: netHead(params),
      energy,
      seasons,
      meanCms,
      years: flow.dates.length / 365.25,
      cellKm: intake ? haversineKm([intake.lat, intake.lon], [flow.cell.lat, flow.cell.lon]) : 0,
    };
  }, [flow, profile, assume, intake]);

  const reset = useCallback(() => {
    setIntake(null);
    setPower(null);
    setReach(null);
    setBigger(null);
    setFlow(null);
    setProfile(null);
    setNeighbours(null);
    setError(null);
    setSwapped(false);
  }, []);

  return (
    <div className="flex h-full flex-col lg:block">
      <div ref={mapEl} className="h-[46vh] w-full shrink-0 lg:absolute lg:inset-0 lg:h-full" />

      <header className="pointer-events-none absolute left-0 right-0 top-0 z-10 hidden items-center gap-2 px-4 py-3 lg:flex">
        <Mark />
        <span className="text-[13px] font-semibold tracking-tight">Ghatta</span>
        <span className="text-[11px] text-muted">run-of-river screening</span>
      </header>

      <Reading
        intake={intake}
        power={power}
        reach={reach}
        bigger={bigger}
        onUseBigger={useBigger}
        flow={flow}
        profile={profile}
        result={result}
        assume={assume}
        setAssume={setAssume}
        busy={busy}
        error={error}
        swapped={swapped}
        neighbours={neighbours}
        onProbe={runProbe}
        onReset={reset}
      />
    </div>
  );
}

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
