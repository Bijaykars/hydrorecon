/**
 * Where do the gauges and plants sit once pulled onto the traced river?
 *
 *   node --experimental-strip-types --no-warnings checks/osm-snap-export.mjs
 *
 * MERIT Hydro's upstream-area raster is only large ON the channel; one pixel off
 * a big river it collapses to a headwater value. Sampling it along HydroRIVERS'
 * 500 m geometry was therefore noisy, and the workaround — take the maximum over
 * a wide window — invents catchment by grabbing whichever trunk river happens to
 * pass nearby (pipeline/build_merit_upa.py).
 *
 * The hypothesis is that the geometry was the problem, not MERIT. OSM's traced
 * centrelines put a point in the actual channel, so a SMALL window should then
 * be enough, and a small window cannot steal a neighbouring river.
 *
 * This writes both positions — raw and traced — for the DHM gauges and the built
 * plants, so pipeline/merit_probe.py can sample MERIT at each and score them
 * against flows we know. Node does the snapping because that is where the
 * shipped matcher lives; Python does the raster because that is where PIL is.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u).replace(/^undefined/, '');
  if (p.startsWith('/') || /^[\w.-]+\.(json|dat|bin)$/.test(p)) {
    try {
      return new Response(readFileSync(`public/${p.replace(/^\//, '')}`), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return realFetch(p, i);
};

const { downstreamPath, hasReachData } = await import('../src/rivers.ts');
const { snapPathToOsm, osmRiversAvailable } = await import('../src/osm-rivers.ts');

if (!(await osmRiversAvailable())) {
  console.error('traced geometry missing');
  process.exit(1);
}

const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));
const validation = JSON.parse(readFileSync('src/data/validation.json', 'utf8'));

/**
 * Snap one point by snapping a short walk through it and keeping the first
 * position. A single point has no direction, and the matcher's whole value is
 * that it decides which watercourse a RUN of points belongs to.
 */
async function snapPoint(lat, lon) {
  if (!hasReachData(lat, lon)) return null;
  const path = await downstreamPath(lat, lon, 3).catch(() => null);
  if (!path || path.length < 6) return null;
  const snap = await snapPathToOsm(path).catch(() => null);
  if (!snap || snap.matched < 0.6) return null;
  return { lat: snap.path[0].lat, lon: snap.path[0].lon, movedM: snap.movedM };
}

const out = { gauges: [], plants: [] };

for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < 10 || !(s.meanCms > 0)) continue;
  const snapped = await snapPoint(s.lat, s.lon);
  out.gauges.push({
    river: s.river,
    meanCms: s.meanCms,
    raw: [s.lat, s.lon],
    osm: snapped ? [snapped.lat, snapped.lon] : null,
  });
}

for (const p of validation.plants) {
  const [lat, lon] = p.intake;
  const snapped = await snapPoint(lat, lon);
  out.plants.push({
    name: p.name,
    designQ: p.actual?.designQ ?? null,
    raw: [lat, lon],
    osm: snapped ? [snapped.lat, snapped.lon] : null,
  });
}

const snappedG = out.gauges.filter((g) => g.osm).length;
const snappedP = out.plants.filter((g) => g.osm).length;
writeFileSync('checks/.osm-snapped.json', JSON.stringify(out));
console.log(
  `wrote checks/.osm-snapped.json — gauges ${snappedG}/${out.gauges.length}, ` +
    `plants ${snappedP}/${out.plants.length} pulled onto traced geometry`
);
