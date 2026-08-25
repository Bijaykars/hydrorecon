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
 * Up to 20 calendar years. Open-Meteo bills long ranges as many
 * request-equivalents, so asking for everything on every click needlessly burns
 * the shared free quota. Incomplete local years are removed before use so a
 * partial season cannot bias the FDC; the remaining period caches perfectly.
 */
const MODEL = 'consolidated_v4';
const LAST_COMPLETE_YEAR = new Date().getUTCFullYear() - 1;
export const GLOFAS_START = `${LAST_COMPLETE_YEAR - 19}-01-01`;
export const GLOFAS_END = `${LAST_COMPLETE_YEAR}-12-31`;

// v2 excludes incomplete calendar years. Keeping v1 responses would silently
// reintroduce the partial-year bias this version exists to remove.
/**
 * NOT RENAMED WITH THE APP.
 *
 * This is a localStorage key holding up to 180 days of cached discharge. The
 * name changed to HydroRecon; changing this string would orphan every cached
 * series and re-fetch the lot from a free, donation-funded service that this
 * project has gone to some trouble not to hammer. The prefix is an internal
 * key, not a brand, and it stays until there is a reason to bump the version.
 */
const CACHE_PREFIX = 'ghatta:glofas:v2:';
const CACHE_INDEX = `${CACHE_PREFIX}index`;
const COOLDOWN_KEY = `${CACHE_PREFIX}cooldown`;
const CACHE_MAX = 12;
const CACHE_TTL_MS = 180 * 864e5;
const inFlight = new Map<string, Promise<DischargeSeries>>();

/** GloFAS is a 0.05° grid; quantizing to it makes the cache actually hit. */
export const CELL_DEG = 0.05;
const quantize = (lat: number, lon: number) => ({
  lat: Math.round(lat / CELL_DEG) * CELL_DEG,
  lon: Math.round(lon / CELL_DEG) * CELL_DEG,
});

/**
 * ONLY NEPAL IS FETCHED. Everywhere else is refused before a request is made.
 *
 * The discharge service is free, shared and donation-funded, and this app was
 * spending its quota on questions it had no business asking: every click
 * anywhere on Earth cost a twenty-year daily archive. Sweeping the licensed
 * plant list exhausted the day's allowance in an afternoon and earned a
 * twelve-hour pause, which stopped the measurement work outright.
 *
 * The box is the one the bundled river network covers and the one the local
 * GloFAS store was downloaded for, so this is not an arbitrary fence: outside
 * it there is no river network, no hypsometry, no rainfall and no regional
 * regression either. A flow number there was never going to be worth much.
 *
 * The cost is real and deliberate: the app's global mode no longer fetches
 * flow. Terrain, head and the scheme geometry still work anywhere. One constant
 * reverses this if that trade ever stops being worth it.
 */
const NEPAL_BOX = { west: 79.9, south: 26.2, east: 88.4, north: 30.6 };
const insideNepal = (lat: number, lon: number) =>
  lat >= NEPAL_BOX.south && lat <= NEPAL_BOX.north && lon >= NEPAL_BOX.west && lon <= NEPAL_BOX.east;

const OUTSIDE =
  'Flow data is limited to Nepal, so the shared discharge service is never asked for more ' +
  'than this tool needs. Terrain and head still work here.';

/**
 * The local GloFAS store, when the dev server is offering one.
 *
 * Open-Meteo serves GloFAS and the store IS GloFAS, downloaded from ECMWF for
 * Nepal (pipeline/fetch-glofas-nepal.py), so where both hold a cell they agree
 * and neither the developer nor the shared free service pays for the difference.
 *
 * THEY ARE NOT IDENTICAL, AND THAT WAS ASSUMED FOR A WHILE. This is the raw
 * grid and it carries nulls the served product does not: at Mistri Khola's cell
 * it holds about 90% of the days in every year, so no year cleared the 99%
 * complete-year bar and a site that had a result before the store existed began
 * reporting no river.
 *
 * AND THE MISSING DAYS ARE SEASONAL, which is why the bar must not simply be
 * lowered to admit them: 68% of January is absent from that cell, 29% of
 * December, none of the monsoon, in runs averaging ten days and reaching 39.
 * Dropping them and building a flow-duration curve removes the LOW flows
 * preferentially — overstating dry-season yield and firm energy, the dangerous
 * direction. So `hasCompleteYear` gates the store instead: a cell it covers
 * thinly falls through to the network, exactly as an uncovered cell always did.
 * The store may be cheaper than the service; it may not be worse.
 *
 * Absent in a production build, where the route does not exist — hence the
 * content check rather than a status check. A static host answers an unknown
 * path with index.html and a 200, and parsing that as a flow series would be a
 * silent, confident lie.
 */
