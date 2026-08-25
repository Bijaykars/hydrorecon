/**
 * What rock is under this scheme, from Nepal's own map.
 *
 * The app already had three geological things and not one of them could answer
 * the question. `geology.ts` holds a DMG sheet INDEX — which publications cover
 * the alignment, never what is printed on them. `geology-overlay.ts` draws the
 * province sheets as raster tiles, which can be looked at and cannot be asked.
 * Macrostrat can be asked, over the network, and hands back a harmonized global
 * compilation that the report already calls out in as many words: "one polygon
 * spanning the entire alignment, and it is not an engineering input."
 *
 * This is Nepal's own 1:1,000,000 sheet as polygons, offline, carrying the
 * formation names Nepali engineers and DMG's own maps use — Kushma, Ulleri,
 * Ranimatta, Siwalik. Built by `pipeline/build-nepal-geology-units.py`.
 *
 * THE ONE THING IT ADDS THAT NOTHING ELSE DID: contacts. A headrace that stays
 * inside one formation is a different tunnel from one crossing three contacts,
 * because a contact is where the ground changes, where water comes in, and
 * where the excavation gets expensive. `geologyAlongPath` counts them.
 *
 * WHAT IT CANNOT DO, and the report must keep saying so. At 1:1,000,000 half a
 * millimetre of ink is 500 m of ground, so a contact carries roughly that much
 * positional error. This names the belt; it does not site a portal. Nothing
 * here is a substitute for the 1:50,000 sheets or for walking the line.
 *
 * AND THIRTY PERCENT HAS NO POLYGON — WHICH IS THE DIGITISATION, NOT THE MAP.
 * `No Data` covers ~45,000 km2, 29.6% of the extent, concentrated in the high
 * north where high-head schemes sit. This file used to say Nepal's geological
 * map was blank there. It is not: the printed Amatya & Jnawali (1994) sheet
 * covers the whole country, and DMG's own 1:350,000 province sheets — already
 * bundled — map 39 tiles' worth of ground this vector calls No Data. Measured
 * by `checks/geology-vs-dmg-sheets.mjs`.
 *
 * So `noData` means "this dataset does not carry it, go and read the published
 * sheet", not "nothing is known here". No function returns null for a point
 * inside Nepal, because absence and unmapped look identical to a caller and
 * mean opposite things — but the advice attached to `noData` is now the
 * opposite of what it was.
 */
import raw from './data/nepal-geology-units.json' with { type: 'json' };

type RawPolygon = {
  c: string;
  n: string;
  /** [south, west, north, east]. */
  b: [number, number, number, number];
  /** Flat [lat, lon, lat, lon, …] per ring; outer rings and holes both. */
  r: number[][];
};

type Bundle = {
  _source: string;
  _sourceUrl: string;
  _origin: string;
  _scale: string;
  _license: string;
  _retrieved: string;
  _simplifiedM: number;
  _noDataShare: number;
  _noDataKm2: number;
  _note: string;
  units: { c: string; n: string; polygons: number; areaKm2: number }[];
  polygons: RawPolygon[];
};

const BUNDLE = raw as unknown as Bundle;
const POLYGONS = BUNDLE.polygons;

export const GEOLOGY_UNITS_SOURCE = BUNDLE._source;
export const GEOLOGY_UNITS_SOURCE_URL = BUNDLE._sourceUrl;
export const GEOLOGY_UNITS_ORIGIN = BUNDLE._origin;
export const GEOLOGY_UNITS_SCALE = BUNDLE._scale;
export const GEOLOGY_UNITS_LICENSE = BUNDLE._license;
export const GEOLOGY_UNITS_RETRIEVED = BUNDLE._retrieved;
export const GEOLOGY_UNITS_NOTE = BUNDLE._note;
export const GEOLOGY_UNITS_COUNT = BUNDLE.units.length;
export const GEOLOGY_NO_DATA_SHARE = BUNDLE._noDataShare;
export const GEOLOGY_NO_DATA_KM2 = BUNDLE._noDataKm2;

