/**
 * "I can see the river on the satellite map, I click on it, and the app will not
 * put the point there." How big is each of the two possible causes?
 *
 *   node --experimental-strip-types --no-warnings checks/click-vs-visible-river.mjs
 *   node --experimental-strip-types --no-warnings checks/click-vs-visible-river.mjs --self-check
 *
 * WHY. The two causes need different fixes, so each needs a size before the app
 * is touched.
 *   CAUSE 1  the visible stream is not in the clickable network at all (the click
 *            is further than SNAP_KM from every modelled reach, so it attaches to
 *            nothing).
 *   CAUSE 2  the click IS accepted, but the marker is moved onto the modelled
 *            HydroRIVERS line, which can sit well away from the real channel.
 *
 * METHOD. public/nepal-osm-rivers.json holds lines traced from satellite imagery
 * (r=1 river class, r=0 stream class); they stand in for "a river the user can
 * see". One simulated click is emitted per 1,000 m of line, deterministically,
 * starting 500 m in (a line shorter than 500 m contributes its midpoint), kept
 * only inside the app's coverage box. Each click goes through the app's REAL
 * nearestReach and reachToRead from src/rivers.ts; nothing of the snap is
 * reimplemented. Displacement is nearest.distanceKm * 1000, which is the app's own
 * measure of how far the marker moves when it snaps to nearest.point.
 *
 * WHAT IT CANNOT SAY.
 *  - OSM lines are not every visible channel. A stream the satellite shows and OSM
 *    never traced is not a click here, so Cause 1 is, if anything, a floor.
 *  - A simulated click lands exactly on the OSM centre line. That is the best case
 *    for the user: a real hand lands beside the water, which adds to every number.
 *  - OSM itself carries canals, ditches and side channels, so "the OSM line is a
 *    river the user meant" is generous for the stream class in particular.
 *  - Local distances use a flat equirectangular scale (good to a few metres over a
 *    kilometre), and the 1 km spacing is along the line, so clicks cluster on the
 *    long reaches and winding lines get more clicks per unit area.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

/** The network is fetched in the browser; point the loader at the same files from disk. */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (path.startsWith('/')) {
    const buf = readFileSync(`public${path}`);
    return new Response(buf, { status: 200 });
  }
  return realFetch(path, init);
};

import { nearestReach, reachToRead, hasReachData, SNAP_KM, vertexPositions } from '../src/rivers.ts';

const SELF_CHECK = process.argv.includes('--self-check');

const SPACING_M = 1000;
const FIRST_M = 500;
const STRICT_M = 250;
const MOVE_THRESHOLDS_M = [50, 100, 250, 500];
const BOX = { south: 27.4, north: 28.4, west: 84.3, east: 85.1 };
const OUT = 'pipeline/.cache/click-vs-visible-river.json';

/* --------------------------------------------------------------- geometry */

/** Metres per degree at a latitude (flat-earth; the same order of accuracy as the app's own snap). */
function metresPerDeg(latDeg) {
  const phi = (latDeg * Math.PI) / 180;
  return {
    mLat: 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    mLon: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  };
}

/** One point per SPACING_M along a flat [lat, lon, ...] line, FIRST_M in; short lines give their midpoint. */
function clicksAlong(p) {
  const n = p.length / 2;
  if (n < 2) return [];
  const segLen = new Array(n - 1);
  let total = 0;
  for (let k = 0; k + 1 < n; k++) {
    const { mLat, mLon } = metresPerDeg((p[2 * k] + p[2 * k + 2]) / 2);
    const dy = (p[2 * k + 2] - p[2 * k]) * mLat;
    const dx = (p[2 * k + 3] - p[2 * k + 1]) * mLon;
    segLen[k] = Math.hypot(dx, dy);
    total += segLen[k];
  }
  if (!(total > 0)) return [];
  const targets = [];
  if (total < FIRST_M) targets.push(total / 2);
  else for (let d = FIRST_M; d <= total; d += SPACING_M) targets.push(d);
  const out = [];
  let k = 0;
  let before = 0;
  for (const d of targets) {
    while (k < segLen.length - 1 && before + segLen[k] < d) before += segLen[k++];
    const t = segLen[k] > 0 ? Math.min(1, Math.max(0, (d - before) / segLen[k])) : 0;
    out.push([p[2 * k] + t * (p[2 * k + 2] - p[2 * k]), p[2 * k + 1] + t * (p[2 * k + 3] - p[2 * k + 1])]);
  }
  return out;
}

