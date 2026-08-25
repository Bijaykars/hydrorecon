/**
 * Private Nepali GIS layers — the ones that cannot ship.
 *
 * Everything else in this app loads from a source whose licence permits
 * redistribution. These four came through a private channel with provenance
 * that has not been established, and the municipality boundaries carry an
 * explicit HERMES term: non-commercial use only, no redistribution without
 * consent. pipeline/build-local-gis.mjs writes them to sources/local/, which
 * .gitignore excludes.
 *
 * So this module is written for their ABSENCE first. A fresh clone has no
 * sources/local/, every fetch here 404s, every function returns null, and the
 * app behaves exactly as it did before these existed. That is not a fallback
 * bolted on afterwards — it is the normal case, and the loaded case is the
 * exception.
 *
 * WHAT THEY ADD, all four being things no open global dataset carries:
 *
 *   the survey sheet   Nepal's 1:25,000 sheets carry surveyed contours and spot
 *                      heights. The app's terrain is a 30 m global DEM with
 *                      about +/-15 m of vertical error; a real sheet is how an
 *                      engineer replaces that with a measurement. Knowing the
 *                      sheet number is how you order one.
 *   annual rainfall    Nepal's own isohyet map, the surface HYDEST's regression
 *                      was fitted against — measured at Nepali stations rather
 *                      than modelled globally.
 *   buffer zones       A distinct permitting regime that rings several parks and
 *                      is simply missing from OpenStreetMap.
 *   the municipality   The body an application actually goes to.
 */

type Sheet = { n: string; r: string; b: [number, number, number, number] };
type Band = { mm: number; rings: number[][] };
type Zone = { rings: number[][] };
type Unit = { n: string; d: string; p: string; t: string; rings: number[][] };

type Local = {
  sheets: Sheet[];
  bands: Band[];
  zones: Zone[];
  units: Unit[];
};

let cache: Promise<Local | null> | null = null;

/** Load once. A 404 is the expected answer, not an error worth surfacing. */
export function loadLocalGis(): Promise<Local | null> {
  if (cache) return cache;
  cache = (async () => {
    const base = `${import.meta.env.BASE_URL}local/`;
    const get = async <T>(name: string, key: string): Promise<T[]> => {
      try {
        const r = await fetch(`${base}${name}`);
        if (!r.ok) return [];
        const j = (await r.json()) as Record<string, T[]>;
        return j[key] ?? [];
      } catch {
        return [];
      }
    };
    const [sheets, bands, zones, units] = await Promise.all([
      get<Sheet>('sheets.json', 'sheets'),
      get<Band>('isohyet.json', 'bands'),
      get<Zone>('buffers.json', 'zones'),
      get<Unit>('units.json', 'units'),
    ]);
    // Nothing present means no private layer here — say so once, with null.
    if (!sheets.length && !bands.length && !zones.length && !units.length) return null;
    return { sheets, bands, zones, units };
  })();
  return cache;
}

/** Even-odd ray cast over flat [lat, lon, …] rings. */
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

export type LocalContext = {
  /** Official 1:25,000 sheet number covering the site, e.g. "2884 10". */
  sheet: string | null;
  /** Survey region the sheet belongs to. */
  sheetRegion: string | null;
  /** Mean annual precipitation over the site, mm. */
  annualRainMm: number | null;
  /** Municipality, district and province — who to apply to. */
  unit: { name: string; district: string; province: string; kind: string } | null;
  /** True when the site sits inside a protected-area buffer zone. */
  inBufferZone: boolean;
};

/**
 * Everything the private layers know about one point.
 *
 * Returns null when no private layer is installed, which lets the panel omit
 * the whole section rather than render a row of dashes.
 */
export async function localContextAt(lat: number, lon: number): Promise<LocalContext | null> {
  const g = await loadLocalGis();
  if (!g) return null;

  const sheet = g.sheets.find(
    (s) => lat >= s.b[0] && lat <= s.b[2] && lon >= s.b[1] && lon <= s.b[3]
  );

  /**
   * Isohyet bands nest: a 4000 mm core sits inside the 3000 mm band that
   * contains it. The smallest containing band is the specific one, so it wins.
   */
  /**
   * "Smallest" is AREA, not latitude span.
   *
   * Ranking on `maxLat - minLat` ignores longitude entirely, so a band that is
   * short and very wide beat one that is taller and much smaller overall. At
   * (27.04, 86.04) it chose the 2,000 mm band, planar area 0.736 deg², over the
   * 1,800 mm band at 0.686 — the wrong rainfall for the site, decided by an
   * unrelated dimension of a bounding box.
   *
   * The shoelace formula over the rings gives the real polygon area, and
   * summing absolute ring areas keeps a band with holes from scoring as tiny.
   */
  const ringArea = (r: number[]) => {
    let sum = 0;
    for (let i = 0; i + 3 < r.length; i += 2) {
      // Rings are [lat, lon, lat, lon, …]; the sign cancels in the absolute.
      sum += r[i + 1] * r[i + 2] - r[i + 3] * r[i];
    }
    return Math.abs(sum) / 2;
  };

  let annualRainMm: number | null = null;
  let tightest = Infinity;
  for (const b of g.bands) {
    if (!inside(lat, lon, b.rings)) continue;
    const area = b.rings.reduce((sum, r) => sum + ringArea(r), 0);
    if (area < tightest) {
      tightest = area;
      annualRainMm = b.mm;
    }
  }

  const u = g.units.find((x) => inside(lat, lon, x.rings));

  return {
    sheet: sheet?.n ?? null,
    sheetRegion: sheet?.r || null,
    annualRainMm,
    unit: u ? { name: u.n, district: u.d, province: u.p, kind: u.t } : null,
    inBufferZone: g.zones.some((z) => inside(lat, lon, z.rings)),
  };
}

/** Whether a private layer is installed at all — for the panel's heading. */
export const hasLocalGis = () => loadLocalGis().then((g) => g !== null);
