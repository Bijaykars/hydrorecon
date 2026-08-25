/**
 * What the ground has done here, and what design should assume it can do.
 *
 * Two datasets, answering two different questions:
 *
 * PGA — the GEM Global Seismic Hazard Map v2023 (CC BY-NC-SA), peak ground
 * acceleration on rock at 475-year return. This is the reference case of
 * nearly every code, Nepal's NBC 105 included, and it is the number a
 * feasibility memo actually quotes. On ROCK: soft valley fill amplifies
 * shaking well beyond it — Kathmandu 2015 was the demonstration — so it is a
 * floor for design, not a site value.
 *
 * Seismicity — the USGS ComCat catalog, M4+ since 1900 (public domain).
 * Instrumented earthquakes: what actually ruptured, how big, how deep.
 * BIPAD's earthquake entries are damage reports and answer neither.
 *
 * Epicentre distance is context, not exposure: Gorkha's epicentre was 77 km
 * from Kathmandu and Kathmandu still shook at intensity IX. The PGA already
 * integrates all sources — the catalog is the observational record behind it.
 */
import pgaRaw from './data/nepal-pga.json' with { type: 'json' };
import quakesRaw from './data/nepal-quakes.json' with { type: 'json' };
import { haversineKm } from './engine/hydro.ts';

type PgaGrid = {
  _source: string;
  _retrieved: string;
  lat0: number;
  lon0: number;
  dLat: number;
  dLon: number;
  rows: number;
  cols: number;
  data: number[];
};
type QuakeBundle = {
  _source: string;
  _retrieved: string;
  /** [magnitude, year, lat, lon, depthKm] */
  quakes: [number, number, number, number, number][];
};

const PGA = pgaRaw as unknown as PgaGrid;
const CAT = quakesRaw as unknown as QuakeBundle;

export const QUAKE_COUNT = CAT.quakes.length;
export const QUAKE_RETRIEVED = CAT._retrieved;
export const PGA_RETRIEVED = PGA._retrieved;

export type SeismicScreen = {
  /** 475-year PGA on rock, in g. Null outside the grid. */
  pgaG: number | null;
  /** Instrumented M4+ within 50 km since 1900. */
  within50: number;
  /** Instrumented M5+ within 100 km since 1900. */
  m5Within100: number;
  /** Largest event within 100 km. */
  largest: { mag: number; year: number; km: number; depthKm: number } | null;
  pgaSource: string;
  catalogSource: string;
};

/** Bilinear PGA between cell centres — the grid is ~5.5 km, a site is a point. */
export function pgaAt(lat: number, lon: number): number | null {
  // Continuous position in row/col space, measured at cell centres.
  const rf = (PGA.lat0 - lat) / PGA.dLat - 0.5;
  const cf = (lon - PGA.lon0) / PGA.dLon - 0.5;
  // Outside the extracted window is an honest null, never an edge value.
  if (rf < -0.5 || cf < -0.5 || rf > PGA.rows - 0.5 || cf > PGA.cols - 0.5) return null;
  const r0 = Math.max(0, Math.min(PGA.rows - 2, Math.floor(rf)));
  const c0 = Math.max(0, Math.min(PGA.cols - 2, Math.floor(cf)));
  const tr = Math.max(0, Math.min(1, rf - r0));
  const tc = Math.max(0, Math.min(1, cf - c0));
  const v = (r: number, c: number) => PGA.data[r * PGA.cols + c];
  const q = [v(r0, c0), v(r0, c0 + 1), v(r0 + 1, c0), v(r0 + 1, c0 + 1)];
  if (q.some((x) => x < 0)) return null;
  const g =
    (q[0] * (1 - tc) + q[1] * tc) * (1 - tr) + (q[2] * (1 - tc) + q[3] * tc) * tr;
  return Math.round(g) / 1000;
}

export function seismicAt(lat: number, lon: number): SeismicScreen {
  let within50 = 0;
  let m5Within100 = 0;
  let largest: SeismicScreen['largest'] = null;
  for (const [mag, year, qlat, qlon, depthKm] of CAT.quakes) {
    // Cheap reject: 100 km is under 1 degree of latitude.
    if (Math.abs(qlat - lat) > 1) continue;
    const km = haversineKm([lat, lon], [qlat, qlon]);
    if (km > 100) continue;
    if (km <= 50) within50++;
    if (mag >= 5) m5Within100++;
    if (!largest || mag > largest.mag) largest = { mag, year, km, depthKm };
  }
  return {
    pgaG: pgaAt(lat, lon),
    within50,
    m5Within100,
    largest,
    pgaSource: PGA._source,
    catalogSource: CAT._source,
  };
}

/** Every catalog event, for the map. */
export function quakesGeoJson(): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: CAT.quakes.map(([mag, year, lat, lon, depthKm]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { m: mag, y: year, d: depthKm },
    })),
  };
}
