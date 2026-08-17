/**
 * Where the real measurements are.
 *
 * Flow is the dominant error in every estimate this app makes — around +/-50%,
 * against +/-8% from terrain — because both flow sources are uncalibrated global
 * models with nothing gauged at the site. No amount of better arithmetic fixes
 * that. One real record does.
 *
 * Nepal's DHM publishes a national station inventory, and its river-station
 * locations were already bundled and going unused. This turns them into the answer to "so what
 * would I have to do to trust this number?": name the specific station whose
 * record transfers to this site, say how it relates hydrologically, and give the
 * factor to scale it by.
 *
 * The VALUES are not available — hydrology.gov.np/gss/api/observation returns
 * 403 "Permission denied or Api Keys required", and it does so for DHM's own
 * portal too, not just for us. So this is a pointer, not a data source. That is
 * still most of the value: knowing which station to request, and what its record
 * is worth once you have it, is the part that needs the river network.
 */
// The import attribute is required by Node's ESM loader, which `npm run check`
// uses; Vite is happy either way.
import stationsRaw from './data/dhm-stations.json' with { type: 'json' };
import { downstreamPath, hasReachData, nearestReach } from './rivers.ts';
import { haversineKm } from './engine/hydro.ts';

type RawStation = {
  n: string;
  y: number;
  x: number;
  e: number | null;
  r: number;
  /** 1 when the station records manual discharge (Q_M), not only water level. */
  q?: number;
  /** DHM series id for that discharge record, to quote in a data request. */
  qs?: number;
  rv?: string;
  b?: string;
  d?: string;
  w?: number;
  g?: number;
};

/** How the gauge sits relative to the study site, hydrologically. */
export type Relation =
  /** Water measured there flows past here — the record needs scaling UP. */
  | 'upstream'
  /** Water from here flows past there — the record needs scaling DOWN. */
  | 'downstream'
  /** Close by, but on a different branch. Only a regional analogue. */
  | 'nearby catchment';

export type Gauge = {
  name: string;
  lat: number;
  lon: number;
  /** Straight-line distance to the nearest point on the studied reach, km. */
  distanceKm: number;
  /** Catchment above the gauge, km², from the mapped network. Null off-network. */
  uplandKm2: number | null;
  relation: Relation;
  /**
   * Whether DHM records DISCHARGE here, or only water level.
   *
   * This is the difference between a record you can use and one you would still
   * have to convert. A stage record without its rating curve is not a flow
   * series, and that curve is a separate thing to obtain — so of two otherwise
   * equal stations, the one gauging discharge is worth far more. 194 of the
   * bundled stations carry a manual discharge series; the rest are stage only.
   */
  measuresDischarge: boolean;
  /** DHM's own series id for that discharge record, for quoting in a request. */
  seriesId: number | null;
  /** River, basin and district as DHM records them. */
  river: string | null;
  basin: string | null;
  district: string | null;
  /** DHM's published flood thresholds at this gauge board, m. */
  warnLevelM: number | null;
  dangerLevelM: number | null;
  /**
   * Multiply the gauge's discharge by this to get discharge here.
   *
   * Catchment-area transfer, Q_here = Q_gauge x (A_here / A_gauge), is the
   * standard method for an ungauged site and what a Nepali feasibility study
   * would do with this record. It assumes the two catchments generate runoff at
   * a similar rate per km², which holds when they share a climate and share
   * terrain — hence `trustworthy` below.
   */
  areaRatio: number | null;
  /**
   * Whether the transfer is defensible rather than merely arithmetic.
   *
   * Standard hydrological practice keeps area-ratio transfer to roughly 0.5-2x
   * and to the same river. Beyond that the two catchments are different enough
   * that the ratio stops carrying the runoff behaviour with it.
   */
  trustworthy: boolean;
};

const STATION_BUNDLE = stationsRaw as unknown as {
  _source: string;
  _retrieved: string;
  stations: RawStation[];
};
const STATIONS = STATION_BUNDLE.stations;

