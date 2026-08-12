import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { useStore } from '../state/store.ts';

/**
 * Cesium 3D scene — keyless by construction. Terrain: Re:Earth quantized-mesh
 * (global, CORS ✓, CC-BY — verified in docs/research/2026-08-12-stack.md);
 * imagery: Esri World Imagery. No ion token anywhere. Loaded lazily: this module
 * (and Cesium's ~1.7 MB gz) only arrives when the user enters 3D.
 */

/** MapLibre zoom → camera height. Rough but good enough to land in the same valley. */
function heightForZoom(zoom: number): number {
  return 40_000_000 / 2 ** zoom;
}

export default function Scene3D() {
  const el = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const site = useStore((s) => s.site);

  useEffect(() => {
    if (!el.current || viewerRef.current) return;
    let dead = false;

    (async () => {
      try {
        const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
          'https://terrain.reearth.land/cesium-mesh/ellipsoid',
          { credit: 'Re:Earth Terrain · Mapterhorn (CC BY 4.0)' }
        );
        if (dead || !el.current) return;

        const viewer = new Cesium.Viewer(el.current, {
          terrainProvider,
          baseLayer: new Cesium.ImageryLayer(
            new Cesium.UrlTemplateImageryProvider({
              url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
              credit: 'Imagery: Esri World Imagery',
              maximumLevel: 18,
            })
          ),
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
        });
        viewerRef.current = viewer;
        viewer.scene.globe.depthTestAgainstTerrain = true;

        const { view } = useStore.getState();
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(
            view.lon,
            view.lat - 0.22,
            Math.max(3200, heightForZoom(view.zoom))
          ),
          orientation: {
            heading: 0,
            pitch: Cesium.Math.toRadians(-32),
            roll: 0,
          },
        });
        setStatus('ready');
      } catch (e) {
        if (!dead) {
          setStatus('error');
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      dead = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  // Selected site as a pin in the 3D scene.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    viewer.entities.removeAll();
    if (!site) return;
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(site.reach.point.lon, site.reach.point.lat),
      point: {
        pixelSize: 9,
        color: Cesium.Color.fromCssColorString('#4db8ff'),
        outlineColor: Cesium.Color.fromCssColorString('#e6edf3'),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `river reach · ${site.reach.uplandKm2.toLocaleString()} km²`,
        font: '11px sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#e6edf3'),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#10161d').withAlpha(0.85),
        pixelOffset: new Cesium.Cartesian2(0, -18),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }, [site, status]);

  return (
    <div className="relative h-full w-full bg-[#07171d]">
      <div ref={el} className="absolute inset-0 [&_.cesium-viewer-bottom]:opacity-70" />
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg/70">
          <div className="rounded-lg border border-line bg-panel px-4 py-2.5 text-[12px] text-muted">
            Loading 3D terrain — Re:Earth quantized mesh…
          </div>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <div className="max-w-sm rounded-lg border border-red/40 bg-panel px-4 py-3 text-[12px] leading-relaxed text-muted">
            <div className="mb-1 font-semibold text-red">3D terrain failed to load</div>
            {error}
            <div className="mt-1.5 text-faint">
              Re:Earth Terrain is a best-effort public service. The fallback provider
              (cesium-martini over AWS tiles) lands in M4.
            </div>
          </div>
        </div>
      )}
      <div className="absolute bottom-8 left-2.5 z-10 rounded border border-line bg-panel/90 px-2 py-1 text-[10px] text-faint">
        Underground mode + scheme geometry land in M4 (Globe.translucency).
      </div>
    </div>
  );
}
