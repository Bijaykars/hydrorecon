/**
 * The river as someone traced it, rather than as a 500 m model inferred it.
 *
 * HydroRIVERS carries everything this app reasons with — catchment area,
 * long-term discharge, upstream and downstream topology — and none of it is in
 * OpenStreetMap. What HydroRIVERS does not carry is a believable line: derived
 * at about 500 m, it turns a Himalayan meander into a chord, leaving straight
 * runs of 350 m at the median and up to 3.7 km on this app's own reaches. An
 * intake cannot be placed on a bend that the data does not contain.
 *
 * So the two are used for what each is good for. Topology and hydrology stay
 * with HydroRIVERS; the geometry is pulled onto OSM's traced centreline.
 *
 * WHY NOT INFER IT FROM TERRAIN: that was tried twice and rejected twice
 * against the ten built plants (see snapPathToValley in src/api.ts). Seeking
 * the lowest ground in a cross-section cannot systematically improve head,
 * because head is a difference of two elevations and lowering both cancels; all
 * it adds is variance. A traced line is evidence, not inference.
 *
 * SOURCE: OpenStreetMap contributors, ODbL 1.0, via Geofabrik's Nepal extract.
 */
import { haversineKm } from './engine/hydro.ts';

type Bundle = { _retrieved: string; lines: { r: number; p: number[] }[] };

/** Cell size for the lookup grid, degrees. About 2 km, a few times the tolerance. */
const CELL = 0.02;

type Loaded = { lines: Bundle['lines']; grid: Map<string, number[]>; retrieved: string };
let loaded: Loaded | null = null;
let loading: Promise<Loaded | null> | null = null;

const key = (lat: number, lon: number) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

function load(): Promise<Loaded | null> {
  if (loading) return loading;
  loading = (async () => {
    try {
      // Same guard rivers.ts uses. Unguarded, `import.meta.env` is undefined
      // outside Vite and the property access throws into the catch below —
      // which reads as "the file is missing" and silently disables traced
      // geometry rather than reporting a problem.
      const baseUrl = import.meta.env?.BASE_URL ?? '/';
      const res = await fetch(`${baseUrl}nepal-osm-rivers.json`);
      if (!res.ok) return null;
      const bundle = (await res.json()) as Bundle;
      // Index every cell each line passes through, so a lookup reads a handful
      // of candidates instead of fifty-five thousand polylines.
      const grid = new Map<string, number[]>();
      bundle.lines.forEach((line, index) => {
        const seen = new Set<string>();
        for (let i = 0; i + 1 < line.p.length; i += 2) {
          const k = key(line.p[i], line.p[i + 1]);
          if (seen.has(k)) continue;
          seen.add(k);
          const bucket = grid.get(k);
          if (bucket) bucket.push(index);
          else grid.set(k, [index]);
        }
      });
      return { lines: bundle.lines, grid, retrieved: bundle._retrieved };
    } catch {
      return null;
    }
  })().then((v) => (loaded = v));
  return loading;
}

/** Whether the traced geometry is available at all. */
export async function osmRiversAvailable(): Promise<boolean> {
  return (await load()) !== null;
}

export const osmRiversRetrieved = () => loaded?.retrieved ?? null;

/** Closest point on a segment, in degrees, with the distance in km. */
function nearestOnSegment(
  lat: number,
  lon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): { lat: number; lon: number; km: number } {
  const cos = Math.cos((lat * Math.PI) / 180) || 1;
  const px = (lon - aLon) * cos;
  const py = lat - aLat;
  const dx = (bLon - aLon) * cos;
  const dy = bLat - aLat;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cLat = aLat + t * dy;
  const cLon = aLon + (t * dx) / cos;
  return { lat: cLat, lon: cLon, km: haversineKm([lat, lon], [cLat, cLon]) };
}

/**
 * How far a point may be pulled onto a traced channel.
 *
 * HydroRIVERS and OSM disagree by a few hundred metres on the same river, which
 * is the error being corrected. Past this the nearest traced line is more
 * likely a different watercourse than the same one drawn better, and moving
 * there would be a worse mistake than staying put.
 *
 * Tightening this to 300 m was tried against the built plants and was worse,
 * not better: it did nothing for Upper Bhote Koshi, the one plant that regresses
 * badly, and it gave back the large gain on Upper Tamakoshi (862 m against a
 * published 822 m, from 985 m). The pull distance is not what ails Bhote Koshi.
 */
const MAX_PULL_KM = 0.5;

/** How much closer a different watercourse must be before the match leaves the one it is on. */
const SWITCH_MARGIN_KM = 0.25;

