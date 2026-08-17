/**
 * Recorded natural-hazard incidents near a proposed Nepal layout.
 *
 * The bundled BIPAD points are historical reports, not a susceptibility map,
 * an earthquake catalogue, a GLOF routing model or a probability surface. The
 * only calculation here is distance from a reported point to the selected
 * intake-powerhouse river reach. Zero nearby records therefore means "none in
 * this screened public inventory", never "no hazard".
 */
import hazardRaw from './data/nepal-hazards.json' with { type: 'json' };

export type HazardKind =
  | 'landslide'
  | 'flood'
  | 'earthquake'
  | 'glof'
  | 'avalanche'
  | 'inundation';

type RawRecord = [id: number, date: string, lat: number, lon: number];
type RawCategory = {
  id: number;
  slug: HazardKind;
  title: string;
  records: RawRecord[];
};
type RawBundle = {
  _source: string;
  _fetchedFrom: string;
  _retrieved: string;
  _period: { from: string; to: string };
  _crs: string;
  _terms: string;
  _note: string;
  categories: RawCategory[];
};

const BUNDLE = hazardRaw as unknown as RawBundle;

export type HazardRecord = {
  id: number;
  kind: HazardKind;
  title: string;
  date: string;
  lat: number;
  lon: number;
  /** Local projected distance to the selected reach, kilometres. */
  distanceKm: number;
  /** Human-readable official BIPAD record. */
  url: string;
};

export type HazardInventoryRecord = Omit<HazardRecord, 'distanceKm'>;

export type HazardCategorySummary = {
  kind: HazardKind;
  title: string;
  count: number;
  /** Total approved + verified records in the bundled national inventory. */
  nationwideRecords: number;
  nearestKm: number | null;
  latestDate: string | null;
};

export type HazardScreen = {
  /** Corridor radius around the intake-powerhouse reach. */
  radiusKm: number;
  total: number;
  records: HazardRecord[];
  categories: HazardCategorySummary[];
  source: string;
  fetchedFrom: string;
  retrieved: string;
  period: { from: string; to: string };
  crs: string;
  limitation: string;
};

export const BIPAD_RETRIEVED = BUNDLE._retrieved;
export const BIPAD_PERIOD = BUNDLE._period;
export const BIPAD_RECORD_COUNT = BUNDLE.categories.reduce(
  (sum, category) => sum + category.records.length,
  0
);

const INVENTORY: readonly HazardInventoryRecord[] = BUNDLE.categories.flatMap((category) =>
  category.records.map(([id, date, lat, lon]) => ({
    id,
    kind: category.slug,
    title: category.title,
    date,
    lat,
    lon,
    url: `https://bipadportal.gov.np/incidents/${id}/response`,
  }))
);

/** Approved + verified national point inventory for directed-network screens. */
export function hazardInventory(
  kinds?: readonly HazardKind[]
): readonly HazardInventoryRecord[] {
  if (!kinds) return INVENTORY;
  const wanted = new Set(kinds);
  return INVENTORY.filter((record) => wanted.has(record.kind));
}

/** Category colours shared by the sidebar and MapLibre layer. */
export const HAZARD_COLORS: Record<HazardKind, string> = {
  landslide: '#b98255',
  flood: '#4fc1d8',
  earthquake: '#c07262',
  glof: '#75b5d0',
  avalanche: '#d7dce2',
  inundation: '#5d89b3',
};

/**
 * Point-to-segment distance in a local metric frame.
 *
 * EPSG:3857 is not used for analysis. At this <=15 km scale, a local
 * equirectangular frame centred on the segment keeps distortion far below the
 * precision of BIPAD's administrative/geocoded incident locations.
 */
function segmentKm(
  point: { lat: number; lon: number },
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const lat0 = ((point.lat + a.lat + b.lat) / 3) * (Math.PI / 180);
  const kx = 111.32 * Math.cos(lat0);
  const ky = 110.574;
  const px = (point.lon - a.lon) * kx;
  const py = (point.lat - a.lat) * ky;
  const dx = (b.lon - a.lon) * kx;
  const dy = (b.lat - a.lat) * ky;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
}

/** Shortest local-metric distance from one point to a polyline. */
export function pointToPathKm(
  point: { lat: number; lon: number },
  path: readonly { lat: number; lon: number }[]
): number {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return segmentKm(point, path[0], path[0]);
  let best = Infinity;
  for (let index = 0; index + 1 < path.length; index++) {
    best = Math.min(best, segmentKm(point, path[index], path[index + 1]));
  }
  return best;
}

/**
 * Approved and verified BIPAD records inside a corridor around this layout.
 *
 * Fifteen kilometres is intentionally a broad investigation catchment: many
 * BIPAD points are municipality/ward locations rather than surveyed scars. It
 * is useful for discovering evidence to inspect, not for deciding exposure.
 */
export function hazardsFor(
  path: readonly { lat: number; lon: number }[],
  radiusKm = 15
): HazardScreen {
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error('hazard-screen radius must be a positive number');
  }

  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const point of path) {
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
    west = Math.min(west, point.lon);
    east = Math.max(east, point.lon);
  }
  const meanLat = path.length ? (south + north) / 2 : 28;
  const padLat = radiusKm / 110.574;
  const padLon = radiusKm / (111.32 * Math.cos((meanLat * Math.PI) / 180));

  const records: HazardRecord[] = [];
  const categories: HazardCategorySummary[] = [];
  for (const category of BUNDLE.categories) {
    const hits: HazardRecord[] = [];
    if (path.length) {
      for (const [id, date, lat, lon] of category.records) {
        // Cheap bounding-box reject before visiting each reach segment.
        if (
          lat < south - padLat ||
          lat > north + padLat ||
          lon < west - padLon ||
          lon > east + padLon
        ) {
          continue;
        }
        const distanceKm = pointToPathKm({ lat, lon }, path);
        if (distanceKm > radiusKm) continue;
        hits.push({
          id,
          kind: category.slug,
          title: category.title,
          date,
          lat,
          lon,
          distanceKm,
          url: `https://bipadportal.gov.np/incidents/${id}/response`,
        });
      }
    }
    hits.sort((a, b) => a.distanceKm - b.distanceKm || b.date.localeCompare(a.date));
    records.push(...hits);
    categories.push({
      kind: category.slug,
      title: category.title,
      count: hits.length,
      nationwideRecords: category.records.length,
      nearestKm: hits[0]?.distanceKm ?? null,
      latestDate: hits.reduce<string | null>(
        (latest, record) => (!latest || record.date > latest ? record.date : latest),
        null
      ),
    });
  }

  records.sort((a, b) => a.distanceKm - b.distanceKm || b.date.localeCompare(a.date));
  return {
    radiusKm,
    total: records.length,
    records,
    categories,
    source: BUNDLE._source,
    fetchedFrom: BUNDLE._fetchedFrom,
    retrieved: BUNDLE._retrieved,
    period: BUNDLE._period,
    crs: BUNDLE._crs,
    limitation:
      'Historical approved/verified reports only. Counts are not independent events, susceptibility or probability; locations may be administrative points, no-record is not no-hazard, and GLOF/flood exposure needs upstream routing.',
  };
}