/* ------------------------------------------------------------- statistics */

/** Linear-interpolated percentile of a sorted array. */
function pct(sorted, q) {
  if (!sorted.length) return NaN;
  const x = (sorted.length - 1) * q;
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}
const share = (k, n) => (n > 0 ? (100 * k) / n : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : 'n/a');
const fa = (x) => (Number.isFinite(x) ? (x >= 100 ? x.toFixed(0) : x.toFixed(1)) : 'n/a');

/** Run one list of [lat, lon] clicks through the app's snap and summarise. */
async function measure(points) {
  const disp = []; // metres, snapped clicks only
  const areas = []; // km2, snapped clicks only
  let n = 0;
  let notSnapped = 0;
  let noneIn250 = 0;
  let noReachAtAll = 0;
  let mainStem = 0;
  let promoted = 0;
  let promotionError = null;
  for (const [lat, lon] of points) {
    n++;
    const hit = await nearestReach(lat, lon);
    if (!hit) {
      noReachAtAll++;
      notSnapped++;
      noneIn250++;
      continue;
    }
    const dM = hit.nearest.distanceKm * 1000;
    if (dM > STRICT_M) noneIn250++;
    if (hit.mainStem) mainStem++;
    try {
      if (reachToRead(hit).overridden) promoted++;
    } catch (e) {
      promotionError = String(e && e.message ? e.message : e);
    }
    if (hit.nearest.distanceKm > SNAP_KM) {
      notSnapped++;
      continue;
    }
    disp.push(dM);
    areas.push(hit.nearest.uplandKm2);
  }
  disp.sort((a, b) => a - b);
  areas.sort((a, b) => a - b);
  const snapped = disp.length;
  return {
    n,
    notSnapped,
    notSnappedPct: share(notSnapped, n),
    noReachAtAll,
    noneIn250,
    noneIn250Pct: share(noneIn250, n),
    snapped,
    disp: {
      median: pct(disp, 0.5),
      p75: pct(disp, 0.75),
      p90: pct(disp, 0.9),
      over: Object.fromEntries(MOVE_THRESHOLDS_M.map((t) => [t, share(disp.filter((d) => d > t).length, snapped)])),
    },
    mainStemPct: share(mainStem, n),
    promotedPct: promotionError ? null : share(promoted, n),
    promotionError,
    area: {
      p10: pct(areas, 0.1),
      median: pct(areas, 0.5),
      p90: pct(areas, 0.9),
      under10Pct: share(areas.filter((a) => a < 10).length, snapped),
      under100Pct: share(areas.filter((a) => a < 100).length, snapped),
    },
  };
}

/* -------------------------------------------------------------- self-check */

