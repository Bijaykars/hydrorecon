/**
 * Every request here goes straight from the visitor's browser to a public API.
 * No backend, no key, no proxy. Both endpoints had their `access-control-allow-origin`
 * verified with real requests — see docs/research/PHASE1-REPORT.md.
 *
 * Both work anywhere on Earth. Nothing in this file is region-specific.
 */
import { haversineKm } from './engine/hydro.ts';

// ---------------------------------------------------------------------------
// Discharge — GloFAS v4 via Open-Meteo. Global, keyless, m³/s, ACAO: *
// ---------------------------------------------------------------------------

/**
 * 20 complete calendar years. Open-Meteo bills long ranges as many
 * request-equivalents, so asking for everything on every click needlessly burns
 * the shared free quota. 20 years still spans several wet/dry cycles, and the
 * period is immutable so it caches perfectly.
 */
const MODEL = 'consolidated_v4';
const LAST_COMPLETE_YEAR = new Date().getUTCFullYear() - 1;
export const GLOFAS_START = `${LAST_COMPLETE_YEAR - 19}-01-01`;
export const GLOFAS_END = `${LAST_COMPLETE_YEAR}-12-31`;

const CACHE_PREFIX = 'ghatta:glofas:v1:';
const CACHE_INDEX = `${CACHE_PREFIX}index`;
const COOLDOWN_KEY = `${CACHE_PREFIX}cooldown`;
const CACHE_MAX = 12;
const CACHE_TTL_MS = 180 * 864e5;
const inFlight = new Map<string, Promise<DischargeSeries>>();

/** GloFAS is a 0.05° grid; quantizing to it makes the cache actually hit. */
const CELL_DEG = 0.05;
const quantize = (lat: number, lon: number) => ({
  lat: Math.round(lat / CELL_DEG) * CELL_DEG,
  lon: Math.round(lon / CELL_DEG) * CELL_DEG,
});

type Stored = { savedAt: number; data: DischargeSeries };

function readStored(key: string): Stored | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, data: DischargeSeries) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), data }));
    const prior = JSON.parse(localStorage.getItem(CACHE_INDEX) ?? '[]') as string[];
    const next = [key, ...prior.filter((k) => k !== key)].slice(0, CACHE_MAX);
    localStorage.setItem(CACHE_INDEX, JSON.stringify(next));
    for (const old of prior) if (!next.includes(old)) localStorage.removeItem(CACHE_PREFIX + old);
  } catch {
    // Storage can be full or disabled. The analysis still works; it just will
    // not survive a reload.
  }
}

function cooldownUntil(): number {
  try {
    return Number(localStorage.getItem(COOLDOWN_KEY) ?? 0);
  } catch {
    return 0;
  }
}

const cooldownMessage = (retryAt: number) =>
  `Open-Meteo asked us to pause for about ${Math.max(1, Math.ceil((retryAt - Date.now()) / 60000))} min ` +
  `— it is a shared free service. Head and terrain still work.`;

export type DischargeSeries = {
  dates: string[];
  /** m³/s, nulls dropped. */
  values: number[];
  /** The grid cell the model actually used — not the point you clicked. */
  cell: { lat: number; lon: number };
  elevationM: number;
  from: 'network' | 'cache' | 'stale-cache';
};

