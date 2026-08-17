/**
 * Geological evidence for the selected river reach.
 *
 * DMG contributes an authoritative publication-availability index. Macrostrat
 * contributes open, harmonized regional context at three points. Neither is an
 * engineering-geology model, so this module deliberately exposes source scale,
 * rights and limitations beside every result.
 */
import raw from './data/nepal-geology-maps.json' with { type: 'json' };

export type GeoPoint = { lat: number; lon: number };
export type SheetBounds = [west: number, south: number, east: number, north: number];

export type DmgSheet = { code: string; bounds: SheetBounds };
export type DmgMap = {
  id: number;
  title: string;
  published: string;
  previewUrl: string;
  sheets: DmgSheet[];
};

type DmgBundle = {
  _source: string;
  _sourceUrl: string;
  _sourceUpdated: string;
  _retrieved: string;
  _scale: string;
  _crs: string;
  _rights: string;
  _availability: string;
  _geometryMethod: string;
  _note: string;
  maps: DmgMap[];
};

const bundle = raw as unknown as DmgBundle;

export const DMG_MAP_COUNT = bundle.maps.length;
export const DMG_SOURCE = bundle._source;
export const DMG_SOURCE_URL = bundle._sourceUrl;
export const DMG_UPDATED = bundle._sourceUpdated;
export const DMG_RETRIEVED = bundle._retrieved;

export type DmgMapMatch = Omit<DmgMap, 'sheets'> & {
  /** Only the publication parts touched by the selected reach. */
  sheets: DmgSheet[];
};

export type DmgGeologyScreen = {
  maps: DmgMapMatch[];
  catalogMaps: number;
  source: string;
  sourceUrl: string;
  updated: string;
  retrieved: string;
  scale: string;
  crs: string;
  rights: string;
  availability: string;
  geometryMethod: string;
  limitation: string;
};

const inside = (point: GeoPoint, [west, south, east, north]: SheetBounds) =>
  point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north;

const orient = (a: GeoPoint, b: GeoPoint, c: GeoPoint) =>
  (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);

const between = (a: number, b: number, value: number) =>
  value >= Math.min(a, b) - 1e-12 && value <= Math.max(a, b) + 1e-12;

/** Inclusive segment intersection, including a reach running along a sheet edge. */
const segmentsIntersect = (a: GeoPoint, b: GeoPoint, c: GeoPoint, d: GeoPoint) => {
  const abC = orient(a, b, c);
  const abD = orient(a, b, d);
  const cdA = orient(c, d, a);
  const cdB = orient(c, d, b);
  const eps = 1e-12;
  if (((abC > eps && abD < -eps) || (abC < -eps && abD > eps)) &&
      ((cdA > eps && cdB < -eps) || (cdA < -eps && cdB > eps))) return true;
  if (Math.abs(abC) <= eps && between(a.lon, b.lon, c.lon) && between(a.lat, b.lat, c.lat)) return true;
  if (Math.abs(abD) <= eps && between(a.lon, b.lon, d.lon) && between(a.lat, b.lat, d.lat)) return true;
  if (Math.abs(cdA) <= eps && between(c.lon, d.lon, a.lon) && between(c.lat, d.lat, a.lat)) return true;
  return Math.abs(cdB) <= eps && between(c.lon, d.lon, b.lon) && between(c.lat, d.lat, b.lat);
};

export function reachIntersectsSheet(path: readonly GeoPoint[], bounds: SheetBounds): boolean {
  if (path.some((point) => inside(point, bounds))) return true;
  const [west, south, east, north] = bounds;
  const corners: GeoPoint[] = [
    { lon: west, lat: south },
    { lon: east, lat: south },
    { lon: east, lat: north },
    { lon: west, lat: north },
  ];
  for (let i = 1; i < path.length; i += 1) {
    for (let edge = 0; edge < 4; edge += 1) {
      if (segmentsIntersect(path[i - 1], path[i], corners[edge], corners[(edge + 1) % 4])) return true;
    }
  }
  return false;
}

/** Official published 1:50,000 map products whose derived sheet footprints touch this reach. */
export function geologyMapsFor(path: readonly GeoPoint[]): DmgGeologyScreen {
  const maps = bundle.maps.flatMap((map) => {
    const sheets = map.sheets.filter((sheet) => reachIntersectsSheet(path, sheet.bounds));
    return sheets.length ? [{ ...map, sheets }] : [];
  });
  return {
    maps,
    catalogMaps: bundle.maps.length,
    source: bundle._source,
    sourceUrl: bundle._sourceUrl,
    updated: bundle._sourceUpdated,
    retrieved: bundle._retrieved,
    scale: bundle._scale,
    crs: bundle._crs,
    rights: bundle._rights,
    availability: bundle._availability,
    geometryMethod: bundle._geometryMethod,
    limitation:
      maps.length > 0
        ? bundle._note
        : 'No published 1:50,000 map was identified for this reach in the official online catalog; this is a catalog no-match, not an absence of geology or previous mapping.',
  };
}

