import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { toast } from 'sonner';
import { useStore, type LayerKey } from '../state/store.ts';
import { dhmStations, riversGeoJson } from './rivers.ts';

/** #z/lat/lon — shareable view, replaceState only (no history spam). */
function readHashView(): { lon: number; lat: number; zoom: number } | null {
  const m = location.hash.match(/^#(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { zoom: Number(m[1]), lat: Number(m[2]), lon: Number(m[3]) };
}

const LAYER_DEFS: { key: LayerKey; label: string; hint?: string }[] = [
  { key: 'hillshade', label: 'Hillshade', hint: 'AWS Terrain Tiles, basin scale' },
  { key: 'rivers', label: 'Rivers — HydroRIVERS', hint: 'line width ∝ mean discharge' },
  { key: 'satellite', label: 'Satellite — Esri' },
  { key: 'stations', label: 'DHM stations', hint: '1,115 hydro/met stations' },
];

const ROADMAP_LAYERS = ['Projects & licenses', 'Glacial lakes · GLOF', 'Faults', 'Transmission'];

export function MapView() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Collapsed by default on phones — open, it swallows the small map.
  const [layersOpen, setLayersOpen] = useState(
    () => window.matchMedia('(min-width: 900px)').matches
  );

  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const flyTo = useStore((s) => s.flyTo);
  const site = useStore((s) => s.site);
  const siteBusy = useStore((s) => s.siteBusy);

  // ---------------- map bring-up (salvaged, validated settings) ----------------
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const stored = useStore.getState().view;
    const initial = readHashView() ?? stored;
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [initial.lon, initial.lat],
      zoom: initial.zoom,
      attributionControl: { compact: true },
      // AWS terrain tiles ship no Cache-Control; treat static DEM data as fresh.
      refreshExpiredTiles: false,
      fadeDuration: 0,
      maxTileCacheZoomLevels: 10,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

    // The panel library sizes its panes a frame after mount; MapLibre's own
    // observer can catch the container mid-layout (measured: width read 0 →
    // canvas pinned at the 400px fallback). Own observer + settle kick makes
    // sizing deterministic, and covers panel drags too.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(mapEl.current);
    requestAnimationFrame(() => map.resize());

    // Optional OpenFreeMap sprite entries occasionally arrive missing — supply a
    // neutral raster so MapLibre neither warns nor drops cartographic detail.
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

    map.on('load', () => {
      // Relief under everything water-related. Stock dark style paints water
      // nearly invisible; in this app rivers are the subject.
      if (!map.getSource('dem')) {
        map.addSource('dem', {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 12, // measured: DEM was 84% of zoom bytes; relief is a basin-scale cue
          attribution: 'Terrain: AWS Terrain Tiles',
        });
      }
      const firstWaterId = map.getStyle().layers?.find((l) => l.id === 'water')?.id;
      map.addLayer(
        {
          id: 'satellite',
          type: 'raster',
          source: {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            attribution: 'Imagery: Esri World Imagery',
          },
          layout: { visibility: 'none' },
        },
        firstWaterId
      );
      map.addLayer(
        {
          id: 'hillshade',
          type: 'hillshade',
          source: 'dem',
          minzoom: 9,
          maxzoom: 12,
          paint: {
            'hillshade-exaggeration': [
              'interpolate',
              ['linear'],
              ['zoom'],
              9,
              0.35,
              11,
              0.55,
              12,
              0.18,
            ],
            'hillshade-shadow-color': '#000914',
            'hillshade-highlight-color': '#43617d',
            'hillshade-accent-color': '#0d1a26',
          },
        },
        firstWaterId
      );
      if (map.getLayer('water')) {
        map.setPaintProperty('water', 'fill-color', '#12456b');
        map.setPaintProperty('water', 'fill-opacity', 0.9);
      }
      if (map.getLayer('waterway')) {
        map.setPaintProperty('waterway', 'line-color', '#4db8ff');
        map.setPaintProperty('waterway', 'line-opacity', 0.85);
      }

      // HydroRIVERS overlay — the screening subject, discharge-scaled.
      riversGeoJson()
        .then((fc) => {
          if (!fc || map.getSource('hydrorivers')) return;
          map.addSource('hydrorivers', { type: 'geojson', data: fc });
          map.addLayer({
            id: 'rivers',
            type: 'line',
            source: 'hydrorivers',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': '#4db8ff',
              'line-opacity': ['interpolate', ['linear'], ['get', 'o'], 2, 0.45, 5, 0.9],
              'line-width': [
                'interpolate',
                ['exponential', 1.6],
                ['zoom'],
                6,
                ['interpolate', ['linear'], ['get', 'd'], 1, 0.3, 50, 1.1, 1000, 2.2],
                12,
                ['interpolate', ['linear'], ['get', 'd'], 1, 1.1, 50, 2.6, 1000, 5],
              ],
            },
          });
          syncLayers(map, useStore.getState().layers);
        })
        .catch((e) =>
          toast.error('River network failed to load', {
            description: e instanceof Error ? e.message : String(e),
          })
        );

      // DHM stations — real catalog, toggleable.
      map.addSource('dhm', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: dhmStations.map((st) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [st.x, st.y] },
            properties: { n: st.n, r: st.r, e: st.e },
          })),
        },
      });
      map.addLayer({
        id: 'stations',
        type: 'circle',
        source: 'dhm',
        minzoom: 7,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2, 12, 4.5],
          'circle-color': ['case', ['==', ['get', 'r'], 1], '#4db8ff', '#8fa3b5'],
          'circle-opacity': 0.85,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#0b0f14',
        },
      });
      map.on('click', 'stations', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as { n: string; r: number; e: number | null };
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>${p.n}</b><br/><span style="color:#8fa3b5">${p.r === 1 ? 'River gauge' : 'Met station'}${p.e ? ` · ${p.e} m` : ''} · DHM</span>`
          )
          .addTo(map);
      });

      // Selected-site marker pair (halo + dot), data set on selection.
      map.addSource('site', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'site-halo',
        type: 'circle',
        source: 'site',
        paint: {
          'circle-radius': 11,
          'circle-color': 'transparent',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#e6edf3',
          'circle-stroke-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'site-dot',
        type: 'circle',
        source: 'site',
        paint: { 'circle-radius': 4, 'circle-color': '#4db8ff' },
      });

      syncLayers(map, useStore.getState().layers);
    });

    map.on('click', (e) => {
      // Station clicks open their popup instead of selecting a site.
      const hits = map.queryRenderedFeatures(e.point, { layers: map.getLayer('stations') ? ['stations'] : [] });
      if (hits.length > 0) return;
      void useStore.getState().selectSite(e.lngLat.lat, e.lngLat.lng);
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      const v = { lon: c.lng, lat: c.lat, zoom: map.getZoom() };
      useStore.getState().setView(v);
      history.replaceState(null, '', `#${v.zoom.toFixed(2)}/${v.lat.toFixed(4)}/${v.lon.toFixed(4)}`);
    });

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---------------- reactive wiring ----------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded()) syncLayers(map, layers);
    else map.once('idle', () => syncLayers(map, layers));
  }, [layers]);

  useEffect(() => {
    if (!flyTo || !mapRef.current) return;
    mapRef.current.flyTo({
      center: [flyTo.lon, flyTo.lat],
      zoom: flyTo.zoom,
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1400,
    });
  }, [flyTo]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource('site') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: site
        ? [
            {
              type: 'Feature',
              geometry: {
                type: 'Point',
                coordinates: [site.reach.point.lon, site.reach.point.lat],
              },
              properties: {},
            },
          ]
        : [],
    });
  }, [site]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#07171d]">
      {/* h-full, not absolute: maplibre-gl.css forces position:relative on the
          container, which zeroes an inset-based height. */}
      <div ref={mapEl} className="h-full w-full" />

      {/* Layers control */}
      <div className="absolute left-2.5 top-2.5 z-10 w-52 rounded-lg border border-line bg-panel/95 shadow-[0_10px_30px_rgba(0,0,0,0.45)] backdrop-blur">
        <button
          type="button"
          onClick={() => setLayersOpen((o) => !o)}
          className="flex w-full items-center justify-between px-2.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted hover:text-ink"
        >
          Layers
          <span className="text-faint">{layersOpen ? '−' : '+'}</span>
        </button>
        {layersOpen && (
          <div className="border-t border-line px-2.5 py-1.5">
            {LAYER_DEFS.map((l) => (
              <label
                key={l.key}
                className="flex cursor-pointer items-center gap-2 py-1 text-[12px] text-ink"
              >
                <input
                  type="checkbox"
                  checked={layers[l.key]}
                  onChange={() => toggleLayer(l.key)}
                  className="size-3 accent-[#4db8ff]"
                />
                <span className="flex-1">{l.label}</span>
              </label>
            ))}
            <div className="mt-1.5 border-t border-line pt-1.5">
              {ROADMAP_LAYERS.map((name) => (
                <div key={name} className="flex items-center gap-2 py-0.5 text-[11px] text-faint">
                  <span className="size-3 rounded-sm border border-line" />
                  <span className="flex-1">{name}</span>
                  <span className="rounded bg-panel-3 px-1 text-[9px] uppercase text-faint">M1</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {siteBusy && (
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-line bg-panel/95 px-3 py-1 text-[11px] text-muted">
          Resolving river reach…
        </div>
      )}
    </div>
  );
}

function syncLayers(map: maplibregl.Map, layers: Record<LayerKey, boolean>) {
  const set = (id: string, on: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  };
  set('hillshade', layers.hillshade);
  set('rivers', layers.rivers);
  set('satellite', layers.satellite);
  set('stations', layers.stations);
}
