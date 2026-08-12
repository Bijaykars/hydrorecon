/**
 * Nepal's protected areas.
 *
 *   npm run build:protected
 *
 * WHY: roughly a quarter of Nepal is national park, wildlife reserve or
 * conservation area, and hydropower inside them is restricted or prohibited
 * outright. A screening tool that ranks a site in the middle of Sagarmatha
 * National Park alongside one on an unprotected river is not screening, it is
 * wasting the engineer's afternoon. This is a go/no-go constraint and belongs
 * beside the energy figure, not in a footnote.
 *
 * The tool does not decide the legal question — conservation areas in
 * particular do permit some development, and buffer zones differ again. It says
 * which designation the site falls inside so the engineer knows which
 * permission regime applies before spending anything.
 *
 * SOURCE: OpenStreetMap via Overpass, (c) OpenStreetMap contributors, ODbL 1.0.
 * The extract is a derived database and stays ODbL; that governs the data file,
 * not this repository's MIT code.
 */
import { writeFileSync } from 'node:fs';

/**
 * Mirrors, best first. Full relation geometry for every Nepali park is about
 * 1.2 MB and takes over a minute to assemble; the main instance answers 504
 * under load, the Kumi mirror does not.
 */
const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const UA = 'Ghatta/0.2 (open-source hydropower screening; github.com/Bijaykars)';
const OUT = 'src/data/nepal-protected.json';

/** Below this a polygon is a village pond tagged nature_reserve, not a park. */
const MIN_AREA_KM2 = 5;

const ask = async (ql) => {
  let last = '';
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(ql),
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
      });
      if (r.ok) return (await r.json()).elements ?? [];
      last = `HTTP ${r.status} from ${new URL(url).host}`;
    } catch (e) {
      last = `${new URL(url).host}: ${e.message}`;
    }
  }
  throw new Error(`Overpass: ${last}`);
};

/**
 * Stitch OSM relation members into closed rings.
 *
 * A boundary relation does not hold polygons. It holds the boundary chopped
 * into ways — often dozens, in arbitrary order and arbitrary direction, because
 * each is shared with whatever else borders it. Treating each member as its own
 * ring, which the first version of this script did, feeds open polylines to a
 * ray-casting test and produces nonsense: every Nepali park, including Chitwan
 * and Sagarmatha, tested as outside Nepal.
 *
 * So the ways are joined end to end, reversing where needed, until each ring
 * closes. Chitwan alone arrives as 69 pieces.
 */
