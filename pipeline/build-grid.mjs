/**
 * Nepal's transmission grid, from OpenStreetMap.
 *
 *   npm run build:grid
 *
 * WHY: a scheme's distance to a line that can actually take its power is one of
 * the few things that decides a Nepali small-hydro project outright, and the app
 * had nothing to say about it. Twenty megawatts three kilometres from a 132 kV
 * line is a different proposition from the same twenty megawatts sixty
 * kilometres up a valley, and the difference is frequently larger than every
 * refinement to the energy estimate put together.
 *
 * SOURCE AND LICENCE: OpenStreetMap via the Overpass API, © OpenStreetMap
 * contributors, ODbL 1.0. The extract written here is a derived database and
 * stays ODbL — that is a licence on the DATA file, not on this repository's MIT
 * code, the same split already used for the bundled HydroRIVERS extract.
 * Attribution ships with the app and in every export.
 *
 * Overpass rejects anonymous requests with 406, so the User-Agent below is
 * required, not decoration.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const UA = 'HydroRecon/0.2 (open-source hydropower screening; github.com/Bijaykars)';
const OUT = 'src/data/nepal-grid.json';

/**
 * Below this a line cannot evacuate a hydropower plant of any size worth
 * screening — 400 V and 11 kV tags are local distribution, not a connection
 * point. Keeping them would make every site look conveniently close to the grid.
 */
const MIN_KV = 30;

/**
 * Overpass answers are cached on disk, keyed by the query itself.
 *
 * These two queries pull full geometry for every power line and substation in
 * Nepal, which is heavy enough that the public instances return 504 under load
 * — and losing a good response to a later failure means starting over. The
 * cache makes a rerun free and makes the pipeline reproducible offline. Delete
 * pipeline/.cache/overpass-*.json to force a refresh.
 */
const CACHE = 'pipeline/.cache';
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

const ask = async (ql) => {
  const key = `${CACHE}/overpass-${createHash('sha1').update(ql).digest('hex').slice(0, 12)}.json`;
  if (existsSync(key)) {
    console.log('  (cached)');
    return JSON.parse(readFileSync(key, 'utf8')).elements ?? [];
  }
  let last = '';
  for (let pass = 0; pass < 2; pass++) {
    for (const url of ENDPOINTS) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(ql),
          headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(180_000),
        });
        if (r.ok) {
          const body = await r.text();
          writeFileSync(key, body);
          return JSON.parse(body).elements ?? [];
        }
        last = `HTTP ${r.status} from ${new URL(url).host}: ${(await r.text()).slice(0, 80)}`;
      } catch (e) {
        last = `${new URL(url).host}: ${e.message}`;
      }
    }
  }
  throw new Error(`Overpass: ${last}`);
};

/**
 * Highest voltage on a tag, in kV.
 *
 * OSM writes volts, and multi-circuit towers carry several separated by ';'
 * ("132000;66000"). The highest is what the line can carry, so that is what a
 * developer would connect to.
 */
const kvOf = (tags) => {
  const raw = tags?.voltage;
  if (!raw) return 0; // untagged — kept, but flagged as unknown
  const best = Math.max(...String(raw).split(';').map((v) => Number(v) || 0));
  return best > 0 ? Math.round(best / 1000) : 0;
};

const AREA = 'area["ISO3166-1"="NP"][admin_level=2]->.np;';

console.log('fetching transmission lines…');
const lineEls = await ask(
  `[out:json][timeout:240];${AREA}(way["power"="line"](area.np););out tags geom;`
);
console.log(`  ${lineEls.length} ways`);

/**
 * Substations, with their footprints rather than just a centre point.
 *
 * The geometry is what makes the voltage inference below possible: a line ends
 * INSIDE a substation's fence, so the footprint is the test. Relations were
 * checked for and Nepal has none — every substation in OSM here is a way or a
 * node — so this query is complete, not merely convenient.
 */
console.log('fetching substations…');
const subEls = await ask(
  `[out:json][timeout:240];${AREA}(way["power"="substation"](area.np);node["power"="substation"](area.np););out tags geom;`
);
console.log(`  ${subEls.length} substations`);

/** Round to ~11 m. Finer than that is false precision for a screening distance. */
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Drop vertices that do not change where the line runs.
 *
 * Perpendicular-distance simplification: only the distance to the nearest point
 * on a line matters here, so a vertex that sits within a tolerance of the
 * straight segment spanning its neighbours carries no information. At 150 m the
 * error is well inside the uncertainty of the tags themselves.
 */