async function selfCheck() {
  // Points exactly on the app's own modelled reach lines: sample places across
  // the box, take the reach nearestReach offers, and place a point on one of its
  // stored segments (vertexPositions exposes the raw modelled vertices).
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const onLine = [];
  let guard = 0;
  while (onLine.length < 200 && guard++ < 5000) {
    const lat = BOX.south + rnd() * (BOX.north - BOX.south);
    const lon = BOX.west + rnd() * (BOX.east - BOX.west);
    const hit = await nearestReach(lat, lon);
    if (!hit) continue;
    const i = hit.nearest.networkIndex;
    let len = 0;
    while (await vertexPositions(i, len)) len++;
    if (len < 2) continue;
    const k = Math.floor(rnd() * (len - 1));
    const a = (await vertexPositions(i, k)).raw;
    const b = (await vertexPositions(i, k + 1)).raw;
    const t = rnd();
    onLine.push([a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon), { index: i, reachUplandKm2: hit.nearest.reachUplandKm2 }]);
  }
  let ok = true;
  const fail = (m) => {
    ok = false;
    console.log(`FAIL  ${m}`);
  };
  if (onLine.length < 200) fail(`only ${onLine.length} on-line points could be built`);

  const base = await measure(onLine);
  // The app's own confluence rule (rivers.ts TIE_KM = 30 m) hands a click within
  // ~30 m of a larger river to that river, so a point on a small reach right beside
  // a big one can legitimately move up to ~30 m. Such a point must have been
  // handed to a DIFFERENT, LARGER reach; anything else over 5 m is a real failure.
  let tied = 0;
  let maxDisp = 0;
  for (const [la, lo, src] of onLine) {
    const hit = await nearestReach(la, lo);
    const d = hit.nearest.distanceKm * 1000;
    maxDisp = Math.max(maxDisp, d);
    if (d < 5) continue;
    const handedToLarger = hit.nearest.networkIndex !== src.index && hit.nearest.reachUplandKm2 > src.reachUplandKm2 && d < 45;
    if (handedToLarger) tied++;
    else fail(`on-line point displaced ${f1(d)} m and not by the confluence tie rule`);
  }
  console.log(`on the app's own reach lines: n=${base.n}, snapped ${base.snapped}, median ${f1(base.disp.median)} m, under 5 m: ${base.n - tied}/${base.n}, handed to a larger neighbour by the 30 m confluence tie rule: ${tied} (max ${f1(maxDisp)} m)`);
  if (base.snapped !== base.n) fail(`${base.n - base.snapped} on-line points did not snap`);

  const east = onLine.map(([la, lo]) => [la, lo + 300 / metresPerDeg(la).mLon]);
  const shifted = await measure(east);
  console.log(`displaced 300 m due east: median displacement ${f1(shifted.disp.median)} m (expect 150-300 m), snapped ${shifted.snapped}/${shifted.n}`);
  if (!(shifted.disp.median >= 150 && shifted.disp.median <= 300)) fail('median displacement after a 300 m shift is outside 150-300 m');

  // The OSM click generator itself: spacing is a hard property worth one assertion.
  const straight = [28, 85, 28.02, 85]; // about 2,211 m due north
  const c = clicksAlong(straight);
  if (c.length !== 2) fail(`a 2.2 km line should give 2 clicks (at 500 m and 1,500 m), got ${c.length}`);
  const tiny = clicksAlong([28, 85, 28.001, 85]); // about 111 m
  if (tiny.length !== 1) fail('a line under 500 m should give exactly its midpoint');
  console.log(ok ? 'self-check: PASS' : 'self-check: FAIL');
  process.exit(ok ? 0 : 1);
}

/* --------------------------------------------------------------------- run */

