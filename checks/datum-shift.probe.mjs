/**
 * Are the coordinates taken from Nepali government sources in Nepal's national
 * datum (Everest 1830, "Nepal 1981"/Nagarkot) while the app treats them as WGS84?
 *
 *   node --experimental-strip-types --no-warnings checks/datum-shift.probe.mjs
 *   node --experimental-strip-types --no-warnings checks/datum-shift.probe.mjs --self-check
 *   ... --all-lines      # sensitivity: index streams too, not only the river class
 *
 * WHY. About 5% of commissioned plants are badly mis-predicted because the
 * published coordinate lands on a tributary beside the real river, and 58 of 115
 * gauges disagree with DHM's own table by over 1 km. A datum mix-up displaces
 * every point by one consistent ~200 m vector, which is a fingerprint that can be
 * looked for against river lines traced from satellite imagery. Random siting
 * error has no such direction.
 *
 * TRUTH. public/nepal-osm-rivers.json (OpenStreetMap, WGS84). NOT HydroRIVERS:
 * OSM-traced rivers move the app's own network vertices by a mean of 135 m.
 * The file marks r=1 river, r=0 stream; by default only r=1 is used (the brief),
 * --all-lines adds the streams, because hydropower intakes often sit on rivers
 * OSM files as streams and a river-only truth can read "no river nearby".
 *
 * SETS.
 *   A  all located DoED projects (box centre: DoED publishes ranges, lat/lon are
 *      their midpoints, so every A point is a box centre, not a surveyed point)
 *   B  the 193 fleet plants, at the coordinate the engine was run from ('intake')
 *   C  DHM gauges at the coordinates src/data/dhm-records.json carries
 *   D  the same gauges at DHM's own published table (sources/dhm-catchments.json)
 *      - the CONTROL: believed resurveyed GPS, so its best shift should be ~origin.
 *   (C-matched is C restricted to the gauges that join to D, so C and D are
 *   compared on identical gauges - harness rule 2.)
 *
 * CONVENTIONS. Distances are in local metres (equirectangular about each point).
 * The search is capped at CAP_M = 3000 m. A point with no river inside the cap is
 * COUNTED beyond the cap and scored AS the cap in every median, so the set stays
 * the same size at every shift; it is never dropped. Offset vectors (ii) use only
 * the within-cap points and say how many. The grid-search tie-break is the mean
 * capped distance, medians being discrete.
 */
import { readFileSync, existsSync } from 'node:fs';

const SELF_CHECK = process.argv.includes('--self-check');
const ALL_LINES = process.argv.includes('--all-lines');

const CAP_M = 3000;
const GRID_MAX = 600;
const GRID_STEP = 50;
const HEAT_STEP = 100;
const BOOT_N = 2000;
const TIE_M = 5;
const NEAR_VECTOR_M = 100;
const R_QUERY = CAP_M + GRID_MAX * Math.SQRT2 + 10; // candidate radius: cap + the largest grid shift

/** Seeded, so the interval printed is the interval next time (same generator as gauge-catchment-bands.mjs). */
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/* ----------------------------------------------------------------- datums */

// Quoted from memory as EPSG "Nepal 1981 to WGS 84 (1)"; NOT yet verified against the EPSG registry.
const EVEREST_1830 = { a: 6377276.345, invF: 300.8017 };
const WGS84 = { a: 6378137, invF: 298.257223563 };
const NEPAL_1981_TO_WGS84 = { dX: 293.17, dY: 726.18, dZ: 245.36 };

const D2R = Math.PI / 180;
/** Metres per degree of latitude and longitude at a point (WGS84 meridian / prime-vertical radii). */
function metresPerDeg(latDeg) {
  const f = 1 / WGS84.invF;
  const e2 = f * (2 - f);
  const s = Math.sin(latDeg * D2R);
  const W2 = 1 - e2 * s * s;
  const N = WGS84.a / Math.sqrt(W2);
  const M = (WGS84.a * (1 - e2)) / (W2 * Math.sqrt(W2));
  return { mLat: M * D2R, mLon: N * Math.cos(latDeg * D2R) * D2R };
}

/**
 * Full Molodensky, h = 0 (heights are ignored: at Nepal's 100-5000 m the effect
 * on the horizontal answer is well under a metre). Returns the change in degrees.
 */
