/**
 * The app's CURRENT catchment area at each of DHM's 190 published station
 * coordinates, for checks/fine-network-vs-dhm.py to score against.
 *
 *   node --experimental-strip-types --no-warnings checks/dhm-engine-areas.mjs
 *
 * WHAT IT WRITES  pipeline/.cache/fine/engine-areas.json: for every station in
 * sources/dhm-catchments.json, the area the app's real nearestReach offers.
 *   meritKm2   nearest.uplandKm2 (MERIT per-vertex; falls back to the reach's own
 *              area where MERIT is absent, which areaSource says)
 *   reachKm2   nearest.reachUplandKm2 (HydroRIVERS' own attribute)
 *   snapM      how far the coordinate is from that reach, metres
 *
 * Document overrides (src/overrides.ts) are switched OFF: they pin named places
 * to a published area, so leaving them on would score the app against the answer.
 *
 * WHAT IT CANNOT SAY. It reads `nearest`, not the main-stem alternative the app
 * sometimes offers, and a station further than SNAP_KM from any reach is still
 * given the nearest one (snapM says so) rather than dropped.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

/** The network is fetched in the browser; point the loader at the same files from disk. */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (path.startsWith('/')) return new Response(readFileSync(`public${path}`), { status: 200 });
  return realFetch(path, init);
};

const { nearestReach, SNAP_KM } = await import('../src/rivers.ts');
const { setOverridesEnabled } = await import('../src/overrides.ts');
setOverridesEnabled(false);

const stations = JSON.parse(readFileSync('sources/dhm-catchments.json', 'utf8')).stations;
const rows = [];
for (const s of stations) {
  const hit = await nearestReach(s.lat, s.lon);
  rows.push({
    id: s.id,
    meritKm2: hit ? hit.nearest.uplandKm2 : null,
    reachKm2: hit ? hit.nearest.reachUplandKm2 : null,
    areaSource: hit ? hit.nearest.areaSource : null,
    snapM: hit ? hit.nearest.distanceKm * 1000 : null,
  });
}
mkdirSync('pipeline/.cache/fine', { recursive: true });
writeFileSync('pipeline/.cache/fine/engine-areas.json', JSON.stringify({ made: new Date().toISOString(), snapKm: SNAP_KM, rows }, null, 1));
const none = rows.filter((r) => r.meritKm2 == null).length;
const far = rows.filter((r) => r.snapM != null && r.snapM > SNAP_KM * 1000).length;
console.log(`wrote pipeline/.cache/fine/engine-areas.json: ${rows.length} stations, ${none} with no reach, ${far} beyond SNAP_KM (${SNAP_KM} km)`);
