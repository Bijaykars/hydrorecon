/**
 * Context around a scheme: who already holds this river, and what the terrain
 * upstream has been doing. Both are fetched straight from the browser; both had
 * `access-control-allow-origin: *` verified with real requests.
 *
 * These do not change the energy calculation. They change whether the site is
 * worth another day of anyone's time, which is the actual decision at screening.
 */
import { haversineKm } from './engine/hydro.ts';

// ---------------------------------------------------------------------------
// Licensed and operating hydropower — Department of Electricity Development,
// via the Open Data Nepal mirror. CC BY-SA.
// ---------------------------------------------------------------------------

export type Licence = {
  name: string;
  river: string;
  district: string;
  capacityMW: number | null;
  promoter: string;
  /** Survey / Generation / Operation. */
  stage: string;
  licenceNo: string;
  lat: number;
  lon: number;
  distanceKm: number;
};

const DOED_URL =
  'https://api.opendatanepal.com/dataset/bb1bad3f-ddf3-487a-a220-e7ca989d3085/resource/' +
  '5f21e34f-c6d4-4c7f-ad8d-3469f78f99ac/download/tmpa8mgl0k6.csv';

/** Quoted CSV with commas inside fields — a split(',') would shred it. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

let licenceCache: Promise<Omit<Licence, 'distanceKm'>[]> | null = null;

export function loadLicences(): Promise<Omit<Licence, 'distanceKm'>[]> {
  if (licenceCache) return licenceCache;
  licenceCache = (async () => {
    const res = await fetch(DOED_URL);
    if (!res.ok) throw new Error(`licence registry: HTTP ${res.status}`);
    const rows = parseCsv(await res.text());
    if (rows.length < 2) return [];
    const head = rows[0].map((h) => h.trim());
    const col = (re: RegExp) => head.findIndex((h) => re.test(h));
    const iName = col(/^Project$/i);
    const iRiver = col(/^River$/i);
    const iDist = col(/^District$/i);
    const iCap = col(/Capacity/i);
    const iProm = col(/^Promoter$/i);
    const iLic = col(/Lic No/i);
    const iLon = col(/^Longitude$/i);
    const iLat = col(/^Latitude$/i);
    const iType = col(/License Type/i);
    const out: Omit<Licence, 'distanceKm'>[] = [];
    for (const r of rows.slice(1)) {
      const lat = Number(r[iLat]);
      const lon = Number(r[iLon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      const cap = parseFloat(r[iCap]);
      out.push({
        name: (r[iName] ?? '').trim(),
        river: (r[iRiver] ?? '').trim(),
        district: (r[iDist] ?? '').trim(),
        capacityMW: Number.isFinite(cap) ? cap : null,
        promoter: (r[iProm] ?? '').trim(),
        stage: (r[iType] ?? '').trim(),
        licenceNo: (r[iLic] ?? '').trim(),
        lat,
        lon,
      });
    }
    return out;
  })().catch((e) => {
    licenceCache = null; // let a later attempt retry
    throw e;
  });
  return licenceCache;
}

/** Licences whose coordinates fall within `radiusKm` of any point on the reach. */
export function licencesAlong(
  all: readonly Omit<Licence, 'distanceKm'>[],
  path: readonly { lat: number; lon: number }[],
  radiusKm = 6
): Licence[] {
  if (path.length === 0) return [];
  // Coarse box first: 572 rows x a few hundred path points is otherwise wasteful.
  const pad = radiusKm / 100;
  let n = -90;
  let s = 90;
  let e = -180;
  let w = 180;
  for (const p of path) {
    n = Math.max(n, p.lat);
    s = Math.min(s, p.lat);
    e = Math.max(e, p.lon);
    w = Math.min(w, p.lon);
  }
  const out: Licence[] = [];
  for (const l of all) {
    if (l.lat > n + pad || l.lat < s - pad || l.lon > e + pad || l.lon < w - pad) continue;
    let best = Infinity;
    for (const p of path) {
      const d = haversineKm([l.lat, l.lon], [p.lat, p.lon]);
      if (d < best) best = d;
      if (best < 0.25) break; // close enough, stop measuring
    }
    if (best <= radiusKm) out.push({ ...l, distanceKm: best });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

// ---------------------------------------------------------------------------
// Recorded hazard events — NOT wired up, and here is why.
//
// Nepal's national disaster portal (bipadportal.gov.np/api/v1/incident/) is
// live and sends CORS, and it carries landslide, flood and GLOF records that
// this tool wants. But it has no working spatial filter: every documented and
// guessed bbox parameter is silently ignored — a Marsyangdi-window query
// returned 200 rows of which 2 were in the window — and the archive is about
// 62,000 records, so filtering client-side would mean ~310 requests per click.
// It also returns duplicates and a `count` field of int64-max.
//
// So it belongs in a build-time pipeline that mirrors it once into a compact
// static layer, not in a runtime fetch. Left undone rather than shipped slow.
// ---------------------------------------------------------------------------