/**
 * A waterway follows ONE watercourse, and never a gully that crosses it.
 *
 * Distance-plus-hysteresis was not enough. Diagnosed on Upper Bhote Koshi
 * (checks/bhotekoshi-osm.mjs), the single plant traced geometry used to
 * destroy — head 148 m to 344 m against a published 145 m — the path switched
 * watercourse SIX times in six kilometres, hopping off the river onto traced
 * streams of four, five and nineteen vertices: tributaries dropping down the
 * valley side, which is why the head exploded. Wherever such a gully passed
 * within a few tens of metres it was simply the nearest thing.
 *
 * OSM classifies each line as river or stream, and that is the missing signal.
 * The rule is not "prefer rivers" — a small khola scheme is genuinely on a
 * stream — it is "do not DEMOTE". Once the match is on a river it may move to
 * another river, but a stream has to wait until no river is in reach at all.
 * Starting class is not left to whichever line happens to be nearest the first
 * point either; it is the class that serves the most points along the path.
 */
const NEVER_DEMOTE = true;

/** Every traced line whose cell neighbourhood contains this point. */
function candidatesNear(data: Loaded, lat: number, lon: number): number[] {
  const out = new Set<number>();
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      const bucket = data.grid.get(key(lat + dLat * CELL, lon + dLon * CELL));
      if (bucket) for (const i of bucket) out.add(i);
    }
  }
  return [...out];
}

/** Closest approach of one traced line to a point. */
function closestOnLine(
  data: Loaded,
  index: number,
  lat: number,
  lon: number
): { lat: number; lon: number; km: number } | null {
  const p = data.lines[index].p;
  let best: { lat: number; lon: number; km: number } | null = null;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const hit = nearestOnSegment(lat, lon, p[i], p[i + 1], p[i + 2], p[i + 3]);
    if (hit.km < (best?.km ?? Infinity)) best = hit;
  }
  return best;
}

export type OsmSnap = {
  path: { lat: number; lon: number; km: number }[];
  /**
   * Which traced line and segment each point matched, parallel to `path`;
   * null where the point kept its modelled position.
   */
  matches: ({ line: number; seg: number } | null)[];
  /** Mean distance each point moved, metres. */
  movedM: number;
  /** Share of points that found a traced channel within tolerance. */
  matched: number;
  lengthBeforeKm: number;
  lengthAfterKm: number;
};

/**
 * Pull a modelled river path onto the traced one.
 *
 * Each point looks only in its own neighbourhood, and the result is rebuilt and
 * re-measured: a line that now follows the meander is longer than the chord it
 * replaced, and that length is what a headrace has to span.
 *
 * Points that find nothing traced within tolerance keep their modelled
 * position rather than being dragged to the nearest ditch — the small streams
 * this app screens are not all in OSM, and a partial correction on a real
 * channel beats a complete one onto the wrong channel.
 */
