/**
 * Nepal's surveyed contours, laid under the site.
 *
 * The app's terrain is a 30 m global DEM carrying about ±15 m of vertical
 * error, and head is the second-largest uncertainty in the whole estimate.
 * Nepal's 1:25,000 sheets carry contours and spot heights that were surveyed on
 * the ground at roughly 2 m per pixel. Putting one under the intake is how an
 * engineer stops taking this app's word for the terrain.
 *
 * WHAT IS AND IS NOT COVERED, stated plainly because it is uneven. Of 691
 * scans, only 40 carry a world file, and only those are placed here. The rest
 * are perfectly good maps with no georeferencing, and they are NOT positioned
 * by guesswork: their sheet numbers imply a neat-line, but measuring the 40
 * known scans against their own neat-lines showed the collar varying by up to
 * 1.9 km. Extrapolating that would slide a 2 m map kilometres across a valley,
 * which is worse than showing nothing. The sheet index still names the right
 * sheet to order everywhere in Nepal — see src/local-gis.ts.
 *
 * Each scan is added as a MapLibre `image` source, which takes four corners and
 * handles the rotation itself. The sheets are not axis-aligned, so a bounding
 * box would shear them.
 */
import type maplibregl from 'maplibre-gl';

type TopoSheet = {
  /** File name, served by the dev-server route in vite.config.ts. */
  f: string;
  n: string;
  /** Corners as [lon, lat]: top-left, top-right, bottom-right, bottom-left. */
  c: [[number, number], [number, number], [number, number], [number, number]];
  /** [south, west, north, east] for cheap visibility tests. */
  b: [number, number, number, number];
};

/**
 * Below this the sheets are unreadable anyway and would only cost bandwidth —
 * each scan is around 10 MB. At z13 a single sheet spans the screen.
 */
const MIN_ZOOM = 12;

/** A cap on how many 10 MB scans may be resident at once. */
const MAX_ACTIVE = 4;

let sheets: TopoSheet[] | null = null;
let loading: Promise<TopoSheet[]> | null = null;

function load(): Promise<TopoSheet[]> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}local/topo-index.json`);
      if (!r.ok) return [];
      const j = (await r.json()) as { sheets?: TopoSheet[] };
      return j.sheets ?? [];
    } catch {
      return [];
    }
  })().then((s) => (sheets = s));
  return loading;
}

/** Whether any sheet is placed at all — the panel uses this to offer the toggle. */
export async function topoAvailable(): Promise<number> {
  return (await load()).length;
}

const srcId = (n: string) => `topo-${n.replace(/[^a-z0-9]+/gi, '-')}`;
const active = new Set<string>();

function removeAll(map: maplibregl.Map) {
  for (const id of active) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
  active.clear();
}

/**
 * Show the sheets covering the current view, and drop the ones that left it.
 *
 * Called on every map move, so it must be cheap and idempotent: it diffs the
 * wanted set against what is already on the map and touches only the
 * difference. Re-adding an existing source would make MapLibre refetch 10 MB.
 */
export async function syncTopoOverlay(
  map: maplibregl.Map,
  enabled: boolean,
  opacity = 0.85
): Promise<void> {
  const all = sheets ?? (await load());
  if (!all.length) return;

  if (!enabled || map.getZoom() < MIN_ZOOM) {
    removeAll(map);
    return;
  }

  const b = map.getBounds();
  const s = b.getSouth();
  const w = b.getWest();
  const n = b.getNorth();
  const e = b.getEast();

  const cx = (s + n) / 2;
  const cy = (w + e) / 2;
  const wanted = all
    .filter((t) => t.b[0] <= n && t.b[2] >= s && t.b[1] <= e && t.b[3] >= w)
    // Nearest to the centre first, so the cap keeps what the eye is on.
    .sort(
      (p, q) =>
        Math.hypot((p.b[0] + p.b[2]) / 2 - cx, (p.b[1] + p.b[3]) / 2 - cy) -
        Math.hypot((q.b[0] + q.b[2]) / 2 - cx, (q.b[1] + q.b[3]) / 2 - cy)
    )
    .slice(0, MAX_ACTIVE);

  const keep = new Set(wanted.map((t) => srcId(t.n)));
  for (const id of [...active]) {
    if (keep.has(id)) continue;
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    active.delete(id);
  }

  for (const t of wanted) {
    const id = srcId(t.n);
    if (active.has(id)) {
      map.setPaintProperty(id, 'raster-opacity', opacity);
      continue;
    }
    map.addSource(id, {
      type: 'image',
      url: `/topo/${encodeURIComponent(t.f)}`,
      coordinates: t.c,
    });
    map.addLayer({
      id,
      type: 'raster',
      source: id,
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': 200 },
    });
    active.add(id);
    // Keep every vector layer above the scan — the whole point is to read the
    // river and the scheme against surveyed contours, not to bury them.
    // report-ends-* are added to the style BEFORE the three scheme layers, so a
    // list naming only those still slid the scan above the INTAKE and
    // POWERHOUSE markers and the exported figure lost them. Lowest first.
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

/** Sheets currently drawn, for the panel to name. */
export const activeTopoSheets = (): string[] =>
  [...active].map((id) => id.replace(/^topo-/, '').replace(/-/g, ' '));