async function localResponse(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<Response | null> {
  try {
    const res = await fetch(`/glofas?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { signal });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
    const j = await res.json();
    if (!j?.daily?.river_discharge?.length) return null;
    // Handed back as a Response so every caller below parses one shape.
    return new Response(JSON.stringify(j), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return null;
  }
}

/**
 * Does this response hold at least one substantially complete calendar year?
 *
 * Used to decide whether the local store can answer a cell at all. The store is
 * the raw ECMWF grid and carries nulls the served product fills, so a cell it
 * holds thinly must fall through to the network rather than be reported as a
 * river with no usable record.
 */
async function hasCompleteYear(res: Response): Promise<boolean> {
  try {
    const j = (await res.json()) as {
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
    return completeCalendarYears(dates, values).years.length > 0;
  } catch {
    return false;
  }
}

type Stored = { savedAt: number; data: DischargeSeries };

function readStored(key: string): Stored | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

/**
 * @param scratch A probe rather than a site the engineer asked about.
 *
 * The shape audit samples the eight neighbouring cells to see whether one of
 * them fits Nepal's seasonal regime better. That is nine entries for one
 * question, against a cache that holds twelve — so an audit used to evict very
 * nearly every site studied earlier, and each of those then had to be fetched
 * from Open-Meteo again. The cache was spending the quota it exists to save.
 *
 * Probes are still stored, because re-auditing the same site should be free.
 * They just join at the BACK of the index instead of the front, so they are the
 * first things dropped and can never push out a site someone actually studied.
 */
function writeStored(key: string, data: DischargeSeries, scratch = false) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), data }));
    const prior = JSON.parse(localStorage.getItem(CACHE_INDEX) ?? '[]') as string[];
    const rest = prior.filter((k) => k !== key);
    const next = (scratch ? [...rest, key] : [key, ...rest]).slice(0, CACHE_MAX);
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

/**
 * Keep only substantially complete calendar years from a daily record.
 *
 * The consolidated endpoint can return the requested date axis with nulls
 * before local coverage begins and after its latest update. Merely dropping
 * those nulls leaves seasonal fragments that bias the flow-duration curve.
 */
export function completeCalendarYears(
  dates: readonly string[],
  values: readonly number[],
  minCoverage = 0.99
): { dates: string[]; values: number[]; years: number[] } {
  /**
   * COMPLETENESS IS UNIQUE CALENDAR DAYS, not row count.
   *
   * Counting rows meant 365 copies of 2021-01-01 passed as a complete year with
   * coverage 1.0 and produced an annual-energy figure and interannual spread
   * from a single day's flow. Any repeated or malformed timestamp inflated the
   * count the same way, and every downstream statistic that says "complete
   * year" inherited it.
   */
  const seen = new Set<string>();
  const counts = new Map<number, number>();
  const valid: { date: string; value: number; year: number }[] = [];
  for (let i = 0; i < Math.min(dates.length, values.length); i++) {
    const value = values[i];
    const date = dates[i];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    const year = Number(date.slice(0, 4));
    if (!Number.isInteger(year) || !Number.isFinite(value)) continue;
    valid.push({ date, value, year });
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const years = [...counts.entries()]
    .filter(([year, days]) => days >= (leap(year) ? 366 : 365) * minCoverage)
    .map(([year]) => year)
    .sort((a, b) => a - b);
  const keep = new Set(years);
  const kept = valid.filter((x) => keep.has(x.year));
  return {
    dates: kept.map((x) => x.date),
    values: kept.map((x) => x.value),
    years,
  };
}

export async function fetchDischarge(
  lat: number,
  lon: number,
  signal?: AbortSignal,
  /** True for a neighbourhood probe: cached, but first in line to be evicted. */
  scratch = false
): Promise<DischargeSeries> {
  if (!insideNepal(lat, lon)) throw new Error(OUTSIDE);
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
    /**
     * The store is a SOURCE, and where it is thinner than the service it must
     * not be the last word.
     *
     * The raw ECMWF grid carries nulls the served product does not: at Mistri
     * Khola's cell the store holds about 90% of days in every year, so the 99%
     * complete-year rule rejected all twenty and the site — which had a result
     * before the store existed — began reporting no river at all. The store's
     * purpose is to spare a donation-funded service, not to answer worse than
     * it does, so a cell it cannot cover completely falls through to the
     * network exactly as an uncovered cell already did.
     */
    let local = await localResponse(cell.lat, cell.lon, signal);
    if (local && !(await hasCompleteYear(local.clone()))) local = null;
    let res = local ?? (await fetch(`${base}&models=${MODEL}`, { signal }));
    if (!local && res.status === 400) res = await fetch(base, { signal });

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
    const complete = completeCalendarYears(dates, values);
    if (complete.values.length === 0) {
      throw new Error('The flood model returned no complete calendar year at this point.');
    }
    const data: DischargeSeries = {
      dates: complete.dates,
      values: complete.values,
      cell: { lat: j.latitude, lon: j.longitude },
      elevationM: j.elevation,
      from: 'network',
    };
    writeStored(key, data, scratch);
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
        // scratch: eight probe cells must not evict the engineer's own studies
        // from a 12-entry cache. auditShape already passes this; this path did
        // not, so one probe could push three real sites out.
        const s = await fetchDischarge(lat + dy * CELL_DEG, lon + dx * CELL_DEG, undefined, true);
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

export const meanOf = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;

/**
 * The long record — GloFAS back to 1984 — for one cell, on request only.
 *
 * The default up-to-20-year request is a quota courtesy, not a statistics choice. When the
 * user asks the app to work a site harder, doubling the record is the cheapest
 * real improvement on the FDC's tails: the up-to-40-year window can hold droughts and
 * flood years the ordinary request misses. Only complete local years survive.
 * Not cached in localStorage — at ~15k
 * daily values it would evict several ordinary studies to store one.
 */
export async function fetchDischargeYears(
  lat: number,
  lon: number,
  years = 40,
  signal?: AbortSignal
): Promise<DischargeSeries> {
  if (!insideNepal(lat, lon)) throw new Error(OUTSIDE);
  const cell = quantize(lat, lon);
  const start = `${LAST_COMPLETE_YEAR - (years - 1)}-01-01`;
  const base =
    `https://flood-api.open-meteo.com/v1/flood?latitude=${cell.lat.toFixed(4)}` +
    `&longitude=${cell.lon.toFixed(4)}&daily=river_discharge` +
    `&start_date=${start}&end_date=${GLOFAS_END}`;
  /**
   * The local store holds ONE fixed window and ignores the range asked for.
   *
   * It covers 2006-2025 — about 20 years, the same span an ordinary request
   * already gets — so answering a 40-year audit from it returns exactly the
   * record the site was already using, while the completion text promised
   * deeper droughts and rarer floods. That is the audit reporting evidence it
   * did not obtain. Where the store cannot cover the request, the network can,
   * so the request goes there.
   */
  const wantsMoreThanStore = years > 20;
  const local = wantsMoreThanStore ? null : await localResponse(cell.lat, cell.lon, signal);
  let res = local ?? (await fetch(`${base}&models=${MODEL}`, { signal }));
  if (!local && res.status === 400) res = await fetch(base, { signal });
  if (res.status === 429) throw new Error('Open-Meteo asked us to pause — try the audit again in a few minutes.');
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
  if (values.length === 0) throw new Error('The flood model has no river at this point.');
  const complete = completeCalendarYears(dates, values);
  if (complete.values.length === 0) {
    throw new Error('The flood model returned no complete calendar year at this point.');
  }
  return {
    dates: complete.dates,
    values: complete.values,
    cell: { lat: j.latitude, lon: j.longitude },
    elevationM: j.elevation,
    from: 'network',
  };
}

// ---------------------------------------------------------------------------
// Terrain — Terrarium DEM tiles decoded in the browser.
// O(tiles), not O(points): once tiles are cached, sampling more points is free.
// ---------------------------------------------------------------------------

/**
 * Best first. Re:Earth (Mapterhorn) serves 512 px tiles to z17; AWS stops at z15
 * and 404s past it. Both are 30 m DEMs over Nepal, so profile sampling is capped
 * at the first zoom that actually resolves that native posting.
 */
export const TERRAIN_SOURCE_IDS = [
  'Re:Earth Mapterhorn',
  'AWS Terrain Tiles',
  'GEDTM30 bare earth',
] as const;

export type TerrainSourceId = (typeof TERRAIN_SOURCE_IDS)[number];

export const GEDTM_SOURCE_ID: TerrainSourceId = TERRAIN_SOURCE_IDS[2];

/**
 * Mapterhorn screens every site. Measured, not assumed.
 *
 * `npm run probe:dem` samples all three products at 120 shared river reaches
 * and solves for each one's own head error with the three-cornered-hat
 * estimator: Mapterhorn 2.4 m, GEDTM30 5.0 m, AWS 7.4 m. Mapterhorn and GEDTM30
 * share a Copernicus parent so the absolute metres are soft, but the order
 * between those two is not — subtracting their solutions cancels the shared
 * covariance exactly and leaves how far each sits from AWS, 7.8 m against 8.9 m.
 */
export const PRIMARY_TERRAIN_SOURCE_ID: TerrainSourceId = TERRAIN_SOURCE_IDS[0];

/**
 * Which two products cross-check a site — GEDTM30 second where it exists.
 *
 * AWS held this slot and lost it on measurement. Against the same 120 reaches
 * every pair involving AWS carries an RMSE near 86 m against a sigma under 9,
 * while the one pair that excludes it runs RMSE 6.9 m against sigma 5.6 m. The
 * catastrophic disagreements this project has always attributed to "voids and
 * gorge artifacts" are AWS's voids specifically; the GEDTM30 Nepal cut has
 * 100% coverage and none. A second opinion whose own error is smaller and whose
 * tail is absent is a better second opinion.
 *
 * It does NOT change any headline number. The primary stays Mapterhorn, so the
 * area, storage and head a site reports are the same either way; what changes
 * is the spread quoted beside them, which is now measuring terrain rather than
 * measuring AWS's dropouts.
 *
 * ASYNC, AND FALLING BACK, because the GEDTM30 store is served by a dev-only
 * Vite route. A production build has no `/gedtm` and would otherwise be left
 * with no second source at all — the cross-check would vanish silently, which
 * is worse than a weaker one. Every result already carries `source`, so the
 * reader is told which second opinion they actually got.
 */
export async function screenTerrainSources(): Promise<readonly TerrainSourceId[]> {
  const gedtm = await gedtmMeta();
  return [PRIMARY_TERRAIN_SOURCE_ID, gedtm ? GEDTM_SOURCE_ID : TERRAIN_SOURCE_IDS[1]];
}

const DEM_SOURCES = [
  {
    id: TERRAIN_SOURCE_IDS[0],
    url: (z: number, x: number, y: number) =>
      `https://terrain.reearth.land/terrarium/elevation/${z}/${x}/${y}.png`,
    tilePx: 512,
    maxZoom: 17,
    nativeM: 30,
  },
  {
    id: TERRAIN_SOURCE_IDS[1],
    url: (z: number, x: number, y: number) =>
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    tilePx: 256,
    maxZoom: 15,
    nativeM: 30,
  },
] as const;

/** Never fetch more than this many DEM tiles for one profile. */
const TILE_BUDGET = 12;

const tileCache = new Map<string, Promise<ImageData | null>>();

/** A slow public tile host must never hold the entire study open indefinitely. */
export const DEM_TILE_TIMEOUT_MS = 6000;
const DEM_SOURCE_COOLDOWN_MS = 5 * 60_000;
const demSourceUnavailableUntil = new Map<string, number>();

/** Resolve with a safe fallback when an external operation rejects or exceeds its deadline. */
export function settleWithin<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    work.then(finish, () => finish(fallback));
  });
}