export async function snapPathToOsm(
  path: readonly { lat: number; lon: number; km: number }[]
): Promise<OsmSnap | null> {
  const data = await load();
  if (!data || path.length < 3) return null;

  /**
   * Seed the match with the watercourse that serves the PATH, not the one that
   * happens to sit nearest its first point. One stray vertex at the intake
   * should not decide which river the whole scheme is read from.
   */
  const serves = new Map<number, number>();
  for (const point of path) {
    for (const index of candidatesNear(data, point.lat, point.lon)) {
      const hit = closestOnLine(data, index, point.lat, point.lon);
      if (hit && hit.km <= MAX_PULL_KM) serves.set(index, (serves.get(index) ?? 0) + 1);
    }
  }
  let seed = -1;
  let seedScore = -1;
  for (const [index, n] of serves) {
    // Ties go to the river: a trunk and a tributary can serve equal counts.
    const score = n * 2 + (data.lines[index].r === 1 ? 1 : 0);
    if (score > seedScore) {
      seedScore = score;
      seed = index;
    }
  }
  const onRiver = seed >= 0 && data.lines[seed].r === 1;

  const out: { lat: number; lon: number; km: number }[] = [];
  /**
   * Where each point landed on the traced network, parallel to `path`.
   *
   * `null` means the point kept its modelled position. Carried so a caller can
   * substitute OSM's OWN vertices between two consecutive matches instead of
   * the straight chord that currently joins them — snapping the corners while
   * keeping ~500 m chords is what makes the drawn river cut across meanders it
   * has already been corrected onto.
   */
  const matches: ({ line: number; seg: number } | null)[] = [];
  let moved = 0;
  let matched = 0;
  /**
   * Stay on the watercourse you are already on.
   *
   * Snapping each point to whatever traced line happens to be nearest lets
   * consecutive points land on DIFFERENT rivers wherever two run close
   * together, and the path then zigzags between them. Measured against the
   * built plants that is not a small error: Upper Bhote Koshi's head went from
   * 148 m to 326 m against a published 145 m, because the ends of the reach had
   * hopped onto different watercourses at different elevations.
   *
   * So the previous point's line keeps the benefit of the doubt. Another line
   * has to be closer by a clear margin before the match moves to it, which is
   * the same hysteresis any map-matcher uses to stay on one road.
   */
  let currentLine = seed;
  for (const point of path) {
    let best: { lat: number; lon: number; km: number; line: number; seg: number } | null = null;
    let bestRiver: { lat: number; lon: number; km: number; line: number; seg: number } | null = null;
    let onCurrent: { lat: number; lon: number; km: number; line: number; seg: number } | null = null;
    const seen = new Set<number>();
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const bucket = data.grid.get(key(point.lat + dLat * CELL, point.lon + dLon * CELL));
        if (!bucket) continue;
        for (const index of bucket) {
          if (seen.has(index)) continue;
          seen.add(index);
          const p = data.lines[index].p;
          for (let i = 0; i + 3 < p.length; i += 2) {
            const hit = nearestOnSegment(point.lat, point.lon, p[i], p[i + 1], p[i + 2], p[i + 3]);
            const withLine = { ...hit, line: index, seg: i >> 1 };
            if (hit.km < (best?.km ?? Infinity)) best = withLine;
            if (data.lines[index].r === 1 && hit.km < (bestRiver?.km ?? Infinity))
              bestRiver = withLine;
            if (index === currentLine && hit.km < (onCurrent?.km ?? Infinity)) onCurrent = withLine;
          }
        }
      }
    }
    /**
     * Never demote. With the path established on a river, a traced stream is
     * only allowed to win when no river is within the pull radius — otherwise
     * every side gully that brushes the corridor steals a point or two and
     * drags the elevation profile up the valley wall with it.
     */
    const candidate =
      NEVER_DEMOTE && onRiver && best && data.lines[best.line].r !== 1 && bestRiver
        ? bestRiver
        : best;
    const chosen =
      onCurrent && onCurrent.km <= (candidate?.km ?? Infinity) + SWITCH_MARGIN_KM
        ? onCurrent
        : candidate;
    if (chosen && chosen.km <= MAX_PULL_KM) {
      matched++;
      moved += chosen.km * 1000;
      currentLine = chosen.line;
      out.push({ lat: chosen.lat, lon: chosen.lon, km: 0 });
      matches.push({ line: chosen.line, seg: chosen.seg });
    } else {
      out.push({ lat: point.lat, lon: point.lon, km: 0 });
      matches.push(null);
    }
  }

  let km = 0;
  for (let i = 0; i < out.length; i++) {
    if (i > 0) km += haversineKm([out[i - 1].lat, out[i - 1].lon], [out[i].lat, out[i].lon]);
    out[i].km = km;
  }
  return {
    path: out,
    matches,
    movedM: moved / Math.max(1, matched),
    matched: matched / path.length,
    lengthBeforeKm: path[path.length - 1].km,
    lengthAfterKm: km,
  };
}

/**
 * Charge the scheme for the river's real length, without moving the river.
 *
 * TWO SEPARABLE ERRORS, and only one of them is safe to fix.
 *
 * HydroRIVERS draws a chord across every meander it cannot resolve, so the
 * waterway it reports is SHORT: measured against traced geometry over sixty
 * reaches (checks/length-vs-osm.mjs), short by 3.8% at the median, on 80% of
 * reaches, and by up to 22%. That is a one-directional bias with a known cause,
 * and length is not cosmetic — it sizes the headrace and penstock and sets the
 * friction loss taken off gross head.
 *
 * Replacing the whole COURSE was tried and rejected. Wired into the ten built
 * plants it improved head on three, worsened it on two and left four alone:
 * median head error 26% to 20%, but mean unchanged at 37%, capacity error up
 * from 17% to 28%, and Upper Bhote Koshi — which HydroRIVERS gets to within 2%
 * — regressed to 35%. Better on average is not good enough to move every site's
 * elevation profile onto a different line.
 *
 * So the two are split. Head is a difference between two ENDPOINT elevations,
 * and those endpoints stay exactly where the validated path put them. Length is
 * a property of the course BETWEEN them, and that is what traced geometry
 * measures better. This returns the factor to stretch the along-path distances
 * by, and nothing else.
 *
 * Returns 1 when traced geometry is unavailable, too little of the path matched
 * to trust, or the traced line came out shorter — a chord cannot be longer than
 * the curve it cuts, so a shorter trace means the match wandered, not that the
 * river is straighter than modelled.
 */
const MIN_MATCHED_TO_APPLY = 0.6;

