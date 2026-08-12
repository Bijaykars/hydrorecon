/**
 * HydroRIVERS Nepal extract — decoder, nearest-reach lookup, GeoJSON overlay.
 * Salvaged from the validated RiverPower implementation (checkpoint 18b26a8):
 * the format, the grid lookup and the main-stem guard all survived real QA
 * (the Sapta Koshi tributary bug: nearest reach was 12 km² while the 54,100 km²
 * main stem ran 260 m away — a 4,500x catchment understatement).
 */
import type { Reach, ReachHit } from '../types.ts';
import stationsJson from '../data/dhm-stations.json';

export type DhmStation = {
  /** Name as published by DHM. */
  n: string;
  /** Latitude. */
  y: number;
  /** Longitude. */
  x: number;
  /** Elevation, m — null when DHM does not publish one. */
  e: number | null;
  /** 1 = river gauge (discharge/level), 0 = met/other station. */
  r: number;
};

export const dhmStations = stationsJson as DhmStation[];

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
};

const GRID_DEG = 0.1;
const cellKey = (lon: number, lat: number) =>
  Math.round(lon / GRID_DEG) * 100000 + Math.round(lat / GRID_DEG);

let riverNet: Promise<RiverNet | null> | null = null;

/** Decode the packed network. Lazy: the first Nepal interaction pays for it once. */
export function loadNepalRivers(): Promise<RiverNet | null> {
  if (riverNet) return riverNet;
  riverNet = (async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}nepal-rivers.dat`, { cache: 'reload' });
    if (!res.ok) throw new Error(`river network: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
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

/** How far to look for a bigger channel beside the one you clicked. */
const MAIN_STEM_KM = 1.5;
/** Only offer the alternative when it is genuinely a different order of river. */
const MAIN_STEM_RATIO = 5;

/** Nearest mapped reach to a point, plus the dominant channel nearby. */
export async function nearestReach(lat: number, lon: number): Promise<ReachHit | null> {
  const net = await loadNepalRivers();
  if (!net) return null;
  const s = net.scale;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const degToKm = 111.32;

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
    if (seen.size > 0 && ring >= 1) break;
  }
  if (seen.size === 0) return null;

  const mk = (
    i: number,
    hit: { distanceKm: number; point: { lat: number; lon: number } }
  ): Reach => ({
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
 * The network as a GeoJSON overlay, discharge and order on each reach so the map
 * can scale line width by how much water actually flows there. Order-1 headwaters
 * are left to the basemap's waterway layer — including them doubles the feature
 * count for lines under 3 km that read as noise at screening scale.
 */
export async function riversGeoJson(): Promise<GeoJSON.FeatureCollection | null> {
  const net = await loadNepalRivers();
  if (!net) return null;
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < net.count; i++) {
    if (net.ord[i] < 2) continue;
    const a = net.start[i];
    const coords: [number, number][] = new Array(net.len[i]);
    for (let k = 0; k < net.len[i]; k++) {
      coords[k] = [net.xy[(a + k) * 2] / net.scale, net.xy[(a + k) * 2 + 1] / net.scale];
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        d: net.dis[i] / 1000, // mean discharge, m³/s
        o: net.ord[i], // Strahler order
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Nearest DHM stations to a point, with distance. */
export function nearestStations(
  lat: number,
  lon: number,
  count = 4
): (DhmStation & { km: number })[] {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  return dhmStations
    .map((st) => {
      const dx = (st.x - lon) * cosLat;
      const dy = st.y - lat;
      return { ...st, km: Math.sqrt(dx * dx + dy * dy) * 111.32 };
    })
    .sort((a, b) => a.km - b.km)
    .slice(0, count);
}