async function main() {
  const OSM = 'public/nepal-osm-rivers.json';
  if (!existsSync(OSM)) {
    console.error(`${OSM} is missing`);
    process.exit(1);
  }
  const bundle = JSON.parse(readFileSync(OSM, 'utf8'));
  const inBox = (lat, lon) => lat >= BOX.south && lat <= BOX.north && lon >= BOX.west && lon <= BOX.east;

  const clicks = { river: [], stream: [] };
  for (const l of bundle.lines) {
    const dst = l.r === 1 ? clicks.river : clicks.stream;
    for (const pt of clicksAlong(l.p)) if (hasReachData(pt[0], pt[1])) dst.push(pt);
  }

  const groups = {
    river: clicks.river,
    stream: clicks.stream,
    'river, Kathmandu-Gorkha box': clicks.river.filter(([a, o]) => inBox(a, o)),
    'stream, Kathmandu-Gorkha box': clicks.stream.filter(([a, o]) => inBox(a, o)),
  };

  const t0 = Date.now();
  const res = {};
  for (const [name, pts] of Object.entries(groups)) {
    res[name] = await measure(pts);
    console.error(`  ${name}: ${pts.length} clicks measured (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }

  console.log(`Simulated clicks on OSM lines, one per ${SPACING_M} m, SNAP_KM = ${SNAP_KM}, strict reading = ${STRICT_M} m`);
  console.log(`Box = ${BOX.south}-${BOX.north} N, ${BOX.west}-${BOX.east} E\n`);

  for (const [name, r] of Object.entries(res)) {
    console.log(`=== ${name}  (n = ${r.n}) ===`);
    console.log(`CAUSE 1  not within SNAP_KM (attaches to nothing): ${r.notSnapped} = ${f1(r.notSnappedPct)}%` + (r.noReachAtAll ? `  [${r.noReachAtAll} had no reach in the search window at all]` : ''));
    console.log(`         no reach within ${STRICT_M} m (stricter reading):  ${r.noneIn250} = ${f1(r.noneIn250Pct)}%`);
    console.log(`CAUSE 2  among the ${r.snapped} clicks that snap, marker displacement:`);
    console.log(`         median ${f0(r.disp.median)} m   p75 ${f0(r.disp.p75)} m   p90 ${f0(r.disp.p90)} m`);
    console.log('         moved more than ' + MOVE_THRESHOLDS_M.map((t) => `${t} m: ${f1(r.disp.over[t])}%`).join('   '));
    console.log(`         main stem offered: ${f1(r.mainStemPct)}%   reach read is not the nearest: ${r.promotedPct == null ? `not measurable (${r.promotionError})` : f1(r.promotedPct) + '%'}`);
    console.log(`         snapped reach catchment: p10 ${fa(r.area.p10)} km2   median ${fa(r.area.median)} km2   p90 ${fa(r.area.p90)} km2   under 10 km2: ${f1(r.area.under10Pct)}%   under 100 km2: ${f1(r.area.under100Pct)}%\n`);
  }

  console.log('=== SUMMARY (built only from the numbers above) ===');
  for (const [name, r] of Object.entries(res)) {
    const movedAll100 = (r.disp.over[100] * r.snapped) / r.n; // share of ALL clicks that snap AND move the marker > 100 m
    console.log(
      `- ${name}: standing exactly on a traced ${name.startsWith('river') ? 'river' : 'stream'}, ` +
        `${f1(r.notSnappedPct)}% of clicks attach to no modelled reach (cause 1; ${f1(r.noneIn250Pct)}% have none within ${STRICT_M} m). ` +
        `Of the ${f1(100 - r.notSnappedPct)}% that do attach, the marker moves a median ${f0(r.disp.median)} m ` +
        `and more than 100 m in ${f1(r.disp.over[100])}% (cause 2; that is ${f1(movedAll100)}% of all clicks). ` +
        `The snapped reach drains a median ${fa(r.area.median)} km2; ${f1(r.area.under10Pct)}% are under 10 km2.`
    );
  }
  const rv = res.river;
  const st = res.stream;
  const bigger = (a, b) => (a > b ? 'cause 1 (not in the network)' : 'cause 2 (marker moved off the channel)');
  const r100 = (rv.disp.over[100] * rv.snapped) / rv.n;
  const s100 = (st.disp.over[100] * st.snapped) / st.n;
  console.log(`- On the river class the larger problem is ${bigger(rv.notSnappedPct, r100)} (${f1(rv.notSnappedPct)}% vs ${f1(r100)}% of clicks); on the stream class it is ${bigger(st.notSnappedPct, s100)} (${f1(st.notSnappedPct)}% vs ${f1(s100)}%).`);
  console.log('- These are best-case figures: the click sits exactly on the OSM line, and only channels OSM traced are counted.');

  mkdirSync('pipeline/.cache', { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ made: new Date().toISOString(), spacingM: SPACING_M, firstM: FIRST_M, snapKm: SNAP_KM, strictM: STRICT_M, box: BOX, groups: res }, null, 2)
  );
  console.log(`\nwrote ${OUT}`);
}

if (SELF_CHECK) await selfCheck();
else await main();
