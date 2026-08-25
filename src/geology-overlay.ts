/**
 * Nepal's published geological maps, laid under the site.
 *
 * The engineering-geology screen had one live source, Macrostrat, and over
 * Nepal it carries a single polygon: "Precambrian-Phanerozoic sedimentary
 * rocks", 443-1000 Ma, identical at intake, mid-reach and powerhouse. That is
 * not an engineering input. The Department of Mines and Geology publishes a
 * 1:350,000 geological map per province — mapped units, thrusts, fold axes,
 * bedding attitudes — and pipeline/build-dmg-geology.py cuts those into tiles.
 *
 * Each tile is a MapLibre `image` source placed by four corners rather than a
 * bounding box, because the sheets are conic: meridians converge, so a page
 * rectangle is a slightly sheared quadrilateral on the ground and a box would
 * stretch it. topo-overlay.ts hangs the survey scans the same way and for the
 * same reason.
 *
 * WHAT IS NOT COVERED. Karnali is absent. Its graticule fit came out at 7.2 pt,
 * past the threshold the builder enforces, so it is dropped rather than placed
 * a kilometre out.
 *
 * HOW ACCURATE THE REST ARE, measured rather than assumed. The builder's own
 * graticule residual is a SELF-check and cannot detect a sheet read correctly
 * but placed wrongly. checks/geology-georeference.py answers it independently:
 * it reads the spot heights printed on each sheet, samples a 30 m elevation
 * model at each, and searches for the shift that makes them agree best. A sheet
 * hung correctly optimises at zero. Measured — Bagmati and Gandaki 0.25 km,
 * Koshi 0.35 km, Sudurpaschim 0.50 km, Lumbini 1.12 km. The first three sit at
 * the search step, so they are "at or below", not "exactly". Lumbini is the one
 * to distrust.
 *
 * `placementKm` on a sheet is that measured figure, so anything quoting this
 * overlay quotes what was measured and not what was hoped.
 */
import type maplibregl from 'maplibre-gl';

type GeologyTile = {
  /** File name, served by the dev-server route in vite.config.ts. */
  f: string;
  /** Province sheet it came from. */
  p: string;
  /** Corners as [lon, lat]: top-left, top-right, bottom-right, bottom-left. */
  c: [[number, number], [number, number], [number, number], [number, number]];
  /** [south, west, north, east] for cheap visibility tests. */
  b: [number, number, number, number];
};

export type GeologyIndex = {
  tiles: GeologyTile[];
  /** Graticule self-check, in metres. Internal consistency only. */
  accuracy: Record<string, { residualM: number }>;
  /** Independently measured placement error, in km. The one to quote. */
  placement: Record<string, number>;
  scale: string;
};

/**
 * Below this a 1:350,000 sheet is smaller than the screen pixel it lands on and
 * the country's own basemap says more. Above it the units start to separate.
 */
const MIN_ZOOM = 9;

/**
 * How many tiles may be resident. Each is a few hundred kilobytes.
 *
 * Twelve is right for panning: the store is local, but a browser holding fifty
 * image sources for a map nobody is looking at is still waste. It is NOT right
 * for the report capture, which frames sixty kilometres deliberately and needs
 * the whole rectangle covered — at twelve the bottom row of tiles never
 * arrived and the printed figure had a blank strip across it. Hence the
 * argument on syncGeologyOverlay rather than a bigger constant for everyone.
 */
const MAX_ACTIVE = 12;

let index: GeologyIndex | null = null;
let loading: Promise<GeologyIndex | null> | null = null;
const active = new Set<string>();

/**
 * Which call is allowed to touch the map.
 *
 * This function awaits the index before it does anything, so two calls can be
 * in flight at once and finish out of order. That is not hypothetical: on
 * mount the effect calls sync(false) while the index is still downloading, the
 * user toggles the layer on, sync(true) resolves first and adds the tiles, and
 * then the stale sync(false) resolves and removes them again. The layer read as
 * broken while every individual piece worked.
 *
 * A monotonic ticket fixes it: after the await, a call that is no longer the
 * newest returns without touching anything.
 */
let ticket = 0;

// `dmg-sheet-`, not `geology-`: the app already owns geology-sheet-fill,
// geology-sheet-lines and geology-sheet-labels for the DMG coverage index,
// and sharing a prefix made a layer count ambiguous the first time it was
// checked.
const srcId = (f: string) => `dmg-sheet-${f.replace(/\W+/g, '-')}`;

