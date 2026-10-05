/**
 * The ice upstream of a site, from Nepal's own glaciers rather than a proxy.
 *
 * The app has carried 4,152 glacial LAKE centroids since the connectivity screen
 * was written, and no ice. That is enough to ask whether a lake drains through a
 * site and nothing at all about what feeds it. Where a glacierised fraction was
 * wanted — and it is wanted, because it separates a melt-fed dry season from a
 * rain-fed one — the stand-in was hypsometry, the share of catchment above
 * 5,000 m. That is a mountain, not a glacier: most ground above 5,000 m in Nepal
 * is bare rock and seasonal snow.
 *
 * `pipeline/build-nepal-glaciers.py` cuts RGI 7.0 to the three transboundary
 * basins — 6,816 glaciers, 8,016 km² of ice, CC-BY-4.0 — and this asks it two
 * questions: what ice drains to this point, and how much of the catchment is it.
 *
 * THE ROUTING IS THE SAME ROUTING THE LAKES USE. `connectUpstreamSources` snaps
 * each centroid to the mapped network and walks it downstream to the target, so
 * a glacier counts only when the channel actually connects. That matters here
 * more than it does for lakes: the bundle's extent is a BOUNDING BOX, and
 * Rongbuk sits inside it while draining north into Tibet. Nothing but a
 * flow-path test can tell those apart.
 */
import { connectUpstreamSources } from './rivers.ts';

type RawGlacier = [
  id: string,
  name: string,
  areaKm2: number,
  lat: number,
  lon: number,
  zminM: number,
  zmedM: number,
  zmaxM: number,
  surgeType: number,
  rings: number[][][],
];

export type Glacier = {
  id: string;
  /** RGI's own name where it has one; 188 of 6,816 do. */
  name: string | null;
  areaKm2: number;
  lat: number;
  lon: number;
  zminM: number;
  zmedM: number;
  zmaxM: number;
  /** RGI surge classification; 0 for all but 8 glaciers here. */
  surgeType: number;
  /** Simplified outline rings, [lon, lat]. For drawing — use areaKm2 for area. */
  rings: number[][][];
};

export type ConnectedGlacier = Glacier & {
  snapKm: number;
  routeKm: number;
};

export type GlacierScreen = {
  connected: ConnectedGlacier[];
  /** Total connected ice, km². */
  iceKm2: number;
  /** Ice as a share of the catchment, when the catchment area is known. */
  glacierisedFraction: number | null;
  /** Lowest ice front on any connected glacier — where melt enters the river. */
  lowestFrontM: number | null;
  /** Nearest connected glacier by flow path. */
  nearest: ConnectedGlacier | null;
  /** The largest few, for naming in a report. */
  largest: ConnectedGlacier[];
  inventory: {
    total: number;
    totalIceKm2: number;
    source: string;
    citation: string;
    license: string;
    simplifiedToleranceM: number;
    limitation: string;
  };
  /** How the connection was decided, so a reader can weigh it. */
  method: string;
};

type Bundle = {
  _source: string;
  _citation: string;
  _license: string;
  _simplification: { toleranceM: number };
  _counts: { glaciers: number; totalIceKm2: number };
  _limitation: string;
  glaciers: RawGlacier[];
};

/**
 * FETCHED, NOT IMPORTED — and the difference is 2.4 MB of first paint.
 *
 * Every other bundled layer in `src/data/` is a static import, which Vite inlines
 * into the JS bundle: it is downloaded, parsed and instantiated before the app
 * renders, whether or not anyone asks about it. That is fine for the 4 KB site
 * overrides and it was not fine here — these outlines are larger than every
 * other statically imported layer combined, and most sessions never look at ice.
 *
 * So this follows `osm-rivers.ts` instead: one lazy fetch from public/, cached
 * for the session, kicked off only when something actually asks. A failure
 * disables the glacier screen and reports it rather than taking the app down.
 */