function simplify(pts, tolDeg) {
  if (pts.length <= 2) return pts;
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
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = Math.hypot(ex, ey);
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

const TOL_DEG = 150 / 111320; // ~150 m

const lines = [];
let vertsIn = 0;
let vertsOut = 0;
for (const e of lineEls) {
  const kv = kvOf(e.tags);
  if (kv > 0 && kv < MIN_KV) continue; // local distribution, not a connection point
  const pts = (e.geometry ?? []).filter((g) => g && Number.isFinite(g.lat)).map((g) => [g.lat, g.lon]);
  if (pts.length < 2) continue;
  vertsIn += pts.length;
  const simp = simplify(pts, TOL_DEG).map(([y, x]) => [r4(y), r4(x)]);
  vertsOut += simp.length;
  lines.push({ kv, p: simp.flat() });
}

/**
 * Voltage for the substations OSM never tagged.
 *
 * Fewer than half of Nepal's substations carry a `voltage` tag, and voltage is
 * the whole point of the layer: a 33 kV yard is not a connection for a 100 MW
 * plant, and the app cannot say so if it does not know. But a substation is
 * defined by the lines that terminate in it, and those ARE tagged — so where a
 * 132 kV line ends inside the fence, the yard is a 132 kV yard.
 *
 * That is inference, not a tag, and it is recorded as such: `i: 1` marks a
 * voltage the app worked out rather than read, and the panel says "inferred
 * from a connecting line" so nobody mistakes it for surveyed fact. Measured on
 * the current extract it recovers 29 of the 122 untagged yards.
 *
 * The endpoint test uses a padded bounding box rather than the true polygon.
 * The pad is ~400 m, larger than most switchyards, because OSM line ends stop
 * at the fence, at the gantry, or a little short of both, and a strict
 * point-in-polygon test would miss the majority for no gain in truth.
 */
const ENDPOINT_PAD_DEG = 0.004;

function inferKv(sub, tagged) {
  const g = sub.geometry ?? (Number.isFinite(sub.lat) ? [{ lat: sub.lat, lon: sub.lon }] : []);
  if (!g.length) return 0;
  let lat0 = 99;
  let lat1 = -99;
  let lon0 = 999;
  let lon1 = -999;
  for (const p of g) {
    if (!p) continue;
    lat0 = Math.min(lat0, p.lat);
    lat1 = Math.max(lat1, p.lat);
    lon0 = Math.min(lon0, p.lon);
    lon1 = Math.max(lon1, p.lon);
  }
  let best = 0;
  for (const l of tagged) {
    for (const p of l.ends) {
      if (
        p.lat >= lat0 - ENDPOINT_PAD_DEG &&
        p.lat <= lat1 + ENDPOINT_PAD_DEG &&
        p.lon >= lon0 - ENDPOINT_PAD_DEG &&
        p.lon <= lon1 + ENDPOINT_PAD_DEG
      ) {
        if (l.kv > best) best = l.kv;
      }
    }
  }
  return best;
}

/** Line endpoints with a known voltage — the evidence the inference reads. */
const taggedEnds = [];
for (const e of lineEls) {
  const kv = kvOf(e.tags);
  const g = e.geometry;
  if (!(kv > 0) || !g?.length) continue;
  taggedEnds.push({ kv, ends: [g[0], g[g.length - 1]].filter(Boolean) });
}

const subs = [];
let inferredCount = 0;
for (const e of subEls) {
  const lat = e.lat ?? e.center?.lat ?? avg(e.geometry, 'lat');
  const lon = e.lon ?? e.center?.lon ?? avg(e.geometry, 'lon');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  let kv = kvOf(e.tags);
  let inferred = 0;
  if (!(kv > 0)) {
    kv = inferKv(e, taggedEnds);
    if (kv > 0) {
      inferred = 1;
      inferredCount++;
    }
  }
  if (kv > 0 && kv < MIN_KV) continue;
  subs.push({
    n: (e.tags?.name ?? e.tags?.['name:en'] ?? '').trim() || null,
    kv,
    // OSM's own classification, where present: a transmission yard is a
    // candidate connection point, a distribution yard almost never is.
    k: e.tags?.substation ?? null,
    ...(inferred ? { i: 1 } : {}),
    y: r4(lat),
    x: r4(lon),
  });
}

function avg(geom, key) {
  if (!geom?.length) return NaN;
  let s = 0;
  let n = 0;
  for (const p of geom) {
    if (!p) continue;
    s += p[key];
    n++;
  }
  return n ? s / n : NaN;
}

const out = {
  _source: 'OpenStreetMap via Overpass, © OpenStreetMap contributors, ODbL 1.0',
  _retrieved: new Date().toISOString().slice(0, 10),
  _note: 'Derived database. Redistribution of this file is governed by ODbL, not the MIT licence on the code.',
  lines,
  subs,
};
const json = JSON.stringify(out);
writeFileSync(OUT, json);

const byKv = new Map();
for (const l of lines) byKv.set(l.kv, (byKv.get(l.kv) ?? 0) + 1);
console.log(`\nwrote ${OUT}: ${(json.length / 1024).toFixed(1)} KB`);
console.log(`  lines:       ${lines.length}  (${vertsIn} vertices simplified to ${vertsOut})`);
console.log(`  by kV:       ${[...byKv].sort((a, b) => b[0] - a[0]).map(([k, n]) => `${k || '?'}kV:${n}`).join('  ')}`);
console.log(`  substations: ${subs.length}, ${subs.filter((s) => s.n).length} named, ${subs.filter((s) => s.kv > 0).length} with voltage (${inferredCount} inferred from a connecting line)`);
console.log(`  transmission yards: ${subs.filter((s) => s.k === "transmission").length}`);
