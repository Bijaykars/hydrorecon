/**
 * Is the national geology vector blank because Nepal is unmapped, or because
 * the digitisation stopped?
 *
 *   node --experimental-strip-types --no-warnings checks/geology-vs-dmg-sheets.mjs
 *
 * WHY THIS EXISTS. `src/geology-units.ts` reports that ~30% of its extent
 * carries no polygon, concentrated in the high north. The first version of that
 * module told the reader Nepal's geological map was blank there — that a
 * high-head site sat on ground nobody had mapped. That is false, and it is the
 * dangerous direction: it says "no information exists" when the correct advice
 * is "buy the sheet".
 *
 * Two independent things say so. Externally, the printed Amatya & Jnawali
 * (1994) 1:1,000,000 map is the standard national map and covers the whole
 * country including the Tibetan-Tethys and Higher Himalayan zones. Locally —
 * which is what this harness measures — the app ALREADY bundles the Department
 * of Mines and Geology's province sheets at 1:350,000 as raster tiles. If DMG
 * printed a sheet over ground the 1:1M vector calls No Data, the vector's blank
 * cannot mean the ground is unmapped.
 *
 * THE COMPARISON IS NOT BETWEEN EQUALS and that is the point. The province
 * sheets are a finer, later publication; the vector is a coarser, earlier one
 * that somebody digitised in part. Any tile where the sheet exists and the
 * vector is blank is one place a reader would have been told nothing is known.
 *
 * WHAT IT CANNOT SAY. A tile centre is one point, so this counts tiles rather
 * than area, and it says nothing about whether the two sources AGREE on the
 * unit where both have one — that is a different and harder question needing
 * the sheets to be read rather than located. It answers only: does published
 * DMG mapping exist where this vector is silent?
 */
import { readFileSync } from 'node:fs';

const SHEETS = 'sources/geology/index.json';
const VECTOR = 'src/data/nepal-geology-units.json';

let tiles;
try {
  tiles = JSON.parse(readFileSync(SHEETS, 'utf8')).tiles;
} catch {
  console.error(`missing ${SHEETS} — run: npm run build:geology`);
  process.exit(1);
}
const bundle = JSON.parse(readFileSync(VECTOR, 'utf8'));
const polys = bundle.polygons;

const NO_DATA = (name) => name === 'No Data' || !name;

/** Even-odd ray cast over the flat [lat, lon, …] rings, as the module does. */
const inside = (lat, lon, rings) => {
  let hit = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i];
      const xi = r[i + 1];
      const yj = r[j];
      const xj = r[j + 1];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
};

const unitAt = (lat, lon) => {
  let blank = null;
  for (const p of polys) {
    if (lat < p.b[0] || lat > p.b[2] || lon < p.b[1] || lon > p.b[3]) continue;
    if (!inside(lat, lon, p.r)) continue;
    if (NO_DATA(p.n)) blank = p.n || '(blank)';
    else return p.n;
  }
  return blank;
};

let named = 0;
let missing = 0;
let offVector = 0;
const byProvince = new Map();

for (const t of tiles) {
  // t.b is [south, west, north, east]; take the tile centre.
  const lat = (t.b[0] + t.b[2]) / 2;
  const lon = (t.b[1] + t.b[3]) / 2;
  const u = unitAt(lat, lon);
  if (u === null) {
    offVector++;
    continue;
  }
  if (NO_DATA(u) || u === '(blank)') {
    missing++;
    const e = byProvince.get(t.p) ?? { missing: 0, total: 0 };
    e.missing++;
    byProvince.set(t.p, e);
  } else {
    named++;
  }
  const e = byProvince.get(t.p) ?? { missing: 0, total: 0 };
  e.total++;
  byProvince.set(t.p, e);
}

const total = tiles.length;
const pc = (v) => `${((100 * v) / total).toFixed(1)}%`;

console.log(`DMG province sheets at ${JSON.parse(readFileSync(SHEETS, 'utf8'))._scale}, tile centres`);
console.log(`tested against the ${bundle._scale} vector (${bundle._source})\n`);
console.log(`  tiles                                 ${total}`);
console.log(`  vector names a unit                   ${named}  (${pc(named)})`);
console.log(`  vector carries NO POLYGON             ${missing}  (${pc(missing)})   <-- the finding`);
console.log(`  tile centre outside the vector        ${offVector}  (${pc(offVector)})`);
console.log(`     (province sheets overhang the national border; not a gap)\n`);

console.log('  by province:');
for (const [prov, e] of [...byProvince.entries()].sort((a, b) => b[1].missing - a[1].missing)) {
  const bar = '#'.repeat(Math.round((20 * e.missing) / Math.max(1, e.total)));
  console.log(
    `    ${prov.padEnd(14)} ${String(e.missing).padStart(3)}/${String(e.total).padEnd(3)} blank in vector  ${bar}`
  );
}

console.log();
if (missing > 0) {
  console.log(
    `  VERDICT: DMG printed mapping over ${missing} tile(s) the 1:1,000,000 vector leaves blank.\n` +
      `  The vector's "No Data" is therefore a gap in the DIGITISATION, not in Nepal's geology.\n` +
      `  The report and panel must send the reader to the published sheet, never report an\n` +
      `  absence of knowledge. This is what src/geology-units.ts got wrong on its first pass.`
  );
} else {
  console.log(
    '  VERDICT: no province-sheet tile falls on vector No Data. That does NOT prove the\n' +
      '  ground is unmapped — the province sheets do not cover the whole country either.'
  );
}
