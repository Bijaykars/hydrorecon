/** Display geometry only. Never replaces the engine's coordinates or chainage. */
import { snapPathToOsm, densifyAlongTrace, osmLines, type OsmSnap } from './osm-rivers.ts';
import { haversineKm } from './engine/hydro.ts';

type Point = { lat: number; lon: number; km: number };
export type RiverDisplay = {
  points: { lat: number; lon: number; offsetM: number; traced: boolean }[];
  segments: { coordinates: [number, number][]; traced: boolean }[];
};

export function riverDisplayFromSnap(path: readonly Point[], snap: OsmSnap, lines: readonly { p: readonly number[] }[]): RiverDisplay {
  if (snap.path.length !== path.length || snap.matches.length !== path.length) throw new Error('Display geometry must retain one point per model sample');
  const points = path.map((p, i) => ({
    lat: snap.matches[i] ? snap.path[i].lat : p.lat,
    lon: snap.matches[i] ? snap.path[i].lon : p.lon,
    offsetM: snap.matches[i] ? haversineKm([p.lat, p.lon], [snap.path[i].lat, snap.path[i].lon]) * 1000 : 0,
    traced: !!snap.matches[i],
  }));
  const segments = points.slice(1).map((b, i) => {
    const a = points[i];
    const ma = snap.matches[i];
    const mb = snap.matches[i + 1];
    // Preserve the matcher's conservative same-way, forward-only connection.
    const eligible = !!ma && !!mb && ma.line === mb.line && mb.seg >= ma.seg;
    const pair = { ...snap, path: [snap.path[i], snap.path[i + 1]], matches: [ma, mb] };
    const dense = densifyAlongTrace(pair, lines);
    const traced = eligible && (ma.seg === mb.seg || dense.tracedSegments === 1);
    return { coordinates: traced ? dense.coordinates : [[a.lon, a.lat], [b.lon, b.lat]] as [number, number][], traced };
  });
  return { points, segments };
}

export async function buildRiverDisplay(path: readonly Point[]): Promise<RiverDisplay | null> {
  const [snap, lines] = await Promise.all([snapPathToOsm(path), osmLines()]);
  return snap && lines ? riverDisplayFromSnap(path, snap, lines) : null;
}

export function displayGeoJson(display: RiverDisplay, from = 0, to = display.points.length - 1): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: display.segments.slice(from, to).map((segment) => ({
    type: 'Feature', properties: { traced: segment.traced, source: segment.traced ? 'OpenStreetMap channel trace; display only' : 'Approximate connector; channel unconfirmed' },
    geometry: { type: 'LineString', coordinates: segment.coordinates },
  })) };
}
