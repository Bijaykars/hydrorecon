/**
 * When a point lands near two channels, which one should the app read?
 *
 *   node --experimental-strip-types --no-warnings checks/snap-rule.mjs
 *
 * The app takes the NEAREST mapped reach, on the reasoning that a click means
 * the channel clicked on. Two of the ten built plants are destroyed by that:
 * Upper Tamakoshi's published headworks snap to an 8 km2 tributary rather than
 * the 1,754 km2 Tamakoshi sitting 0.95 km away, and the app then reports 0.8 MW
 * against a built 456.
 *
 * Auto-snapping to the bigger neighbour was tried in an earlier session and
 * rejected for moving the marker further than this app is willing to move it.
 * That rejection was about the MARKER. This asks a narrower question: when the
 * neighbour is not merely bigger but overwhelmingly bigger, is the nearest
 * reach still the right one to READ?
 *
 * DHM's gauges can answer it, because each one has a measured mean flow and a
 * known position. For every station where the app is offered a choice, both
 * candidates are scored against what the river actually carries.
 */
import { readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u);
  if (p.startsWith('/')) return new Response(readFileSync(`public${p}`), { status: 200 });
  return realFetch(p, i);
};

const { nearestReach, hasReachData } = await import('../src/rivers.ts');
const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8'));

const SNAP_KM = 1.0;
const MIN_YEARS = 10;
/** Nepal's rivers run 0.005-0.25 m3/s per km2. */
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;

const cases = [];
let offered = 0;
for (const s of records.stations) {
  if (s.lat == null || (s.completeYears ?? 0) < MIN_YEARS || !(s.meanCms > 0)) continue;
  if (!hasReachData(s.lat, s.lon)) continue;
  const hit = await nearestReach(s.lat, s.lon).catch(() => null);
  if (!hit || hit.nearest.distanceKm > SNAP_KM) continue;
  const near = hit.nearest;
  const main = hit.mainStem ?? null;
  if (!main) continue; // no choice was offered; nothing to decide
  offered++;
  cases.push({
    river: s.river,
    measured: s.meanCms,
    nearKm2: near.uplandKm2,
    mainKm2: main.uplandKm2,
    ratio: main.uplandKm2 / Math.max(1e-9, near.uplandKm2),
    nearKm: near.distanceKm,
    mainKm: main.distanceKm,
    // Specific discharge implied by the MEASURED flow on each candidate.
    sNear: s.meanCms / Math.max(1e-9, near.uplandKm2),
    sMain: s.meanCms / Math.max(1e-9, main.uplandKm2),
  });
}

const plausible = (v) => v >= SPECIFIC_MIN && v <= SPECIFIC_MAX;
console.log(`\n${offered} gauges where the app is offered a bigger neighbour\n`);

console.log('which candidate can actually carry the measured flow?');
const onlyMain = cases.filter((c) => !plausible(c.sNear) && plausible(c.sMain));
const onlyNear = cases.filter((c) => plausible(c.sNear) && !plausible(c.sMain));
const both = cases.filter((c) => plausible(c.sNear) && plausible(c.sMain));
const neither = cases.filter((c) => !plausible(c.sNear) && !plausible(c.sMain));
console.log(`  only the MAIN STEM works : ${onlyMain.length}`);
console.log(`  only the NEAREST works   : ${onlyNear.length}`);
console.log(`  both plausible           : ${both.length}`);
console.log(`  neither                  : ${neither.length}`);

console.log('\nif the rule were "take the main stem when it is at least Nx bigger":');
console.log('  N     fires   right   wrong   net');
for (const N of [3, 5, 10, 20, 30, 50, 100]) {
  const fires = cases.filter((c) => c.ratio >= N);
  const right = fires.filter((c) => !plausible(c.sNear) && plausible(c.sMain)).length;
  const wrong = fires.filter((c) => plausible(c.sNear) && !plausible(c.sMain)).length;
  console.log(
    `${String(N).padStart(4)}  ${String(fires.length).padStart(6)}  ${String(right).padStart(6)}  ` +
      `${String(wrong).padStart(6)}  ${(right - wrong >= 0 ? '+' : '') + (right - wrong)}`
  );
}

console.log(
  '\nand the rule this actually argues for — "take the main stem only when the\n' +
    'nearest reach cannot carry a plausible flow at all":'
);
console.log(`  fires on ${onlyMain.length}, right ${onlyMain.length}, wrong 0`);
if (onlyMain.length) {
  console.log('\n  cases it would fix:');
  for (const c of onlyMain.slice(0, 12)) {
    console.log(
      `    ${c.river.padEnd(20)} ${c.measured.toFixed(1).padStart(7)} m3/s   ` +
        `near ${c.nearKm2.toFixed(0).padStart(5)} km2 (${c.sNear.toFixed(2)})  ` +
        `main ${c.mainKm2.toFixed(0).padStart(6)} km2 (${c.sMain.toFixed(3)})  ${c.ratio.toFixed(0)}x`
    );
  }
}
if (onlyNear.length) {
  console.log('\n  cases where the NEAREST is right and a ratio rule would break it:');
  for (const c of onlyNear.slice(0, 8)) {
    console.log(
      `    ${c.river.padEnd(20)} ${c.measured.toFixed(1).padStart(7)} m3/s   ` +
        `near ${c.nearKm2.toFixed(0).padStart(5)} km2 (${c.sNear.toFixed(3)})  ` +
        `main ${c.mainKm2.toFixed(0).padStart(6)} km2 (${c.sMain.toFixed(4)})  ${c.ratio.toFixed(0)}x`
    );
  }
}
