/**
 * Every request in this file goes straight from the visitor's browser to a public API.
 * No backend, no key, no proxy. Each endpoint had its `access-control-allow-origin`
 * header verified with a real request during Phase 1 — see PHASE1-REPORT.md.
 */
import { CFS_TO_CMS, USGS_NO_DATA, haversineKm } from './hydro.ts';
import dhmRaw from './dhm-stations.json';

/**
 * Use 20 complete calendar years for screening. Open-Meteo counts long date
 * ranges as many request-equivalents, so requesting every available day on
 * every click needlessly exhausts the shared free quota. Twenty years still
 * spans multiple wet/dry cycles and is cached because the period is immutable.
 */
const COMPLETE_YEAR = new Date().getUTCFullYear() - 1;
export const GLOFAS_START = `${COMPLETE_YEAR - 19}-01-01`;
export const GLOFAS_END = `${COMPLETE_YEAR}-12-31`;

const today = () => new Date().toISOString().slice(0, 10);

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  // 429 is common on the free tiers and is temporary — say so rather than
  // showing a bare status code that reads like the site is broken.
  if (res.status === 429) {
    throw new Error(
      `${new URL(url).host} is rate-limiting right now. It is a shared free service — ` +
        'wait a minute and click again.'
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json() as Promise<T>;
}

const FLOOD_CACHE_PREFIX = 'riverpower:glofas:v3:';
const FLOOD_CACHE_INDEX = `${FLOOD_CACHE_PREFIX}index`;
const FLOOD_COOLDOWN_KEY = `${FLOOD_CACHE_PREFIX}cooldown`;
const FLOOD_CACHE_MAX = 10;
const FLOOD_CACHE_TTL_MS = 180 * 864e5;
const floodInFlight = new Map<string, Promise<DischargeSeries>>();

type StoredFlood = { savedAt: number; data: DischargeSeries };

function floodCell(lat: number, lon: number) {
  const step = 0.05;
  return {
    lat: Math.round(lat / step) * step,
    lon: Math.round(lon / step) * step,
  };
}

function readStoredFlood(key: string): StoredFlood | null {
  try {
    const raw = localStorage.getItem(`${FLOOD_CACHE_PREFIX}${key}`);
    return raw ? (JSON.parse(raw) as StoredFlood) : null;
  } catch {
    return null;
  }
}

function writeStoredFlood(key: string, data: DischargeSeries) {
  try {
    localStorage.setItem(
      `${FLOOD_CACHE_PREFIX}${key}`,
      JSON.stringify({ savedAt: Date.now(), data } satisfies StoredFlood)
    );
    const prior = JSON.parse(localStorage.getItem(FLOOD_CACHE_INDEX) ?? '[]') as string[];
    const next = [key, ...prior.filter((x) => x !== key)].slice(0, FLOOD_CACHE_MAX);
    localStorage.setItem(FLOOD_CACHE_INDEX, JSON.stringify(next));
    for (const old of prior) {
      if (!next.includes(old)) localStorage.removeItem(`${FLOOD_CACHE_PREFIX}${old}`);
    }
  } catch {
    // Storage can be unavailable or full. The analysis still works; it simply
    // cannot be reused on the next visit.
  }
}

function rateLimitMessage(retryAt: number) {
  const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60000));
  return `The free Open-Meteo service asked us to pause for about ${minutes} min. River placement, catchment flow and all non-GloFAS checks still work.`;
}

