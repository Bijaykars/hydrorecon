/**
 * How wrong is the WATERWAY LENGTH the app reports?
 *
 *   node --experimental-strip-types --no-warnings checks/length-vs-osm.mjs
 *
 * The app prints things like "a 12.8 km waterway taking 1,254 m of drop", and
 * that length is not cosmetic: it sizes the headrace and penstock, it sets the
 * friction loss subtracted from gross head, and the search uses it to compare
 * candidate schemes against each other.
 *
 * It is measured along HydroRIVERS, which is derived at about 500 m. A chord
 * across a meander is shorter than the meander, so the number should be
 * systematically SHORT — every bend the data fails to represent is length the
 * canal still has to be built around.
 *
 * That is a prediction, and OpenStreetMap can test it: the same reaches traced
 * by hand from imagery (see src/osm-rivers.ts). Where the traced line is longer,
 * the modelled line was cutting corners.
 *
 * This does not prove OSM is right in an absolute sense. It establishes the
 * DIRECTION and SIZE of a bias the app currently reports as if it were exact.
 */
import { readFileSync } from 'node:fs';

/**
 * The app fetches its data files; Node has no server here, so requests are
 * answered from public/ directly. Two shapes need handling: an absolute
 * "/nepal-rivers.dat", and the "${import.meta.env.BASE_URL}nepal-osm-rivers.json"
 * that osm-rivers.ts builds — outside Vite that env is undefined and the URL
 * arrives as "undefinednepal-osm-rivers.json".
 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u).replace(/^undefined/, '');
  if (p.startsWith('/') || /^[\w.-]+\.(json|dat|bin)$/.test(p)) {
    const file = `public/${p.replace(/^\//, '')}`;
    try {
      return new Response(readFileSync(file), { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return realFetch(p, i);
};

const { downstreamPath, hasReachData } = await import('../src/rivers.ts');
const { snapPathToOsm, osmRiversAvailable } = await import('../src/osm-rivers.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

if (!(await osmRiversAvailable())) {
  console.log('public/nepal-osm-rivers.json is missing — run pipeline/build-osm-rivers.mjs');
  process.exit(0);
}

/** Long enough to be a real waterway, short enough to be one scheme. */
const WALK_KM = 12;
const MIN_MATCHED = 0.8;

const rows = [];
for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < 5) continue;
  if (!hasReachData(s.lat, s.lon)) continue;
  const path = await downstreamPath(s.lat, s.lon, WALK_KM).catch(() => null);
  if (!path || path.length < 8) continue;
  const snap = await snapPathToOsm(path).catch(() => null);
  if (!snap || snap.matched < MIN_MATCHED) continue;
  if (!(snap.lengthBeforeKm > 1)) continue;
  rows.push({
    river: s.river,
    before: snap.lengthBeforeKm,
    after: snap.lengthAfterKm,
    ratio: snap.lengthAfterKm / snap.lengthBeforeKm,
    movedM: snap.movedM,
    matched: snap.matched,
  });
  if (rows.length >= 60) break;
}

if (!rows.length) {
  console.log('no reach matched OSM well enough to compare');
  process.exit(0);
}

const r = rows.map((x) => x.ratio).sort((a, b) => a - b);
const med = r[Math.floor(r.length / 2)];
const mean = r.reduce((a, b) => a + b, 0) / r.length;
const pct = (p) => r[Math.min(r.length - 1, Math.floor(p * r.length))];
const longer = rows.filter((x) => x.ratio > 1).length;

console.log(`\nWATERWAY LENGTH: modelled (HydroRIVERS) vs traced (OSM)`);
console.log(`${rows.length} reaches, ${WALK_KM} km walks, >=${MIN_MATCHED * 100}% of points matched\n`);
console.log(`  traced / modelled   median ${med.toFixed(3)}x   mean ${mean.toFixed(3)}x`);
console.log(`                      10-90% ${pct(0.1).toFixed(3)}x - ${pct(0.9).toFixed(3)}x`);
console.log(`  traced is LONGER on ${longer}/${rows.length} reaches (${((longer / rows.length) * 100).toFixed(0)}%)`);
console.log(`  mean point movement ${(rows.reduce((a, b) => a + b.movedM, 0) / rows.length).toFixed(0)} m`);

const bias = (med - 1) * 100;
console.log(
  `\n  -> the reported waterway length is short by about ${bias.toFixed(1)}% at the median.`
);
console.log(
  `     On a 12.8 km waterway that is ${((12.8 * bias) / 100).toFixed(2)} km of canal and pipe\n` +
    `     the app is not charging the scheme for.`
);

const worst = [...rows].sort((a, b) => b.ratio - a.ratio).slice(0, 5);
console.log('\n  worst understatements:');
for (const w of worst) {
  console.log(
    `    ${w.river.padEnd(22)} ${w.before.toFixed(1).padStart(5)} km -> ${w.after.toFixed(1).padStart(5)} km  ` +
      `(+${(((w.after - w.before) / w.before) * 100).toFixed(0)}%)`
  );
}
