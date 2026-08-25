/**
 * Official hydropower development context around a proposed scheme.
 *
 * The first release downloaded a third-party CSV mirror at runtime. That made
 * the answer depend on CORS, connectivity and a snapshot whose age was unknown.
 * This module instead reads a reproducible bundle built directly from all nine
 * public DoED hydro tables. The source update and retrieval dates travel with
 * the data, and the build fails if a table has a missing serial number.
 */
import projectsRaw from './data/doed-projects.json' with { type: 'json' };
import { haversineKm } from './engine/hydro.ts';

export type Licence = {
  name: string;
  river: string;
  district: string;
  capacityMW: number | null;
  promoter: string;
  /** Official DoED category, including applications as well as issued licences. */
  stage:
    | 'Operating'
    | 'Construction licence'
    | 'Survey licence'
    | 'Construction application'
    | 'Survey application';
  licenceNo: string;
  issued: string;
  validUntil: string | null;
  commissioned: string | null;
  lat: number;
  lon: number;
  /** DoED-published [south, west, north, east] coordinate range. */
  bounds: [number, number, number, number];
  source: string;
  /** Distance to the published coordinate range, not merely its midpoint. */
  distanceKm: number;
};

/** Geolocated official record before a site-specific distance is attached. */
export type DoedProject = Omit<Licence, 'distanceKm'>;

type BundledProject = Omit<Licence, 'lat' | 'lon' | 'bounds' | 'distanceKm'> & {
  lat: number | null;
  lon: number | null;
  bounds: [number, number, number, number] | null;
};

type Registry = {
  _retrieved: string;
  _updated: string;
  projects: BundledProject[];
};

const REGISTRY = projectsRaw as unknown as Registry;

export const DOED_UPDATED = REGISTRY._updated;
export const DOED_RETRIEVED = REGISTRY._retrieved;
export const DOED_REGISTER_URL = 'https://doed.gov.np/';

const PROJECTS: DoedProject[] = REGISTRY.projects
  .filter(
    (p): p is BundledProject & {
      lat: number;
      lon: number;
      bounds: [number, number, number, number];
    } =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lon) &&
      p.bounds !== null &&
      p.lat! > 26 &&
      p.lat! < 31 &&
      p.lon! > 80 &&
      p.lon! < 89
  )
  .map((p) => ({ ...p, lat: p.lat, lon: p.lon, bounds: p.bounds }));

/** Kept asynchronous so callers do not need to care whether a future bundle is lazy-loaded. */
export function loadLicences(): Promise<DoedProject[]> {
  return Promise.resolve(PROJECTS);
}

/**
 * Conservative distance from a point to DoED's published coordinate range.
 *
 * DoED gives north/south and east/west limits, not an alignment. Measuring only
 * to their midpoint can miss a long storage project by tens of kilometres. A
 * clamped point-to-box distance is safer for conflict screening: it may flag a
 * project whose actual works sit elsewhere in the box, but it does not silently
 * miss one whose published range crosses the proposed reach.
 */
function distanceToBounds(
  p: { lat: number; lon: number },
  [south, west, north, east]: readonly number[]
): number {
  const lat = Math.max(south, Math.min(north, p.lat));
  const lon = Math.max(west, Math.min(east, p.lon));
  return haversineKm([p.lat, p.lon], [lat, lon]);
}

const stageRank = (stage: Licence['stage']): number => {
  if (stage === 'Operating') return 0;
  if (stage === 'Construction licence') return 1;
  if (stage === 'Construction application') return 2;
  if (stage === 'Survey licence') return 3;
  return 4;
};

/** DoED records whose published coordinate range lies within `radiusKm` of the reach. */
export function licencesAlong(
  all: readonly DoedProject[],
  path: readonly { lat: number; lon: number }[],
  radiusKm = 6
): Licence[] {
  if (path.length === 0) return [];
  // Latitude pad. Longitude degrees are narrower, so they need a wider one —
  // see lonPad below; a single pad rejected licences inside the radius.
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

  const lonPad = pad / Math.max(0.2, Math.cos((((n + s) / 2) * Math.PI) / 180));

  const out: Licence[] = [];
  for (const project of all) {
    const [south, west, north, east] = project.bounds;
    if (south > n + pad || north < s - pad || west > e + lonPad || east < w - lonPad) continue;
    let best = Infinity;
    for (const p of path) {
      const d = distanceToBounds(p, project.bounds);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best <= radiusKm) out.push({ ...project, distanceKm: best });
  }

  // The six visible rows must never hide an operating or construction conflict
  // behind a nearer survey application.
  return out.sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || a.distanceKm - b.distanceKm);
}
