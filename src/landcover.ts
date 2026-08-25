/**
 * What the alignment actually crosses.
 *
 * HydroRecon could describe a scheme's hydrology, terrain, geology, hazards, grid
 * and licence neighbours, and could not say what the waterway runs THROUGH. In
 * Nepal that is not cosmetic. A headrace across national forest triggers forest
 * clearance and compensatory plantation under the Forest Act; cropland triggers
 * acquisition and compensation; a built-up crossing raises resettlement. Those
 * are among the slowest consents a run-of-river project waits on, and they are
 * decided by ground the app already knows the coordinates of.
 *
 * The store is ESA WorldCover 2021 at 10 m, reduced to 30 m by the mode of each
 * 3x3 block and cut to Nepal — see pipeline/build-worldcover-nepal.py. This
 * module reads one window covering the scheme and samples it along the line, so
 * a screen costs a single request of a few tens of kilobytes rather than a
 * point query per vertex.
 *
 * TWO LIMITS, BOTH LOAD-BEARING.
 *
 * COVER IS NOT TENURE. "Tree cover" does not distinguish national forest from
 * community forest from a private woodlot, and in Nepal those carry different
 * consents, different authorities and different compensation. This screen says
 * a forest consent is in play; it cannot say which one, and nothing here should
 * be read as saying the land is available.
 *
 * A LINE IS NOT A FOOTPRINT. What is measured is the centreline. A real
 * headrace has a right of way, spoil disposal, an access track and a portal
 * yard, all of which take more ground than the line and none of which is sited
 * yet at screening. The forest figure is therefore a floor.
 */

/** Codes that carry a distinct consent, so callers do not scatter magic numbers. */
export const TREE_COVER = 10;
export const BUILT_UP = 50;
export const CROPLAND = 40;
export const PERMANENT_WATER = 80;

export type LandcoverMeta = {
  rows: number;
  cols: number;
  pixelDeg: number;
  west: number;
  north: number;
  east: number;
  south: number;
  nodata: number;
  cellM: number;
  nativeM: number;
  classes: Record<string, string>;
  _source: string;
  _limitation: string;
};

export type LandcoverSpan = {
  code: number;
  label: string;
  km: number;
  /** Share of the sampled alignment, 0..1. */
  share: number;
};

export type LandcoverScreen = {
  /** Length actually sampled, which is the waterway length. */
  waterwayKm: number;
  /** Every class the line touches, longest first. */
  along: LandcoverSpan[];
  /** Cover at the two ends, where the structures go. */
  intake: string | null;
  powerhouse: string | null;
  /** Share of the line that fell on no-data, normally zero inside Nepal. */
  unknownShare: number;
  cellM: number;
  source: string;
  limitation: string;
};

type Point = { lat: number; lon: number };

/**
 * One sample per cell. Sampling finer than the raster does not buy resolution,
 * and sampling coarser walks past whole patches of forest.
 */
const STEP_KM = 0.03;

/** Matches the dev-server route's own cap; a corridor is far below it. */
const MAX_WINDOW_CELLS = 4_000_000;

let meta: LandcoverMeta | null = null;
let loading: Promise<LandcoverMeta | null> | null = null;

/** Load once. A 404 is the expected answer where the store was never built. */
export function loadLandcoverMeta(): Promise<LandcoverMeta | null> {
  loading ??= (async () => {
    try {
      const r = await fetch('/worldcover/meta');
      if (!r.ok) return null;
      const j = (await r.json()) as LandcoverMeta;
      return j.rows > 0 && j.cols > 0 ? j : null;
    } catch {
      return null;
    }
  })().then((v) => (meta = v));
  return loading;
}

const R = 6371;
function km(a: Point, b: Point): number {
  const p = Math.PI / 180;
  const dLat = (b.lat - a.lat) * p;
  const dLon = (b.lon - a.lon) * p;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Land cover along a polyline.
 *
 * Returns null where the store is absent — a production build, or a site
 * outside Nepal — which callers must treat as "not screened", never as "no
 * forest". The two look identical in a summary and only one of them is safe.
 */
export async function screenLandcover(
  path: readonly Point[]
): Promise<LandcoverScreen | null> {
  const m = meta ?? (await loadLandcoverMeta());
  if (!m || path.length < 2) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of path) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  if (maxLat < m.south || minLat > m.north || maxLon < m.west || minLon > m.east) return null;

  // One cell of margin so a sample on the boundary still lands inside.
  const row0 = Math.max(0, Math.floor((m.north - maxLat) / m.pixelDeg) - 1);
  const row1 = Math.min(m.rows, Math.ceil((m.north - minLat) / m.pixelDeg) + 1);
  const col0 = Math.max(0, Math.floor((minLon - m.west) / m.pixelDeg) - 1);
  const col1 = Math.min(m.cols, Math.ceil((maxLon - m.west) / m.pixelDeg) + 1);
  const rows = row1 - row0;
  const cols = col1 - col0;
  if (rows <= 0 || cols <= 0 || rows * cols > MAX_WINDOW_CELLS) return null;

  let cells: Uint8Array;
  try {
    const r = await fetch(`/worldcover/window?row0=${row0}&col0=${col0}&rows=${rows}&cols=${cols}`);
    if (!r.ok) return null;
    cells = new Uint8Array(await r.arrayBuffer());
    if (cells.length !== rows * cols) return null;
  } catch {
    return null;
  }

  const at = (lat: number, lon: number): number => {
    const r = Math.floor((m.north - lat) / m.pixelDeg) - row0;
    const c = Math.floor((lon - m.west) / m.pixelDeg) - col0;
    if (r < 0 || r >= rows || c < 0 || c >= cols) return m.nodata;
    return cells[r * cols + c];
  };
  const label = (code: number) => m.classes[String(code)] ?? `Class ${code}`;

  const byCode = new Map<number, number>();
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const segKm = km(a, b);
    if (!(segKm > 0)) continue;
    const steps = Math.max(1, Math.round(segKm / STEP_KM));
    const dk = segKm / steps;
    for (let s = 0; s < steps; s++) {
      // Midpoint of the step, so a sample is never taken exactly on a vertex
      // where two segments would both claim it.
      const t = (s + 0.5) / steps;
      const code = at(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t);
      byCode.set(code, (byCode.get(code) ?? 0) + dk);
      total += dk;
    }
  }
  if (!(total > 0)) return null;

  const unknown = byCode.get(m.nodata) ?? 0;
  byCode.delete(m.nodata);
  const along = [...byCode.entries()]
    .map(([code, k]) => ({ code, label: label(code), km: k, share: k / total }))
    .sort((x, y) => y.km - x.km);

  const head = path[0];
  const tail = path[path.length - 1];
  const ends = (p: Point) => {
    const code = at(p.lat, p.lon);
    return code === m.nodata ? null : label(code);
  };

  return {
    waterwayKm: total,
    along,
    intake: ends(head),
    powerhouse: ends(tail),
    unknownShare: unknown / total,
    cellM: m.cellM,
    source: m._source,
    limitation: m._limitation,
  };
}