function molodensky(latDeg, lonDeg, from, to, { dX, dY, dZ }) {
  const phi = latDeg * D2R;
  const lam = lonDeg * D2R;
  const fa = from.a;
  const ff = 1 / from.invF;
  const da = to.a - from.a;
  const df = 1 / to.invF - 1 / from.invF;
  const e2 = ff * (2 - ff);
  const b = fa * (1 - ff);
  const sp = Math.sin(phi), cp = Math.cos(phi), sl = Math.sin(lam), cl = Math.cos(lam);
  const W2 = 1 - e2 * sp * sp;
  const N = fa / Math.sqrt(W2);
  const M = (fa * (1 - e2)) / (W2 * Math.sqrt(W2));
  const dPhi =
    (-dX * sp * cl - dY * sp * sl + dZ * cp + (da * N * e2 * sp * cp) / fa + df * ((M * fa) / b + (N * b) / fa) * sp * cp) / M;
  const dLam = (-dX * sl + dY * cl) / (N * cp);
  return { dLat: dPhi / D2R, dLon: dLam / D2R };
}

/** Independent route to the same thing: geodetic -> ECEF -> translate -> geodetic. Used to catch a sign slip. */
function geocentric(latDeg, lonDeg, from, to, { dX, dY, dZ }) {
  const phi = latDeg * D2R, lam = lonDeg * D2R;
  const f1 = 1 / from.invF;
  const e21 = f1 * (2 - f1);
  const N1 = from.a / Math.sqrt(1 - e21 * Math.sin(phi) ** 2);
  const X = N1 * Math.cos(phi) * Math.cos(lam) + dX;
  const Y = N1 * Math.cos(phi) * Math.sin(lam) + dY;
  const Z = N1 * (1 - e21) * Math.sin(phi) + dZ;
  const f2 = 1 / to.invF;
  const e22 = f2 * (2 - f2);
  const p = Math.hypot(X, Y);
  let phi2 = Math.atan2(Z, p * (1 - e22));
  for (let i = 0; i < 10; i++) {
    const N2 = to.a / Math.sqrt(1 - e22 * Math.sin(phi2) ** 2);
    phi2 = Math.atan2(Z + e22 * N2 * Math.sin(phi2), p);
  }
  return { dLat: phi2 / D2R - latDeg, dLon: Math.atan2(Y, X) / D2R - lonDeg };
}

const NEG = (t) => ({ dX: -t.dX, dY: -t.dY, dZ: -t.dZ });
/** Treat (lat, lon) as Everest 1830 and express in WGS84. */
const forward = (lat, lon, fn = molodensky) => fn(lat, lon, EVEREST_1830, WGS84, NEPAL_1981_TO_WGS84);
/** The opposite sign: treat (lat, lon) as WGS84 and express in Everest 1830. */
const inverse = (lat, lon, fn = molodensky) => fn(lat, lon, WGS84, EVEREST_1830, NEG(NEPAL_1981_TO_WGS84));
/** A degree change at a point, in metres east / north. */
function toMetres(lat, d) {
  const { mLat, mLon } = metresPerDeg(lat);
  return { e: d.dLon * mLon, n: d.dLat * mLat };
}

/* ------------------------------------------------------------- river index */

const OSM = 'public/nepal-osm-rivers.json';
if (!existsSync(OSM)) {
  console.error(`${OSM} is missing`);
  process.exit(1);
}
const bundle = JSON.parse(readFileSync(OSM, 'utf8'));
const lines = bundle.lines.filter((l) => ALL_LINES || l.r === 1);
const SEG = []; // flat: latA, lonA, latB, lonB
for (const l of lines) {
  for (let i = 0; i + 3 < l.p.length; i += 2) SEG.push(l.p[i], l.p[i + 1], l.p[i + 2], l.p[i + 3]);
}
const segs = Float64Array.from(SEG);
const NSEG = segs.length / 4;

