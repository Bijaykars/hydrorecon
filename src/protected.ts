/**
 * Is this site inside a protected area?
 *
 * About a quarter of Nepal is national park, wildlife reserve or conservation
 * area, and what may be built inside each differs sharply. Ranking a scheme in
 * the middle of Sagarmatha National Park alongside one on an unprotected river
 * is not screening — it is wasting the engineer's afternoon on something that
 * cannot be permitted. This is a go/no-go input and belongs beside the capacity
 * figure, not in a footnote.
 *
 * WHAT THIS DOES NOT DO: decide the legal question. Nepal's conservation areas
 * genuinely host hydropower — several licensed schemes sit inside Annapurna —
 * while national parks effectively do not, and buffer zones differ again from
 * both. So the answer is which designation the site falls inside and what that
 * usually means, leaving the permission question where it belongs, with DNPWC.
 *
 * Boundaries are OpenStreetMap's, simplified to about 200 m. That is fine for
 * "you are well inside Chitwan" and useless for "you are 150 m outside the
 * boundary" — near an edge, the answer is that it is near an edge.
 */
import protectedRaw from './data/nepal-protected.json' with { type: 'json' };

type RawArea = {
  n: string;
  k: string;
  c: string | null;
  r: string;
  a: number;
  /** Flat [lat, lon, lat, lon, …] per ring. */
  rings: number[][];
};

const PROTECTED_BUNDLE = protectedRaw as unknown as { _retrieved: string; areas: RawArea[] };
const AREAS = PROTECTED_BUNDLE.areas;
export const PROTECTED_RETRIEVED = PROTECTED_BUNDLE._retrieved;

export type ProtectedHit = {
  name: string;
  /** What the designation usually means for a developer. */
  regime: string;
  kind: string;
  areaKm2: number;
  /**
   * True when the point sits within the simplification tolerance of a boundary,
   * where inside and outside cannot honestly be distinguished.
   */
  nearEdge: boolean;
  /**
   * Distance to the boundary, km — set only by `protectedNear`, where the point
   * is outside. `edgeDistDeg` already scales longitude by cos(lat), so its
   * degrees convert straight to km.
   */
  distanceKm?: number;
};

/** Roughly the simplification tolerance, in degrees. */
const EDGE_DEG = 250 / 111320;

/** Even-odd ray cast against every ring of one area. */
function inside(lat: number, lon: number, rings: number[][]): boolean {
  let hit = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i];
      const xi = r[i + 1];
      const yj = r[j];
      const xj = r[j + 1];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

/** Shortest distance from the point to any boundary segment, in degrees. */
function edgeDistDeg(lat: number, lon: number, rings: number[][]): number {
  let best = Infinity;
  const cos = Math.cos((lat * Math.PI) / 180);
  for (const r of rings) {
    for (let i = 0; i + 3 < r.length; i += 2) {
      const ay = r[i];
      const ax = r[i + 1];
      const by = r[i + 2];
      const bx = r[i + 3];
      const dy = by - ay;
      const dx = (bx - ax) * cos;
      const py = lat - ay;
      const px = (lon - ax) * cos;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Every protected area containing this point, largest first.
 *
 * More than one can apply: Nepal nests buffer zones against parks, and a site
 * can sit inside both a conservation area and something stricter within it.
 */
export function protectedAt(lat: number, lon: number): ProtectedHit[] {
  const hits: ProtectedHit[] = [];
  for (const a of AREAS) {
    if (!inside(lat, lon, a.rings)) continue;
    hits.push({
      name: a.n,
      regime: a.r,
      kind: a.k,
      areaKm2: a.a,
      nearEdge: edgeDistDeg(lat, lon, a.rings) < EDGE_DEG,
    });
  }
  return hits.sort((x, y) => y.areaKm2 - x.areaKm2);
}

/**
 * Areas the point is not inside but sits close to.
 *
 * Worth saying, because a boundary simplified to 200 m cannot settle a site
 * that is 300 m outside one, and because an intake outside a park with its
 * powerhouse inside is still a park problem.
 */
export function protectedNear(lat: number, lon: number, km = 3): ProtectedHit[] {
  const tol = km / 111.32;
  const out: ProtectedHit[] = [];
  for (const a of AREAS) {
    if (inside(lat, lon, a.rings)) continue;
    const d = edgeDistDeg(lat, lon, a.rings);
    if (d <= tol) {
      out.push({
        name: a.n,
        regime: a.r,
        kind: a.k,
        areaKm2: a.a,
        nearEdge: true,
        distanceKm: d * 111.32,
      });
    }
  }
  return out;
}

/** Whether any hit is one that would stop a project outright. */
export const isHardStop = (hits: ProtectedHit[]): boolean =>
  hits.some((h) => /prohibited|heavily restricted/i.test(h.regime));

export const PROTECTED_COUNT = AREAS.length;

/** Simplified national protected-area boundaries for visible map context. */
export function protectedAreasGeoJson(): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: AREAS.map((area) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: area.rings.map((ring) => {
          const coordinates = Array.from({ length: Math.floor(ring.length / 2) }, (_, i) => [
            ring[i * 2 + 1],
            ring[i * 2],
          ]);
          const first = coordinates[0];
          const last = coordinates.at(-1);
          if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
            coordinates.push([...first]);
          }
          return coordinates;
        }),
      },
      properties: {
        name: area.n,
        kind: area.k,
        regime: area.r,
        areaKm2: area.a,
      },
    })),
  };
}
