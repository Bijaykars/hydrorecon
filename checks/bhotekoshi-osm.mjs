/**
 * Why does traced geometry break Upper Bhote Koshi?
 *
 *   node --experimental-strip-types --no-warnings checks/bhotekoshi-osm.mjs
 *
 * Snapping the modelled river onto OpenStreetMap's traced centreline improves 8
 * of 9 built plants and destroys one: Upper Bhote Koshi's gross head goes from
 * 148 m to 344 m against a published 145 m. That single regression is the only
 * reason traced geometry is still not wired in, and it has never been diagnosed
 * — only worked around by tuning constants, which did not help.
 *
 * So stop tuning and look. This walks the same path the app walks, snaps it, and
 * reports for every point WHICH traced line it landed on and how far it moved.
 * A head error of +196 m over a 2 km reach is not a subtle sampling artifact; it
 * is the two ends of the line sitting on different watercourses at different
 * altitudes, and if that is what is happening it will be visible as a line
 * index changing partway down.
 *
 * IT WAS. Six switches in six kilometres, off the Bhote Koshi and onto traced
 * streams of four, five and nineteen vertices — side gullies dropping down the
 * valley wall, each briefly the nearest thing. That is the whole explanation.
 *
 * This script keeps its OWN COPY of the original point-by-point matching on
 * purpose, so the failure stays reproducible after src/osm-rivers.ts was fixed
 * to stop demoting a river to a stream. Its output is the BEFORE picture; do
 * not read it as current behaviour.
 */
import { readFileSync } from 'node:fs';

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

const { downstreamPath } = await import('../src/rivers.ts');
const { haversineKm } = await import('../src/engine/hydro.ts');

const INTAKE = [27.9388, 85.945];
const WALK_KM = 6;

const bundle = JSON.parse(readFileSync('public/nepal-osm-rivers.json', 'utf8'));
const CELL = 0.02;
const key = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
const grid = new Map();
bundle.lines.forEach((line, index) => {
  const seen = new Set();
  for (let i = 0; i + 1 < line.p.length; i += 2) {
    const k = key(line.p[i], line.p[i + 1]);
    if (seen.has(k)) continue;
    seen.add(k);
    (grid.get(k) ?? grid.set(k, []).get(k)).push(index);
  }
});

function nearestOnSegment(lat, lon, aLat, aLon, bLat, bLon) {
  const cos = Math.cos((lat * Math.PI) / 180) || 1;
  const px = (lon - aLon) * cos;
  const py = lat - aLat;
  const dx = (bLon - aLon) * cos;
  const dy = bLat - aLat;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cLat = aLat + t * dy;
  const cLon = aLon + (t * dx) / cos;
  return { lat: cLat, lon: cLon, km: haversineKm([lat, lon], [cLat, cLon]) };
}

const MAX_PULL_KM = 0.5;
const SWITCH_MARGIN_KM = 0.25;

const path = await downstreamPath(INTAKE[0], INTAKE[1], WALK_KM);
console.log(`\nUpper Bhote Koshi: ${path.length} points over ${path[path.length - 1].km.toFixed(2)} km\n`);
console.log('  i   modelled lat,lon        moved   line  river?  vertices  note');
console.log('-'.repeat(88));

let currentLine = -1;
let switches = 0;
const used = new Map();
for (let idx = 0; idx < path.length; idx++) {
  const point = path[idx];
  let best = null;
  let onCurrent = null;
  const seen = new Set();
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      const bucket = grid.get(key(point.lat + dLat * CELL, point.lon + dLon * CELL));
      if (!bucket) continue;
      for (const index of bucket) {
        if (seen.has(index)) continue;
        seen.add(index);
        const p = bundle.lines[index].p;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const hit = nearestOnSegment(point.lat, point.lon, p[i], p[i + 1], p[i + 2], p[i + 3]);
          const withLine = { ...hit, line: index };
          if (hit.km < (best?.km ?? Infinity)) best = withLine;
          if (index === currentLine && hit.km < (onCurrent?.km ?? Infinity)) onCurrent = withLine;
        }
      }
    }
  }
  const chosen =
    onCurrent && onCurrent.km <= (best?.km ?? Infinity) + SWITCH_MARGIN_KM ? onCurrent : best;
  let note = '';
  if (chosen && chosen.km <= MAX_PULL_KM) {
    if (currentLine !== -1 && chosen.line !== currentLine) {
      switches++;
      note = `SWITCHED from line ${currentLine}`;
    }
    currentLine = chosen.line;
    used.set(chosen.line, (used.get(chosen.line) ?? 0) + 1);
  } else {
    note = chosen ? `no pull (nearest ${chosen.km.toFixed(2)} km)` : 'nothing within reach';
  }
  const l = chosen ? bundle.lines[chosen.line] : null;
  console.log(
    `${String(idx).padStart(3)}  ${point.lat.toFixed(5)},${point.lon.toFixed(5)}  ` +
      `${chosen ? (chosen.km * 1000).toFixed(0).padStart(5) : '    -'} m  ` +
      `${chosen ? String(chosen.line).padStart(5) : '    -'}  ` +
      `${l ? (l.r === 1 ? 'river' : 'strm ') : '  -  '}  ` +
      `${l ? String(l.p.length / 2).padStart(6) : '     -'}  ${note}`
  );
}

console.log(`\n${switches} watercourse switches along the path`);
console.log('lines used, by point count:');
for (const [line, n] of [...used.entries()].sort((a, b) => b[1] - a[1])) {
  const l = bundle.lines[line];
  console.log(`  line ${String(line).padStart(6)}  ${String(n).padStart(3)} points  ${l.r === 1 ? 'river' : 'stream'}  ${l.p.length / 2} vertices`);
}