export const DHM_STATIONS_RETRIEVED = STATION_BUNDLE._retrieved;

/** River gauges only — the file also carries 916 rainfall stations. */
const RIVER_GAUGES = STATIONS.filter((s) => s.r === 1);

/** Beyond this a gauge is not describing this site under any interpretation. */
const MAX_SEARCH_KM = 40;
/** How close a downstream walk must pass to count as "the same river". */
const CONNECT_KM = 1.5;
/** Area-ratio bounds inside which a transfer is standard practice. */
const RATIO_LO = 0.5;
const RATIO_HI = 2;
/**
 * How closely the two snap candidates must agree before the catchment area is
 * believed. Beyond this the gauge is at a confluence and its channel is
 * unresolved — see `resolve`.
 */
const AGREE_RATIO = 1.5;

/**
 * Gauges whose record could inform this reach, best first.
 *
 * "Best" is not "closest". A station 3 km away on a different stream is worth
 * less than one 20 km down the same river, because only the second one is
 * measuring this water. So connected stations rank first, and within those, the
 * one whose catchment is closest in size to the site's.
 */
export async function gaugesFor(
  path: readonly { lat: number; lon: number }[],
  studyUplandKm2: number | null
): Promise<Gauge[]> {
  if (path.length === 0) return [];

  // Coarse box first — 199 stations against a few hundred path points otherwise.
  const pad = MAX_SEARCH_KM / 100;
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

  const near: { st: RawStation; distanceKm: number }[] = [];
  for (const st of RIVER_GAUGES) {
    if (st.y > n + pad || st.y < s - pad || st.x > e + pad || st.x < w - pad) continue;
    let best = Infinity;
    for (const p of path) {
      const d = haversineKm([st.y, st.x], [p.lat, p.lon]);
      if (d < best) best = d;
      if (best < 0.25) break;
    }
    if (best <= MAX_SEARCH_KM) near.push({ st, distanceKm: best });
  }
  near.sort((a, b) => a.distanceKm - b.distanceKm);

  // Resolving each one costs a network walk, so stop after a handful.
  const out: Gauge[] = [];
  for (const { st, distanceKm } of near.slice(0, 6)) {
    out.push(await resolve(st, distanceKm, path, studyUplandKm2));
  }

  return out.sort((a, b) => {
    // Connected first — only a gauge on this water is measuring this river.
    const connected = (g: Gauge) => (g.relation === 'nearby catchment' ? 1 : 0);
    if (connected(a) !== connected(b)) return connected(a) - connected(b);
    // Then a real discharge record over a stage-only one: without its rating
    // curve a stage series is not flow, and the curve is a separate request.
    if (a.measuresDischarge !== b.measuresDischarge) return a.measuresDischarge ? -1 : 1;
    // Then closest in catchment size, since that is what transfers cleanly.
    const off = (g: Gauge) =>
      g.areaRatio ? Math.abs(Math.log(g.areaRatio)) : Number.POSITIVE_INFINITY;
    if (off(a) !== off(b)) return off(a) - off(b);
    return a.distanceKm - b.distanceKm;
  });
}