const CELL = 0.02;
const cellKey = (ci, cj) => ci * 100000 + cj;
const grid = new Map();
for (let s = 0; s < NSEG; s++) {
  const la = segs[4 * s], oa = segs[4 * s + 1], lb = segs[4 * s + 2], ob = segs[4 * s + 3];
  const i0 = Math.floor(Math.min(la, lb) / CELL), i1 = Math.floor(Math.max(la, lb) / CELL);
  const j0 = Math.floor(Math.min(oa, ob) / CELL), j1 = Math.floor(Math.max(oa, ob) / CELL);
  for (let ci = i0; ci <= i1; ci++)
    for (let cj = j0; cj <= j1; cj++) {
      const k = cellKey(ci, cj);
      const b = grid.get(k);
      if (b) b.push(s);
      else grid.set(k, [s]);
    }
}
const stamp = new Uint32Array(NSEG);
let stampN = 0;

/** Segments within R_QUERY of the point, as local-metre endpoints relative to the point. */
function candidates(lat, lon) {
  const { mLat, mLon } = metresPerDeg(lat);
  const dLat = R_QUERY / mLat, dLon = R_QUERY / mLon;
  stampN++;
  const out = [];
  for (let ci = Math.floor((lat - dLat) / CELL); ci <= Math.floor((lat + dLat) / CELL); ci++)
    for (let cj = Math.floor((lon - dLon) / CELL); cj <= Math.floor((lon + dLon) / CELL); cj++) {
      const b = grid.get(cellKey(ci, cj));
      if (!b) continue;
      for (const s of b) {
        if (stamp[s] === stampN) continue;
        stamp[s] = stampN;
        const ax = (segs[4 * s + 1] - lon) * mLon, ay = (segs[4 * s] - lat) * mLat;
        const bx = (segs[4 * s + 3] - lon) * mLon, by = (segs[4 * s + 2] - lat) * mLat;
        if (segDist2(ax, ay, bx, by, 0, 0) <= R_QUERY * R_QUERY) out.push(ax, ay, bx, by);
      }
    }
  return Float64Array.from(out);
}

let NX = 0, NY = 0; // nearest point of the last segDist2 that improved, by side effect (no allocation in the hot loop)
function segDist2(ax, ay, bx, by, px, py) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  NX = ax + t * vx;
  NY = ay + t * vy;
  const dx = px - NX, dy = py - NY;
  return dx * dx + dy * dy;
}