const sourceIsCoolingDown = (id: string) => (demSourceUnavailableUntil.get(id) ?? 0) > Date.now();
const coolDownSource = (id: string) =>
  void demSourceUnavailableUntil.set(id, Date.now() + DEM_SOURCE_COOLDOWN_MS);

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
  const raw = new Promise<ImageData | null>((resolve) => {
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
  let p: Promise<ImageData | null>;
  p = settleWithin(raw, DEM_TILE_TIMEOUT_MS, null).then((tile) => {
    // Do not permanently cache a timeout or transient host failure. The source
    // cooldown prevents an immediate retry storm while preserving later recovery.
    if (tile === null && tileCache.get(key) === p) tileCache.delete(key);
    return tile;
  });
  tileCache.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Following a valley downhill, from terrain alone.
//
// The bundled river network only covers one window of the world. Terrain tiles
// cover all of it, and a river is simply the line of steepest descent along a
// valley floor — so the same one-click search can run anywhere by tracing the
// DEM. This is the D8 idea behind pysheds and WhiteboxTools (both copyleft, so
// the method is reimplemented rather than copied), coarsened: instead of
// stepping pixel to pixel, where a single noisy cell or a filled pit derails
// the trace, it steps a fixed distance and picks the lowest of a fan of
// forward-facing candidates. That averages over DEM noise and walks straight
// through small pits without needing a pit-filling pass.
// ---------------------------------------------------------------------------

/** One elevation sample from the tiles already in memory. NaN if not loaded. */
function elevationFromTiles(
  tiles: Map<string, ImageData | null>,
  zoom: number,
  lat: number,
  lon: number
): number {
  const fx = lonToTileX(lon, zoom);
  const fy = latToTileY(lat, zoom);
  const img = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
  return img ? sampleBilinear(img, fx % 1, fy % 1) : NaN;
}

const R_EARTH_KM = 6371.0088;

/** Move a bearing and distance over the sphere. */
function offset(lat: number, lon: number, bearingRad: number, km: number) {
  const dLat = (km / R_EARTH_KM) * Math.cos(bearingRad) * (180 / Math.PI);
  const dLon =
    ((km / R_EARTH_KM) * Math.sin(bearingRad) * (180 / Math.PI)) /
    Math.cos((lat * Math.PI) / 180);
  return { lat: lat + dLat, lon: lon + dLon };
}

export type TracedPoint = { lat: number; lon: number; km: number; elevationM: number };
export type TracedPath = {
  points: TracedPoint[];
  source: string;
  zoom: number;
  resolutionM: number;
  tilesFetched: number;
};

/**
 * Follow the valley downhill from a point, using terrain only.
 * Returns evenly spaced points with elevation already attached.
 */
export async function traceDownhill(
  lat: number,
  lon: number,
  maxKm = 22,
  stepKm = 0.15
): Promise<TracedPath | null> {
  /**
   * A generous tile patch around the click, at a zoom that keeps the count sane.
   *
   * Longitude degrees are narrower than latitude ones by cos(lat), so using one
   * span for both made the east-west window short: at 28°N a nominal 22 km
   * half-width covered 19.4 km, and a trace permitted to run 22 km could leave
   * the fetched raster before it got there.
   */
  const latSpanDeg = maxKm / 111;
  const lonSpanDeg = latSpanDeg / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const corners = [
    { lat: lat - latSpanDeg, lon: lon - lonSpanDeg },
    { lat: lat + latSpanDeg, lon: lon + lonSpanDeg },
  ];
  let terrain:
    | {
        src: (typeof DEM_SOURCES)[number];
        zoom: number;
        tiles: Map<string, ImageData | null>;
      }
    | undefined;

  for (const src of DEM_SOURCES) {
    if (sourceIsCoolingDown(src.id)) continue;
    const maxUsefulZoom = demAnalysisZoom(src.tilePx, src.maxZoom, src.nativeM, lat);
    let zoom = maxUsefulZoom;
    for (let z = maxUsefulZoom; z >= 9; z--) {
      const nx =
        Math.floor(lonToTileX(corners[1].lon, z)) - Math.floor(lonToTileX(corners[0].lon, z)) + 1;
      const ny =
        Math.floor(latToTileY(corners[0].lat, z)) - Math.floor(latToTileY(corners[1].lat, z)) + 1;
      if (nx * ny <= 36) {
        zoom = z;
        break;
      }
    }

    const x0 = Math.floor(lonToTileX(corners[0].lon, zoom));
    const x1 = Math.floor(lonToTileX(corners[1].lon, zoom));
    const y0 = Math.floor(latToTileY(corners[1].lat, zoom));
    const y1 = Math.floor(latToTileY(corners[0].lat, zoom));
    const tiles = new Map<string, ImageData | null>();
    const jobs: Promise<void>[] = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        jobs.push(loadTile(src, zoom, x, y).then((img) => void tiles.set(`${x}/${y}`, img)));
      }
    }
    await Promise.all(jobs);
    if ([...tiles.values()].some((tile) => tile === null)) {
      coolDownSource(src.id);
      continue;
    }
    demSourceUnavailableUntil.delete(src.id);
    terrain = { src, zoom, tiles };
    break;
  }

  if (!terrain) return null;
  const { src, zoom, tiles } = terrain;

  const z0 = elevationFromTiles(tiles, zoom, lat, lon);
  if (!Number.isFinite(z0)) return null;

  const out: TracedPoint[] = [{ lat, lon, km: 0, elevationM: z0 }];
  let cur = { lat, lon };
  let curZ = z0;
  let bearing: number | null = null;
  let km = 0;
  /** Allowed climb per step, to cross a pool or a DEM pit without stalling. */
  const CLIMB_TOLERANCE_M = 6;

  while (km < maxKm) {
    // Fan of candidates. Once moving, stay within ±100° of the current heading
    // so the trace cannot double back up the valley it just came down.
    const arc = bearing === null ? Math.PI : (100 * Math.PI) / 180;
    const n = bearing === null ? 24 : 15;
    let bestZ = Infinity;
    let best: { lat: number; lon: number } | null = null;
    let bestBearing = 0;
    for (let i = 0; i < n; i++) {
      const b = (bearing ?? 0) + (bearing === null ? (2 * Math.PI * i) / n : -arc + (2 * arc * i) / (n - 1));
      const p = offset(cur.lat, cur.lon, b, stepKm);
      const z = elevationFromTiles(tiles, zoom, p.lat, p.lon);
      if (!Number.isFinite(z)) continue;
      if (z < bestZ) {
        bestZ = z;
        best = p;
        bestBearing = b;
      }
    }
    if (!best) break;
    if (bestZ > curZ + CLIMB_TOLERANCE_M) break; // genuinely uphill: the valley has ended

    km += stepKm;
    cur = best;
    // Track the descent, but never let a pool raise the recorded profile.
    curZ = Math.min(curZ, bestZ);
    bearing = bestBearing;
    out.push({ lat: cur.lat, lon: cur.lon, km, elevationM: bestZ });
  }
  return {
    points: out,
    source: `${src.id} (valley trace)`,
    zoom,
    resolutionM: groundResolution(zoom, src.tilePx, lat, src.nativeM),
    tilesFetched: tiles.size,
  };
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

/**
 * A square, locally metric DEM window for two-dimensional terrain questions.
 *
 * Profiles answer elevation along a line. Pondage needs every cell around a
 * proposed dam, with a real cell area in square metres. The grid is centred on
 * `center`; its middle cell is exactly that coordinate, rows run north to south,
 * and columns west to east. Geographic bounds are retained only for drawing the
 * result back on the web map — all area/volume arithmetic uses `cellSizeM`.
 */
/**
 * Geometry of the local GEDTM30 extract, as written by
 * pipeline/build-gedtm-nepal.py. Fetched once; absent in a production build,
 * which is what makes the source quietly unavailable rather than broken.
 */
type GedtmMeta = {
  rows: number;
  cols: number;
  pixelDeg: number;
  west: number;
  north: number;
  scale: number;
  offset: number;
  nodata: number;
  nativeM: number;
};

let gedtmMetaPromise: Promise<GedtmMeta | null> | null = null;

function gedtmMeta(): Promise<GedtmMeta | null> {
  // The catch has to cover the PARSE, not just the request. A build with no
  // /gedtm route usually answers with the SPA's index.html and a cheerful 200,
  // so `r.ok` is true and it is `json()` that rejects. Chaining the catch after
  // the then is what makes both shapes of "not here" come back as null.
  gedtmMetaPromise ??= fetch('/gedtm/meta')
    .then((r) => (r.ok ? (r.json() as Promise<GedtmMeta>) : null))
    .catch(() => null);
  return gedtmMetaPromise;
}

export type TerrainWindow = {
  center: { lat: number; lon: number };
  rows: number;
  cols: number;
  elevations: Float32Array;
  cellSizeM: number;
  north: number;
  south: number;
  east: number;
  west: number;
  source: string;
  zoom: number;
  resolutionM: number;
  tilesFetched: number;
};

/**
 * Highest zoom whose tile count still fits the budget for these points.
 * Counts the tiles the path actually touches rather than its bounding box — a
 * river meanders, so a bbox count would drop the zoom far more than necessary.
 */
function pickZoom(
  src: (typeof DEM_SOURCES)[number],
  pts: { lat: number; lon: number }[],
  budget: number
): number {
  const maxUsefulZoom = demAnalysisZoom(src.tilePx, src.maxZoom, src.nativeM, pts[0]?.lat ?? 0);
  for (let z = maxUsefulZoom; z >= 8; z--) {
    const need = new Set<string>();
    for (const p of pts) {
      need.add(`${Math.floor(lonToTileX(p.lon, z))}/${Math.floor(latToTileY(p.lat, z))}`);
      if (need.size > budget) break;
    }
    if (need.size <= budget) return z;
  }
  return 8;
}

/** Ground distance covered by one tile PIXEL. Not the same as knowing that much. */
const pixelSpacingM = (z: number, tilePx: number, lat: number) =>
  (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (2 ** z * tilePx);

/**
 * The first zoom whose pixel spacing resolves the DEM's native grid. Going
 * higher downloads more interpolated pixels without adding terrain evidence.
 */
export function demAnalysisZoom(
  tilePx: number,
  maxZoom: number,
  nativeM: number,
  lat: number
): number {
  const cappedMax = Math.max(0, Math.floor(maxZoom));
  if (!(tilePx > 0) || !(nativeM > 0) || !Number.isFinite(lat)) return cappedMax;
  for (let z = 0; z <= cappedMax; z++) {
    if (pixelSpacingM(z, tilePx, lat) <= nativeM) return z;
  }
  return cappedMax;
}

/**
 * How finely the terrain is actually known, metres.
 *
 * Serving a 30 m DEM as 512 px tiles at z17 puts a sample every ~1 m, and this
 * used to report that number — so the app claimed a "~2 m grid" for terrain whose
 * real posting is 30 m, overstating it by more than an order of magnitude.
 * Oversampling interpolates; it does not measure. Resolution can never be finer
 * than the source, so the effective figure is whichever is coarser.
 *
 * 30 m is the global posting of the datasets behind both sources (SRTM,
 * Copernicus GLO-30). A few countries fold in finer national data, so in those
 * places this understates the terrain — the safe direction for an engineering
 * number to be wrong in.
 */
const groundResolution = (z: number, tilePx: number, lat: number, nativeM: number) =>
  Math.max(pixelSpacingM(z, tilePx, lat), nativeM);

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
  return sampleAlong(
    Array.from({ length: samples }, (_, i) => {
      const t = i / (samples - 1);
      return {
        lat: from[0] + t * (to[0] - from[0]),
        lon: from[1] + t * (to[1] - from[1]),
        distanceKm: t * total,
      };
    }),
    TILE_BUDGET
  );
}

/**
 * Elevation along an arbitrary path — a real river course rather than a straight
 * line. A longer path needs more tiles, so it gets a larger budget and, where
 * that is still not enough, a coarser zoom. The chosen resolution is reported.
 *
 * `onlySource` pins the sampling to one named DEM product. The site audit uses
 * it to measure the same path on the SECOND product and compare: two
 * independently produced terrains disagreeing by 3 m at this site is worth more
 * than a global ±15 m assumption, and disagreeing by 30 m is worth even more.
 */
export function fetchPathProfile(
  path: { lat: number; lon: number; km: number }[],
  onlySource?: string
): Promise<ElevationProfile> {
  return sampleAlong(
    path.map((p) => ({ lat: p.lat, lon: p.lon, distanceKm: p.km })),
    PATH_TILE_BUDGET,
    onlySource
  );
}

/** Maximum DEM tiles one pondage window may ask a source for. */
const TERRAIN_WINDOW_TILE_BUDGET = 64;

/**
 * Fetch a two-dimensional DEM window without first materialising hundreds of
 * thousands of point objects.
 *
 * The terrain servers expose an interpolated Web-Mercator image pyramid. We
 * stop at the first zoom that resolves the native 30 m DEM, then sample a local
 * 30 m grid. A higher image zoom would make the pixels smaller but would not add
 * measured terrain. If the requested window crosses too many tiles, the zoom is
 * reduced until the request is bounded.
 */
/**
 * A terrain window sampled from the local GEDTM30 extract.
 *
 * Same contract as the tile path: the caller has already fixed the centre,
 * spacing and bounds, and this only fills in elevations. That matters more than
 * it looks — pondage.ts re-runs its second source against the FIRST source's
 * dam axis and indexes both grids by cell, which is only meaningful while every
 * source produces the identical geometry.
 *
 * The store is a plain uint16 raster in geographic coordinates, so this pulls
 * the covering rectangle in one request and interpolates between pixel CENTRES
 * — the half-pixel shift is the difference between a bilinear read and a
 * nearest-neighbour one dressed up as bilinear.
 */
async function gedtmTerrainWindow(g: {
  center: { lat: number; lon: number };
  rows: number;
  cols: number;
  halfCells: number;
  cellSizeM: number;
  north: number;
  south: number;
  east: number;
  west: number;
  metresPerDegreeLat: number;
  metresPerDegreeLon: number;
}): Promise<TerrainWindow> {
  const meta = await gedtmMeta();
  if (!meta) throw new Error('The local GEDTM30 store is not available.');

  const px = meta.pixelDeg;
  // Fractional pixel-centre indices of the window corners, then one cell of
  // margin so the bilinear stencil at the edge has its four neighbours.
  const fx = (lon: number) => (lon - meta.west) / px - 0.5;
  const fy = (lat: number) => (meta.north - lat) / px - 0.5;
  const col0 = Math.floor(fx(g.west)) - 1;
  const col1 = Math.ceil(fx(g.east)) + 1;
  const row0 = Math.floor(fy(g.north)) - 1;
  const row1 = Math.ceil(fy(g.south)) + 1;
  if (col0 < 0 || row0 < 0 || col1 >= meta.cols || row1 >= meta.rows) {
    throw new Error('The GEDTM30 store does not cover this window.');
  }

  const wCols = col1 - col0 + 1;
  const wRows = row1 - row0 + 1;
  const res = await fetch(
    `/gedtm/window?row0=${row0}&col0=${col0}&rows=${wRows}&cols=${wCols}`
  );
  if (!res.ok) throw new Error(`The GEDTM30 store refused the window (${res.status}).`);
  const raw = new Uint16Array(await res.arrayBuffer());
  if (raw.length !== wRows * wCols) throw new Error('The GEDTM30 window came back the wrong size.');

  const at = (r: number, c: number) => {
    const v = raw[r * wCols + c];
    return v === meta.nodata ? NaN : v / meta.scale + meta.offset;
  };

  const elevations = new Float32Array(g.rows * g.cols);
  for (let row = 0; row < g.rows; row++) {
    const lat = g.center.lat + ((g.halfCells - row) * g.cellSizeM) / g.metresPerDegreeLat;
    const y = fy(lat) - row0;
    const yi = Math.floor(y);
    const ty = y - yi;
    for (let col = 0; col < g.cols; col++) {
      const lon = g.center.lon + ((col - g.halfCells) * g.cellSizeM) / g.metresPerDegreeLon;
      const x = fx(lon) - col0;
      const xi = Math.floor(x);
      const tx = x - xi;
      const a = at(yi, xi);
      const b = at(yi, xi + 1);
      const c = at(yi + 1, xi);
      const d = at(yi + 1, xi + 1);
      elevations[row * g.cols + col] =
        a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    }
  }
  if (!elevations.some(Number.isFinite)) {
    throw new Error('The GEDTM30 window holds no data at this location.');
  }

  return {
    center: g.center,
    rows: g.rows,
    cols: g.cols,
    elevations,
    cellSizeM: g.cellSizeM,
    north: g.north,
    south: g.south,
    east: g.east,
    west: g.west,
    source: GEDTM_SOURCE_ID,
    // Not a tile pyramid. Zero says "no zoom applies" rather than implying one.
    zoom: 0,
    resolutionM: meta.nativeM,
    tilesFetched: 1,
  };
}

export async function fetchTerrainWindow(
  center: { lat: number; lon: number },
  radiusKm: number,
  requestedCellSizeM = 30,
  onlySource?: TerrainSourceId
): Promise<TerrainWindow> {
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
    throw new Error('Terrain window needs a finite latitude and longitude.');
  }
  if (!(radiusKm > 0) || !(requestedCellSizeM > 0)) {
    throw new Error('Terrain window radius and cell size must be positive.');
  }

  const sources =
    onlySource && onlySource !== GEDTM_SOURCE_ID
      ? DEM_SOURCES.filter((source) => source.id === onlySource)
      : DEM_SOURCES;
  if (sources.length === 0) throw new Error(`Unknown terrain source: ${onlySource}`);

  // Both current sources have a nominal 30 m native grid. Sampling more finely
  // would manufacture cells and, worse, make the area look more precise.
  const nativeM = Math.max(...sources.map((s) => s.nativeM));
  const cellSizeM = Math.max(requestedCellSizeM, nativeM);
  const halfCells = Math.ceil((radiusKm * 1000) / cellSizeM);
  const rows = halfCells * 2 + 1;
  const cols = rows;
  const halfSpanM = (halfCells + 0.5) * cellSizeM;
  const metresPerDegreeLat = 111_320;
  const cos = Math.max(0.01, Math.cos((center.lat * Math.PI) / 180));
  const metresPerDegreeLon = metresPerDegreeLat * cos;
  const north = center.lat + halfSpanM / metresPerDegreeLat;
  const south = center.lat - halfSpanM / metresPerDegreeLat;
  const east = center.lon + halfSpanM / metresPerDegreeLon;
  const west = center.lon - halfSpanM / metresPerDegreeLon;

  // Asked for by name only. There is no fallback to the tile sources here: a
  // silent substitution would turn "GEDTM30 scored X" into "something scored X".
  if (onlySource === GEDTM_SOURCE_ID) {
    return gedtmTerrainWindow({
      center,
      rows,
      cols,
      halfCells,
      cellSizeM,
      north,
      south,
      east,
      west,
      metresPerDegreeLat,
      metresPerDegreeLon,
    });
  }

  for (const src of sources) {
    // An explicit comparison is allowed one direct attempt even if an earlier
    // automatic request cooled the source down. Otherwise the "second DEM"
    // audit could silently turn into the primary DEM again.
    if (!onlySource && sourceIsCoolingDown(src.id)) continue;

    const maxUsefulZoom = demAnalysisZoom(src.tilePx, src.maxZoom, src.nativeM, center.lat);
    let zoom = 8;
    for (let z = maxUsefulZoom; z >= 8; z--) {
      const x0 = Math.floor(lonToTileX(west, z));
      const x1 = Math.floor(lonToTileX(east, z));
      const y0 = Math.floor(latToTileY(north, z));
      const y1 = Math.floor(latToTileY(south, z));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= TERRAIN_WINDOW_TILE_BUDGET) {
        zoom = z;
        break;
      }
    }

    const x0 = Math.floor(lonToTileX(west, zoom));
    const x1 = Math.floor(lonToTileX(east, zoom));
    const y0 = Math.floor(latToTileY(north, zoom));
    const y1 = Math.floor(latToTileY(south, zoom));
    const tiles = new Map<string, ImageData | null>();
    await Promise.all(
      Array.from({ length: x1 - x0 + 1 }, (_, xi) => x0 + xi).flatMap((x) =>
        Array.from({ length: y1 - y0 + 1 }, (_, yi) => y0 + yi).map(async (y) => {
          tiles.set(`${x}/${y}`, await loadTile(src, zoom, x, y));
        })
      )
    );
    if ([...tiles.values()].some((tile) => tile === null)) {
      coolDownSource(src.id);
      continue;
    }
    demSourceUnavailableUntil.delete(src.id);

    const elevations = new Float32Array(rows * cols);
    for (let row = 0; row < rows; row++) {
      const lat = center.lat + ((halfCells - row) * cellSizeM) / metresPerDegreeLat;
      for (let col = 0; col < cols; col++) {
        const lon = center.lon + ((col - halfCells) * cellSizeM) / metresPerDegreeLon;
        elevations[row * cols + col] = elevationFromTiles(tiles, zoom, lat, lon);
      }
    }
    if (!elevations.some(Number.isFinite)) continue;

    return {
      center,
      rows,
      cols,
      elevations,
      cellSizeM,
      north,
      south,
      east,
      west,
      source: src.id,
      zoom,
      resolutionM: groundResolution(zoom, src.tilePx, center.lat, src.nativeM),
      tilesFetched: tiles.size,
    };
  }

  throw new Error('No terrain data covers the pondage window.');
}

