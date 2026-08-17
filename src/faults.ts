/**
 * Regional mapped active-fault context for Nepal layouts.
 *
 * Geometry is measured in a local engineering frame centred on the selected
 * reach. Web Mercator is deliberately not used. This is a discovery screen:
 * a regional trace is neither a surveyed fault location nor a seismic design
 * action, and the selected river reach is not a routed project waterway.
 */
import raw from './data/nepal-faults.json' with { type: 'json' };

export type FaultTrace = {
  id: string;
  sourceId: string;
  name: string | null;
  type: string;
  reference: string | null;
  /** [longitude, latitude], EPSG:4326. */
  points: [number, number][];
};

type RawBundle = {
  _source: string;
  _sourceUrl: string;
  _commit: string;
  _retrieved: string;
  _license: string;
  _licenseUrl: string;
  _attribution: string;
  _citation: string;
  _crs: string;
  _coordinateOrder: string;
  _regionalFaultSourceCount: number;
  _note: string;
  traces: FaultTrace[];
};

const BUNDLE = raw as unknown as RawBundle;

export type FaultPathPoint = { lat: number; lon: number; km?: number };

export type FaultHit = {
  id: string;
  sourceId: string;
  name: string | null;
  type: string;
  reference: string | null;
  points: readonly [number, number][];
  /** Minimum local-projected separation from the selected reach. */
  distanceKm: number;
  /** True only when the two mapped polylines intersect. */
  intersectsReach: boolean;
  /** Distance along the selected reach to its nearest/intersection point. */
  chainageKm: number;
  nearestReachPoint: { lat: number; lon: number };
  nearestFaultPoint: { lat: number; lon: number };
};

export type FaultScreen = {
  radiusKm: number;
  nearby: FaultHit[];
  nearest: FaultHit | null;
  crossings: number;
  source: string;
  sourceUrl: string;
  commit: string;
  retrieved: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  citation: string;
  crs: string;
  regionalFaultSources: number;
  limitation: string;
};

export const FAULT_RETRIEVED = BUNDLE._retrieved;
export const FAULT_TRACE_COUNT = BUNDLE._regionalFaultSourceCount;
export const FAULT_SOURCE_URL = BUNDLE._sourceUrl;
export const FAULT_COLOR = '#d77a68';

type XY = { x: number; y: number };
type Closest = { distance: number; t: number; u: number; intersects: boolean };

const cross = (a: XY, b: XY) => a.x * b.y - a.y * b.x;
const dot = (a: XY, b: XY) => a.x * b.x + a.y * b.y;
const minus = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });

function pointSegment(p: XY, a: XY, b: XY): { distance: number; t: number } {
  const d = minus(b, a);
  const length2 = dot(d, d);
  const t = length2 > 0 ? Math.max(0, Math.min(1, dot(minus(p, a), d) / length2)) : 0;
  return { distance: Math.hypot(p.x - (a.x + t * d.x), p.y - (a.y + t * d.y)), t };
}

/** Exact intersection when present, otherwise the closest endpoint/segment pair. */
function closestSegments(a: XY, b: XY, c: XY, d: XY): Closest {
  const r = minus(b, a);
  const s = minus(d, c);
  const denom = cross(r, s);
  const ca = minus(c, a);
  const scale = Math.max(1, Math.hypot(r.x, r.y), Math.hypot(s.x, s.y));
  if (Math.abs(denom) > 1e-12 * scale * scale) {
    const t = cross(ca, s) / denom;
    const u = cross(ca, r) / denom;
    if (t >= -1e-12 && t <= 1 + 1e-12 && u >= -1e-12 && u <= 1 + 1e-12) {
      return {
        distance: 0,
        t: Math.max(0, Math.min(1, t)),
        u: Math.max(0, Math.min(1, u)),
        intersects: true,
      };
    }
  }
  // Collinear overlap is an intersection too. It matters when a generalized
  // regional trace happens to follow the generalized river centreline.
  if (Math.abs(denom) <= 1e-12 * scale * scale && Math.abs(cross(ca, r)) <= 1e-12 * scale * scale) {
    const r2 = dot(r, r);
    const s2 = dot(s, s);
    if (r2 > 0 && s2 > 0) {
      const tc = dot(minus(c, a), r) / r2;
      const td = dot(minus(d, a), r) / r2;
      const lo = Math.max(0, Math.min(tc, td));
      const hi = Math.min(1, Math.max(tc, td));
      if (lo <= hi + 1e-12) {
        const t = Math.max(0, Math.min(1, lo));
        const p = { x: a.x + r.x * t, y: a.y + r.y * t };
        const u = Math.max(0, Math.min(1, dot(minus(p, c), s) / s2));
        return { distance: 0, t, u, intersects: true };
      }
    }
  }

  const candidates: Closest[] = [];
  const acd = pointSegment(a, c, d);
  candidates.push({ distance: acd.distance, t: 0, u: acd.t, intersects: false });
  const bcd = pointSegment(b, c, d);
  candidates.push({ distance: bcd.distance, t: 1, u: bcd.t, intersects: false });
  const cab = pointSegment(c, a, b);
  candidates.push({ distance: cab.distance, t: cab.t, u: 0, intersects: false });
  const dab = pointSegment(d, a, b);
  candidates.push({ distance: dab.distance, t: dab.t, u: 1, intersects: false });
  return candidates.reduce((best, candidate) =>
    candidate.distance < best.distance ? candidate : best
  );
}