let meta: Bundle | null = null;
let loading: Promise<Glacier[] | null> | null = null;

function load(): Promise<Glacier[] | null> {
  if (loading) return loading;
  loading = (async () => {
    try {
      // Same guard rivers.ts uses: unguarded, `import.meta.env` is undefined
      // outside Vite and the property access throws into the catch below.
      const baseUrl = import.meta.env?.BASE_URL ?? '/';
      const res = await fetch(`${baseUrl}nepal-glaciers.json`);
      if (!res.ok) return null;
      const bundle = (await res.json()) as Bundle;
      meta = bundle;
      return bundle.glaciers.map((g) => ({
        id: g[0],
        name: g[1] || null,
        areaKm2: g[2],
        lat: g[3],
        lon: g[4],
        zminM: g[5],
        zmedM: g[6],
        zmaxM: g[7],
        surgeType: g[8],
        rings: g[9],
      }));
    } catch {
      return null;
    }
  })();
  return loading;
}

export const glacierInventory = () => load();

/**
 * Ice within this box, for drawing. Cheap once loaded, and does NOT mean
 * "drains here" — `glaciersUpstreamOf` is the only thing that decides that.
 */
export async function glaciersInBox(box: {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}): Promise<Glacier[]> {
  const all = await load();
  if (!all) return [];
  return all.filter(
    (g) => g.lat >= box.latMin && g.lat <= box.latMax && g.lon >= box.lonMin && g.lon <= box.lonMax
  );
}

/**
 * A glacier centroid can sit a long way from the channel its melt reaches — the
 * tongue is what touches the river and the centroid is up in the accumulation
 * basin — so the snap is looser than the 1.5 km used for lakes. Large glaciers
 * in this inventory run to 90 km², which is roughly 5 km of centroid-to-terminus
 * on its own.
 */
const GLACIER_SNAP_KM = 5;
const GLACIER_ROUTE_KM = 200;

export async function glaciersUpstreamOf(
  target: { lat: number; lon: number },
  catchmentKm2?: number | null
): Promise<GlacierScreen | null> {
  const all = await load();
  if (!all) return null;
  const screen = await connectUpstreamSources(target, all, {
    maxSnapKm: GLACIER_SNAP_KM,
    maxRouteKm: GLACIER_ROUTE_KM,
  });
  if (!screen) return null;

  const connected: ConnectedGlacier[] = screen.connections
    .map((c) => ({ ...c.source, snapKm: c.snapKm, routeKm: c.routeKm }))
    .sort((a, b) => a.routeKm - b.routeKm);

  const iceKm2 = connected.reduce((sum, g) => sum + g.areaKm2, 0);
  return {
    connected,
    iceKm2,
    glacierisedFraction:
      catchmentKm2 && catchmentKm2 > 0 ? Math.min(1, iceKm2 / catchmentKm2) : null,
    lowestFrontM: connected.length ? Math.min(...connected.map((g) => g.zminM)) : null,
    nearest: connected[0] ?? null,
    largest: [...connected].sort((a, b) => b.areaKm2 - a.areaKm2).slice(0, 3),
    inventory: {
      total: meta?._counts.glaciers ?? all.length,
      totalIceKm2: meta?._counts.totalIceKm2 ?? 0,
      source: meta?._source ?? 'Randolph Glacier Inventory 7.0',
      citation: meta?._citation ?? '',
      license: meta?._license ?? 'CC-BY-4.0',
      simplifiedToleranceM: meta?._simplification.toleranceM ?? 60,
      limitation: meta?._limitation ?? '',
    },
    method:
      `Glacier centroids within ${GLACIER_SNAP_KM} km of a mapped channel vertex, walked downstream ` +
      `through the directed river network to the intake, capped at ${GLACIER_ROUTE_KM} km of flow path. ` +
      'A centroid sits in the accumulation basin rather than at the terminus, so the snap is a channel ' +
      'topology test and not a hydrological catchment delineation.',
  };
}