/**
 * Pull a coarse river line down onto the valley floor it actually follows.
 *
 * HydroRIVERS is derived at about 500 m, so on this app's own reaches a bend
 * becomes a chord: straight runs measure 350 m at the median and up to 3.7 km.
 * That is visible — an intake can only be dropped on a straight line where the
 * river plainly curves — and it is not only cosmetic. A chord across a meander
 * under-measures the waterway, so headrace and penstock lengths are understated,
 * and elevations get sampled off the channel on the valley side.
 *
 * The terrain already knows where the river is: it is the lowest ground in the
 * cross-section. So each point is offered a set of positions perpendicular to
 * its own flow direction and moves to the lowest one. The DEM tiles are the
 * same ones the profile needs anyway, so this costs decoding rather than
 * network.
 *
 * NOT WIRED IN, AND THE REASON IS WORTH MORE THAN THE FUNCTION.
 *
 * Two versions were built and both were rejected against the ten built plants.
 * The first took the lowest of nine samples per point independently, which is a
 * minimum filter: it biased downward and seized side gullies, pushing a
 * validated 145 m head to 322 m. The second, below, is a Viterbi pass that
 * chooses the whole line at once and refuses to climb — it is genuinely
 * smoother, cutting uphill steps in the profile from 121 to 49 on one reach.
 * It still made head WORSE: mean absolute head error across the plants went
 * from 39.3% to 62.7%, worse on six of nine.
 *
 * The diagnosis is the useful part. HEAD IS A DIFFERENCE OF TWO ELEVATIONS.
 * Moving the whole line onto lower ground lowers both ends by roughly the same
 * amount and cancels out; where it does not cancel, it is because one end
 * happened to find deeper ground than the other, which is noise, not signal. So
 * this technique cannot systematically improve head — it can only add variance
 * to it. The head error in the validation set comes from somewhere else
 * entirely: the published intake and powerhouse coordinates are not where the
 * real works sit. For an engineer placing their own markers, head is already
 * the drop between those markers at about +/-1.2%.
 *
 * What the snap DOES do correctly is horizontal: the line grows 7-14% longer as
 * it recovers meanders the 500 m source data cut into chords, and that length is
 * what a headrace has to span. If this is ever revived, it should be for
 * waterway length and channel shape, with elevations left to the question they
 * actually belong to.
 *
 * WHAT IT WILL NOT DO. The search is deliberately short, and lateral movement
 * is rate-limited between neighbours, because the failure worth avoiding is
 * hopping into an adjacent tributary or across a saddle — a smooth 200 m
 * correction is a better line, a 600 m jump is a different river. Where the
 * valley is broad and flat the lowest cell is close to arbitrary, and the
 * result is then no worse than the line it started from.
 */
