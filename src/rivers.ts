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
    const res = await fetch(`${import.meta.env.BASE_URL}nepal-rivers.dat`);
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
    return { count, scale, upland, dis, ord, start, len, xy, grid, byFirst };
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

export async function nearestReach(lat: number, lon: number): Promise<ReachHit | null> {
  if (!hasReachData(lat, lon)) return null;
  const n = await load();
  const s = n.scale;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const degToKm = 111.32;

  const seen = new Map<number, { distanceKm: number; point: { lat: number; lon: number } }>();
  const consider = (i: number) => {
    const a = n.start[i];
    let d2 = Infinity;
    let point = { lat, lon };
    for (let k = 0; k < n.len[i]; k++) {
      const rLon = n.xy[(a + k) * 2] / s;
      const rLat = n.xy[(a + k) * 2 + 1] / s;
      const dx = (rLon - lon) * cosLat;
      const dy = rLat - lat;
      const d = dx * dx + dy * dy;
      if (d < d2) {
        d2 = d;
        point = { lat: rLat, lon: rLon };
      }
    }
    seen.set(i, { distanceKm: Math.sqrt(d2) * degToKm, point });
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
  if (seen.size === 0) return null;

  const mk = (i: number, hit: { distanceKm: number; point: { lat: number; lon: number } }): Reach => ({
    uplandKm2: n.upland[i] / 10,
    meanDischargeCms: n.dis[i] / 1000,
    strahler: n.ord[i],
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
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let bestI = -1;
  let bestK = 0;
  let bestD = Infinity;
  const target = hit.nearest.point;
  for (let ring = 0; ring <= 3 && bestI < 0; ring++) {
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gy = -ring; gy <= ring; gy++) {
        const bucket = n.grid.get(cellKey(target.lon + gx * GRID_DEG, target.lat + gy * GRID_DEG));
        if (!bucket) continue;
        for (const i of bucket) {
          for (let k = 0; k < n.len[i]; k++) {
            const vx = n.xy[(n.start[i] + k) * 2] / s;
            const vy = n.xy[(n.start[i] + k) * 2 + 1] / s;
            const dx = (vx - target.lon) * cosLat;
            const dy = vy - target.lat;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              bestI = i;
              bestK = k;
            }
          }
        }
      }
    }
  }
  if (bestI < 0) return null;

  // Collect raw vertices downstream, starting mid-reach where the user clicked.
  const raw: { lat: number; lon: number; uplandKm2: number; meanCms: number }[] = [];
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
