/**
 * Bundled HydroRIVERS extract: gives upstream catchment area and a mapped
 * centreline to snap to. It covers one window of the world, so it is loaded
 * lazily and only when a click falls inside that window — everywhere else the
 * app works exactly the same, just without the snap and the catchment figure.
 *
 * Decoder and the main-stem guard are the validated originals (see git 18b26a8):
 * measured at Sapta Koshi, the geometrically nearest reach was a 12 km²
 * tributary while the 54,100 km² main stem ran 260 m away — a 4,500x error.
 */

/** Bounding box of the bundled extract. */
const COVER = { west: 79.9, south: 26.2, east: 88.4, north: 30.6 };

export const hasReachData = (lat: number, lon: number) =>
  lat >= COVER.south && lat <= COVER.north && lon >= COVER.west && lon <= COVER.east;

export const coverageBox = COVER;

export type Reach = {
  /** Upstream contributing catchment area, km². */
  uplandKm2: number;
  /** HydroRIVERS long-term mean discharge, m³/s. */
  meanDischargeCms: number;
  strahler: number;
  /** How far the click was from the mapped centreline, km. */
  distanceKm: number;
  point: { lat: number; lon: number };
  /**
   * Fraction of the upstream catchment lying below 5000 m and below 3000 m.
   *
   * Nepal's own HYDEST regression needs these, and nothing else supplies them:
   * dry-season flow depends on the catchment below the snowline, and flood peaks
   * on the catchment below 3000 m. Built by pipeline/build-hypsometry.mjs from
   * HydroBASINS sub-basins and terrain. NaN outside the coverage.
   */
  below5000Frac: number;
  below3000Frac: number;
  /**
   * Catchment-mean monsoon (Jun–Sep) precipitation, mm — HYDEST's MMP input,
   * from the CHPclim climatology via pipeline/build-mmp.mjs. NaN when the file
   * predates MMP or the catchment falls outside the coverage.
   */
  monsoonMm: number;
  /** Stable index in the bundled, directed HydroRIVERS extract. */
  networkIndex: number;
  /** Nearest stored centreline vertex within that reach. */
  networkVertex: number;
};

type RiverNet = {
  count: number;
  scale: number;
  upland: Int32Array;
  dis: Int32Array;
  ord: Uint8Array;
  start: Int32Array;
  len: Int32Array;
  xy: Int32Array;
  grid: Map<number, number[]>;
  /** Reach indices keyed by their first vertex, for downstream walking. */
  byFirst: Map<number, number[]>;
  /**
   * Two bytes per reach: catchment fraction below 5000 m, then below 3000 m,
   * each quantised to 0-254 with 255 meaning unknown. Null if the file is
   * missing, which must stay survivable — hypsometry is an enhancement, and the
   * app worked before it existed.
   */
  hypso: Uint8Array | null;
  /** Bytes per reach in `hypso`: 2 (fractions only) or 4 (plus MMP uint16). */
  hypsoStride: number;
};

const GRID_DEG = 0.1;
const cellKey = (lon: number, lat: number) =>
  Math.round(lon / GRID_DEG) * 100000 + Math.round(lat / GRID_DEG);

/** Exact key for a stored vertex. Coordinates sit on a 1/480° grid, so integers match exactly. */
const vertexKey = (x: number, y: number) => x * 4194304 + y;

let net: Promise<RiverNet> | null = null;

