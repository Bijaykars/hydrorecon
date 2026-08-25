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

import { areaOverrideAt } from './overrides.ts';

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
  /**
   * The REACH's own catchment area, km², before MERIT refined it per-vertex.
   *
   * Kept because uplandKm2 and meanDischargeCms now come from different sources
   * and are still used as a pair (specific discharge). This is the denominator
   * that matches the discharge numerator, so anything judging the two together
   * can tell an inconsistency from a real reading.
   */
  reachUplandKm2: number;
  /**
   * Where uplandKm2 came from. 'override' means a named document states it and
   * beat both inferences; the panel must say so, because a pinned number is a
   * different kind of claim from a sampled one.
   */
  areaSource: 'merit' | 'reach' | 'override';
  /** With areaSource 'override', the document behind it. */
  areaOverride?: { name: string; source: string };
  /**
   * Mean elevation of the upstream catchment, m. NaN where unknown.
   * The Modified HYDEST regression takes this as a direct input.
   */
  averageAltitudeM: number;
  /** Annual catchment precipitation, mm. NaN where unknown. */
  annualPrecipMm: number;
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
  /** Log-quantised MERIT catchment area per vertex; 0 where none was sampled. */
  upa: Uint16Array | null;
  /** Mean upstream catchment elevation per reach, metres; 0 where unknown. */
  elev: Uint16Array | null;
  /** Annual catchment precipitation per reach, mm; 0 where unknown. */
  annualMm: Uint16Array | null;
  /** Per-vertex position pulled onto the OSM-traced channel; 0 where untraced. */
  snapped: Int32Array | null;
  upaLo: number;
  upaHi: number;
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

    /**
     * MERIT Hydro catchment area, per VERTEX rather than per reach.
     *
     * HydroRIVERS stores one UPLAND_SKM for a whole reach, derived at about
     * 500 m, and it is sometimes not merely coarse but wrong: it puts 2 km2
     * behind the Kali Gandaki gauge that measures 449 m3/s. MERIT's `upa` band
     * is accumulated at 92.77 m, and read on a traced channel it agrees with
     * what the gauges actually carry — 65 of 70 give a physically possible
     * specific discharge against HydroRIVERS' 58, rescuing seven and breaking
     * none (pipeline/build_merit_upa.py).
     *
     * Optional, like hypsometry: a vertex with no traced sample is stored as 0
     * and the reach figure stands. Nothing must depend on this file existing.
     */
    let upa: Uint16Array | null = null;
    let upaLo = 0;
    let upaHi = 0;
    try {
      const ur = await fetch(`${baseUrl}nepal-upa.dat`);
      if (ur.ok) {
        const ab = await ur.arrayBuffer();
        const dv = new DataView(ab);
        if (dv.getUint32(0, true) === 0x4e555031 && dv.getUint32(4, true) === xy.length / 2) {
          upaLo = dv.getFloat32(8, true);
          upaHi = dv.getFloat32(12, true);
          upa = new Uint16Array(ab, 16);
        }
      }
    } catch {
      // Enhancement only.
    }

    /**
     * Mean elevation of the upstream catchment, metres.
     *
     * Needed by the Modified HYDEST regression that Nepali offices actually
     * run, which takes average catchment altitude as an input and cannot be
     * evaluated without it. Optional like every other enhancement here: absent,
     * that one method is simply unavailable and nothing else changes.
     */
    let elev: Uint16Array | null = null;
    try {
      const er = await fetch(`${baseUrl}nepal-elev.dat`);
      if (er.ok) {
        const ab = await er.arrayBuffer();
        const dv = new DataView(ab);
        if (dv.getUint32(0, true) === 0x4e455031 && dv.getUint32(4, true) === count) {
          elev = new Uint16Array(ab, 8);
        }
      }
    } catch {
      // Enhancement only.
    }

    /** Annual catchment precipitation, for the Modified HYDEST wetness index. */
    let annualMm: Uint16Array | null = null;
    try {
      const ar = await fetch(`${baseUrl}nepal-annual-precip.dat`);
      if (ar.ok) {
        const ab = await ar.arrayBuffer();
        const dv = new DataView(ab);
        if (dv.getUint32(0, true) === 0x4e415031 && dv.getUint32(4, true) === count) {
          annualMm = new Uint16Array(ab, 8);
        }
      }
    } catch {
      // Enhancement only.
    }

    /**
     * Where OpenStreetMap has traced the channel, the position of every vertex
     * on it. Built by pipeline/snap-vertices-to-osm.mjs, and used for DRAWING
     * only — see riversGeoJson.
     */
    let snapped: Int32Array | null = null;
    try {
      const sr = await fetch(`${baseUrl}nepal-osm-snapped.dat`);
      if (sr.ok) {
        const ab = await sr.arrayBuffer();
        const dv = new DataView(ab);
        if (dv.getUint32(0, true) === 0x4f535631 && dv.getUint32(4, true) === xy.length / 2) {
          snapped = new Int32Array(ab, 8);
        }
      }
    } catch {
      // Enhancement only.
    }

    return { count, scale, upland, dis, ord, start, len, xy, grid, byFirst, hypso, hypsoStride, upa, upaLo, upaHi, elev, annualMm, snapped };
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
/**
 * MEASURED at 3 km and reverted. Marsyangdi's real main stem sits 2.7 km from
 * its published intake, so widening the search looked like the fix. On the
 * 19-plant fleet it turned Marsyangdi AND Sunigad from a number into no scheme
 * at all, and improved nothing.
 *
 * It also improved the headline while doing so, which is the part worth
 * remembering: under-predictions fell from 2/19 to 1/17 purely because the
 * failing plant dropped out of the scored set. A one-sided failure test still
 * lies if the denominator is allowed to move.
 */
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
  /**
   * DISTANCE TO THE RIVER, NOT TO ITS STORED VERTICES.
   *
   * HydroRIVERS carries a polyline, and only its corner points are stored. This
   * used to take the nearest of those corners, which is a different quantity: a
   * point sitting exactly ON a long straight reach can be half its length away
   * from either end. 38.7% of the 164,825 segments in this extract are longer
   * than the 0.8 km snap threshold and 10.9% exceed 1.6 km, so at the midpoint
   * of a long reach the click failed to snap to the river it was on — or a
   * stray vertex belonging to a different reach won instead, handing the study
   * the wrong catchment entirely.
   *
   * Projecting onto each segment fixes both. `vertex` stays the nearer endpoint
   * because the topology walk downstream is vertex-indexed.
   */
  const consider = (i: number) => {
    const a = n.start[i];
    let d2 = Infinity;
    let point = { lat, lon };
    let vertex = 0;
    const count = n.len[i];
    for (let k = 0; k < count; k++) {
      const vLon = n.xy[(a + k) * 2] / s;
      const vLat = n.xy[(a + k) * 2 + 1] / s;
      // The vertex itself, so a single-point reach is still measurable.
      const vdx = (vLon - lon) * cosLat;
      const vdy = vLat - lat;
      const vd = vdx * vdx + vdy * vdy;
      if (vd < d2) {
        d2 = vd;
        point = { lat: vLat, lon: vLon };
        vertex = k;
      }
      if (k + 1 >= count) continue;

      // The segment from this vertex to the next, projected onto.
      const wLon = n.xy[(a + k + 1) * 2] / s;
      const wLat = n.xy[(a + k + 1) * 2 + 1] / s;
      const ex = (wLon - vLon) * cosLat;
      const ey = wLat - vLat;
      const len2 = ex * ex + ey * ey;
      if (!(len2 > 0)) continue;
      let t = (((lon - vLon) * cosLat) * ex + (lat - vLat) * ey) / len2;
      // Endpoints are already covered by the vertex pass above.
      if (!(t > 0) || !(t < 1)) continue;
      const px = (lon - vLon) * cosLat - t * ex;
      const py = lat - vLat - t * ey;
      const pd = px * px + py * py;
      if (pd < d2) {
        d2 = pd;
        point = { lat: vLat + t * ey, lon: vLon + t * (wLon - vLon) };
        // The endpoint the projection sits nearer to: the downstream walk is
        // indexed by stored vertex, so it must be one of the two real ones.
        vertex = t < 0.5 ? k : k + 1;
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

/**
 * SNAPPING THE CLICK TO OPENSTREETMAP WAS TRIED AND IS WORSE.
 *
 * The reasoning was sound: this network is derived at about 500 m, its
 * centreline can sit hundreds of metres from the water, and every remaining
 * under-prediction in the plant fleet is a coordinate that landed on the
 * tributary beside the river it meant. OSM traces the channel itself, so
 * resolving the click there first should ask "which reach is nearest the
 * WATER" rather than "nearest a coordinate".
 *
 * Measured on 101 fleet plants it moved nine of them and made things worse:
 * plants reaching their licence fell 84 to 83, catastrophic under-predictions
 * rose 8 to 9. Molun Khola went from a 195 km2 catchment to 4, and 51.8 MW to
 * 1.1; Phewa from 577 km2 to 156.
 *
 * The reason is already written a few files away, in snapPathToOsm: "a partial
 * correction on a real channel beats a complete one onto the wrong channel."
 * OSM traces irrigation canals, ditches and side channels as readily as rivers,
 * and the NEAREST traced line to a point is very often not the river. Pulling a
 * click to it is confidently wrong in a way that leaving it alone is not.
 *
 * This is the fourth attempt at the mis-snap class and the fourth to measure
 * worse. The pattern in all four: each added a rule that fires everywhere to
 * fix something that goes wrong in about four per cent of cases.
 */
export async function nearestReach(lat: number, lon: number): Promise<ReachHit | null> {
  if (!hasReachData(lat, lon)) return null;
  const n = await load();
  const seen = reachCandidates(n, lat, lon);
  if (seen.size === 0) return null;

  /**
   * MEASURED (checks/area-discharge-consistency.mjs), 105 gauges.
   *
   * MERIT's per-vertex area and HydroRIVERS' own reach area agree closely —
   * median 0.99x, p10 0.92x, p90 1.01x — so wiring MERIT in did not quietly
   * move the ground under 96% of sites. It disagrees by more than 2x on four,
   * and on the two that matter MERIT is right: Chepe Khola reads 302 km2
   * against HydroRIVERS' 6, and the gauge there measures 24.7 m3/s against the
   * network's 0.35. HydroRIVERS had snapped to a side channel.
   *
   * A TRAP worth naming, since this project leans on specific discharge as its
   * physics test everywhere: that test is VACUOUS against the network's own
   * area. HydroRIVERS derives discharge from its own catchment, so dividing one
   * by the other lands in the plausible band by construction — 105 of 105 here,
   * including the reach that is wrong by a factor of seventy. Against MERIT's
   * independent area the same test flags 2, and the gauges confirm both. An
   * independent denominator is the whole point; the reach's own proves nothing.
   *
   * No guard was added for those two. Flowchoice's existing judge already
   * demotes the network when an independent source disagrees beyond 3x, and
   * HYDEST on the MERIT area returns 17.5 m3/s for Chepe against the network's
   * 0.35 — the case is caught by machinery that already ships.
   *
   * KNOWN FAILURE, unfixed: MERIT bleeds across confluences.
   *
   * The build samples a 92.77 m flow-accumulation raster in a small window
   * around each vertex, and next to a big river the neighbouring pixel carries
   * that river's accumulation. Sweeping 3,823 points across Nepal's mapped
   * channels, MERIT exceeds the reach's own area by more than 2x on 6.3% of
   * them — and it is not spread evenly:
   *
   *   order 1   p99  74x   max 4954x   8.9% over 2x
   *   order 2   p99  23x   max  707x   4.5%
   *   order 3+  p99   3x   max   13x   under 3%
   *
   * Mistri Khola is the proof rather than the inference: two DIFFERENT reaches
   * there, an order-4 tributary of 321 km2 and the order-5 Kali Gandaki of
   * 3,969 km2, report the SAME MERIT area of 3,638 km2. One raster line is
   * being read for both.
   *
   * It is NOT guarded against, because a bleed and a rescue are indistinguishable
   * at a point: Chepe Khola reads 302 km2 against a reach's 6 and MERIT is
   * right there, a 50x disagreement sitting inside the same range as the bleeds.
   * No threshold separates them, and any rule that suppressed the bleeds would
   * discard the rescues that justified this data in the first place.
   *
   * READ THE VALIDATION THAT CLEARED THIS WITH SUSPICION. MERIT was measured to
   * rescue seven gauges and break none — on gauges, whose median catchment is
   * about 800 km2 and two thirds of which sit at order 4 or above. Real projects
   * have a median catchment near 100 km2 and three quarters sit at order 3 or
   * below. The bleed rate is roughly 9% where the projects are and 1% where the
   * gauges are, so that clearance barely sampled the regime it was clearing.
   *
   * END-TO-END, ANSWERED. 72 fleet plants scored under both configurations,
   * MERIT per-vertex area against the reach figure alone:
   *
   *                 licence reached   implied median   under 0.5x
   *   MERIT on          57/72             4.0 km            7
   *   MERIT off         57/72             3.6 km            9
   *
   * Two fewer catastrophic under-predictions, which is the one-sided test, and
   * the same number of plants landing on the curve. It earns its place.
   *
   * The mechanism is visible plant by plant. Sunigad's reach area is 3 km2 and
   * MERIT reads 196; the scheme goes from 0.42 MW to 23.9 against a licensed
   * 11.1. Super Dordi's reach is 5 km2 against MERIT's 164, and 1.68 MW becomes
   * 46.9 against a licensed 54. Where HydroRIVERS has snapped to a stub, MERIT
   * is the only thing that notices.
   *
   * IT ALSO LOSES ONE, and the loss is the bleed documented below. At the DoED
   * coordinate for Upper Tamakoshi the reach reads 2,100 km2 and MERIT reads
   * 306 — MERIT is the wrong one there, and capacity falls from 131 MW to 56
   * against a built 456. Note this is a DIFFERENT point from the OSM headworks
   * used in plants.json, where MERIT reads 1741 against a published 1745. The
   * per-vertex figure is excellent where the vertex is on the channel and
   * arbitrary where it is not.
   *
   * Catchment at this exact point, where MERIT could be read there.
   *
   * Falls back to the reach figure, which is what every caller used before and
   * what still applies on the headwaters OpenStreetMap has not traced.
   */
  /**
   * A MERIT reading far BELOW the reach's own area is a dropout, not a catchment.
   *
   * The bleed problem is documented and deliberate: a 92 m accumulation raster
   * sampled beside a big river picks up its line, so MERIT can read far too
   * HIGH, and suppressing that would discard genuine rescues along with it.
   * The opposite direction carries no such ambiguity. HydroRIVERS says a reach
   * drains 2,106 km²; the raster cannot legitimately say 0.1 km² at a point on
   * it. That is the sample landing off the flow line — a hillside cell beside
   * the channel — and it is nonsense in a way a bleed is not.
   *
   * It bit at Upper Bhote Koshi: the snap correctly chose the 2,106 km² Bhote
   * Koshi, the per-vertex MERIT sample at the chosen vertex read 0.1 km², and
   * the engine then found no scheme on a river carrying 45 MW of built plant.
   *
   * Deliberately one-sided, and deliberately generous: only readings under a
   * tenth of the mapped area are refused, so ordinary disagreement between a
   * 92 m raster and a 500 m network passes untouched.
   */
  const MERIT_MIN_FRAC = 0.1;
  const areaAt = (i: number, vertex: number): number => {
    const reachFallback = n.upland[i] / 10;
    if (!n.upa) return reachFallback;
    const v = n.upa[n.start[i] + vertex];
    if (!v) return reachFallback;
    const merit = n.upaLo * Math.exp(((v - 1) / 65534) * Math.log(n.upaHi / n.upaLo));
    if (reachFallback > 0 && merit < reachFallback * MERIT_MIN_FRAC) return reachFallback;
    return merit;
  };

  const mk = (i: number, hit: ReachCandidate): Reach => {
    const merit = areaAt(i, hit.vertex);
    const reachArea = n.upland[i] / 10;
    return {
    uplandKm2: merit,
    areaSource: merit === reachArea ? 'reach' : 'merit',
    meanDischargeCms: n.dis[i] / 1000,
    reachUplandKm2: reachArea,
    strahler: n.ord[i],
    distanceKm: hit.distanceKm,
    point: hit.point,
    // 255 is the "no hypsometry here" sentinel; 0-254 spans 0..1.
    below5000Frac:
      n.hypso && n.hypso[i * n.hypsoStride] !== 255 ? n.hypso[i * n.hypsoStride] / 254 : NaN,
    below3000Frac:
      n.hypso && n.hypso[i * n.hypsoStride + 1] !== 255 ? n.hypso[i * n.hypsoStride + 1] / 254 : NaN,
    averageAltitudeM: n.elev && n.elev[i] > 0 ? n.elev[i] : NaN,
    annualPrecipMm: n.annualMm && n.annualMm[i] > 0 ? n.annualMm[i] : NaN,
    monsoonMm: (() => {
      if (!n.hypso || n.hypsoStride < 4) return NaN;
      const v = n.hypso[i * 4 + 2] | (n.hypso[i * 4 + 3] << 8);
      return v === 0xffff ? NaN : v;
    })(),
    networkIndex: i,
    networkVertex: hit.vertex,
    };
  };

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

/**
 * A neighbour draining this many times more is not a neighbour, it is the river.
 *
 * The app reads the NEAREST reach, because a click should mean the channel
 * clicked on. At a confluence that rule can hand a study a rivulet: Upper
 * Tamakoshi's published headworks land 0.95 km from the 1,754 km2 Tamakoshi and
 * a few metres from an 8 km2 tributary, and the app reported 0.8 MW against a
 * built 456.
 *
 * Auto-snapping on the existing 5x test was tried and rejected — it moves the
 * marker further than this app is willing to move it, and at 5x the user may
 * well have meant the smaller channel. So the threshold was measured instead.
 * Across the DHM stations where a bigger neighbour is offered at all
 * (checks/snap-rule.mjs), scoring each candidate against the flow the gauge
 * actually recorded:
 *
 *   ratio >= 5    4 right, 1 wrong
 *   ratio >= 100  4 right, 0 wrong
 *
 * The one case a loose rule breaks is the Sabhaya Khola, where the nearest
 * reach is a real 397 km2 river beside a 28,225 km2 one at 71x. The four it
 * fixes sit at 313x, 662x, 704x and 1121x. A hundred separates them with room
 * on both sides, and it is defensible without the statistics: a channel
 * draining a hundredth of what runs a kilometre away carries a hundredth of the
 * water, and nobody sites an intake there and means it.
 *
 * ONLY FIVE STATIONS OFFER THE CHOICE, so this is a small sample and the
 * threshold is deliberately far from both edges rather than fitted to them.
 *
 * A RATIO ALONE CANNOT CATCH EVERYTHING, and the gap is now measured.
 *
 * Seti Khola HPP is licensed at 25 MW. Its intake snaps to a 37 km2 tributary
 * with the 311 km2 river 0.42 km away — a ratio of 8.3, far below this
 * threshold, so nothing fires and the app reports 8.5 MW. Lowering the
 * threshold to catch it is not available: the Sabhaya Khola, where the NEAREST
 * reach is correct, sits at 71. No single ratio separates 8.3 from 71.
 *
 * The signal that does separate them is physical, and the app already fetches
 * it. The flood model reads 21.5 m3/s at Seti Khola, which on the 37 km2
 * candidate is 0.578 m3/s per km2 — impossible anywhere in Nepal — and on the
 * 311 km2 candidate is 0.069, textbook. Run over the fleet plants where a
 * neighbour is offered at all, that test fires on Seti Khola alone and stays
 * silent where the candidates are within a factor of 1.2 of each other.
 *
 * It cannot live HERE, because this function runs before any flow is fetched
 * and HydroRIVERS' own per-reach discharge is self-consistent with its own
 * catchment, carrying no independent information. It needs the model's cell,
 * which means the decision belongs after the discharge fetch — a re-entrant
 * change to the study path, not a constant to tune. Left undone deliberately
 * rather than approximated here.
 *
 * The same failure explains why engine/flowchoice.ts sides with the network at
 * Seti Khola: its judge is WECS/DHM computed from the SNAPPED catchment, so a
 * wrong area produces a wrong regional estimate that then confirms the wrong
 * source. The judge inherits the error it is meant to arbitrate.
 */
/**
 * A/B'd ON 31 SCORABLE PLANTS, and left where it was.
 *
 * Lower Modi Khola snaps to a 38 km2 tributary with the 565 km2 Modi 0.84 km
 * away — a 14.7x difference, under this bar, so the app warns and does not act,
 * and the plant reads 2.6 MW against a licensed 20. Dropping the bar to 12x
 * fixes exactly that plant, and on the seed it was found in the under-prediction
 * count went 1/18 to 0/18.
 *
 * On the full 31-plant sample it went 4 to 4. p10 0.19x against 0.20x, median
 * 1.99x against 2.04x, p90 unchanged. The single-seed win was one plant, not a
 * trend, and a lower bar promotes more marginal cases for no measured gain —
 * while Upper Syange is already a documented false positive at 100x.
 *
 * The under-predictions that remain are one coherent class: a published
 * coordinate landing on a tributary beside the real river. Four of the five are
 * that; the app detects them (`ambiguous`) and declines to move the marker,
 * which is a deliberate choice about what a click means, not a bug in this
 * number.
 */
const OVERWHELMING_RATIO = 100;

/**
 * A MEASURED FALSE POSITIVE, not yet fixed.
 *
 * Upper Syange Khola SHP is a 2.4 MW scheme on a 15.7 km2 khola with the 2,483
 * km2 Marsyangdi 1.33 km away — a ratio of 158, so this rule promotes it and
 * the app reports 301 MW. The khola can host the plant perfectly well: 2.4 MW
 * at the head found needs 0.475 m3/s, which is 0.030 m3/s per km2, ordinary
 * for Nepal. The nearest reach was right and this rule overrode it.
 *
 * No threshold fixes that. Upper Tamakoshi, where promotion IS correct, sits at
 * 218; Upper Syange at 158; and Seti Khola, which also needs promoting, at 8.3.
 * The three do not separate by ratio in any order.
 *
 * arbitrateByModelFlow above is the principled replacement — it promotes only
 * where the modelled discharge is physically impossible on the nearest
 * catchment — and it should eventually subsume this rule entirely. That change
 * is NOT made here because the run that would prove it does not break Upper
 * Tamakoshi was cut off by the discharge service's rate limit. Keeping both for
 * now is strictly no worse than what shipped this morning and strictly better
 * on Seti Khola; replacing one with the other unmeasured would not be.
 */

/** Nepal's rivers run between these, m3/s per km2. Outside is not a real river. */
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;

/**
 * The arbiter a ratio cannot be: does the catchment make the MODEL's own flow
 * physically possible?
 *
 * Where two candidates are offered, their catchments differ but the water at
 * that spot does not. The flood model measures that water independently of
 * either catchment, so it can say which one is real: at Seti Khola it reads
 * 21.5 m3/s, which on the 37 km2 nearest reach is 0.578 m3/s per km2 —
 * impossible anywhere in Nepal — and on the 311 km2 neighbour is 0.069.
 *
 * This is what OVERWHELMING_RATIO cannot do. Seti Khola's candidates differ by
 * 8.3x and the Sabhaya Khola's, where the NEAREST is correct, by 71x; no
 * threshold separates them. Physics does.
 *
 * Deliberately one-sided and narrow. It promotes ONLY when the nearest reach
 * cannot carry the modelled flow at all AND the neighbour comfortably can, so a
 * merely-larger neighbour never wins. Run across the fleet plants offered a
 * choice, it fires on Seti Khola alone and stays silent wherever the candidates
 * sit within a factor of 1.2.
 *
 * REFUTED, AND DISABLED. The reasoning above is wrong, and MERIT disproved it.
 *
 * The claim was that a ~5 km cell reading high near a big river indicates the
 * point is ON that river. It does not. It indicates the CELL covers it. Sampled
 * at 93 m at each coordinate, MERIT Hydro says:
 *
 *   Seti Khola     37 km2 — matching the NEAREST reach, not the 311 km2 neighbour
 *   Upper Syange   15 km2 — matching the NEAREST reach, not the 2,483 km2 neighbour
 *   Likhu-4        14 km2 — matching the NEAREST reach
 *
 * So Seti Khola genuinely sits on a 37 km2 channel and this arbiter promoted it
 * to 311 km2 on the strength of a model reading that was itself wrong. It turned
 * a 0.34x under-prediction into a 3.28x over-prediction — a different error, not
 * a smaller one. Trusting the model's magnitude to arbitrate is exactly what
 * engine/flowchoice.ts exists because you cannot do.
 *
 * WHAT WOULD ACTUALLY WORK is the thing that caught the mistake: MERIT sampled
 * at the CLICK POINT and compared against both candidates. It answers all four
 * test cases correctly, including Upper Tamakoshi, where the point is off-channel
 * at 93 m and reads 2,107 km2 at 1.4 km — supporting promotion there and
 * refusing it in the other three.
 *
 * It is not implemented because the per-vertex bundle this app ships samples
 * MERIT at RIVER VERTICES, and the discriminating read is at an arbitrary click,
 * which needs the raster itself. That is a data-shipping problem (a Nepal-wide
 * upa lookup is ~100 MB before quantisation), not a logic one.
 *
 * Left in place, unused, because the reasoning is worth keeping visible: the
 * next person to think "the flood model can tell us which river this is" should
 * find this note before spending a day on it.
 */
export function arbitrateByModelFlow(
  hit: { nearest: Reach; mainStem: Reach | null },
  chosen: Reach,
  modelMeanCms: number
): { reach: Reach; promoted: boolean } {
  const { nearest, mainStem } = hit;
  if (!mainStem || chosen !== nearest || !(modelMeanCms > 0)) return { reach: chosen, promoted: false };
  if (!(nearest.uplandKm2 > 0) || !(mainStem.uplandKm2 > 0)) return { reach: chosen, promoted: false };
  const onNearest = modelMeanCms / nearest.uplandKm2;
  const onMain = modelMeanCms / mainStem.uplandKm2;
  const promote = onNearest > SPECIFIC_MAX && onMain >= SPECIFIC_MIN && onMain <= SPECIFIC_MAX;
  return { reach: promote ? mainStem : chosen, promoted: promote };
}

/**
 * The reach a study should actually read, given the choice nearestReach offers.
 *
 * Returns the nearest reach unchanged in every ordinary case. The marker does
 * not move and `nearest`/`mainStem` keep their meanings; this only decides
 * which one the hydrology is read from, and callers should tell the user when
 * it is not the nearest.
 */
export function reachToRead(hit: { nearest: Reach; mainStem: Reach | null }): {
  reach: Reach;
  overridden: boolean;
} {
  const { nearest, mainStem } = hit;
  const overridden =
    !!mainStem && nearest.uplandKm2 > 0 && mainStem.uplandKm2 / nearest.uplandKm2 >= OVERWHELMING_RATIO;
  const reach = overridden ? mainStem! : nearest;

  /**
   * A sourced area is applied HERE and not while building candidates, because a
   * pin is anchored to a place and several channels can pass within its radius.
   * Attached to every candidate it would give a headwater trickle the main
   * stem's catchment and then let that inflated figure decide which of the two
   * to read. Attached to the chosen reach it corrects the answer without
   * touching the choice.
   */
  const pinned = areaOverrideAt(reach.point.lat, reach.point.lon);
  if (!pinned) return { reach, overridden };
  return {
    reach: {
      ...reach,
      uplandKm2: pinned.uplandKm2,
      areaSource: 'override',
      areaOverride: { name: pinned.name, source: pinned.source },
    },
    overridden,
  };
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
        // Same per-vertex MERIT area the reach lookup uses, so a path and a
        // click on the same spot never disagree about the catchment.
        uplandKm2: (() => {
          const fallback = n.upland[cur] / 10;
          if (!n.upa) return fallback;
          const v = n.upa[n.start[cur] + k];
          if (!v) return fallback;
          const merit = n.upaLo * Math.exp(((v - 1) / 65534) * Math.log(n.upaHi / n.upaLo));
          // Same dropout guard as `areaAt` above: a raster sample far below the
          // mapped reach area is off the flow line, not a smaller catchment.
          return fallback > 0 && merit < fallback * 0.1 ? fallback : merit;
        })(),
        meanCms: n.dis[cur] / 1000,
        networkIndex: cur,
        networkVertex: k,
      };
      if (raw.length > 0) {
        const prev = raw[raw.length - 1];
        const seg = haversineKmLocal([prev.lat, prev.lon], [p.lat, p.lon]);
        /**
         * CLIP THE SEGMENT THAT CROSSES THE LIMIT, do not append it whole.
         *
         * The walk used to push the entire stored segment and only notice on
         * the next iteration, then resample all of it — so a corridor asked for
         * 22 km returned up to 25.92 km. 117 of 131 station-anchor paths ran
         * past their declared maximum, and everything downstream that trusts
         * that corridor — the intake search, gauge relations, terrain requests
         * — was quietly inspecting further than configured.
         */
        if (km + seg >= maxKm) {
          const f = seg > 0 ? (maxKm - km) / seg : 0;
          raw.push({
            ...p,
            lat: prev.lat + f * (p.lat - prev.lat),
            lon: prev.lon + f * (p.lon - prev.lon),
          });
          km = maxKm;
          break;
        }
        km += seg;
      }
      raw.push(p);
    }
    if (km >= maxKm) break;
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
/**
 * The network, drawn on the traced channel wherever one exists.
 *
 * WHY THE MAP LOOKED WRONG. HydroRIVERS is derived at about 500 m, so a bend
 * becomes a chord: our line cuts across meanders the satellite image plainly
 * shows. The basemap's own OSM waterways were drawn in the SAME cyan, so the
 * two sat side by side reading as one dataset that could not decide where the
 * river was. That is a bad look for a tool whose whole claim is care.
 *
 * pipeline/snap-vertices-to-osm.mjs already pulled every vertex onto the traced
 * channel — it was built so MERIT could be sampled on the water rather than
 * beside it — and about three quarters of vertices found one. Drawing those
 * positions puts the line on the river.
 *
 * FOR DRAWING ONLY, and the distinction is not cosmetic. Swapping the geometry
 * the ENGINE runs on was measured and rejected: elevations sampled along a
 * re-drawn line changed the head for the worse. What the engine does carry is
 * the LENGTH correction (osmLengthFactor), which already accounts for the
 * meander this line now shows — so the picture and the arithmetic agree about
 * the river being longer than the chord, and disagree about nothing else.
 *
 * A vertex OSM never traced keeps its modelled position, so the line degrades
 * to what it always was rather than to a guess.
 */
export async function riversGeoJson(): Promise<GeoJSON.FeatureCollection> {
  const n = await load();
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < n.count; i++) {
    if (n.ord[i] < 2) continue;
    const a = n.start[i];
    const coordinates: [number, number][] = new Array(n.len[i]);
    for (let k = 0; k < n.len[i]; k++) {
      const v = a + k;
      const sy = n.snapped ? n.snapped[v * 2] : 0;
      const sx = n.snapped ? n.snapped[v * 2 + 1] : 0;
      coordinates[k] =
        sy !== 0 && sx !== 0
          ? [sx / 1e6, sy / 1e6]
          : [n.xy[v * 2] / n.scale, n.xy[v * 2 + 1] / n.scale];
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: { d: n.dis[i] / 1000 },
    });
  }
  return { type: 'FeatureCollection', features };
}