function floodCooldown() {
  try {
    return Number(localStorage.getItem(FLOOD_COOLDOWN_KEY) ?? 0);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Discharge — GloFAS via Open-Meteo. Global, keyless, m3/s, ACAO: *
// ---------------------------------------------------------------------------

export type DischargeSeries = {
  dates: string[];
  /** m3/s. Nulls in the source become NaN and are filtered by the FDC builder. */
  values: number[];
  /** Grid cell the model actually used, which is not the point you clicked. */
  cell: { lat: number; lon: number };
  elevationM: number;
  units: string;
  /** Whether the time series came from the network or this device's cache. */
  cacheStatus?: 'network' | 'fresh' | 'stale';
};

export async function fetchGlofas(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<DischargeSeries> {
  const cell = floodCell(lat, lon);
  const key = `${cell.lat.toFixed(2)},${cell.lon.toFixed(2)},${GLOFAS_START},${GLOFAS_END}`;
  const stored = readStoredFlood(key);
  if (stored && Date.now() - stored.savedAt < FLOOD_CACHE_TTL_MS) {
    return { ...stored.data, cacheStatus: 'fresh' };
  }

  const cooldown = floodCooldown();
  if (cooldown > Date.now()) {
    if (stored) return { ...stored.data, cacheStatus: 'stale' };
    throw new Error(rateLimitMessage(cooldown));
  }

  const hit = floodInFlight.get(key);
  if (hit) return hit;

  const request = (async () => {
    const url =
      `https://flood-api.open-meteo.com/v1/flood?latitude=${cell.lat.toFixed(4)}&longitude=${cell.lon.toFixed(4)}` +
      `&daily=river_discharge&start_date=${GLOFAS_START}&end_date=${GLOFAS_END}` +
      `&models=glofas_v4_consolidated`;
    const res = await fetch(url, { signal });
    if (res.status === 429) {
      const body = await res.text().catch(() => '');
      const retryHeader = res.headers.get('retry-after');
      const retrySeconds = Number(retryHeader);
      const retryDate = retryHeader ? Date.parse(retryHeader) : NaN;
      const now = new Date();
      const tomorrow = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        5
      );
      const retryAt = /daily/i.test(body)
        ? tomorrow
        : Date.now() +
          (Number.isFinite(retrySeconds) && retrySeconds > 0
            ? retrySeconds * 1000
            : Number.isFinite(retryDate) && retryDate > Date.now()
              ? retryDate - Date.now()
              : 15 * 60000);
      try {
        localStorage.setItem(FLOOD_COOLDOWN_KEY, String(retryAt));
      } catch {
        /* private browsing can disallow storage */
      }
      if (stored) return { ...stored.data, cacheStatus: 'stale' as const };
      throw new Error(rateLimitMessage(retryAt));
    }
    if (!res.ok) throw new Error(`Detailed flow history could not be loaded (HTTP ${res.status}).`);
    const j = (await res.json()) as {
      latitude: number;
      longitude: number;
      elevation: number;
      daily: { time: string[]; river_discharge: (number | null)[] };
      daily_units: { river_discharge: string };
    };
    const dates: string[] = [];
    const values: number[] = [];
    for (let i = 0; i < j.daily.time.length; i++) {
      const v = j.daily.river_discharge[i];
      if (v === null || v === undefined) continue;
      dates.push(j.daily.time[i]);
      values.push(v);
    }
    const data: DischargeSeries = {
      dates,
      values,
      cell: { lat: j.latitude, lon: j.longitude },
      elevationM: j.elevation,
      units: j.daily_units?.river_discharge ?? 'm³/s',
      cacheStatus: 'network',
    };
    writeStoredFlood(key, data);
    return data;
  })().finally(() => floodInFlight.delete(key));

  floodInFlight.set(key, request);
  return request;
}

export type Candidate = {
  lat: number;
  lon: number;
  meanCms: number;
  uplandKm2?: number;
  strahler?: number;
  /** Which network answered — the UI labels provenance differently for each. */
  source: 'hydrorivers' | 'glofas';
};

export type ScanResult = {
  cells: Candidate[];
  /** True when only the strongest reaches fit the display budget. */
  limited: boolean;
  source: 'hydrorivers' | 'glofas';
};

// ---------------------------------------------------------------------------
// Precipitation — NASA POWER (MERRA-2)
// ---------------------------------------------------------------------------

export type PrecipSummary = {
  annualMeanMm: number;
  monthlyMeanMm: number[];
  years: number;
  /** era5 pins the request to the homogeneous reanalysis; best_match silently switches model in 2017. */
  model: string;
};

/**
 * Precipitation climatology from NASA POWER (MERRA-2, gauge-corrected).
 *
 * Chosen over ERA5 after measuring both against three Nepali stations with
 * well-known totals (20-yr means, 2001-2020):
 *                     truth        ERA5              NASA POWER
 *   Kathmandu     1400-1600 mm   2848 (1.9x high)    1224
 *   Jomsom          250-340 mm   2593 (8x high)       951
 *   Lumle             ~5000 mm   2699 (1.9x low)     1316
 * NASA POWER is much closer in the mid-hills, where most schemes sit.
 *
 * NEITHER resolves Himalayan orography: the real Lumle:Jomsom ratio is ~16x,
 * ERA5 renders it as 1.04x and NASA POWER as 1.38x. The UI has to say so.
 */
export async function fetchPrecip(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<PrecipSummary> {
  const endYear = new Date().getUTCFullYear() - 1;
  const startYear = endYear - 19;
  const url =
    `https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=PRECTOTCORR&community=AG` +
    `&longitude=${lon.toFixed(4)}&latitude=${lat.toFixed(4)}` +
    `&start=${startYear}&end=${endYear}&format=JSON`;
  const j = await getJson<{
    properties: { parameter: { PRECTOTCORR: Record<string, number> } };
  }>(url, signal);
  const monthly = j.properties?.parameter?.PRECTOTCORR ?? {};
  const monthSum = new Array(12).fill(0);
  const yearsSeen = new Set<string>();
  let total = 0;
  for (const [key, v] of Object.entries(monthly)) {
    // Keys ending in 13 are POWER's annual daily average, not a calendar month.
    const month = Number(key.slice(4, 6));
    if (month < 1 || month > 12) continue;
    // POWER uses -999 as its fill value; summing it would silently wreck the total.
    if (!Number.isFinite(v) || v <= -900) continue;
    const year = Number(key.slice(0, 4));
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthlyTotalMm = v * days; // monthly API unit is mean mm/day
    monthSum[month - 1] += monthlyTotalMm;
    yearsSeen.add(String(year));
    total += monthlyTotalMm;
  }
  const years = Math.max(1, yearsSeen.size);
  return {
    annualMeanMm: total / years,
    monthlyMeanMm: monthSum.map((s) => s / years),
    years,
    model: 'NASA POWER (MERRA-2)',
  };
}

// ---------------------------------------------------------------------------
// Seismicity — USGS FDSN event catalog. Nepal is highly seismic and the app
// previously listed this under "cannot see".
// ---------------------------------------------------------------------------

export type Quake = { mag: number; date: string; place: string; depthKm: number; distanceKm: number };

export type SeismicSummary = { count: number; largest: Quake | null; recent: Quake[]; radiusKm: number };

export async function fetchSeismicity(
  lat: number,
  lon: number,
  radiusKm = 100,
  signal?: AbortSignal
): Promise<SeismicSummary> {
  const url =
    `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${lat.toFixed(4)}` +
    `&longitude=${lon.toFixed(4)}&maxradiuskm=${radiusKm}&minmagnitude=4.5&starttime=1900-01-01&orderby=magnitude`;
  const j = await getJson<{
    features: {
      properties: { mag: number; time: number; place: string };
      geometry: { coordinates: [number, number, number] };
    }[];
  }>(url, signal);
  const all: Quake[] = (j.features ?? [])
    .filter((f) => Number.isFinite(f.properties?.mag))
    .map((f) => ({
      mag: f.properties.mag,
      date: new Date(f.properties.time).toISOString().slice(0, 10),
      place: f.properties.place ?? '',
      depthKm: f.geometry.coordinates[2],
      distanceKm: haversineKm([lat, lon], [f.geometry.coordinates[1], f.geometry.coordinates[0]]),
    }));
  return {
    count: all.length,
    largest: all[0] ?? null, // ordered by magnitude
    recent: [...all].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
    radiusKm,
  };
}

// ---------------------------------------------------------------------------
// USGS — the "measured" cross-check. US only; 404 outside it, which is not an error.
// ---------------------------------------------------------------------------

export type Gauge = {
  siteNo: string;
  name: string;
  lat: number;
  lon: number;
  distanceKm: number;
  /** Square miles in the source; converted to km2 here. Frequently blank. */
  drainageAreaKm2: number | null;
  altitudeM: number | null;
  altDatum: string | null;
  hasDischargeRecord: boolean;
  recordStart: string | null;
  recordEnd: string | null;
  recordDays: number | null;
};

/** Parse a USGS RDB table: comment lines start with #, then a header row, then a types row. */
function parseRdb(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const cols = lines[0].split('\t').map((c) => c.trim());
  return lines.slice(2).map((line) => {
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    cols.forEach((c, i) => (row[c] = (cells[i] ?? '').trim()));
    return row;
  });
}

/**
 * Nearest US gauges with a daily discharge record.
 * Returns [] both when there is no gauge and when the point is outside the US —
 * the site service answers an empty bbox with HTTP 404 and a zero-length body.
 */
export async function fetchNearbyGauges(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<Gauge[]> {
  const d = 0.5; // degrees; the site service rejects very large boxes
  const bbox = [lon - d, lat - d, lon + d, lat + d].map((v) => v.toFixed(5)).join(',');
  const url =
    `https://waterservices.usgs.gov/nwis/site/?format=rdb&bBox=${bbox}` +
    `&siteType=ST&hasDataTypeCd=dv&siteStatus=all&siteOutput=expanded`;
  const res = await fetch(url, { signal });
  if (res.status === 404) return []; // documented empty-result behaviour, not a failure
  if (!res.ok) throw new Error(`USGS site service: HTTP ${res.status}`);
  const rows = parseRdb(await res.text());

  const gauges = rows
    .filter((r) => r.site_no && r.dec_lat_va && r.dec_long_va)
    .map((r): Gauge => {
      const gLat = Number(r.dec_lat_va);
      const gLon = Number(r.dec_long_va);
      const daSqMi = Number(r.drain_area_va);
      const altFt = Number(r.alt_va);
      return {
        siteNo: r.site_no,
        name: r.station_nm || r.site_no,
        lat: gLat,
        lon: gLon,
        distanceKm: haversineKm([lat, lon], [gLat, gLon]),
        drainageAreaKm2: Number.isFinite(daSqMi) && r.drain_area_va ? daSqMi * 2.58999 : null,
        altitudeM: Number.isFinite(altFt) && r.alt_va ? altFt * 0.3048 : null,
        altDatum: r.alt_datum_cd || null,
        hasDischargeRecord: false,
        recordStart: null,
        recordEnd: null,
        recordDays: null,
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 5);

  if (gauges.length === 0) return [];

  // Period of record for parameter 00060. count_nu here exactly matches how many
  // daily values the DV service will return, so it doubles as a download estimate.
  try {
    const cat = await fetch(
      `https://waterservices.usgs.gov/nwis/site/?format=rdb&sites=${gauges
        .map((g) => g.siteNo)
        .join(',')}&seriesCatalogOutput=true&outputDataTypeCd=dv`,
      { signal }
    );
    if (cat.ok) {
      for (const r of parseRdb(await cat.text())) {
        if (r.parm_cd !== '00060' || r.stat_cd !== '00003') continue;
        const g = gauges.find((x) => x.siteNo === r.site_no);
        if (!g) continue;
        g.hasDischargeRecord = true;
        g.recordStart = r.begin_date || null;
        g.recordEnd = r.end_date || null;
        g.recordDays = Number(r.count_nu) || null;
      }
    }
  } catch {
    /* period of record is a bonus; a failure here must not lose the gauge list */
  }
  return gauges;
}

export type LiveReading = {
  siteNo: string;
  siteName: string;
  dischargeCms: number | null;
  gageHeightM: number | null;
  timestamp: string | null;
  /** P = provisional, A = approved, e = estimated, Ice = ice-affected. */
  qualifiers: string[];
  ageMinutes: number | null;
};

export async function fetchLiveReading(
  siteNo: string,
  signal?: AbortSignal
): Promise<LiveReading | null> {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteNo}&parameterCd=00060,00065`;
  const res = await fetch(url, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`USGS IV: HTTP ${res.status}`);
  const j = (await res.json()) as {
    value: {
      timeSeries: {
        sourceInfo: { siteName: string };
        variable: { variableCode: { value: string }[]; unit: { unitCode: string } };
        values: { value: { value: string; dateTime: string; qualifiers: string[] }[] }[];
      }[];
    };
  };
  const ts = j.value?.timeSeries ?? [];
  if (ts.length === 0) return null;

  const out: LiveReading = {
    siteNo,
    siteName: ts[0].sourceInfo.siteName,
    dischargeCms: null,
    gageHeightM: null,
    timestamp: null,
    qualifiers: [],
    ageMinutes: null,
  };
  for (const s of ts) {
    const code = s.variable.variableCode?.[0]?.value;
    const pt = s.values?.[0]?.value?.[0];
    if (!pt) continue;
    const raw = Number(pt.value); // values arrive as strings
    if (!Number.isFinite(raw) || raw <= USGS_NO_DATA + 1) continue;
    if (code === '00060') {
      out.dischargeCms = raw * CFS_TO_CMS; // ft3/s -> m3/s
      out.timestamp = pt.dateTime;
      out.qualifiers = pt.qualifiers ?? [];
    } else if (code === '00065') {
      out.gageHeightM = raw * 0.3048; // ft -> m
      if (!out.timestamp) out.timestamp = pt.dateTime;
    }
  }
  if (out.timestamp) {
    out.ageMinutes = Math.round((Date.now() - new Date(out.timestamp).getTime()) / 60000);
  }
  return out;
}

/** Full period-of-record daily discharge. ~190 KB gzipped for a century. */
export async function fetchUsgsDaily(
  siteNo: string,
  signal?: AbortSignal
): Promise<DischargeSeries | null> {
  const url =
    `https://waterservices.usgs.gov/nwis/dv/?format=json&sites=${siteNo}` +
    `&parameterCd=00060&statCd=00003&startDT=1850-01-01&endDT=${today()}`;
  const res = await fetch(url, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`USGS DV: HTTP ${res.status}`);
  const j = (await res.json()) as {
    value: {
      timeSeries: {
        sourceInfo: { geoLocation: { geogLocation: { latitude: number; longitude: number } } };
        variable: { unit: { unitCode: string } };
        values: { value: { value: string; dateTime: string }[] }[];
      }[];
    };
  };
  const ts = j.value?.timeSeries?.[0];
  const pts = ts?.values?.[0]?.value ?? [];
  if (pts.length === 0) return null;
  const dates: string[] = [];
  const values: number[] = [];
  for (const p of pts) {
    const raw = Number(p.value);
    if (!Number.isFinite(raw) || raw <= USGS_NO_DATA + 1) continue; // sentinel
    dates.push(p.dateTime.slice(0, 10));
    values.push(raw * CFS_TO_CMS);
  }
  const geo = ts.sourceInfo.geoLocation.geogLocation;
  return {
    dates,
    values,
    cell: { lat: geo.latitude, lon: geo.longitude },
    elevationM: NaN,
    units: 'm³/s (converted from ft³/s)',
  };
}

// ---------------------------------------------------------------------------
// Nepal DHM station inventory — bundled, see scripts/build-dhm-stations.mjs
// ---------------------------------------------------------------------------

export type DhmStation = {
  name: string;
  lat: number;
  lon: number;
  elevationM: number | null;
  /** Classified as a river gauge by name ("… River at …", "… Khola at …"). */
  isRiverGauge: boolean;
  distanceKm: number;
};

const DHM: { n: string; y: number; x: number; e: number | null; r: number }[] = dhmRaw;

// Simplified national outline. The previous rectangular check admitted parts of
// northern India, which let cross-border HydroRIVERS reaches appear as Nepali
// candidates and incorrectly enabled the Nepal-only panels.
const NEPAL_OUTLINE: readonly [number, number][] = [
  [80.05, 28.82],
  [80.18, 29.18],
  [81.02, 30.24],
  [81.82, 30.45],
  [82.62, 30.34],
  [83.65, 29.78],
  [84.15, 29.45],
  [85.18, 29.25],
  [86.04, 28.94],
  [86.78, 28.55],
  [87.48, 28.31],
  [88.2, 27.95],
  [88.18, 27.1],
  [87.98, 26.72],
  [87.42, 26.42],
  [86.74, 26.36],
  [85.86, 26.57],
  [85.18, 26.7],
  [84.15, 26.35],
  [83.0, 26.45],
  [82.12, 26.72],
  [81.13, 27.35],
  [80.47, 28.33],
];

/** True for points inside a conservative, simplified Nepal boundary. */
export function isInNepal(lat: number, lon: number): boolean {
  if (lat < 26.3 || lat > 30.5 || lon < 80 || lon > 88.25) return false;
  let inside = false;
  for (let i = 0, j = NEPAL_OUTLINE.length - 1; i < NEPAL_OUTLINE.length; j = i++) {
    const [xi, yi] = NEPAL_OUTLINE[i];
    const [xj, yj] = NEPAL_OUTLINE[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Nearest Nepal DHM stations. Locations only — DHM key-gates the actual readings
 * (`/gss/api/observation` returns 403 "Api Keys required"), so this exists to tell a
 * user which real gauge to go and request a record for, not to provide values.
 */
export function nearbyDhmStations(lat: number, lon: number, riverOnly = true, limit = 5): DhmStation[] {
  return DHM.filter((s) => (riverOnly ? s.r === 1 : true))
    .map((s) => ({
      name: s.n,
      lat: s.y,
      lon: s.x,
      elevationM: s.e,
      isRiverGauge: s.r === 1,
      distanceKm: haversineKm([lat, lon], [s.y, s.x]),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Nepal river network — HydroRIVERS v1.0 extract, see scripts/build-hydrorivers.mjs
// Gives upstream catchment area and long-term mean discharge per reach, which no
// keyless global API provides.
// ---------------------------------------------------------------------------

export type Reach = {
  /** Upstream contributing catchment area at this reach, km². */
  uplandKm2: number;
  /** HydroRIVERS long-term mean discharge at this reach, m³/s. */
  meanDischargeCms: number;
  /** Strahler stream order. 1 = headwater. */
  strahler: number;
  /** How far the clicked point was from the reach centreline, km. */
  distanceKm: number;
  /** Closest point on the mapped centreline, used for honest map placement. */
  point: { lat: number; lon: number };
};

type RiverNet = {
  count: number;
  scale: number;
  upland: Int32Array;
  dis: Int32Array;
  ord: Uint8Array;
  /** Vertex slice per reach, as offsets into xy. */
  start: Int32Array;
  len: Int32Array;
  /** Interleaved x,y in scaled integer degrees. */
  xy: Int32Array;
  /** Grid cell key -> reach indices, for nearest lookup. */
  grid: Map<number, number[]>;
};

const GRID_DEG = 0.1;
const cellKey = (lon: number, lat: number) =>
  Math.round(lon / GRID_DEG) * 100000 + Math.round(lat / GRID_DEG);

let riverNet: Promise<RiverNet | null> | null = null;

/** Decode the packed network. Lazy: only Nepal points pay for it. */
export function loadNepalRivers(): Promise<RiverNet | null> {
  if (riverNet) return riverNet;
  riverNet = (async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}nepal-rivers.dat`, { cache: 'reload' });
    if (!res.ok) throw new Error(`river network: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // A 204 or a truncated body would otherwise surface as an opaque
    // "Offset is outside the bounds of the DataView" from the first read.
    if (buf.byteLength < 16) {
      throw new Error(
        `river network: empty response (HTTP ${res.status}, ${buf.byteLength} bytes) — ` +
          'if running the dev server, restart it so Vite picks up public/nepal-rivers.dat'
      );
    }
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x4e505231) throw new Error('river network: bad magic');
    const count = dv.getUint32(4, true);
    const totalVerts = dv.getUint32(8, true);
    const scale = dv.getUint32(12, true);

    const upland = new Int32Array(count);
    const dis = new Int32Array(count);
    const ord = new Uint8Array(count);
    const len = new Int32Array(count);
    const start = new Int32Array(count);
    let o = 16;
    for (let i = 0; i < count; i++) {
      upland[i] = dv.getInt32(o, true);
      dis[i] = dv.getInt32(o + 4, true);
      ord[i] = dv.getUint8(o + 8);
      len[i] = dv.getUint16(o + 9, true);
      o += 11;
    }

    const xy = new Int32Array(totalVerts * 2);
    const grid = new Map<number, number[]>();
    let vi = 0;
    for (let i = 0; i < count; i++) {
      start[i] = vi;
      let x = 0;
      let y = 0;
      for (let k = 0; k < len[i]; k++) {
        if (k === 0) {
          x = dv.getInt32(o, true);
          y = dv.getInt32(o + 4, true);
          o += 8;
        } else {
          x += dv.getInt16(o, true);
          y += dv.getInt16(o + 2, true);
          o += 4;
        }
        xy[vi * 2] = x;
        xy[vi * 2 + 1] = y;
        vi++;
      }
      // Index by the reach's own vertices so lookup is local.
      const seen = new Set<number>();
      for (let k = 0; k < len[i]; k++) {
        const j = start[i] + k;
        const key = cellKey(xy[j * 2] / scale, xy[j * 2 + 1] / scale);
        if (seen.has(key)) continue;
        seen.add(key);
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
      }
    }
    return { count, scale, upland, dis, ord, start, len, xy, grid };
  })().catch((e) => {
    riverNet = null; // allow a retry
    throw e;
  });
  return riverNet;
}

export type ReachHit = {
  nearest: Reach;
  /**
   * The largest channel within MAIN_STEM_KM, when it dwarfs the nearest one.
   *
   * This matters. Measured at Sapta Koshi at Chatara: the geometrically nearest
   * reach is a 12 km² tributary 0.26 km away, while the Koshi main stem — 54,100 km²
   * — runs alongside it. Returning only the nearest would understate the catchment
   * by a factor of 4,500.
   */
  mainStem: Reach | null;
};

/** How far to look for a bigger channel beside the one you clicked. */
const MAIN_STEM_KM = 1.5;
/** Only offer the alternative when it is genuinely a different order of river. */
const MAIN_STEM_RATIO = 5;

/**
 * Nearest mapped river reach to a point, plus the dominant channel nearby.
 * Searches the point's grid cell then widens, so a click in the middle of nowhere
 * still resolves rather than scanning 42,000 reaches.
 */
export async function nearestReach(lat: number, lon: number): Promise<ReachHit | null> {
  const net = await loadNepalRivers();
  if (!net) return null;
  const s = net.scale;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const degToKm = 111.32;

  // Reach index -> closest distance and point on its actual centreline.
  const seen = new Map<number, { distanceKm: number; point: { lat: number; lon: number } }>();
  const consider = (i: number) => {
    const a = net.start[i];
    let d2 = Infinity;
    let point = { lat, lon };
    for (let k = 0; k < net.len[i]; k++) {
      const reachLon = net.xy[(a + k) * 2] / s;
      const reachLat = net.xy[(a + k) * 2 + 1] / s;
      const dx = (reachLon - lon) * cosLat;
      const dy = reachLat - lat;
      const d = dx * dx + dy * dy;
      if (d < d2) {
        d2 = d;
        point = { lat: reachLat, lon: reachLon };
      }
    }
    seen.set(i, { distanceKm: Math.sqrt(d2) * degToKm, point });
  };

  for (let ring = 0; ring <= 6; ring++) {
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gy = -ring; gy <= ring; gy++) {
        if (ring > 0 && Math.abs(gx) !== ring && Math.abs(gy) !== ring) continue;
        const bucket = net.grid.get(cellKey(lon + gx * GRID_DEG, lat + gy * GRID_DEG));
        if (!bucket) continue;
        for (const i of bucket) if (!seen.has(i)) consider(i);
      }
    }
    // Keep widening until we have something, then one extra ring for context.
    if (seen.size > 0 && ring >= 1) break;
  }
  if (seen.size === 0) return null;

  const mk = (i: number, hit: { distanceKm: number; point: { lat: number; lon: number } }): Reach => ({
    uplandKm2: net.upland[i] / 10,
    meanDischargeCms: net.dis[i] / 1000,
    strahler: net.ord[i],
    distanceKm: hit.distanceKm,
    point: hit.point,
  });

  let nearestI = -1;
  let nearestKm = Infinity;
  let biggestI = -1;
  let biggestUp = -1;
  let biggestKm = 0;
  for (const [i, hit] of seen) {
    if (hit.distanceKm < nearestKm) {
      nearestKm = hit.distanceKm;
      nearestI = i;
    }
    if (hit.distanceKm <= MAIN_STEM_KM && net.upland[i] > biggestUp) {
      biggestUp = net.upland[i];
      biggestI = i;
      biggestKm = hit.distanceKm;
    }
  }
  const nearest = mk(nearestI, seen.get(nearestI)!);
  const mainStem =
    biggestI >= 0 && biggestI !== nearestI && biggestUp > net.upland[nearestI] * MAIN_STEM_RATIO
      ? mk(biggestI, { ...seen.get(biggestI)!, distanceKm: biggestKm })
      : null;
  return { nearest, mainStem };
}

/**
 * Flow-ranked river points for the visible Nepal map. This reads the bundled
 * HydroRIVERS network, so it makes zero Open-Meteo requests and every point is
 * located on a river centreline rather than on a coarse model-cell centroid.
 */
export async function scanNepalCandidates(
  bounds: { west: number; south: number; east: number; north: number }
): Promise<ScanResult> {
  const net = await loadNepalRivers();
  if (!net) return { cells: [], limited: false, source: 'hydrorivers' };
  const MAX_VISIBLE = 240;
  const byMapCell = new Map<string, Candidate>();
  const inBounds = (lat: number, lon: number) =>
    lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;

  for (let i = 0; i < net.count; i++) {
    const meanCms = net.dis[i] / 1000;
    if (!Number.isFinite(meanCms) || meanCms <= 0) continue;
    const start = net.start[i];
    let point: { lat: number; lon: number } | null = null;
    for (let k = 0; k < net.len[i]; k++) {
      const lon = net.xy[(start + k) * 2] / net.scale;
      const lat = net.xy[(start + k) * 2 + 1] / net.scale;
      if (inBounds(lat, lon) && isInNepal(lat, lon)) {
        point = { lat, lon };
        break;
      }
    }
    if (!point) continue;

    // Collapse adjacent short reaches into one readable marker, retaining the
    // strongest channel in each ~5 km visual cell. This prevents the ranking
    // from filling with six near-identical points along the same trunk river.
    const key = `${Math.round(point.lat / 0.05)},${Math.round(point.lon / 0.05)}`;
    const candidate: Candidate = {
      ...point,
      meanCms,
      uplandKm2: net.upland[i] / 10,
      strahler: net.ord[i],
      source: 'hydrorivers',
    };
    const prior = byMapCell.get(key);
    if (!prior || candidate.meanCms > prior.meanCms) byMapCell.set(key, candidate);
  }

  const ranked = [...byMapCell.values()].sort((a, b) => b.meanCms - a.meanCms);
  return {
    cells: ranked.slice(0, MAX_VISIBLE),
    limited: ranked.length > MAX_VISIBLE,
    source: 'hydrorivers',
  };
}

// ---------------------------------------------------------------------------
// Nepal licensed hydropower projects — Open Data Nepal (DoED registry)
// ---------------------------------------------------------------------------

/** Minimal RFC4180-ish parser: handles quoted fields and embedded commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c !== '\r') cur += c;
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

export type NepalProject = {
  name: string;
  district: string;
  capacityMW: number | null;
  river: string;
  promoter: string;
  /** Survey = studying it, Generation = licensed to build, Operation = already running. */
  stage: string;
  licenseNo: string;
  /** Bikram Sambat year the licence runs to. BS - 57 is roughly the AD year. */
  validityBs: string;
  lat: number;
  lon: number;
  distanceKm: number;
};

const PROJECTS_URL =
  'https://api.opendatanepal.com/dataset/bb1bad3f-ddf3-487a-a220-e7ca989d3085/resource/' +
  '5f21e34f-c6d4-4c7f-ad8d-3469f78f99ac/download/tmpa8mgl0k6.csv';

let projectCache: Promise<Omit<NepalProject, 'distanceKm'>[]> | null = null;

/**
 * The 572 licensed Nepali hydropower projects, with coordinates.
 * 128 KB, `access-control-allow-origin: *`, so it is fetched live and cached for
 * the session rather than bundled.
 */
/**
 * Discovery outside Nepal, where there is no bundled river network.
 *
 * Samples the GloFAS grid across the view in ONE multi-location request. This is
 * the fallback, not the default: the Nepal path reads the bundled HydroRIVERS
 * network and costs nothing, whereas this hits a shared free API that rate-limits
 * hard — so it stays at 100 points and widens the grid step rather than paging.
 */
export async function scanGlofasCandidates(
  bounds: { west: number; south: number; east: number; north: number },
  signal?: AbortSignal
): Promise<ScanResult> {
  const MAX_POINTS = 100;
  const CELL = 0.05;
  let step = CELL;
  const spanX = Math.abs(bounds.east - bounds.west);
  const spanY = Math.abs(bounds.north - bounds.south);
  while ((spanX / step + 1) * (spanY / step + 1) > MAX_POINTS) step *= 2;

  const lats: number[] = [];
  const lons: number[] = [];
  for (let y = bounds.south; y <= bounds.north && lats.length < MAX_POINTS; y += step) {
    for (let x = bounds.west; x <= bounds.east && lats.length < MAX_POINTS; x += step) {
      lats.push(y);
      lons.push(x);
    }
  }
  if (lats.length === 0) return { cells: [], limited: false, source: 'glofas' };

  const end = new Date();
  end.setDate(end.getDate() - 2);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  const url =
    `https://flood-api.open-meteo.com/v1/flood?latitude=${lats.map((v) => v.toFixed(4)).join(',')}` +
    `&longitude=${lons.map((v) => v.toFixed(4)).join(',')}&daily=river_discharge` +
    `&start_date=${start.toISOString().slice(0, 10)}&end_date=${end.toISOString().slice(0, 10)}`;

  const raw = await getJson<unknown>(url, signal);
  const list = (Array.isArray(raw) ? raw : [raw]) as {
    latitude: number;
    longitude: number;
    daily?: { river_discharge: (number | null)[] };
  }[];
  // Several sampled points snap to the same model cell; keep the strongest.
  const byCell = new Map<string, Candidate>();
  for (const e of list) {
    const v = (e.daily?.river_discharge ?? []).filter((x): x is number => x !== null);
    if (v.length === 0) continue;
    const meanCms = v.reduce((a, b) => a + b, 0) / v.length;
    if (!Number.isFinite(meanCms) || meanCms <= 0) continue;
    const key = `${e.latitude.toFixed(3)},${e.longitude.toFixed(3)}`;
    const prev = byCell.get(key);
    if (!prev || meanCms > prev.meanCms) {
      byCell.set(key, { lat: e.latitude, lon: e.longitude, meanCms, source: 'glofas' });
    }
  }
  return {
    cells: [...byCell.values()].sort((a, b) => b.meanCms - a.meanCms),
    limited: step > CELL,
    source: 'glofas',
  };
}

export function fetchNepalProjects(signal?: AbortSignal) {
  if (projectCache) return projectCache;
  projectCache = (async () => {
    const res = await fetch(PROJECTS_URL, { signal });
    if (!res.ok) throw new Error(`Open Data Nepal: HTTP ${res.status}`);
    const rows = parseCsv(await res.text());
    if (rows.length < 2) return [];
    const head = rows[0].map((h) => h.trim());
    const col = (want: RegExp) => head.findIndex((h) => want.test(h));
    const iName = col(/^Project$/i);
    const iDist = col(/^District$/i);
    const iCap = col(/Capacity/i);
    const iRiver = col(/^River$/i);
    const iProm = col(/^Promoter$/i);
    const iLic = col(/Lic No/i);
    const iVal = col(/Validity/i);
    const iLon = col(/^Longitude$/i);
    const iLat = col(/^Latitude$/i);
    const iType = col(/License Type/i);
    const out: Omit<NepalProject, 'distanceKm'>[] = [];
    for (const r of rows.slice(1)) {
      const lat = Number(r[iLat]);
      const lon = Number(r[iLon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!isInNepal(lat, lon)) continue; // guards against stray/blank rows
      const cap = parseFloat(r[iCap]);
      out.push({
        name: (r[iName] ?? '').trim(),
        district: (r[iDist] ?? '').trim(),
        capacityMW: Number.isFinite(cap) ? cap : null,
        river: (r[iRiver] ?? '').trim(),
        promoter: (r[iProm] ?? '').trim(),
        stage: (r[iType] ?? '').trim(),
        licenseNo: (r[iLic] ?? '').trim(),
        validityBs: ((r[iVal] ?? '').trim().split('/').pop() ?? '').trim(),
        lat,
        lon,
      });
    }
    return out;
  })().catch((e) => {
    projectCache = null; // let a later attempt retry
    throw e;
  });
  return projectCache;
}

export function projectsNear(
  all: readonly Omit<NepalProject, 'distanceKm'>[],
  lat: number,
  lon: number,
  radiusKm = 25
): NepalProject[] {
  return all
    .map((p) => ({ ...p, distanceKm: haversineKm([lat, lon], [p.lat, p.lon]) }))
    .filter((p) => p.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

// ---------------------------------------------------------------------------
// Existing infrastructure — OSM via Overpass.
// POST with Content-Type: text/plain is CORS-safelisted, so no preflight: one round trip.
// ---------------------------------------------------------------------------

export type OsmFeature = {
  id: string;
  kind: 'dam' | 'weir' | 'plant' | 'reservoir' | 'intake';
  name: string | null;
  lat: number;
  lon: number;
  distanceKm: number;
  capacityMW: number | null;
  operator: string | null;
  /** `water-pumped-storage` must not be presented as a comparable run-of-river plant. */
  method: string | null;
};

function parseCapacityMW(v: string | undefined): number | null {
  if (!v) return null;
  const m = /([\d.]+)\s*(k|M|G)?W/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const scale = m[2]?.toLowerCase() === 'k' ? 1e-3 : m[2]?.toLowerCase() === 'g' ? 1e3 : 1;
  return n * scale;
}

export async function fetchNearbyInfrastructure(
  lat: number,
  lon: number,
  radiusKm = 25,
  signal?: AbortSignal
): Promise<OsmFeature[]> {
  const r = Math.round(radiusKm * 1000);
  // NOTE: waterway=penstock does not exist in OSM — verified over all of Switzerland.
  const q = `[out:json][timeout:40];
(
  nwr["waterway"~"^(dam|weir)$"](around:${r},${lat},${lon});
  nwr["power"="plant"]["plant:source"="hydro"](around:${r},${lat},${lon});
  nwr["power"="generator"]["generator:source"="hydro"](around:${r},${lat},${lon});
  nwr["landuse"="reservoir"](around:${r},${lat},${lon});
  nwr["water"="reservoir"](around:${r},${lat},${lon});
);
out center tags 120;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, // safelisted -> no preflight
    body: q,
    signal,
  });
  if (res.status === 429 || res.status === 504) {
    throw new Error('Overpass is rate-limiting right now — try again in a moment');
  }
  if (!res.ok) throw new Error(`Overpass: HTTP ${res.status}`);
  const j = (await res.json()) as {
    elements: {
      type: string;
      id: number;
      lat?: number;
      lon?: number;
      center?: { lat: number; lon: number };
      tags?: Record<string, string>;
    }[];
  };
  const seen = new Set<string>();
  const out: OsmFeature[] = [];
  for (const el of j.elements ?? []) {
    const t = el.tags ?? {};
    const p = el.center ?? (el.lat !== undefined ? { lat: el.lat, lon: el.lon! } : null);
    if (!p) continue;
    const kind: OsmFeature['kind'] =
      t.power === 'plant' || t.power === 'generator'
        ? 'plant'
        : t.waterway === 'dam'
          ? 'dam'
          : t.waterway === 'weir'
            ? 'weir'
            : 'reservoir';
    const key = `${kind}:${t.name ?? ''}:${p.lat.toFixed(4)}:${p.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${el.type}/${el.id}`,
      kind,
      name: t.name ?? null,
      lat: p.lat,
      lon: p.lon,
      distanceKm: haversineKm([lat, lon], [p.lat, p.lon]),
      capacityMW:
        parseCapacityMW(t['plant:output:electricity']) ??
        parseCapacityMW(t['generator:output:electricity']),
      operator: t.operator ?? null,
      method: t['plant:method'] ?? t['generator:method'] ?? null,
    });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

// ---------------------------------------------------------------------------
// Terrain — AWS terrarium tiles decoded in the browser.
// O(tiles) not O(points): once the tiles are cached, sampling is free.
// ---------------------------------------------------------------------------

/**
 * Terrarium DEM sources, best first.
 *
 * Re:Earth (Mapterhorn) serves 512 px tiles up to z17; AWS tops out at z15 and
 * 404s beyond it — verified at 27.92,85.15 in Nepal. Since gross head is the most
 * error-sensitive input to the whole estimate, the finer source is worth the bytes.
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

function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

function loadTile(src: (typeof DEM_SOURCES)[number], z: number, x: number, y: number): Promise<ImageData | null> {
  const key = `${src.id}/${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const p = new Promise<ImageData | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // both sources send ACAO: *, so the canvas stays untainted
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

/**
 * Highest zoom whose tile count still fits the budget for this reach.
 * A short penstock therefore gets metre-scale sampling instead of the ~50 m
 * a fixed low zoom would give.
 */
function pickZoom(src: (typeof DEM_SOURCES)[number], from: [number, number], to: [number, number]): number {
  for (let z = src.maxZoom; z >= 8; z--) {
    const xs = [lonToTileX(from[1], z), lonToTileX(to[1], z)];
    const ys = [latToTileY(from[0], z), latToTileY(to[0], z)];
    const nx = Math.floor(Math.max(...xs)) - Math.floor(Math.min(...xs)) + 1;
    const ny = Math.floor(Math.max(...ys)) - Math.floor(Math.min(...ys)) + 1;
    if (nx * ny <= TILE_BUDGET) return z;
  }
  return 8;
}

/** Metres per pixel at this zoom and latitude. */
function groundResolution(z: number, tilePx: number, lat: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (2 ** z * tilePx);
}

/**
 * Elevation profile along the straight line between two points.
 * Terrarium decode: elev_m = (R * 256 + G + B / 256) - 32768.
 */
export async function fetchElevationProfile(
  from: [number, number],
  to: [number, number],
  samples = 160
): Promise<ElevationProfile> {
  const total = haversineKm(from, to);
  const pts: { lat: number; lon: number; distanceKm: number }[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    pts.push({
      lat: from[0] + t * (to[0] - from[0]),
      lon: from[1] + t * (to[1] - from[1]),
      distanceKm: t * total,
    });
  }

  // Try the finest source first; fall back if it has no coverage here.
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
    if ([...tiles.values()].every((t) => t === null)) continue; // no coverage — next source

    const points = pts.map((p) => {
      const fx = lonToTileX(p.lon, zoom);
      const fy = latToTileY(p.lat, zoom);
      const img = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
      let elevationM = NaN;
      if (img) {
        const px = Math.min(img.width - 1, Math.max(0, Math.floor((fx % 1) * img.width)));
        const py = Math.min(img.height - 1, Math.max(0, Math.floor((fy % 1) * img.height)));
        const o = (py * img.width + px) * 4;
        elevationM = img.data[o] * 256 + img.data[o + 1] + img.data[o + 2] / 256 - 32768;
      }
      return { ...p, elevationM };
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
  return { points: pts.map((p) => ({ ...p, elevationM: NaN })), source: 'none', zoom: 0, resolutionM: NaN, tilesFetched: 0 };
}