function load(): Promise<RiverNet> {
  if (net) return net;
  net = (async () => {
    const baseUrl = import.meta.env?.BASE_URL ?? '/';
    const res = await fetch(`${baseUrl}nepal-rivers.dat`);
    if (!res.ok) throw new Error(`river network: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // A 204 or truncated body would otherwise surface as an opaque
    // "Offset is outside the bounds of the DataView" on the first read.
    if (buf.byteLength < 16) throw new Error('river network: empty response');
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

    // Connectivity. Measured on this extract: a reach's last vertex coincides
    // exactly with the first vertex of the reach below it for 41,903 of 42,197
    // reaches, upstream area grew downstream in every single one, and no vertex
    // had two candidate successors. So the geometry is genuinely directed and
    // walkable without a NEXT_DOWN field.
    const byFirst = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const v = start[i] * 2;
      const k = vertexKey(xy[v], xy[v + 1]);
      const bucket = byFirst.get(k);
      if (bucket) bucket.push(i);
      else byFirst.set(k, [i]);
    }
    /**
     * Catchment hypsometry, fetched alongside. Optional on purpose: it is an
     * 82 KB enhancement that unlocks Nepal's own HYDEST regression, and every
     * other feature must keep working when it is absent or fails to load.
     */
    let hypso: Uint8Array | null = null;
    let hypsoStride = 2;
    try {
      const hr = await fetch(`${baseUrl}nepal-hypso.dat`);
      if (hr.ok) {
        const hb = new Uint8Array(await hr.arrayBuffer());
        // Two generations of the file: 2 bytes/reach (hypsometry only) and
        // 4 bytes/reach (plus a uint16 of catchment monsoon precipitation, mm).
        if (hb.length === count * 4) {
          hypso = hb;
          hypsoStride = 4;
        } else if (hb.length === count * 2) {
          hypso = hb;
        }
      }
    } catch {
      // Enhancement only — never block the river network on it.
    }

    return { count, scale, upland, dis, ord, start, len, xy, grid, byFirst, hypso, hypsoStride };
  })().catch((e) => {
    net = null; // allow a retry
    throw e;
  });
  return net;
}

/**
 * Only snap a click this far. Beyond it the click clearly was not aimed at a
 * mapped reach, and silently teleporting someone's marker a kilometre onto a
 * tributary is worse than leaving it where they put it.
 */
export const SNAP_KM = 0.8;

/** Look this far for a bigger channel beside the one you clicked. */
const MAIN_STEM_KM = 1.5;
/** Only prefer it when it is genuinely a different order of river. */
const MAIN_STEM_RATIO = 5;

export type ReachHit = { nearest: Reach; mainStem: Reach | null };

type ReachCandidate = {
  distanceKm: number;
  point: { lat: number; lon: number };
  vertex: number;
};

/** Candidate reaches and their closest stored vertex around one WGS84 point. */
function reachCandidates(n: RiverNet, lat: number, lon: number): Map<number, ReachCandidate> {
  const s = n.scale;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const degToKm = 111.32;
  const seen = new Map<number, ReachCandidate>();
  const consider = (i: number) => {
    const a = n.start[i];
    let d2 = Infinity;
    let point = { lat, lon };
    let vertex = 0;
    for (let k = 0; k < n.len[i]; k++) {
      const rLon = n.xy[(a + k) * 2] / s;
      const rLat = n.xy[(a + k) * 2 + 1] / s;
      const dx = (rLon - lon) * cosLat;
      const dy = rLat - lat;
      const d = dx * dx + dy * dy;
      if (d < d2) {
        d2 = d;
        point = { lat: rLat, lon: rLon };
        vertex = k;
      }
    }
    seen.set(i, { distanceKm: Math.sqrt(d2) * degToKm, point, vertex });
  };

  for (let ring = 0; ring <= 6; ring++) {
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gy = -ring; gy <= ring; gy++) {
        if (ring > 0 && Math.abs(gx) !== ring && Math.abs(gy) !== ring) continue;
        const bucket = n.grid.get(cellKey(lon + gx * GRID_DEG, lat + gy * GRID_DEG));
        if (!bucket) continue;
        for (const i of bucket) if (!seen.has(i)) consider(i);
      }
    }
    if (seen.size > 0 && ring >= 1) break;
  }
  return seen;
}

/** Resolve shared confluence vertices the same way everywhere in the app. */
function nearestCandidateIndex(n: RiverNet, seen: ReadonlyMap<number, ReachCandidate>): number {
  // A junction vertex belongs to every reach that meets there. Within about
  // 30 m, prefer the larger upstream area so file order cannot select a rivulet.
  const TIE_KM = 0.03;
  let nearestI = -1;
  let nearestKm = Infinity;
  for (const [i, hit] of seen) {
    const closer = hit.distanceKm < nearestKm - TIE_KM;
    const tied = nearestI >= 0 && Math.abs(hit.distanceKm - nearestKm) <= TIE_KM;
    if (nearestI < 0 || closer || (tied && n.upland[i] > n.upland[nearestI])) {
      nearestKm = Math.min(nearestKm, hit.distanceKm);
      nearestI = i;
    }
  }
  return nearestI;
}

export async function nearestReach(lat: number, lon: number): Promise<ReachHit | null> {
  if (!hasReachData(lat, lon)) return null;
  const n = await load();
  const seen = reachCandidates(n, lat, lon);
  if (seen.size === 0) return null;

  const mk = (i: number, hit: ReachCandidate): Reach => ({
    uplandKm2: n.upland[i] / 10,
    meanDischargeCms: n.dis[i] / 1000,
    strahler: n.ord[i],
    distanceKm: hit.distanceKm,
    point: hit.point,
    // 255 is the "no hypsometry here" sentinel; 0-254 spans 0..1.
    below5000Frac:
      n.hypso && n.hypso[i * n.hypsoStride] !== 255 ? n.hypso[i * n.hypsoStride] / 254 : NaN,
    below3000Frac:
      n.hypso && n.hypso[i * n.hypsoStride + 1] !== 255 ? n.hypso[i * n.hypsoStride + 1] / 254 : NaN,
    monsoonMm: (() => {
      if (!n.hypso || n.hypsoStride < 4) return NaN;
      const v = n.hypso[i * 4 + 2] | (n.hypso[i * 4 + 3] << 8);
      return v === 0xffff ? NaN : v;
    })(),
    networkIndex: i,
    networkVertex: hit.vertex,
  });

  /**
   * Reaches closer together than this are the same place as far as a click can
   * say. It matters at confluences, where the tributary and the river SHARE the
   * junction vertex: both sit at exactly 0.000 km, and "nearest" used to go to
   * whichever the file listed first. Validation caught it handing the Khimti —
   * 379 km², carrying 15 m³/s in the bundle — to a 3.4 km² rivulet, and every
   * study clicked near that junction inherited the rivulet's flow. Within the
   * tie, the larger river wins; anyone genuinely studying the rivulet clicks a
   * hundred metres up it and the tie disappears.
   */
  const nearestI = nearestCandidateIndex(n, seen);
  let biggestI = -1;
  let biggestUp = -1;
  let biggestKm = 0;
  for (const [i, hit] of seen) {
    if (hit.distanceKm <= MAIN_STEM_KM && n.upland[i] > biggestUp) {
      biggestUp = n.upland[i];
      biggestI = i;
      biggestKm = hit.distanceKm;
    }
  }
  const nearest = mk(nearestI, seen.get(nearestI)!);
  const mainStem =
    biggestI >= 0 && biggestI !== nearestI && biggestUp > n.upland[nearestI] * MAIN_STEM_RATIO
      ? mk(biggestI, { ...seen.get(biggestI)!, distanceKm: biggestKm })
      : null;
  return { nearest, mainStem };
}

/** A point on the river, with the reach properties that apply there. */
export type PathPoint = {
  lat: number;
  lon: number;
  /** Distance along the river from the start of the walk, km. */
  km: number;
  uplandKm2: number;
  /** HydroRIVERS long-term mean discharge on this reach, m³/s. */
  meanCms: number;
  /** Directed HydroRIVERS reach and stored vertex used by topology screens. */
  networkIndex: number;
  networkVertex: number;
};

const haversineKmLocal = (a: [number, number], b: [number, number]) => {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

export type DirectedNetworkAdapter = {
  pointCount: (reachIndex: number) => number;
  /** GeoJSON order: longitude, latitude. */
  point: (reachIndex: number, vertex: number) => [number, number];
  next: (reachIndex: number, visited: ReadonlySet<number>) => number | null;
};

export type NetworkPosition = { reachIndex: number; vertex: number };
export type DirectedTrace = { routeKm: number; coordinates: [number, number][] };

/**
 * Walk one directed reach graph to a target position.
 *
 * Exported as a pure function so topology direction, same-reach ordering,
 * cycle rejection and route length can be tested without fetching the bundle.
 */
export function traceDirectedConnection(
  adapter: DirectedNetworkAdapter,
  source: NetworkPosition,
  target: NetworkPosition,
  maxRouteKm = 300
): DirectedTrace | null {
  if (!Number.isFinite(maxRouteKm) || maxRouteKm <= 0) {
    throw new Error('maximum directed route must be positive');
  }
  const visited = new Set<number>();
  const coordinates: [number, number][] = [];
  let routeKm = 0;
  let reachIndex = source.reachIndex;
  let from = source.vertex;

  while (!visited.has(reachIndex)) {
    const count = adapter.pointCount(reachIndex);
    if (count < 1 || from < 0 || from >= count) return null;
    if (reachIndex === target.reachIndex && from > target.vertex) return null;
    const to = reachIndex === target.reachIndex ? target.vertex : count - 1;
    if (to < from || to >= count) return null;
    for (let vertex = from; vertex <= to; vertex++) {
      const point = adapter.point(reachIndex, vertex);
      const previous = coordinates.at(-1);
      if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
      if (previous) {
        routeKm += haversineKmLocal([previous[1], previous[0]], [point[1], point[0]]);
        if (routeKm > maxRouteKm) return null;
      }
      coordinates.push(point);
    }
    if (reachIndex === target.reachIndex) return { routeKm, coordinates };
    visited.add(reachIndex);
    const next = adapter.next(reachIndex, visited);
    if (next == null) return null;
    reachIndex = next;
    from = 0; // duplicate confluence coordinates are removed above
  }
  return null;
}

export type ChannelConnection<T extends { lat: number; lon: number }> = {
  source: T;
  snapKm: number;
  snapped: { lat: number; lon: number };
  routeKm: number;
  route: [number, number][];
};

export type ChannelConnectionScreen<T extends { lat: number; lon: number }> = {
  target: { lat: number; lon: number; snapKm: number; snapped: { lat: number; lon: number } };
  connections: ChannelConnection<T>[];
};

function directedAdapter(n: RiverNet): DirectedNetworkAdapter {
  return {
    pointCount: (reachIndex) => n.len[reachIndex] ?? 0,
    point: (reachIndex, vertex) => {
      const offset = (n.start[reachIndex] + vertex) * 2;
      return [n.xy[offset] / n.scale, n.xy[offset + 1] / n.scale];
    },
    next: (reachIndex, visited) => {
      const last = (n.start[reachIndex] + n.len[reachIndex] - 1) * 2;
      const candidates = (n.byFirst.get(vertexKey(n.xy[last], n.xy[last + 1])) ?? []).filter(
        (candidate) => candidate !== reachIndex && !visited.has(candidate)
      );
      if (candidates.length === 0) return null;
      return candidates.reduce((a, b) => (n.upland[b] > n.upland[a] ? b : a));
    },
  };
}

/**
 * Find source points whose snapped, directed HydroRIVERS path reaches an intake.
 *
 * This is deliberately a channel-topology screen. A source-to-channel snap can
 * cross a ridge, and HydroRIVERS omits streams below its mapping threshold, so
 * every returned connection remains a candidate for DEM/catchment validation.
 */
export async function connectUpstreamSources<T extends { lat: number; lon: number }>(
  target: { lat: number; lon: number },
  sources: readonly T[],
  options: { maxSnapKm?: number; maxRouteKm?: number; targetSnapKm?: number } = {}
): Promise<ChannelConnectionScreen<T> | null> {
  if (!hasReachData(target.lat, target.lon)) return null;
  const maxSnapKm = options.maxSnapKm ?? 1.5;
  const maxRouteKm = options.maxRouteKm ?? 300;
  const targetSnapKm = options.targetSnapKm ?? SNAP_KM;
  if (maxSnapKm <= 0 || maxRouteKm <= 0 || targetSnapKm <= 0) {
    throw new Error('channel-connectivity distances must be positive');
  }
  const n = await load();
  const targetCandidates = reachCandidates(n, target.lat, target.lon);
  const targetI = nearestCandidateIndex(n, targetCandidates);
  if (targetI < 0) return null;
  const targetHit = targetCandidates.get(targetI)!;
  if (targetHit.distanceKm > targetSnapKm) return null;
  const targetPosition = { reachIndex: targetI, vertex: targetHit.vertex };
  const adapter = directedAdapter(n);

  const connections: ChannelConnection<T>[] = [];
  for (const source of sources) {
    if (!hasReachData(source.lat, source.lon)) continue;
    // Great-circle distance is a safe lower bound on a channel route and avoids
    // visiting the network for sources that cannot meet the declared cap.
    const directKm = haversineKmLocal([source.lat, source.lon], [target.lat, target.lon]);
    if (directKm > maxRouteKm + maxSnapKm + targetSnapKm) continue;
    const candidates = reachCandidates(n, source.lat, source.lon);
    const sourceI = nearestCandidateIndex(n, candidates);
    if (sourceI < 0) continue;
    const sourceHit = candidates.get(sourceI)!;
    if (sourceHit.distanceKm > maxSnapKm) continue;
    const trace = traceDirectedConnection(
      adapter,
      { reachIndex: sourceI, vertex: sourceHit.vertex },
      targetPosition,
      maxRouteKm
    );
    if (!trace) continue;
    connections.push({
      source,
      snapKm: sourceHit.distanceKm,
      snapped: sourceHit.point,
      routeKm: trace.routeKm,
      route: trace.coordinates,
    });
  }
  connections.sort((a, b) => a.routeKm - b.routeKm || a.snapKm - b.snapKm);
  return {
    target: {
      ...target,
      snapKm: targetHit.distanceKm,
      snapped: targetHit.point,
    },
    connections,
  };
}

/**
 * Find target points reached by walking downstream from an anchor.
 *
 * This is the inverse question to `connectUpstreamSources`. It is useful for
 * identifying downstream infrastructure that may receive releases, sediment
 * flushing or flood waves from the selected site. It remains a coarse network
 * candidate screen with the same snap and mapping limitations.
 */
export async function connectDownstreamTargets<T extends { lat: number; lon: number }>(
  anchor: { lat: number; lon: number },
  targets: readonly T[],
  options: { maxSnapKm?: number; maxRouteKm?: number; anchorSnapKm?: number } = {}
): Promise<ChannelConnectionScreen<T> | null> {
  if (!hasReachData(anchor.lat, anchor.lon)) return null;
  const maxSnapKm = options.maxSnapKm ?? 1.5;
  const maxRouteKm = options.maxRouteKm ?? 300;
  const anchorSnapKm = options.anchorSnapKm ?? SNAP_KM;
  if (maxSnapKm <= 0 || maxRouteKm <= 0 || anchorSnapKm <= 0) {
    throw new Error('downstream-connectivity distances must be positive');
  }
  const n = await load();
  const anchorCandidates = reachCandidates(n, anchor.lat, anchor.lon);
  const anchorI = nearestCandidateIndex(n, anchorCandidates);
  if (anchorI < 0) return null;
  const anchorHit = anchorCandidates.get(anchorI)!;
  if (anchorHit.distanceKm > anchorSnapKm) return null;
  const anchorPosition = { reachIndex: anchorI, vertex: anchorHit.vertex };
  const adapter = directedAdapter(n);
  const connections: ChannelConnection<T>[] = [];

  for (const target of targets) {
    if (!hasReachData(target.lat, target.lon)) continue;
    const directKm = haversineKmLocal([anchor.lat, anchor.lon], [target.lat, target.lon]);
    if (directKm > maxRouteKm + maxSnapKm + anchorSnapKm) continue;
    const candidates = reachCandidates(n, target.lat, target.lon);
    const targetI = nearestCandidateIndex(n, candidates);
    if (targetI < 0) continue;
    const targetHit = candidates.get(targetI)!;
    if (targetHit.distanceKm > maxSnapKm) continue;
    const trace = traceDirectedConnection(
      adapter,
      anchorPosition,
      { reachIndex: targetI, vertex: targetHit.vertex },
      maxRouteKm
    );
    if (!trace) continue;
    connections.push({
      source: target,
      snapKm: targetHit.distanceKm,
      snapped: targetHit.point,
      routeKm: trace.routeKm,
      route: trace.coordinates,
    });
  }
  connections.sort((a, b) => a.routeKm - b.routeKm || a.snapKm - b.snapKm);
  return {
    target: {
      ...anchor,
      snapKm: anchorHit.distanceKm,
      snapped: anchorHit.point,
    },
    connections,
  };
}

/**
 * Follow the river downstream from a point, returning an evenly-sampled path.
 *
 * This is what lets a single click be enough: the software can look at the whole
 * reach below the click rather than making the user guess where a powerhouse
 * should sit. Forks are resolved by taking the larger catchment, which keeps the
 * walk on the main stem.
 */
export async function downstreamPath(
  lat: number,
  lon: number,
  maxKm = 25,
  spacingKm = 0.12
): Promise<PathPoint[] | null> {
  if (!hasReachData(lat, lon)) return null;
  const n = await load();
  const hit = await nearestReach(lat, lon);
  if (!hit) return null;

  // Which reach did we land on, and where along it?
  const s = n.scale;
  const bestI = hit.nearest.networkIndex;
  const bestK = hit.nearest.networkVertex;

  // Collect raw vertices downstream, starting mid-reach where the user clicked.
  const raw: {
    lat: number;
    lon: number;
    uplandKm2: number;
    meanCms: number;
    networkIndex: number;
    networkVertex: number;
  }[] = [];
  const visited = new Set<number>();
  let cur = bestI;
  let from = bestK;
  let km = 0;
  while (km < maxKm) {
    visited.add(cur);
    for (let k = from; k < n.len[cur]; k++) {
      const p = {
        lat: n.xy[(n.start[cur] + k) * 2 + 1] / s,
        lon: n.xy[(n.start[cur] + k) * 2] / s,
        uplandKm2: n.upland[cur] / 10,
        meanCms: n.dis[cur] / 1000,
        networkIndex: cur,
        networkVertex: k,
      };
      if (raw.length > 0) {
        const prev = raw[raw.length - 1];
        km += haversineKmLocal([prev.lat, prev.lon], [p.lat, p.lon]);
      }
      raw.push(p);
      if (km >= maxKm) break;
    }
    const lastV = (n.start[cur] + n.len[cur] - 1) * 2;
    const next = (n.byFirst.get(vertexKey(n.xy[lastV], n.xy[lastV + 1])) ?? []).filter(
      (j) => j !== cur && !visited.has(j)
    );
    if (next.length === 0) break;
    // At a confluence, stay on the main stem.
    cur = next.reduce((a, b) => (n.upland[b] > n.upland[a] ? b : a));
    from = 1; // its first vertex is the one we just recorded
  }
  if (raw.length < 2) return null;

  // Resample to even spacing so chainage indices are directly comparable.
  const out: PathPoint[] = [{ ...raw[0], km: 0 }];
  let acc = 0;
  for (let i = 1; i < raw.length; i++) {
    const seg = haversineKmLocal([raw[i - 1].lat, raw[i - 1].lon], [raw[i].lat, raw[i].lon]);
    if (seg <= 0) continue;
    let t = spacingKm - acc;
    while (t <= seg) {
      const f = t / seg;
      out.push({
        lat: raw[i - 1].lat + f * (raw[i].lat - raw[i - 1].lat),
        lon: raw[i - 1].lon + f * (raw[i].lon - raw[i - 1].lon),
        km: out[out.length - 1].km + spacingKm,
        uplandKm2: raw[i].uplandKm2,
        meanCms: raw[i].meanCms,
        networkIndex: raw[i].networkIndex,
        networkVertex: raw[i].networkVertex,
      });
      t += spacingKm;
    }
    acc = seg - (t - spacingKm);
  }
  return out;
}

/** The network as a map overlay. Order-1 headwaters are left to the basemap. */
export async function riversGeoJson(): Promise<GeoJSON.FeatureCollection> {
  const n = await load();
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < n.count; i++) {
    if (n.ord[i] < 2) continue;
    const a = n.start[i];
    const coordinates: [number, number][] = new Array(n.len[i]);
    for (let k = 0; k < n.len[i]; k++) {
      coordinates[k] = [n.xy[(a + k) * 2] / n.scale, n.xy[(a + k) * 2 + 1] / n.scale];
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: { d: n.dis[i] / 1000 },
    });
  }
  return { type: 'FeatureCollection', features };
}