/**
 * How far a contact drawn on this sheet could actually be, in km.
 *
 * 1:1,000,000 with a half-millimetre line is 500 m on the ground. Every
 * chainage this module reports for a contact is only good to about this, and
 * the number is exported so the report quotes it rather than reinventing it.
 */
export const CONTACT_ERROR_KM = 0.5;

/**
 * One sample per 100 m along the alignment.
 *
 * Five times finer than the map's own contact error, which is the point where
 * sampling stops buying anything: the limit is the source, not the step. A
 * 13 km waterway is then 130 point-in-polygon tests, which is nothing.
 */
const STEP_KM = 0.1;

/**
 * How far outside every polygon a point may sit and still be attributed, in
 * degrees of latitude.
 *
 * WHY THIS EXISTS. The pipeline simplifies each ring independently, which is
 * not topology-preserving: two polygons that shared an edge in the source no
 * longer do, and a sliver of no-man's-land opens between them. On a 0.02 deg
 * sweep of Nepal that produced 68 points reporting `offSheet` — "outside the
 * national sheet" — while completely ringed by mapped ground. Every one of
 * them is covered in the raw shapefile. A site near Chitwan being told it is
 * outside Nepal is a far worse failure than a contact being 200 m off.
 *
 * 500 m closes them by construction: a gap can be at most twice the 200 m
 * simplification tolerance wide, because each of the two lines can move 200 m
 * the wrong way. It is also exactly the positional error the source carries
 * anyway (CONTACT_ERROR_KM), so nothing is claimed here that the map did not
 * already blur. Points genuinely outside Nepal by more than half a kilometre
 * are unaffected and still report `offSheet`.
 */
const SNAP_DEG = 0.5 / 111.32;

/** Below this the source is giving a bare code with no legend behind it. */
const UNEXPANDED_MAX = 3;

const NO_DATA_NAME = 'No Data';

/**
 * The source subdivides some formations and gives each part its own code.
 * `Middle Siwalik`, `Middle Siwalik1` and `Middle Siwalik2` are three codes
 * (023, 004, 003) for members of one formation, and the Churia fixture in
 * `checks/geology-units.check.ts` walks straight across two of them.
 *
 * Counting that as a formation contact overstates the one number this module
 * exists to produce. The boundary is real and mapped, so it is not discarded —
 * it is flagged, and `formationContacts` reports the count without it.
 */
const formationOf = (name: string) => name.replace(/\s*\d+$/, '').trim().toLowerCase();

export type GeologyUnitHit = {
  /** The sheet's own GEOL_CODE. */
  code: string;
  /** Its CLASS label, verbatim. May be a bare abbreviation — see `named`. */
  name: string;
  /**
   * False where the source labels the polygon `Gh`, `Bu`, `Gn` and so on and
   * publishes no legend expanding them. Twelve of the 57 units are like this.
   * The report prints the code and says the source does not expand it, rather
   * than passing off two letters as a formation.
   */
  named: boolean;
  /**
   * True on the ~30% of the extent this DIGITISATION does not carry — mostly
   * the high north. Not a statement that the ground is unmapped: DMG's printed
   * sheets do cover it. Callers should point the reader at the published sheet
   * rather than report an absence of knowledge.
   */
  noData: boolean;
  /** True beyond the sheet's own edge, i.e. outside Nepal. */
  offSheet: boolean;
  /**
   * True where the point fell in a sliver between polygons and was attributed
   * to the nearest one within 500 m. Reported rather than hidden, though it
   * changes no advice: at this scale the boundary itself is only good to about
   * that distance.
   */
  snapped: boolean;
};

const OFF_SHEET: GeologyUnitHit = {
  code: '',
  name: 'outside the national sheet',
  named: false,
  noData: false,
  offSheet: true,
  snapped: false,
};

const hitOf = (p: RawPolygon, snapped = false): GeologyUnitHit => ({
  code: p.c,
  name: p.n || '(unlabelled)',
  named: p.n.length > UNEXPANDED_MAX && p.n !== NO_DATA_NAME,
  noData: p.n === NO_DATA_NAME || !p.n,
  offSheet: false,
  snapped,
});