/** Load once. A 404 is the expected answer where the tiles were never built. */
export function loadGeologyIndex(): Promise<GeologyIndex | null> {
  loading ??= (async () => {
    try {
      const r = await fetch('/geology/index.json');
      if (!r.ok) return null;
      const j = (await r.json()) as {
        tiles?: GeologyTile[];
        _accuracy?: Record<string, { residualM: number }>;
        _scale?: string;
      };
      if (!j.tiles?.length) return null;
      // Written by the check, not the builder, and absent until it has run.
      const placement: Record<string, number> = {};
      try {
        const pr = await fetch('/geology/placement.json');
        if (pr.ok) {
          const pj = (await pr.json()) as { sheets?: Record<string, { placementKm?: number }> };
          for (const [k, v] of Object.entries(pj.sheets ?? {})) {
            if (typeof v.placementKm === 'number') placement[k] = v.placementKm;
          }
        }
      } catch {
        /* unmeasured is a valid state; it just cannot be quoted */
      }
      return {
        tiles: j.tiles,
        accuracy: j._accuracy ?? {},
        placement,
        scale: j._scale ?? '1:350,000',
      };
    } catch {
      return null;
    }
  })().then((v) => (index = v));
  return loading;
}

function removeAll(map: maplibregl.Map) {
  for (const id of [...active]) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    active.delete(id);
  }
}

export async function syncGeologyOverlay(
  map: maplibregl.Map,
  enabled: boolean,
  opacity = 0.78,
  maxTiles = MAX_ACTIVE
): Promise<void> {
  const mine = ++ticket;
  const idx = index ?? (await loadGeologyIndex());
  if (mine !== ticket || !idx) return;

  if (!enabled || map.getZoom() < MIN_ZOOM) {
    removeAll(map);
    return;
  }

  const b = map.getBounds();
  const s = b.getSouth();
  const w = b.getWest();
  const n = b.getNorth();
  const e = b.getEast();
  const cy = (s + n) / 2;
  const cx = (w + e) / 2;

  const wanted = idx.tiles
    .filter((t) => t.b[0] <= n && t.b[2] >= s && t.b[1] <= e && t.b[3] >= w)
    // Nearest to the centre first, so the cap keeps what the eye is on.
    .sort(
      (p, q) =>
        Math.hypot((p.b[0] + p.b[2]) / 2 - cy, (p.b[1] + p.b[3]) / 2 - cx) -
        Math.hypot((q.b[0] + q.b[2]) / 2 - cy, (q.b[1] + q.b[3]) / 2 - cx)
    )
    .slice(0, Math.max(1, maxTiles));

  const keep = new Set(wanted.map((t) => srcId(t.f)));
  for (const id of [...active]) {
    if (keep.has(id)) continue;
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    active.delete(id);
  }

  for (const t of wanted) {
    const id = srcId(t.f);
    if (active.has(id)) {
      map.setPaintProperty(id, 'raster-opacity', opacity);
      continue;
    }
    map.addSource(id, {
      type: 'image',
      url: `/geology/${encodeURIComponent(t.f)}`,
      coordinates: t.c,
    });
    map.addLayer({
      id,
      type: 'raster',
      source: id,
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': 200 },
    });
    active.add(id);
    // The scheme, the river and the markers stay above the sheet — the point is
    // to read the alignment against the geology, not to bury it.
    /**
     * THE END MARKERS HAVE TO BE IN THIS LIST TOO.
     *
     * It used to name only the three scheme layers, and report-ends-dot and
     * report-ends-label are added to the style BEFORE them — so inserting the
     * sheet below `reaches` still put it ABOVE the two markers, and the
     * exported figure lost its INTAKE and POWERHOUSE labels under the map it
     * was supposed to be read against. On a dark basemap nothing covered them
     * and the defect never showed; it took a bright printed sheet to surface it.
     *
     * The list is in style order, lowest first, so `find` returns the LOWEST
     * layer that must stay above the sheet.
     */
    const firstOverlay = [
      'report-ends-dot',
      'report-ends-label',
      'reaches',
      'scheme-glow',
      'scheme-line',
    ].find((l) => map.getLayer(l));
    if (firstOverlay) map.moveLayer(id, firstOverlay);
  }
}

/** Which sheet covers a point, and how well it is MEASURED to be placed. */
export function geologySheetAt(
  lat: number,
  lon: number
): { province: string; placementKm: number | null; scale: string } | null {
  if (!index) return null;
  const hit = index.tiles.find((t) => t.b[0] <= lat && t.b[2] >= lat && t.b[1] <= lon && t.b[3] >= lon);
  if (!hit) return null;
  return {
    province: hit.p,
    placementKm: index.placement[hit.p] ?? null,
    scale: index.scale,
  };
}