const VALLEY_SEARCH_M = 200;
const VALLEY_STEPS = 4;
/** How far the lateral correction may change between neighbouring points. */
const VALLEY_SLEW_M = 90;
/**
 * What a metre of sideways movement costs against a metre of depth, and what a
 * metre of climbing costs. Together these say: prefer the low ground, but not
 * if reaching it means lurching across the valley or running uphill.
 */
const SLEW_COST_PER_M = 0.25;
const RISE_COST = 3;

export async function snapPathToValley(
  path: { lat: number; lon: number; km: number }[],
  onlySource?: string
): Promise<{ path: { lat: number; lon: number; km: number }[]; profile: ElevationProfile; movedM: number } | null> {
  if (path.length < 3) return null;
  const offsets: number[] = [];
  for (let k = -VALLEY_STEPS; k <= VALLEY_STEPS; k++) offsets.push((k * VALLEY_SEARCH_M) / VALLEY_STEPS);

  // Perpendicular to the local flow direction, in degrees.
  const candidates: { lat: number; lon: number; distanceKm: number }[] = [];
  const perp: { dLat: number; dLon: number }[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const cos = Math.cos((path[i].lat * Math.PI) / 180) || 1;
    let vx = (b.lon - a.lon) * cos;
    let vy = b.lat - a.lat;
    const len = Math.hypot(vx, vy) || 1;
    vx /= len;
    vy /= len;
    // Rotate 90 degrees, then back to degrees of latitude and longitude.
    perp.push({ dLat: vx / 111.32, dLon: -vy / (111.32 * cos) });
    for (const off of offsets) {
      candidates.push({
        lat: path[i].lat + (perp[i].dLat * off) / 1000,
        lon: path[i].lon + (perp[i].dLon * off) / 1000,
        distanceKm: path[i].km,
      });
    }
  }

  /**
   * The same tile budget as an unsnapped profile, deliberately.
   *
   * The offsets are only a couple of hundred metres, so they land almost
   * entirely on tiles the profile needed anyway. Doubling the budget let
   * pickZoom reach for a finer zoom instead, which multiplied the tile count
   * and got the whole run rate-limited off the terrain service — every plant in
   * the validation set failed with "no terrain data" at once.
   */
  const sampled = await sampleAlong(candidates, PATH_TILE_BUDGET, onlySource).catch(() => null);
  if (!sampled || sampled.points.length !== candidates.length) return null;

  /**
   * Choose the whole line at once, not each point on its own.
   *
   * Taking the lowest of nine samples per point independently is a minimum
   * filter: it biases downward wherever the terrain is noisy and will seize a
   * side gully or a DEM pit, which is exactly how the first attempt pushed a
   * validated 145 m head to 322 m. A river does not behave that way. It runs
   * along a coherent floor and it never climbs.
   *
   * So this is a Viterbi pass over the lateral offsets, scoring a whole line:
   *
   *   cost(i,k) = z(i,k) + SLEW_COST x |lateral move| + RISE_COST x (climb)
   *
   * The elevation term still pulls toward the valley floor, the slew term makes
   * the line bend rather than jump, and the rise term encodes the one thing
   * that is certainly true of a river — it only goes down. A low cell reached
   * by climbing, or by hopping the width of the search window, no longer wins.
   */
  const chosen: number[] = [];
  const zAt = (i: number, k: number) => sampled.points[i * offsets.length + k]?.elevationM ?? NaN;

  const cost: number[][] = [];
  const back: number[][] = [];
  cost.push(offsets.map((_, k) => (Number.isFinite(zAt(0, k)) ? zAt(0, k) : Infinity)));
  back.push(offsets.map(() => 0));
  for (let i = 1; i < path.length; i++) {
    const row: number[] = [];
    const from: number[] = [];
    for (let k = 0; k < offsets.length; k++) {
      const z = zAt(i, k);
      if (!Number.isFinite(z)) {
        row.push(Infinity);
        from.push(0);
        continue;
      }
      let best = Infinity;
      let bestPrev = 0;
      for (let k2 = 0; k2 < offsets.length; k2++) {
        const prev = cost[i - 1][k2];
        if (!Number.isFinite(prev)) continue;
        const lateral = Math.abs(offsets[k] - offsets[k2]);
        if (lateral > VALLEY_SLEW_M) continue;
        const zPrev = zAt(i - 1, k2);
        const climb = Number.isFinite(zPrev) ? Math.max(0, z - zPrev) : 0;
        const c = prev + lateral * SLEW_COST_PER_M + climb * RISE_COST;
        if (c < best) {
          best = c;
          bestPrev = k2;
        }
      }
      row.push(Number.isFinite(best) ? best + z : Infinity);
      from.push(bestPrev);
    }
    cost.push(row);
    back.push(from);
  }

  // Walk back from the cheapest ending state.
  let endK = 0;
  let endBest = Infinity;
  for (let k = 0; k < offsets.length; k++) {
    if (cost[path.length - 1][k] < endBest) {
      endBest = cost[path.length - 1][k];
      endK = k;
    }
  }
  if (!Number.isFinite(endBest)) return null;
  for (let i = path.length - 1; i >= 0; i--) {
    chosen[i] = endK;
    endK = back[i][endK];
  }
  const movedTotal = chosen.reduce((sum, k) => sum + Math.abs(offsets[k]), 0);

  // Rebuild the line, then re-measure it: a line that now follows the meander
  // is longer than the chord it replaced, and that length is what a headrace
  // has to span.
  const out: { lat: number; lon: number; km: number }[] = [];
  const points: ProfilePoint[] = [];
  let km = 0;
  for (let i = 0; i < path.length; i++) {
    const off = offsets[chosen[i]];
    const lat = path[i].lat + (perp[i].dLat * off) / 1000;
    const lon = path[i].lon + (perp[i].dLon * off) / 1000;
    if (i > 0) km += haversineKm([out[i - 1].lat, out[i - 1].lon], [lat, lon]);
    out.push({ lat, lon, km });
    points.push({
      lat,
      lon,
      distanceKm: km,
      elevationM: sampled.points[i * offsets.length + chosen[i]].elevationM,
    });
  }
  return {
    path: out,
    profile: { ...sampled, points },
    movedM: movedTotal / path.length,
  };
}

/** A river walk covers far more ground than a penstock line. */
const PATH_TILE_BUDGET = 40;

async function sampleAlong(
  pts: { lat: number; lon: number; distanceKm: number }[],
  budget: number,
  onlySource?: string
): Promise<ElevationProfile> {
  for (const src of DEM_SOURCES) {
    if (onlySource && src.id !== onlySource) continue;
    if (!onlySource && sourceIsCoolingDown(src.id)) continue;
    const zoom = pickZoom(src, pts, budget);
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
    // One missing tile is enough to create a false head or a broken longitudinal
    // profile. Retry the complete path on the backup rather than mixing gaps in.
    if ([...tiles.values()].some((tile) => tile === null)) {
      coolDownSource(src.id);
      continue;
    }
    demSourceUnavailableUntil.delete(src.id);

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
      resolutionM: groundResolution(zoom, src.tilePx, pts[0].lat, src.nativeM),
      tilesFetched: needed.size,
    };
  }
  throw new Error('No terrain data covers this location.');
}