/** Work out how one station relates to the studied reach. */
async function resolve(
  st: RawStation,
  distanceKm: number,
  path: readonly { lat: number; lon: number }[],
  studyUplandKm2: number | null
): Promise<Gauge> {
  const head = path[0];
  let uplandKm2: number | null = null;
  if (hasReachData(st.y, st.x)) {
    const hit = await nearestReach(st.y, st.x);
    /**
     * Which channel is this gauge actually in? Often unanswerable, so ask first.
     *
     * `nearestReach` returns both the geometrically closest reach and the
     * largest one within snapping distance. For a user's click the larger is
     * right — they mean "this river", not the ditch beside it. For a gauge
     * neither is reliably right, and the gap between them measures the doubt:
     *
     *   Khudi Khola at Khudibazar      1,345 km2 nearest vs 29,320 main stem
     *   Marsyangdi River at Dharapani     92 km2 nearest vs 17,297 main stem
     *
     * Both sit at confluences. DHM publishes many station coordinates to two or
     * three decimals, and HydroRIVERS spaces reaches about 500 m apart, so in a
     * braided valley the snap simply cannot resolve which water the instrument
     * is in. Marsyangdi at Dharapani drains roughly 2,000 km2 — neither
     * candidate is close.
     *
     * A catchment area that might be 20x out would produce a transfer factor
     * 20x out, stated to two decimals. So the area is published only when the
     * two candidates agree; otherwise the station is still named and located,
     * with the ambiguity said out loud, and no ratio is offered.
     */
    const near = hit?.nearest?.uplandKm2 ?? null;
    const stem = hit?.mainStem?.uplandKm2 ?? near;
    const agree =
      near !== null && stem !== null && near > 0 && Math.max(stem / near, near / stem) <= AGREE_RATIO;
    uplandKm2 = agree ? near : null;
  }

  let relation: Relation = 'nearby catchment';
  // Does water measured at the gauge flow past the study site? Walk down from
  // the gauge and see whether the walk passes the head of the study reach.
  const fromGauge = await downstreamPath(st.y, st.x, MAX_SEARCH_KM + 10, 0.25).catch(() => null);
  if (fromGauge?.some((p) => haversineKm([p.lat, p.lon], [head.lat, head.lon]) <= CONNECT_KM)) {
    relation = 'upstream';
  } else if (path.some((p) => haversineKm([st.y, st.x], [p.lat, p.lon]) <= CONNECT_KM)) {
    // The study reach's own downstream walk passes the gauge.
    relation = 'downstream';
  }

  const areaRatio =
    studyUplandKm2 && uplandKm2 && uplandKm2 > 0 ? studyUplandKm2 / uplandKm2 : null;

  return {
    name: st.n,
    lat: st.y,
    lon: st.x,
    distanceKm,
    uplandKm2,
    relation,
    measuresDischarge: st.q === 1,
    seriesId: st.qs ?? null,
    river: st.rv ?? null,
    basin: st.b ?? null,
    district: st.d ?? null,
    warnLevelM: st.w ?? null,
    dangerLevelM: st.g ?? null,
    areaRatio,
    trustworthy:
      relation !== 'nearby catchment' &&
      areaRatio !== null &&
      areaRatio >= RATIO_LO &&
      areaRatio <= RATIO_HI,
  };
}

/** One line saying what to actually do with this station. */
export function transferAdvice(g: Gauge): string {
  if (g.areaRatio === null) {
    return g.uplandKm2 === null
      ? 'sits at a confluence — which channel it gauges cannot be resolved, so no scaling factor'
      : 'no catchment known here, so no scaling factor';
  }
  const pct = `${g.areaRatio.toFixed(2)}x`;
  if (!g.trustworthy) {
    if (g.relation === 'nearby catchment') {
      return `different branch — usable only as a regional analogue, not transferred directly`;
    }
    return `catchment ${pct} of the gauge's — outside the 0.5-2x range where area transfer holds`;
  }
  return `multiply its discharge by ${pct} to get flow here`;
}

/** Total gauges bundled, for saying how thin the network is somewhere. */
export const RIVER_GAUGE_COUNT = RIVER_GAUGES.length;
/** How many of those hold an actual discharge record rather than stage alone. */
export const DISCHARGE_GAUGE_COUNT = RIVER_GAUGES.filter((s) => s.q === 1).length;

/** What kind of record DHM holds here, said plainly. */
export function recordKind(g: Gauge): string {
  return g.measuresDischarge
    ? `discharge record${g.seriesId ? ` (DHM series ${g.seriesId})` : ''}`
    : 'water level only — a rating curve is needed too';
}
