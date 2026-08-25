/** Nearest motor-routable OpenStreetMap road for the intake and powerhouse. */

export const ROAD_ACCESS_METHOD = {
  osrm: 'https://github.com/Project-OSRM/osrm-backend/blob/master/docs/http.md#nearest-service',
  osmHighway: 'https://wiki.openstreetmap.org/wiki/Key:highway',
  osmCopyright: 'https://www.openstreetmap.org/copyright',
} as const;

export type RoadRole = 'intake' | 'powerhouse';

export type MotorRoadHit = {
  role: RoadRole;
  site: { lat: number; lon: number };
  road: { lat: number; lon: number };
  distanceM: number;
  name: string | null;
  osmNodeIds: number[];
};

export type RoadAccessScreen = {
  intake: MotorRoadHit | null;
  powerhouse: MotorRoadHit | null;
  source: string;
  limitation: string;
};

type OsrmResponse = {
  code?: string;
  message?: string;
  waypoints?: Array<{
    location?: [number, number];
    distance?: number;
    name?: string;
    nodes?: number[];
  }>;
};

const ROUTERS = [
  'https://routing.openstreetmap.de/routed-car',
  'https://router.project-osrm.org',
] as const;
const MAX_SNAP_M = 20_000;
const REQUEST_TIMEOUT_MS = 7000;
const cache = new Map<string, Promise<Omit<MotorRoadHit, 'role'> | null>>();

async function requestJson(url: string, signal?: AbortSignal): Promise<OsrmResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as OsrmResponse;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function nearestMotorRoad(
  site: { lat: number; lon: number },
  signal?: AbortSignal
): Promise<Omit<MotorRoadHit, 'role'> | null> {
  const key = `${site.lat.toFixed(5)},${site.lon.toFixed(5)}`;
  const prior = cache.get(key);
  if (prior) return prior;

  const work = (async () => {
    let lastError: unknown = null;
    /**
     * NoSegment means THIS router could not snap the coordinate, not that no
     * road exists. OSRM returns it for a point outside its extract or beyond
     * the search radius, so the next router still deserves a try; only after
     * every router has said so is "no road" the honest answer.
     */
    let sawNoSegment = false;
    for (const base of ROUTERS) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const url =
          `${base}/nearest/v1/driving/${site.lon.toFixed(6)},${site.lat.toFixed(6)}` +
          `?number=1&radiuses=${MAX_SNAP_M}`;
        const json = await requestJson(url, signal);
        if (json.code === 'NoSegment') {
          sawNoSegment = true;
          continue;
        }
        const waypoint = json.waypoints?.[0];
        const location = waypoint?.location;
        const distanceM = waypoint?.distance;
        if (
          json.code !== 'Ok' ||
          !location ||
          !Number.isFinite(location[0]) ||
          !Number.isFinite(location[1]) ||
          !Number.isFinite(distanceM) ||
          distanceM! < 0 ||
          distanceM! > MAX_SNAP_M
        ) {
          throw new Error(json.message || 'No usable road snap was returned.');
        }
        const name = waypoint?.name?.trim();
        return {
          site,
          road: { lon: location[0], lat: location[1] },
          distanceM: distanceM!,
          name: name || null,
          osmNodeIds: (waypoint?.nodes ?? []).filter(Number.isFinite),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    if (sawNoSegment) return null; // every router agreed: nothing routable here
    throw lastError instanceof Error
      ? lastError
      : new Error('The OpenStreetMap routing graph is unavailable.');
  })().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, work);
  return work;
}

export async function screenRoadAccess(
  intake: { lat: number; lon: number },
  powerhouse: { lat: number; lon: number },
  signal?: AbortSignal
): Promise<RoadAccessScreen> {
  /**
   * allSettled, not all: one endpoint failing both routers must not discard a
   * road already found for the other. Partial evidence is exactly what matters
   * here — "the powerhouse is 157 m from a road, the intake is unknown" is a
   * useful screening answer and `all` threw it away.
   */
  const [intakeResult, powerhouseResult] = await Promise.allSettled([
    nearestMotorRoad(intake, signal),
    nearestMotorRoad(powerhouse, signal),
  ]);
  // An abort is the caller withdrawing the question, not a routing failure.
  for (const r of [intakeResult, powerhouseResult]) {
    if (r.status === 'rejected' && (r.reason as Error)?.name === 'AbortError') throw r.reason;
  }
  const settled = <T,>(r: PromiseSettledResult<T>): T | null =>
    r.status === 'fulfilled' ? r.value : null;
  const intakeHit = settled(intakeResult);
  const powerhouseHit = settled(powerhouseResult);
  return {
    intake: intakeHit ? { ...intakeHit, role: 'intake' } : null,
    powerhouse: powerhouseHit ? { ...powerhouseHit, role: 'powerhouse' } : null,
    source: 'OpenStreetMap car-routing graph via OSRM nearest',
    limitation:
      'Straight-line gap to a mapped routable road. It is a lower bound, not an access-road alignment; slope, river crossings, road condition, seasonal closure and legal access are not verified.',
  };
}

export function roadAccessGeoJson(screen: RoadAccessScreen): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const hit of [screen.intake, screen.powerhouse]) {
    if (!hit) continue;
    const properties = {
      role: hit.role,
      distanceM: hit.distanceM,
      name: hit.name,
    };
    features.push({
      type: 'Feature',
      properties: { ...properties, kind: 'connector' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [hit.site.lon, hit.site.lat],
          [hit.road.lon, hit.road.lat],
        ],
      },
    });
    features.push({
      type: 'Feature',
      properties: { ...properties, kind: 'road' },
      geometry: { type: 'Point', coordinates: [hit.road.lon, hit.road.lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

export const roadMapUrl = (hit: MotorRoadHit) =>
  `https://www.openstreetmap.org/?mlat=${hit.road.lat.toFixed(6)}&mlon=${hit.road.lon.toFixed(6)}#map=17/${hit.road.lat.toFixed(6)}/${hit.road.lon.toFixed(6)}`;
