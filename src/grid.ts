/**
 * Getting the power out.
 *
 * A scheme's distance to a line that can carry its output decides Nepali small
 * hydro more often than the energy estimate does. Twenty megawatts three
 * kilometres from a 132 kV line is a different project from the same twenty
 * megawatts sixty kilometres up a valley, and the gap between them is usually
 * larger than every refinement to the flow figure put together. The app had
 * nothing to say about it until now.
 *
 * Distances here are straight-line, and a transmission line is not built in a
 * straight line through Nepali terrain — a ridge or a river crossing can double
 * it. So this is a floor on the connection distance, said as such, and useful
 * mainly for telling a three-kilometre site from a sixty-kilometre one.
 *
 * Data: OpenStreetMap via Overpass, © OpenStreetMap contributors, ODbL 1.0.
 * Coverage is good on Nepal's transmission backbone and patchy below 66 kV, so
 * an absent line means "not mapped", never "not there".
 */
import gridRaw from './data/nepal-grid.json' with { type: 'json' };
import { haversineKm } from './engine/hydro.ts';

type RawGrid = {
  lines: { kv: number; p: number[] }[];
  subs: { n: string | null; kv: number; y: number; x: number }[];
};

const GRID = gridRaw as unknown as RawGrid;

export type GridLink = {
  /** Nearest mapped line of any voltage. */
  nearestKm: number;
  nearestKv: number;
  /** Nearest line at or above the voltage this capacity would need. */
  adequateKm: number | null;
  adequateKv: number | null;
  /** The voltage that capacity would typically connect at. */
  requiredKv: number;
  nearestSub: { name: string | null; kv: number; km: number } | null;
};

/**
 * Voltage a plant of this size would typically connect at, kV.
 *
 * A screening rule of thumb from how Nepali projects are actually
 * interconnected, not a published regulation — the real answer comes from NEA's
 * connection study and depends on what capacity the local network already has.
 * It is here so the app can distinguish "there is a line nearby" from "there is
 * a line nearby that could take this", which are not the same thing.
 */
export function requiredKv(capacityMW: number): number {
  if (capacityMW <= 5) return 33;
  if (capacityMW <= 25) return 66;
  if (capacityMW <= 100) return 132;
  return 220;
}

/** Shortest distance from a point to a segment, in km. */
function segKm(lat: number, lon: number, ay: number, ax: number, by: number, bx: number): number {
  // Work in a local flat frame — segments are short, and this avoids a
  // trigonometric projection per candidate point.
  const cos = Math.cos((lat * Math.PI) / 180);
  const px = (lon - ax) * cos;
  const py = lat - ay;
  const dx = (bx - ax) * cos;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return haversineKm([lat, lon], [ay + t * dy, ax + (t * dx) / (cos || 1)]);
}

/**
 * Where this scheme would connect, and how far away that is.
 *
 * `capacityMW` sets what counts as adequate. Pass the powerhouse position, not
 * the intake — the switchyard sits at the machines.
 */
export function gridLink(lat: number, lon: number, capacityMW: number): GridLink {
  const need = requiredKv(capacityMW);

  let nearestKm = Infinity;
  let nearestKv = 0;
  let adequateKm = Infinity;
  let adequateKv = 0;

  for (const line of GRID.lines) {
    const p = line.p;
    // Cheap reject: skip a line whose vertices are all far away in latitude.
    let near = false;
    for (let i = 0; i < p.length; i += 2) {
      if (Math.abs(p[i] - lat) < 1.2) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const d = segKm(lat, lon, p[i], p[i + 1], p[i + 2], p[i + 3]);
      if (d < nearestKm) {
        nearestKm = d;
        nearestKv = line.kv;
      }
      // A line of unknown voltage cannot be counted on to take the power.
      if (line.kv >= need && d < adequateKm) {
        adequateKm = d;
        adequateKv = line.kv;
      }
    }
  }

  let nearestSub: GridLink['nearestSub'] = null;
  for (const s of GRID.subs) {
    const d = haversineKm([lat, lon], [s.y, s.x]);
    if (!nearestSub || d < nearestSub.km) nearestSub = { name: s.n, kv: s.kv, km: d };
  }

  return {
    nearestKm: Number.isFinite(nearestKm) ? nearestKm : Infinity,
    nearestKv,
    adequateKm: Number.isFinite(adequateKm) ? adequateKm : null,
    adequateKv: adequateKv || null,
    requiredKv: need,
    nearestSub,
  };
}

/** Whether the connection is likely to dominate the project's economics. */
export function connectionVerdict(link: GridLink): { text: string; hard: boolean } {
  const km = link.adequateKm;
  if (km === null) {
    return {
      text: `no mapped line at ${link.requiredKv} kV or above anywhere near — the connection would be the project`,
      hard: true,
    };
  }
  if (km > 25) {
    return {
      text: `${km.toFixed(0)} km of new ${link.adequateKv} kV line, which at this length usually costs more than the powerhouse`,
      hard: true,
    };
  }
  if (km > 8) {
    return {
      text: `${km.toFixed(1)} km to ${link.adequateKv} kV — a real transmission cost, worth pricing before anything else`,
      hard: false,
    };
  }
  return {
    text: `${km.toFixed(1)} km to ${link.adequateKv} kV — close enough that the connection is unlikely to decide this`,
    hard: false,
  };
}

export const GRID_LINE_COUNT = GRID.lines.length;
export const GRID_SUB_COUNT = GRID.subs.length;