export async function osmLengthFactor(
  path: readonly { lat: number; lon: number; km: number }[]
): Promise<{ factor: number; snap: OsmSnap | null }> {
  const snap = await snapPathToOsm(path).catch(() => null);
  if (!snap || snap.matched < MIN_MATCHED_TO_APPLY) return { factor: 1, snap };
  if (!(snap.lengthBeforeKm > 0) || !(snap.lengthAfterKm > snap.lengthBeforeKm)) {
    return { factor: 1, snap };
  }
  return { factor: snap.lengthAfterKm / snap.lengthBeforeKm, snap };
}

/** Restate a path's along-course distances at their traced length. */
export function stretchPath<T extends { km: number }>(path: T[], factor: number): T[] {
  return factor === 1 ? path : path.map((p) => ({ ...p, km: p.km * factor }));
}

/**
 * The traced course between two snapped points, not the chord across it.
 *
 * WHY THIS EXISTS. `snapPathToOsm` moves each modelled vertex onto the traced
 * channel and stops there, and `snap-vertices-to-osm.mjs` writes those
 * positions "parallel to the vertex block" — one output vertex per input
 * vertex. HydroRIVERS vertices sit about 500 m apart, so the drawn river is a
 * chain of corners that ARE on the water joined by straight lines that are not.
 * On a meandering Himalayan reach that reads, correctly, as a line cutting
 * across the valley the imagery plainly shows the river going round.
 *
 * OSM already holds the answer at 124 m per vertex over 92,000 km. This walks
 * the matched line between consecutive points and emits its intermediate
 * vertices, so the drawn course follows the channel instead of approximating
 * it.
 *
 * THREE THINGS IT REFUSES TO DO, each of which would trade a cosmetic win for a
 * wrong river:
 *
 *   It will not splice across a LINE CHANGE. Two consecutive points matched to
 *   different OSM ways may be a legitimate confluence or the map-matcher
 *   hopping onto a tributary; inserting one way's geometry between them would
 *   draw a river that does not exist. Those pairs keep their chord.
 *
 *   It will not splice BACKWARDS. OSM ways carry their own direction, which is
 *   not always downstream. A pair whose segment indices run the wrong way is
 *   left as a chord rather than reversed on the assumption the way is drawn
 *   upstream.
 *
 *   It will not splice a DETOUR. If the traced course between two points is
 *   more than MAX_DETOUR times their straight-line separation, the match has
 *   wandered up a side channel and come back. The chord is the safer drawing.
 *
 * Geometry only, and for DRAWING only. Nothing here feeds an elevation sample:
 * `rivers.ts` keeps the engine on the modelled vertices deliberately, and
 * `osm-rivers.ts` records that swapping the course under the engine was
 * measured and lost on capacity.
 */
const MAX_DETOUR = 3;

export function densifyAlongTrace(
  snap: OsmSnap,
  lines: readonly { p: readonly number[] }[]
): { coordinates: [number, number][]; tracedSegments: number; totalSegments: number } {
  const coordinates: [number, number][] = [];
  let tracedSegments = 0;
  let totalSegments = 0;
  for (let i = 0; i < snap.path.length; i++) {
    const a = snap.path[i];
    coordinates.push([a.lon, a.lat]);
    if (i === snap.path.length - 1) break;
    totalSegments++;
    const b = snap.path[i + 1];
    const ma = snap.matches[i];
    const mb = snap.matches[i + 1];
    if (!ma || !mb || ma.line !== mb.line || mb.seg < ma.seg) continue;

    const p = lines[ma.line]?.p;
    if (!p) continue;
    const between: [number, number][] = [];
    let traced = 0;
    let prev: [number, number] = [a.lon, a.lat];
    // Vertices strictly between the two projections: segment `seg` runs from
    // vertex seg to seg+1, so the interior starts at ma.seg + 1.
    for (let v = ma.seg + 1; v <= mb.seg; v++) {
      const lat = p[v * 2];
      const lon = p[v * 2 + 1];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      traced += haversineKm([prev[1], prev[0]], [lat, lon]);
      prev = [lon, lat];
      between.push([lon, lat]);
    }
    if (!between.length) continue;
    traced += haversineKm([prev[1], prev[0]], [b.lat, b.lon]);
    const chord = haversineKm([a.lat, a.lon], [b.lat, b.lon]);
    if (chord > 0 && traced > chord * MAX_DETOUR) continue;
    coordinates.push(...between);
    tracedSegments++;
  }
  return { coordinates, tracedSegments, totalSegments };
}

/** The traced lines themselves, for a caller doing its own densification. */
export async function osmLines(): Promise<readonly { p: readonly number[]; r: number }[] | null> {
  const data = await load();
  return data ? data.lines : null;
}