export async function fetchDischarge(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<DischargeSeries> {
  const cell = quantize(lat, lon);
  const key = `${cell.lat.toFixed(2)},${cell.lon.toFixed(2)}`;
  const stored = readStored(key);
  if (stored && Date.now() - stored.savedAt < CACHE_TTL_MS) {
    return { ...stored.data, from: 'cache' };
  }

  const cooldown = cooldownUntil();
  if (cooldown > Date.now()) {
    if (stored) return { ...stored.data, from: 'stale-cache' };
    throw new Error(cooldownMessage(cooldown));
  }

  const running = inFlight.get(key);
  if (running) return running;

  const request = (async (): Promise<DischargeSeries> => {
    const base =
      `https://flood-api.open-meteo.com/v1/flood?latitude=${cell.lat.toFixed(4)}` +
      `&longitude=${cell.lon.toFixed(4)}&daily=river_discharge` +
      `&start_date=${GLOFAS_START}&end_date=${GLOFAS_END}`;
    // The reanalysis product, not the forecast blend, for a historical record.
    // Open-Meteo has renamed these before (`glofas_v4_consolidated` was retired),
    // so a rejected model name falls back to the service default rather than
    // taking the whole app down.
    let res = await fetch(`${base}&models=${MODEL}`, { signal });
    if (res.status === 400) res = await fetch(base, { signal });

    if (res.status === 429) {
      const body = await res.text().catch(() => '');
      const header = res.headers.get('retry-after');
      const seconds = Number(header);
      const asDate = header ? Date.parse(header) : NaN;
      const now = new Date();
      // A daily-quota rejection lasts until UTC midnight; a burst limit is short.
      const retryAt = /daily/i.test(body)
        ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5)
        : Date.now() +
          (Number.isFinite(seconds) && seconds > 0
            ? seconds * 1000
            : Number.isFinite(asDate) && asDate > Date.now()
              ? asDate - Date.now()
              : 15 * 60000);
      try {
        localStorage.setItem(COOLDOWN_KEY, String(retryAt));
      } catch {
        /* private browsing */
      }
      if (stored) return { ...stored.data, from: 'stale-cache' };
      throw new Error(cooldownMessage(retryAt));
    }
    if (!res.ok) throw new Error(`Flow history unavailable (HTTP ${res.status}).`);

    const j = (await res.json()) as {
      latitude: number;
      longitude: number;
      elevation: number;
      daily: { time: string[]; river_discharge: (number | null)[] };
    };
    const dates: string[] = [];
    const values: number[] = [];
    for (let i = 0; i < j.daily.time.length; i++) {
      const v = j.daily.river_discharge[i];
      if (v === null || v === undefined) continue;
      dates.push(j.daily.time[i]);
      values.push(v);
    }
    if (values.length === 0) {
      throw new Error('The flood model has no river at this point — try a larger channel.');
    }
    const data: DischargeSeries = {
      dates,
      values,
      cell: { lat: j.latitude, lon: j.longitude },
      elevationM: j.elevation,
      from: 'network',
    };
    writeStored(key, data);
    return data;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

/**
 * Mean flow in the eight neighbouring model cells.
 *
 * Why this exists: the model grid is ~5 km, so a cell next door can be off the
 * channel entirely. Measured on the Potomac: 408 m³/s on the main stem against
 * 6 m³/s four kilometres away. Only run on request — it costs 8 requests.
 */
export async function probeNeighbours(
  lat: number,
  lon: number
): Promise<{ lat: number; lon: number; meanCms: number }[]> {
  const out: { lat: number; lon: number; meanCms: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      try {
        const s = await fetchDischarge(lat + dy * CELL_DEG, lon + dx * CELL_DEG);
        out.push({
          lat: s.cell.lat,
          lon: s.cell.lon,
          meanCms: s.values.reduce((a, b) => a + b, 0) / s.values.length,
        });
      } catch {
        // A dry or rate-limited neighbour tells us nothing; skip it.
      }
    }
  }
  return out.sort((a, b) => b.meanCms - a.meanCms);
}

// ---------------------------------------------------------------------------
// Terrain — Terrarium DEM tiles decoded in the browser.
// O(tiles), not O(points): once tiles are cached, sampling more points is free.
// ---------------------------------------------------------------------------

/**
 * Best first. Re:Earth (Mapterhorn) serves 512 px tiles to z17; AWS stops at z15
 * and 404s past it. Gross head is the most error-sensitive input in the whole
 * estimate, so the finer source is worth the bytes.
 */
const DEM_SOURCES = [
  {
    id: 'Re:Earth Mapterhorn',
    url: (z: number, x: number, y: number) =>
      `https://terrain.reearth.land/terrarium/elevation/${z}/${x}/${y}.png`,
    tilePx: 512,
    maxZoom: 17,
  },
  {
    id: 'AWS Terrain Tiles',
    url: (z: number, x: number, y: number) =>
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    tilePx: 256,
    maxZoom: 15,
  },
] as const;

/** Never fetch more than this many DEM tiles for one profile. */
const TILE_BUDGET = 12;

const tileCache = new Map<string, Promise<ImageData | null>>();

const lonToTileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToTileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

function loadTile(
  src: (typeof DEM_SOURCES)[number],
  z: number,
  x: number,
  y: number
): Promise<ImageData | null> {
  const key = `${src.id}/${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const p = new Promise<ImageData | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // both sources send ACAO:*, so the canvas stays readable
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0);
      try {
        resolve(ctx.getImageData(0, 0, c.width, c.height));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src.url(z, x, y);
  });
  tileCache.set(key, p);
  return p;
}

export type ProfilePoint = { distanceKm: number; elevationM: number; lat: number; lon: number };

export type ElevationProfile = {
  points: ProfilePoint[];
  /** Which DEM answered, so the UI can say how much to trust the head. */
  source: string;
  zoom: number;
  /** Ground sample distance of the tiles actually used, metres. */
  resolutionM: number;
  tilesFetched: number;
};

/** Highest zoom whose tile count still fits the budget for this line. */
function pickZoom(
  src: (typeof DEM_SOURCES)[number],
  from: [number, number],
  to: [number, number]
): number {
  for (let z = src.maxZoom; z >= 8; z--) {
    const xs = [lonToTileX(from[1], z), lonToTileX(to[1], z)];
    const ys = [latToTileY(from[0], z), latToTileY(to[0], z)];
    const nx = Math.floor(Math.max(...xs)) - Math.floor(Math.min(...xs)) + 1;
    const ny = Math.floor(Math.max(...ys)) - Math.floor(Math.min(...ys)) + 1;
    if (nx * ny <= TILE_BUDGET) return z;
  }
  return 8;
}

const groundResolution = (z: number, tilePx: number, lat: number) =>
  (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (2 ** z * tilePx);

/** Terrarium decode of one pixel: elev_m = (R*256 + G + B/256) - 32768. */
function decodePixel(img: ImageData, px: number, py: number): number {
  const x = Math.min(img.width - 1, Math.max(0, px));
  const y = Math.min(img.height - 1, Math.max(0, py));
  const o = (y * img.width + x) * 4;
  return img.data[o] * 256 + img.data[o + 1] + img.data[o + 2] / 256 - 32768;
}

/**
 * Bilinear sample at fractional tile coordinates.
 *
 * Nearest-neighbour was measured to shift the head by a whole grid cell (2 m in
 * 180 m) depending on which side of a pixel boundary the endpoint fell — the
 * same two points could read 179 m or 181 m. Head is the most error-sensitive
 * input in the estimate, so it gets interpolated. Edge pixels clamp inside the
 * tile rather than reaching into the neighbour: bounded, and only at seams.
 */
function sampleBilinear(img: ImageData, u: number, v: number): number {
  const fx = u * img.width - 0.5;
  const fy = v * img.height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const top = decodePixel(img, x0, y0) * (1 - tx) + decodePixel(img, x0 + 1, y0) * tx;
  const bot = decodePixel(img, x0, y0 + 1) * (1 - tx) + decodePixel(img, x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bot * ty;
}

/**
 * Elevation along the straight line between two points.
 * Terrarium decode: elev_m = (R * 256 + G + B / 256) - 32768.
 */
export async function fetchProfile(
  from: [number, number],
  to: [number, number],
  samples = 140
): Promise<ElevationProfile> {
  const total = haversineKm(from, to);
  const pts = Array.from({ length: samples }, (_, i) => {
    const t = i / (samples - 1);
    return {
      lat: from[0] + t * (to[0] - from[0]),
      lon: from[1] + t * (to[1] - from[1]),
      distanceKm: t * total,
    };
  });

  for (const src of DEM_SOURCES) {
    const zoom = pickZoom(src, from, to);
    const needed = new Set<string>();
    for (const p of pts) {
      needed.add(`${Math.floor(lonToTileX(p.lon, zoom))}/${Math.floor(latToTileY(p.lat, zoom))}`);
    }
    const tiles = new Map<string, ImageData | null>();
    await Promise.all(
      [...needed].map(async (k) => {
        const [x, y] = k.split('/').map(Number);
        tiles.set(k, await loadTile(src, zoom, x, y));
      })
    );
    if ([...tiles.values()].every((t) => t === null)) continue; // no coverage — try the next source

    const points = pts.map((p) => {
      const fx = lonToTileX(p.lon, zoom);
      const fy = latToTileY(p.lat, zoom);
      const img = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
      return { ...p, elevationM: img ? sampleBilinear(img, fx % 1, fy % 1) : NaN };
    });
    if (points.every((p) => !Number.isFinite(p.elevationM))) continue;

    return {
      points,
      source: src.id,
      zoom,
      resolutionM: groundResolution(zoom, src.tilePx, from[0]),
      tilesFetched: needed.size,
    };
  }
  throw new Error('No terrain data covers this location.');
}