function assembleRings(ways) {
  const open = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

  while (open.length) {
    let ring = open.pop();
    let grew = true;
    while (grew && !same(ring[0], ring[ring.length - 1])) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        const end = ring[ring.length - 1];
        if (same(end, w[0])) ring = ring.concat(w.slice(1));
        else if (same(end, w[w.length - 1])) ring = ring.concat(w.slice(0, -1).reverse());
        else if (same(ring[0], w[w.length - 1])) ring = w.slice(0, -1).concat(ring);
        else if (same(ring[0], w[0])) ring = w.slice(1).reverse().concat(ring);
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    // Keep it whether or not it closed — an unclosed chain still bounds
    // something usefully once the ray-caster treats it as implicitly closed.
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/** Even-odd point-in-polygon over a set of rings. */
function inRings(lat, lon, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i];
      const [yj, xj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Nepal's own boundary, because a bounding box cannot do this job.
 *
 * Overpass's `(area.np)` returns anything INTERSECTING Nepal, which picks up
 * Indian parks that run along the frontier — Dudhwa and Sohelwa in Uttar
 * Pradesh, Barsey in Sikkim. Their centroids sit inside any rectangle drawn
 * around Nepal too, so they can only be excluded by testing against the real
 * border. Telling an engineer their site is inside an Indian tiger reserve
 * would be a strange and undermining way to be wrong.
 */
console.log('fetching Nepal boundary…');
const borderEls = await ask(
  '[out:json][timeout:300];relation["ISO3166-1"="NP"][admin_level=2];out body geom;'
);
const NEPAL_RINGS = assembleRings(
  (borderEls[0]?.members ?? [])
    .filter((m) => m.geometry && m.role !== 'inner')
    .map((m) => m.geometry.filter((p) => p && Number.isFinite(p.lat)).map((p) => [p.lat, p.lon]))
);
if (NEPAL_RINGS.length === 0) throw new Error('could not read Nepal boundary');
console.log(`  ${NEPAL_RINGS.length} boundary segments`);

const AREA = 'area["ISO3166-1"="NP"][admin_level=2]->.np;';

console.log('fetching protected areas…');
const els = await ask(
  `[out:json][timeout:300];${AREA}(` +
    `relation["boundary"="national_park"](area.np);` +
    `relation["boundary"="protected_area"](area.np);` +
    `way["boundary"="national_park"](area.np);` +
    `way["boundary"="protected_area"](area.np);` +
    `);out body geom;`
);
console.log(`  ${els.length} elements`);

/** Rough polygon area in km², by the shoelace formula on a local flat frame. */
function ringAreaKm2(pts) {
  if (pts.length < 3) return 0;
  const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.57;
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += (pts[j][1] * kx) * (pts[i][0] * ky) - (pts[i][1] * kx) * (pts[j][0] * ky);
  }
  return Math.abs(s / 2);
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** Same perpendicular-distance simplification the grid pipeline uses. */
function simplify(pts, tolDeg) {
  if (pts.length <= 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let worstD = 0;
    const [ay, ax] = pts[a];
    const [by, bx] = pts[b];
    const dy = by - ay;
    const dx = bx - ax;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = pts[i];
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worstD > tolDeg && worst > 0) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const TOL_DEG = 200 / 111320; // ~200 m — a park boundary is not surveyed here

/**
 * IUCN protect_class, where OSM carries it, mapped to what it means for a
 * developer. Nepal's conservation areas (class 5/6) genuinely do host
 * hydropower — several licensed schemes sit inside Annapurna — whereas national
 * parks (class 2) do not. Conflating the two would be wrong in both directions.
 */
const REGIME = {
  '1': 'strict — development prohibited',
  '2': 'national park — hydropower prohibited or exceptional',
  '3': 'natural monument — development prohibited',
  '4': 'wildlife reserve — development heavily restricted',
  '5': 'conservation area — development possible with conditions',
  '6': 'managed reserve — development possible with conditions',
};

const areas = [];
let dropped = 0;
for (const e of els) {
  const name = (e.tags?.['name:en'] ?? e.tags?.name ?? '').trim();
  if (!name || name === '?') {
    dropped++;
    continue;
  }
  // Relations arrive as member ways; each becomes a ring, and even-odd
  // containment then handles enclaves and holes correctly.
  const pieces =
    e.type === 'relation'
      ? (e.members ?? [])
          .filter((m) => m.geometry && m.role !== 'inner')
          .map((m) => m.geometry.filter((p) => p && Number.isFinite(p.lat)).map((p) => [p.lat, p.lon]))
      : [(e.geometry ?? []).filter((p) => p && Number.isFinite(p.lat)).map((p) => [p.lat, p.lon])];
  const raw = assembleRings(pieces);
  const rings = [];
  let areaKm2 = 0;
  let sumLat = 0;
  let sumLon = 0;
  let n = 0;
  for (const g of raw) {
    const pts = g;
    if (pts.length < 4) continue;
    areaKm2 += ringAreaKm2(pts);
    for (const p of pts) {
      sumLat += p[0];
      sumLon += p[1];
      n++;
    }
    rings.push(simplify(pts, TOL_DEG).map(([y, x]) => [r4(y), r4(x)]).flat());
  }
  if (rings.length === 0 || n === 0 || areaKm2 < MIN_AREA_KM2) {
    dropped++;
    continue;
  }
  // Drop cross-border parks whose centre is not actually in Nepal.
  const cLat = sumLat / n;
  const cLon = sumLon / n;
  if (!inRings(cLat, cLon, NEPAL_RINGS)) {
    console.log(`  outside Nepal, dropped: ${name}`);
    dropped++;
    continue;
  }
  const cls = String(e.tags?.protect_class ?? '');
  areas.push({
    n: name,
    k: e.tags?.boundary === 'national_park' ? 'national_park' : 'protected_area',
    c: cls || null,
    r: REGIME[cls] ?? 'designation unclear — check with DNPWC before proceeding',
    a: Math.round(areaKm2),
    rings,
  });
}

areas.sort((a, b) => b.a - a.a);

const out = {
  _source: 'OpenStreetMap via Overpass, © OpenStreetMap contributors, ODbL 1.0',
  _note: 'Derived database. Redistribution governed by ODbL, not the MIT licence on the code.',
  areas,
};
const json = JSON.stringify(out);
writeFileSync(OUT, json);

console.log(`\nwrote ${OUT}: ${(json.length / 1024).toFixed(1)} KB`);
console.log(`  kept ${areas.length} areas, dropped ${dropped} unnamed/tiny/foreign`);
for (const a of areas.slice(0, 14)) {
  console.log(`  ${String(a.a).padStart(6)} km²  ${a.n.slice(0, 38).padEnd(39)} ${a.r}`);
}