export type RegionalGeologyUnit = {
  mapId: number;
  sourceId: number;
  name: string;
  lithology: string;
  topInterval: string | null;
  bottomInterval: string | null;
  topAgeMa: number | null;
  bottomAgeMa: number | null;
  color: string | null;
};

export type RegionalGeologySample = {
  role: 'intake' | 'mid-reach' | 'powerhouse';
  lat: number;
  lon: number;
  units: RegionalGeologyUnit[];
};

export type RegionalGeologyScreen = {
  samples: RegionalGeologySample[];
  references: Record<string, string>;
  source: string;
  sourceUrl: string;
  license: 'CC-BY 4.0';
  limitation: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

const MACROSTRAT_URL = 'https://macrostrat.org/api/v2/geologic_units/map';
const regionalCache = new Map<string, Promise<{ units: RegionalGeologyUnit[]; refs: Record<string, string> }>>();

const finiteOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

async function fetchRegionalPoint(point: GeoPoint, signal: AbortSignal | undefined, fetcher: FetchLike) {
  const key = `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
  if (fetcher === fetch && regionalCache.has(key)) return regionalCache.get(key)!;
  const job = (async () => {
    const url = `${MACROSTRAT_URL}?lat=${encodeURIComponent(point.lat.toFixed(6))}&lng=${encodeURIComponent(point.lon.toFixed(6))}`;
    const response = await fetcher(url, { headers: { accept: 'application/json' }, signal });
    if (!response.ok) throw new Error(`Macrostrat regional geology failed: HTTP ${response.status}`);
    const payload = await response.json() as { success?: { license?: unknown; data?: unknown; refs?: unknown } };
    if (payload.success?.license !== 'CC-BY 4.0') {
      throw new Error('Macrostrat response licence is missing or changed; regional geology was not used');
    }
    if (!Array.isArray(payload.success.data)) throw new Error('Macrostrat regional geology response has no data array');
    const refs = payload.success.refs && typeof payload.success.refs === 'object'
      ? Object.fromEntries(Object.entries(payload.success.refs).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {};
    const units = payload.success.data.flatMap((item): RegionalGeologyUnit[] => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      if (typeof row.map_id !== 'number' || typeof row.source_id !== 'number') return [];
      return [{
        mapId: row.map_id,
        sourceId: row.source_id,
        name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Unnamed mapped unit',
        lithology: typeof row.lith === 'string' && row.lith.trim() ? row.lith.trim() : 'lithology not stated',
        topInterval: typeof row.t_int_name === 'string' && row.t_int_name.trim() ? row.t_int_name.trim() : null,
        bottomInterval: typeof row.b_int_name === 'string' && row.b_int_name.trim() ? row.b_int_name.trim() : null,
        topAgeMa: finiteOrNull(row.t_age),
        bottomAgeMa: finiteOrNull(row.b_age),
        color: typeof row.color === 'string' && /^#[0-9a-f]{6}$/i.test(row.color) ? row.color : null,
      }];
    });
    return { units, refs };
  })();
  if (fetcher === fetch) regionalCache.set(key, job);
  try {
    return await job;
  } catch (error) {
    if (fetcher === fetch) regionalCache.delete(key);
    throw error;
  }
}

/**
 * Sample open regional geology at intake, midpoint and powerhouse.
 * Sampling points is intentional: no generalized polygon is presented as a
 * surveyed contact or a foundation/tunnel model.
 */
export async function fetchRegionalGeology(
  path: readonly GeoPoint[],
  signal?: AbortSignal,
  fetcher: FetchLike = fetch
): Promise<RegionalGeologyScreen> {
  if (!path.length) throw new Error('regional geology needs at least one reach point');
  const points = [path[0], path[Math.floor((path.length - 1) / 2)], path[path.length - 1]];
  const roles = ['intake', 'mid-reach', 'powerhouse'] as const;
  const results = await Promise.all(points.map((point) => fetchRegionalPoint(point, signal, fetcher)));
  return {
    samples: results.map((result, index) => ({ role: roles[index], ...points[index], units: result.units })),
    references: Object.assign({}, ...results.map((result) => result.refs)),
    source: 'Macrostrat geologic map API',
    sourceUrl: 'https://macrostrat.org/map/usage',
    license: 'CC-BY 4.0',
    limitation:
      'Harmonized small-scale regional map context only. It cannot establish site lithology, a contact location, rock mass, weathering, discontinuities, permeability, foundation or tunnel conditions; an empty result is not geological clearance.',
  };
}

export type GeologyScreen = {
  dmg: DmgGeologyScreen | null;
  regional: RegionalGeologyScreen | null;
  regionalError: string | null;
};
