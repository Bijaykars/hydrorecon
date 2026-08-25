/**
 * Catchment areas taken from a document instead of inferred from a raster.
 *
 * WHY THIS IS NARROW ON PURPOSE. Correcting data you know to be wrong is good
 * practice; correcting it until predictions match known answers is fitting to
 * the test set, and the two are hard to tell apart from outside. So this file
 * accepts exactly one kind of edit — an INPUT that a named, checkable document
 * states — and refuses the other: no capacities, no heads, no flows, nothing
 * derived, nothing chosen because it improved a validation number.
 *
 * The distinction matters because of what the tool is for. Its whole claim is
 * to say something useful about a site nobody has built. Tuning against the
 * thirty-odd plants that HAVE been built would raise the validation score and
 * lower the actual accuracy, and there would be no measurement left able to
 * tell. Every result is therefore reported twice, with and without this table,
 * so the size of the manual thumb on the scale is always visible.
 */
import data from './data/site-overrides.json' with { type: 'json' };

export type AreaOverride = {
  name: string;
  uplandKm2: number;
  source: string;
};

type Row = AreaOverride & { lat: number; lon: number; radiusKm: number };
const ROWS = data.overrides as Row[];

/**
 * Off switches the table entirely, which is how the harness measures its own
 * influence. Default on: a user of the app should get the best data available.
 */
let enabled = true;
export const setOverridesEnabled = (on: boolean) => {
  enabled = on;
};
export const overridesEnabled = () => enabled;

const KM_PER_DEG = 111.32;

/** The pinned area covering this point, or null. Nearest wins if several do. */
export function areaOverrideAt(lat: number, lon: number): AreaOverride | null {
  if (!enabled) return null;
  let best: AreaOverride | null = null;
  let bestKm = Infinity;
  for (const r of ROWS) {
    const dy = (lat - r.lat) * KM_PER_DEG;
    const dx = (lon - r.lon) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
    const km = Math.hypot(dx, dy);
    if (km <= r.radiusKm && km < bestKm) {
      bestKm = km;
      best = { name: r.name, uplandKm2: r.uplandKm2, source: r.source };
    }
  }
  return best;
}

/** Every row, for the panel that has to show what was overridden and why. */
export const allAreaOverrides = (): readonly Row[] => ROWS;