/** Shortest distance from the point to any ring segment, in degrees of latitude. */
function edgeDistDeg(lat: number, lon: number, rings: number[][]): number {
  let best = Infinity;
  const cos = Math.cos((lat * Math.PI) / 180);
  for (const r of rings) {
    for (let i = 0; i + 3 < r.length; i += 2) {
      const ay = r[i];
      const ax = r[i + 1];
      const dy = r[i + 2] - ay;
      const dx = (r[i + 3] - ax) * cos;
      const py = lat - ay;
      const px = (lon - ax) * cos;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Even-odd ray cast over every ring, so holes subtract without being labelled. */
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

const boxArea = (b: RawPolygon['b']) => (b[2] - b[0]) * (b[3] - b[1]);

/**
 * The mapped unit at one point.
 *
 * Never null for anywhere inside Nepal. Three distinguishable answers: a named
 * unit, `noData` where the sheet is blank, and `offSheet` past its edge.
 *
 * Where polygons overlap — a digitised sheet has slivers — a MAPPED unit wins
 * over `No Data`, and among equals the smallest one wins, because a small
 * polygon drawn on top of a large one is the detail, not the background.
 */
export function geologyUnitAt(lat: number, lon: number): GeologyUnitHit {
  let best: RawPolygon | null = null;
  let bestBlank: RawPolygon | null = null;
  for (const p of POLYGONS) {
    if (lat < p.b[0] || lat > p.b[2] || lon < p.b[1] || lon > p.b[3]) continue;
    if (!inside(lat, lon, p.r)) continue;
    const blank = p.n === NO_DATA_NAME || !p.n;
    if (blank) {
      if (!bestBlank || boxArea(p.b) < boxArea(bestBlank.b)) bestBlank = p;
    } else if (!best || boxArea(p.b) < boxArea(best.b)) {
      best = p;
    }
  }
  if (best) return hitOf(best);
  if (bestBlank) return hitOf(bestBlank);

  // Nothing contains the point. Before declaring it outside Nepal, check
  // whether it is merely in a sliver — see SNAP_DEG.
  let near: RawPolygon | null = null;
  let nearD = SNAP_DEG;
  for (const p of POLYGONS) {
    if (
      lat < p.b[0] - SNAP_DEG ||
      lat > p.b[2] + SNAP_DEG ||
      lon < p.b[1] - SNAP_DEG ||
      lon > p.b[3] + SNAP_DEG
    ) {
      continue;
    }
    const d = edgeDistDeg(lat, lon, p.r);
    if (d < nearD) {
      nearD = d;
      near = p;
    }
  }
  return near ? hitOf(near, true) : OFF_SHEET;
}

export type GeologyRun = {
  unit: GeologyUnitHit;
  /** Chainage from the intake, km. */
  fromKm: number;
  toKm: number;
  lengthKm: number;
};

export type GeologyContact = {
  /** Chainage of the transition, km, good to about CONTACT_ERROR_KM. */
  atKm: number;
  from: GeologyUnitHit;
  to: GeologyUnitHit;
  /**
   * True where both sides are members of the same formation — the source's
   * `Middle Siwalik1` against `Middle Siwalik`. A mapped boundary, but an
   * internal subdivision rather than a change of formation.
   */
  withinFormation: boolean;
};

export type GeologyTraverse = {
  /** Every stretch of one unit along the line, in order. */
  runs: GeologyRun[];
  /**
   * Transitions between two MAPPED units — the geological contacts.
   *
   * Kept apart from `coverageEdges` on purpose. Walking off the edge of the
   * mapping is not a change of rock, and counting the two together would
   * inflate the headline number in the high country, where the blank area is,
   * and where a tunnel is most likely.
   */
  contacts: GeologyContact[];
  /**
   * Contacts between two DIFFERENT formations — `contacts` minus the internal
   * subdivisions. This is the number to quote; `contacts.length` is every
   * mapped boundary including members of one formation meeting each other.
   */
  formationContacts: number;
  /** Transitions into or out of unmapped ground. Not geology. */
  coverageEdges: number;
  lengthKm: number;
  /** How much of the line the national sheet actually maps. */
  mappedKm: number;
  /** Unit at each structure, which is what a foundation note needs. */
  intake: GeologyUnitHit;
  powerhouse: GeologyUnitHit;
  contactErrorKm: number;
  scale: string;
  source: string;
  limitation: string;
};

type Point = { lat: number; lon: number };

const R = 6371;
function km(a: Point, b: Point): number {
  const p = Math.PI / 180;
  const dLat = (b.lat - a.lat) * p;
  const dLon = (b.lon - a.lon) * p;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const sameUnit = (a: GeologyUnitHit, b: GeologyUnitHit) =>
  a.code === b.code && a.offSheet === b.offSheet;

/**
 * The units a waterway crosses, and where it crosses them.
 *
 * Returns null only for an empty path — a site outside Nepal still gets an
 * answer, an `offSheet` one, for the reason at the top of this file.
 */
export function geologyAlongPath(path: readonly Point[]): GeologyTraverse | null {
  if (path.length < 2) return null;

  const runs: GeologyRun[] = [];
  const contacts: GeologyContact[] = [];
  let coverageEdges = 0;
  let chain = 0;
  let mappedKm = 0;

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const segKm = km(a, b);
    if (!(segKm > 0)) continue;
    const steps = Math.max(1, Math.round(segKm / STEP_KM));
    const dk = segKm / steps;
    for (let s = 0; s < steps; s++) {
      // Midpoint of the step, so no sample lands exactly on a vertex where two
      // segments would both claim it — same rule landcover.ts uses.
      const t = (s + 0.5) / steps;
      const hit = geologyUnitAt(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t);
      const last = runs[runs.length - 1];
      if (last && sameUnit(last.unit, hit)) {
        last.toKm = chain + dk;
        last.lengthKm = last.toKm - last.fromKm;
      } else {
        if (last) {
          const known = !last.unit.noData && !last.unit.offSheet && !hit.noData && !hit.offSheet;
          if (known) {
            contacts.push({
              atKm: chain,
              from: last.unit,
              to: hit,
              withinFormation: formationOf(last.unit.name) === formationOf(hit.name),
            });
          }
          else coverageEdges++;
        }
        runs.push({ unit: hit, fromKm: chain, toKm: chain + dk, lengthKm: dk });
      }
      if (!hit.noData && !hit.offSheet) mappedKm += dk;
      chain += dk;
    }
  }
  if (!runs.length) return null;

  return {
    runs,
    contacts,
    formationContacts: contacts.filter((c) => !c.withinFormation).length,
    coverageEdges,
    lengthKm: chain,
    mappedKm,
    intake: geologyUnitAt(path[0].lat, path[0].lon),
    powerhouse: geologyUnitAt(path[path.length - 1].lat, path[path.length - 1].lon),
    contactErrorKm: CONTACT_ERROR_KM,
    scale: GEOLOGY_UNITS_SCALE,
    source: `${GEOLOGY_UNITS_SOURCE} (${GEOLOGY_UNITS_ORIGIN})`,
    limitation: GEOLOGY_UNITS_NOTE,
  };
}

/** Every unit the line touches, longest first — for a table, not a decision. */
export function geologySpans(t: GeologyTraverse) {
  const byCode = new Map<string, { unit: GeologyUnitHit; km: number }>();
  for (const r of t.runs) {
    const e = byCode.get(r.unit.code);
    if (e) e.km += r.lengthKm;
    else byCode.set(r.unit.code, { unit: r.unit, km: r.lengthKm });
  }
  return [...byCode.values()]
    .map((e) => ({ ...e, share: t.lengthKm > 0 ? e.km / t.lengthKm : 0 }))
    .sort((x, y) => y.km - x.km);
}