function pointAt(a: FaultPathPoint, b: FaultPathPoint, t: number) {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

function kmBetween(a: FaultPathPoint, b: FaultPathPoint): number {
  const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  return Math.hypot((b.lon - a.lon) * 111.32 * Math.cos(lat0), (b.lat - a.lat) * 110.574);
}

function chainages(path: readonly FaultPathPoint[]): number[] {
  if (
    path.length > 1 &&
    path.every((point) => Number.isFinite(point.km)) &&
    path.every((point, index) => index === 0 || Number(point.km) >= Number(path[index - 1].km))
  ) {
    const origin = Number(path[0].km);
    return path.map((point) => Number(point.km) - origin);
  }
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + kmBetween(path[i - 1], path[i]));
  return out;
}

/**
 * Find regional GEM traces near a selected reach in a local metric frame.
 *
 * The 50 km default is an investigation-context radius, not a setback. The
 * nearest trace is retained even when it lies outside that context radius.
 */
export function faultsFor(
  path: readonly FaultPathPoint[],
  radiusKm = 50,
  traces: readonly FaultTrace[] = BUNDLE.traces
): FaultScreen {
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error('fault-screen radius must be a positive number');
  }
  if (path.length < 2) return screen([], null, radiusKm);

  const lat0 = path.reduce((sum, point) => sum + point.lat, 0) / path.length;
  const lon0 = path.reduce((sum, point) => sum + point.lon, 0) / path.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.574;
  const xy = (lat: number, lon: number): XY => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky });
  const along = chainages(path);
  const hits: FaultHit[] = [];

  for (const trace of traces) {
    if (trace.points.length < 2) continue;
    let best: FaultHit | null = null;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = xy(path[i].lat, path[i].lon);
      const b = xy(path[i + 1].lat, path[i + 1].lon);
      for (let j = 0; j + 1 < trace.points.length; j++) {
        const [cLon, cLat] = trace.points[j];
        const [dLon, dLat] = trace.points[j + 1];
        const closest = closestSegments(a, b, xy(cLat, cLon), xy(dLat, dLon));
        if (best && closest.distance >= best.distanceKm) continue;
        const reachPoint = pointAt(path[i], path[i + 1], closest.t);
        const faultPoint = {
          lon: cLon + (dLon - cLon) * closest.u,
          lat: cLat + (dLat - cLat) * closest.u,
        };
        best = {
          ...trace,
          distanceKm: closest.distance,
          intersectsReach: closest.intersects,
          chainageKm: along[i] + (along[i + 1] - along[i]) * closest.t,
          nearestReachPoint: reachPoint,
          nearestFaultPoint: faultPoint,
        };
      }
    }
    if (best) hits.push(best);
  }

  hits.sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id));
  return screen(
    hits.filter((hit) => hit.distanceKm <= radiusKm),
    hits[0] ?? null,
    radiusKm
  );
}

function screen(nearby: FaultHit[], nearest: FaultHit | null, radiusKm: number): FaultScreen {
  return {
    radiusKm,
    nearby,
    nearest,
    crossings: nearby.filter((hit) => hit.intersectsReach).length,
    source: BUNDLE._source,
    sourceUrl: BUNDLE._sourceUrl,
    commit: BUNDLE._commit,
    retrieved: BUNDLE._retrieved,
    license: BUNDLE._license,
    licenseUrl: BUNDLE._licenseUrl,
    attribution: BUNDLE._attribution,
    citation: BUNDLE._citation,
    crs: BUNDLE._crs,
    regionalFaultSources: BUNDLE._regionalFaultSourceCount,
    limitation:
      'Regional HimaTibetMap-derived traces, not surveyed fault locations, site clearance, PGA, return period or seismic design. A mapped intersection is with the selected river reach, not a routed canal, tunnel or penstock; unmapped faults may exist.',
  };
}