/** Nearest river from local point (px, py): {d, nx, ny}; d = Infinity when no candidate. */
function nearest(cand, px, py) {
  let best = Infinity, bx = 0, by = 0;
  for (let i = 0; i < cand.length; i += 4) {
    const d2 = segDist2(cand[i], cand[i + 1], cand[i + 2], cand[i + 3], px, py);
    if (d2 < best) {
      best = d2;
      bx = NX;
      by = NY;
    }
  }
  return { d: Math.sqrt(best), nx: bx, ny: by };
}
/** The grid-search inner loop: capped distance only. */
function nearestCapped(cand, px, py) {
  let best = CAP_M * CAP_M;
  for (let i = 0; i < cand.length; i += 4) {
    const d2 = segDist2(cand[i], cand[i + 1], cand[i + 2], cand[i + 3], px, py);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/* ------------------------------------------------------------------- stats */

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = sorted(xs), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quant = (xs, p) => {
  if (!xs.length) return NaN;
  const s = sorted(xs);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const se = (xs) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
};
function bootMedianCI(xs, seed) {
  if (xs.length < 2) return [NaN, NaN];
  const r = rng(seed), n = xs.length, meds = [];
  for (let b = 0; b < BOOT_N; b++) {
    const s = new Array(n);
    for (let i = 0; i < n; i++) s[i] = xs[Math.floor(r() * n)];
    meds.push(median(s));
  }
  meds.sort((a, b) => a - b);
  return [meds[Math.floor(0.025 * BOOT_N)], meds[Math.floor(0.975 * BOOT_N) - 1]];
}
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '-');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const sg = (x) => (x > 0 ? '+' : '') + f0(x);

/* ------------------------------------------------------------ the analysis */

/** Build a set: points get their candidate segments once; every shift reuses them. */
function makeSet(name, pts) {
  return { name, pts, cands: pts.map((p) => candidates(p.lat, p.lon)) };
}

/** Distance of every point from local offset (ox_i, oy_i) (per point) or one common (ox, oy), capped. */
function capDist(set, ox, oy) {
  return set.cands.map((c, i) => nearestCapped(c, Array.isArray(ox) ? ox[i] : ox, Array.isArray(oy) ? oy[i] : oy));
}

function gridSearch(set) {
  const steps = [];
  for (let v = -GRID_MAX; v <= GRID_MAX; v += GRID_STEP) steps.push(v);
  const cells = new Map();
  let best = null;
  for (const dN of steps)
    for (const dE of steps) {
      const d = capDist(set, dE, dN);
      const cell = { dE, dN, med: median(d), mean: mean(d) };
      cells.set(`${dE},${dN}`, cell);
      if (
        !best ||
        cell.med < best.med ||
        (cell.med === best.med && cell.mean < best.mean) ||
        (cell.med === best.med && cell.mean === best.mean && Math.hypot(dE, dN) < Math.hypot(best.dE, best.dN))
      )
        best = cell;
    }
  return { best, origin: cells.get('0,0'), cells };
}

function offsets(set) {
  const E = [], Nn = [];
  let beyond = 0;
  set.cands.forEach((c) => {
    const r = nearest(c, 0, 0);
    if (!(r.d < CAP_M)) beyond++;
    else {
      E.push(r.nx);
      Nn.push(r.ny);
    }
  });
  return { E, N: Nn, beyond };
}

function printHeat(gs) {
  const steps = [];
  for (let v = -GRID_MAX; v <= GRID_MAX; v += HEAT_STEP) steps.push(v);
  console.log(`      median distance to river, m (rows dN north at top, columns dE; shift applied to every point; * = grid minimum)`);
  console.log('  dN\\dE ' + steps.map((v) => sg(v).padStart(5)).join(''));
  for (const dN of [...steps].reverse()) {
    console.log(
      sg(dN).padStart(6) +
        ' ' +
        steps
          .map((dE) => {
            const c = gs.cells.get(`${dE},${dN}`);
            const mark = c.dE === gs.best.dE && c.dN === gs.best.dN ? '*' : ' ';
            return (f0(c.med) + mark).padStart(5);
          })
          .join('')
    );
  }
}

/* -------------------------------------------------------------- self check */

if (SELF_CHECK) {
  const r = rng(20260816);
  const TRUE = { e: -200, n: 50 };
  const pts = [];
  while (pts.length < 300) {
    const s = Math.floor(r() * NSEG), t = r();
    const lat = segs[4 * s] + t * (segs[4 * s + 2] - segs[4 * s]);
    const lon = segs[4 * s + 1] + t * (segs[4 * s + 3] - segs[4 * s + 1]);
    const { mLat, mLon } = metresPerDeg(lat);
    pts.push({ lat: lat + TRUE.n / mLat, lon: lon + TRUE.e / mLon });
  }
  const set = makeSet('self-check', pts);
  const gs = gridSearch(set);
  const off = offsets(set);
  const mE = mean(off.E), mN = mean(off.N);
  console.log(`self-check: ${pts.length} points exactly on ${ALL_LINES ? 'all' : 'river-class'} OSM lines, displaced by (dE ${TRUE.e}, dN ${TRUE.n}) m`);
  console.log(`  grid search best shift (${sg(gs.best.dE)}, ${sg(gs.best.dN)}), expected (${sg(-TRUE.e)}, ${sg(-TRUE.n)}); median ${f0(gs.best.med)} m there vs ${f0(gs.origin.med)} m at origin`);
  console.log(`  mean offset vector (E ${f1(mE)}, N ${f1(mN)}) over ${off.E.length} within-cap points (${off.beyond} beyond cap)`);
  const gridOk = Math.abs(gs.best.dE + TRUE.e) <= GRID_STEP && Math.abs(gs.best.dN + TRUE.n) <= GRID_STEP;
  // The nearest river point is the PERPENDICULAR foot on the nearest line, so the component of the displacement along
  // the line is invisible to it. Over lines of random orientation the expected mean vector is therefore about HALF the
  // correcting shift (E[projection] = I/2), in the right direction. So the bar is: right direction, 0.3-0.7 of the length.
  const cE = -TRUE.e, cN = -TRUE.n;
  const frac = (mE * cE + mN * cN) / (cE * cE + cN * cN);
  const dirOk = mE * cE > 0 && mN * cN > 0;
  const meanOk = dirOk && frac >= 0.3 && frac <= 0.7;
  console.log(
    `  grid recovery within one ${GRID_STEP} m step: ${gridOk ? 'PASS' : 'FAIL'};  mean vector points the right way on both axes and is ${f1(frac)} of the correcting shift (expect ~0.5, bar 0.3-0.7): ${meanOk ? 'PASS' : 'FAIL'}`
  );
  process.exitCode = gridOk && meanOk ? 0 : 1;
} else {
  await main();
}

/* -------------------------------------------------------------------- main */

async function main() {
  const doed = JSON.parse(readFileSync('src/data/doed-projects.json', 'utf8')).projects.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)
  );
  const fleet = JSON.parse(readFileSync('src/data/fleet-validation.json', 'utf8')).plants.filter((p) => p.intake);
  const records = JSON.parse(readFileSync('src/data/dhm-records.json', 'utf8')).stations;
  const CATCH = 'sources/dhm-catchments.json';
  if (!existsSync(CATCH)) {
    console.error(`${CATCH} is missing - run: python pipeline/build-dhm-catchments.py`);
    process.exit(1);
  }
  const table = new Map(JSON.parse(readFileSync(CATCH, 'utf8')).stations.map((s) => [s.id, s]));
  const matched = records.filter((s) => table.has(s.id));

  console.log('='.repeat(78));
  console.log('DATUM-SHIFT PROBE: are Nepali-government coordinates in Everest 1830, read as WGS84?');
  console.log('='.repeat(78));
  console.log(
    `river truth: ${bundle.lines.length} OSM lines in file (r=1 river ${bundle.lines.filter((l) => l.r === 1).length}, r=0 stream ${bundle.lines.filter((l) => l.r !== 1).length}); ` +
      `used ${lines.length} lines (${ALL_LINES ? 'ALL classes, --all-lines' : 'river class r=1 only'}) = ${NSEG} segments`
  );
  console.log(`search cap ${CAP_M} m; beyond-cap points are counted and scored AS the cap; grid +-${GRID_MAX} m in ${GRID_STEP} m steps; bootstrap ${BOOT_N} resamples, seeded.`);

  // Hypothesised displacement
  console.log('\nHYPOTHESIS CONSTANTS (quoted from memory as EPSG "Nepal 1981 to WGS 84 (1)"; NOT yet verified against the EPSG registry)');
  console.log(`  Everest 1830 a=${EVEREST_1830.a} 1/f=${EVEREST_1830.invF};  WGS84 a=${WGS84.a} 1/f=${WGS84.invF};  dX ${NEPAL_1981_TO_WGS84.dX} dY ${NEPAL_1981_TO_WGS84.dY} dZ ${NEPAL_1981_TO_WGS84.dZ} m`);
  const m28 = toMetres(28, forward(28, 84));
  const g28 = toMetres(28, forward(28, 84, geocentric));
  const i28 = toMetres(28, inverse(28, 84));
  console.log(`  at 28 N 84 E, forward (Everest -> WGS84, Molodensky full, h=0): ${sg(m28.e)} m east, ${sg(m28.n)} m north  (length ${f0(Math.hypot(m28.e, m28.n))} m)`);
  console.log(`    cross-check, geocentric route: ${sg(g28.e)} E, ${sg(g28.n)} N;  inverse (opposite direction): ${sg(i28.e)} E, ${sg(i28.n)} N`);
  const DISP = m28;

  const sets = [
    makeSet('A  DoED located projects (box centres)', doed.map((p) => ({ lat: p.lat, lon: p.lon, id: p.licenceNo }))),
    makeSet('B  fleet plants (193, engine intake coord)', fleet.map((p) => ({ lat: p.intake[0], lon: p.intake[1] }))),
    makeSet('C  DHM gauges, records coordinates', records.map((s) => ({ lat: s.lat, lon: s.lon, id: s.id }))),
    makeSet('D  DHM gauges, DHM published coordinates (control)', matched.map((s) => ({ lat: table.get(s.id).lat, lon: table.get(s.id).lon, id: s.id }))),
    makeSet('C* C restricted to the gauges present in D', matched.map((s) => ({ lat: s.lat, lon: s.lon, id: s.id }))),
  ];
  // Box centres: say how many of A actually are boxes, and how big.
  const boxes = JSON.parse(readFileSync('src/data/doed-projects.json', 'utf8')).projects.filter((p) => p.bounds);
  const spanM = boxes.map((p) => Math.hypot((p.bounds[2] - p.bounds[0]) * 111000, (p.bounds[3] - p.bounds[1]) * 98000));
  console.log(
    `\nset A: ${doed.length} of ${boxes.length} DoED projects carry a from-to box; lat/lon are its midpoint. Box diagonal median ${f0(median(spanM))} m, p90 ${f0(quant(spanM, 0.9))} m.`
  );
  console.log('set B: fleet rows are commissioned plants and overlap A (subset); C and D are the same gauges where the ids join.');

  const verdicts = [];
  const summary = [];
  let seed = 7000;
  for (const set of sets) {
    console.log(`\n${'-'.repeat(78)}\n${set.name}\n${'-'.repeat(78)}`);
    const n = set.pts.length;

    // (i)
    const d0 = capDist(set, 0, 0);
    const beyond = d0.filter((d) => d >= CAP_M).length;
    console.log(`(i)  n ${n}   distance to nearest river:  median ${f0(median(d0))}  p75 ${f0(quant(d0, 0.75))}  p90 ${f0(quant(d0, 0.9))} m   beyond ${CAP_M} m cap: ${beyond} (${f1((100 * beyond) / n)}%, scored as ${CAP_M})`);

    // (ii)
    const off = offsets(set);
    const mE = mean(off.E), mN = mean(off.N);
    const [eLo, eHi] = bootMedianCI(off.E, seed++);
    const [nLo, nHi] = bootMedianCI(off.N, seed++);
    console.log(`(ii) offset point -> nearest river point, ${off.E.length} within-cap points (${off.beyond} beyond cap not included):`);
    console.log(`       mean   E ${sg(mE)} (se ${f1(se(off.E))})   N ${sg(mN)} (se ${f1(se(off.N))}) m`);
    console.log(`       median E ${sg(median(off.E))} [95% ${sg(eLo)}, ${sg(eHi)}]   N ${sg(median(off.N))} [95% ${sg(nLo)}, ${sg(nHi)}] m`);

    // (iii)
    const gs = gridSearch(set);
    console.log(`(iii) grid search: best shift dE ${sg(gs.best.dE)}, dN ${sg(gs.best.dN)} m;  median distance ${f0(gs.best.med)} m there vs ${f0(gs.origin.med)} m at (0,0)  (${gs.origin.med > 0 ? sg((100 * (gs.best.med - gs.origin.med)) / gs.origin.med) + '%' : 'n/a'})`);
    printHeat(gs);

    // (iv)
    const fw = set.pts.map((p) => toMetres(p.lat, forward(p.lat, p.lon)));
    const iv = set.pts.map((p) => toMetres(p.lat, inverse(p.lat, p.lon)));
    const dF = capDist(set, fw.map((v) => v.e), fw.map((v) => v.n));
    const dI = capDist(set, iv.map((v) => v.e), iv.map((v) => v.n));
    const h2h = (dv) => {
      let closer = 0, further = 0, tied = 0;
      dv.forEach((d, i) => {
        if (d < d0[i] - TIE_M) closer++;
        else if (d > d0[i] + TIE_M) further++;
        else tied++;
      });
      return `closer ${closer} / further ${further} / tied(<=${TIE_M} m) ${tied}`;
    };
    console.log('(iv) Everest 1830 hypothesis, median distance to river (m) and head-to-head vs as published:');
    console.log(`       as published          ${f0(median(d0)).padStart(5)}`);
    console.log(`       forward-transformed   ${f0(median(dF)).padStart(5)}   ${h2h(dF)}`);
    console.log(`       inverse-transformed   ${f0(median(dI)).padStart(5)}   ${h2h(dI)}`);

    // verdict inputs
    const distTo = (v) => Math.hypot(gs.best.dE - v.e, gs.best.dN - v.n);
    const fwdVec = { e: DISP.e, n: DISP.n };
    const invVec = { e: -DISP.e, n: -DISP.n };
    const zeroIn = (lo, hi) => lo <= 0 && 0 <= hi;
    verdicts.push({
      name: set.name,
      best: gs.best,
      origin: gs.origin,
      dFwd: distTo(fwdVec),
      dInv: distTo(invVec),
      eZero: zeroIn(eLo, eHi),
      nZero: zeroIn(nLo, nHi),
      eCI: [eLo, eHi],
      nCI: [nLo, nHi],
      medPub: median(d0),
      medF: median(dF),
      medI: median(dI),
    });
    summary.push({ set, d0, gs });
  }

  // C vs D
  console.log(`\n${'='.repeat(78)}\nC vs D: vector from the records' coordinate to DHM's published coordinate\n${'='.repeat(78)}`);
  const vec = matched.map((s) => {
    const t = table.get(s.id);
    const { mLat, mLon } = metresPerDeg(s.lat);
    return { e: (t.lon - s.lon) * mLon, n: (t.lat - s.lat) * mLat, lat: s.lat, lon: s.lon };
  });
  const len = vec.map((v) => Math.hypot(v.e, v.n));
  const near = (fn) =>
    vec.filter((v) => {
      const d = toMetres(v.lat, fn(v.lat, v.lon));
      return Math.hypot(v.e - d.e, v.n - d.n) <= NEAR_VECTOR_M;
    }).length;
  const nearFwd = near(forward);
  const nearInv = near(inverse);
  const nearZero = len.filter((l) => l <= NEAR_VECTOR_M).length;
  console.log(`gauges present in both: ${vec.length} of ${records.length} records (table has ${table.size} stations)`);
  console.log(`  vector C->D: median east ${sg(median(vec.map((v) => v.e)))} m, median north ${sg(median(vec.map((v) => v.n)))} m, median length ${f0(median(len))} m (p25 ${f0(quant(len, 0.25))}, p75 ${f0(quant(len, 0.75))}, p90 ${f0(quant(len, 0.9))})`);
  console.log(`  longer than 1 km: ${len.filter((l) => l > 1000).length};  within ${NEAR_VECTOR_M} m of zero (no disagreement): ${nearZero}`);
  console.log(`  within ${NEAR_VECTOR_M} m of the hypothesised displacement (C read as Everest, D the truth; ${sg(DISP.e)} E, ${sg(DISP.n)} N): ${nearFwd} of ${vec.length}`);
  console.log(`  within ${NEAR_VECTOR_M} m of the opposite displacement (${sg(-DISP.e)} E, ${sg(-DISP.n)} N): ${nearInv} of ${vec.length}`);

  // Verdicts, from the numbers above only.
  console.log(`\n${'='.repeat(78)}\nVERDICT PER SET (restating the numbers above; no thresholds beyond those printed)\n${'='.repeat(78)}`);
  for (const v of verdicts) {
    const delta = v.origin.med > 0 ? (100 * (v.best.med - v.origin.med)) / v.origin.med : NaN;
    const bestLen = Math.hypot(v.best.dE, v.best.dN);
    const where =
      bestLen <= GRID_STEP
        ? `at or within one grid step of the origin (${f0(bestLen)} m)`
        : `${f0(bestLen)} m from the origin at (${sg(v.best.dE)}, ${sg(v.best.dN)})`;
    console.log(`${v.name}`);
    console.log(`  - best uniform shift is ${where}; median distance ${f0(v.origin.med)} -> ${f0(v.best.med)} m (${sg(delta)}%).`);
    console.log(`  - that shift is ${f0(v.dFwd)} m from the forward-datum correction and ${f0(v.dInv)} m from the inverse one (within ${NEAR_VECTOR_M} m counts as matching: forward ${v.dFwd <= NEAR_VECTOR_M ? 'YES' : 'no'}, inverse ${v.dInv <= NEAR_VECTOR_M ? 'YES' : 'no'}).`);
    console.log(`  - median offset to river: E interval [${sg(v.eCI[0])}, ${sg(v.eCI[1])}] ${v.eZero ? 'contains' : 'EXCLUDES'} zero; N interval [${sg(v.nCI[0])}, ${sg(v.nCI[1])}] ${v.nZero ? 'contains' : 'EXCLUDES'} zero.`);
    console.log(`  - median distance: published ${f0(v.medPub)} m, forward-transformed ${f0(v.medF)} m, inverse-transformed ${f0(v.medI)} m.`);
  }
  console.log(
    `\nControl set D: best shift ${f0(Math.hypot(verdicts[3].best.dE, verdicts[3].best.dN))} m from the origin, median distance ${f0(verdicts[3].origin.med)} m (the floor this instrument reads on points believed correct).`
  );
}
