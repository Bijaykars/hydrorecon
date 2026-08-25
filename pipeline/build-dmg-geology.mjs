/**
 * Build the official Nepal 1:50,000 geological-map availability index.
 *
 *   npm run build:geology
 *
 * Only factual catalog metadata, derived sheet footprints and links are kept.
 * DMG's low-resolution preview images are not copied: the official page says
 * they are for publication information, while usable maps are hard-copy
 * purchase products and digital versions are not available.
 */
import { createHash } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

const PAGE = 'https://dmgnepal.gov.np/en/resources/geological-maps-150000-4749';
const OUT = 'src/data/nepal-geology-maps.json';
const TMP = `${OUT}.tmp`;
const UA = 'HydroRecon/0.2 (open-source hydropower screening; github.com/Bijaykars)';

const clean = (html) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
const r6 = (value) => Math.round(value * 1e6) / 1e6;
const box = (west, south, east, north) => [r6(west), r6(south), r6(east), r6(north)];

/** Nepal Survey Department 1:50k grid: YYLL + row-major 01..16. */
function nepalSheet(code) {
  const match = code.match(/^(\d{2})(\d{2})[- ](\d{1,2})([A-D])?$/);
  if (!match) throw new Error(`unsupported Nepal sheet code: ${code}`);
  const baseSouth = Number(match[1]);
  const baseWest = Number(match[2]);
  const index = Number(match[3]);
  if (index < 1 || index > 16) throw new Error(`invalid Nepal sheet number: ${code}`);
  const row = Math.floor((index - 1) / 4);
  const col = (index - 1) % 4;
  let west = baseWest + col * 0.25;
  let north = baseSouth + 1 - row * 0.25;
  let east = west + 0.25;
  let south = north - 0.25;
  if (match[4]) {
    const quadrant = match[4];
    const eastHalf = quadrant === 'B' || quadrant === 'D';
    const southHalf = quadrant === 'C' || quadrant === 'D';
    if (eastHalf) west += 0.125;
    else east -= 0.125;
    if (southHalf) north -= 0.125;
    else south += 0.125;
  }
  return { code: `${match[1]}${match[2]} ${String(index).padStart(2, '0')}${match[4] ?? ''}`, bounds: box(west, south, east, north) };
}

/** Legacy Survey of India grid used by DMG's older map sheets. */
function legacySheet(code) {
  const match = code.match(/^(\d{2})\s*([A-P])\/(\d{1,2})$/i);
  if (!match) throw new Error(`unsupported legacy sheet code: ${code}`);
  const million = Number(match[1]);
  const bases = {
    62: [80, 28, 84, 32],
    63: [80, 24, 84, 28],
    71: [84, 28, 88, 32],
    72: [84, 24, 88, 28],
  };
  const base = bases[million];
  if (!base) throw new Error(`unverified legacy million-sheet ${million}`);
  const letter = match[2].toUpperCase().charCodeAt(0) - 65;
  const number = Number(match[3]);
  if (number < 1 || number > 16) throw new Error(`invalid legacy sheet number: ${code}`);
  // Survey of India specifies letters and numbers in vertical columns.
  const degreeCol = Math.floor(letter / 4);
  const degreeRow = letter % 4;
  const quarterCol = Math.floor((number - 1) / 4);
  const quarterRow = (number - 1) % 4;
  const west = base[0] + degreeCol + quarterCol * 0.25;
  const north = base[3] - degreeRow - quarterRow * 0.25;
  return {
    code: `${million} ${match[2].toUpperCase()}/${number}`,
    bounds: box(west, north - 0.25, west + 0.25, north),
  };
}

function coverageFromTitle(title) {
  const sheets = [];
  const seen = new Set();
  for (const match of title.matchAll(/(\d{4})[- ](\d{1,2})([A-D])?(?:\s+(Lower Half))?/gi)) {
    const code = `${match[1]} ${match[2]}${match[3]?.toUpperCase() ?? ''}`;
    let sheet = nepalSheet(code);
    if (match[4]) {
      const [west, south, east, north] = sheet.bounds;
      sheet = { ...sheet, code: `${sheet.code} lower half`, bounds: box(west, south, east, (south + north) / 2) };
    }
    const key = `${sheet.code}:${sheet.bounds.join(',')}`;
    if (!seen.has(key)) {
      seen.add(key);
      sheets.push(sheet);
    }
  }
  for (const match of title.matchAll(/(\d{2})\s*([A-P])\/(\d{1,2})/gi)) {
    const sheet = legacySheet(`${match[1]} ${match[2]}/${match[3]}`);
    const key = `${sheet.code}:${sheet.bounds.join(',')}`;
    if (!seen.has(key)) {
      seen.add(key);
      sheets.push(sheet);
    }
  }
  if (!sheets.length) throw new Error(`no sheet code parsed from: ${title}`);
  return sheets;
}

console.log('fetching official DMG 1:50,000 geological-map catalog...');
const response = await fetch(PAGE, {
  headers: { accept: 'text/html', 'user-agent': UA },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`DMG catalog failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const html = bytes.toString('utf8');
const pageText = clean(html);
if (!/actual usable quality maps can be purchased/i.test(pageText) || !/digital version cannot be purchased/i.test(pageText)) {
  throw new Error('DMG availability/distribution wording changed; review before rebuilding');
}

const rowPattern = /<tr>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>([\s\S]*?)<\/td>[\s\S]*?<td>(\d{4}-\d{2}-\d{2})<\/td>[\s\S]*?href="([^"]+)"[\s\S]*?<\/tr>/g;
const maps = [...html.matchAll(rowPattern)].map((match) => {
  const id = Number(match[1]);
  const title = clean(match[2]);
  const published = match[3];
  const previewUrl = match[4];
  const parsed = new URL(previewUrl);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'dmgnepal.gov.np') {
    throw new Error(`${id}: unexpected preview host ${parsed.hostname}`);
  }
  const sheets = coverageFromTitle(title);
  return { id, title, published, previewUrl, sheets };
});

if (maps.length !== 41) throw new Error(`expected 41 published catalog rows, got ${maps.length}`);
if (!maps.every((map, index) => map.id === index + 1)) throw new Error('DMG serial sequence changed');
if (new Set(maps.map((map) => map.previewUrl)).size !== maps.length) throw new Error('duplicate DMG preview URLs');
if (!maps.some((map) => map.title.includes('Gorkha and Lamjung') && map.published.startsWith('2022'))) {
  throw new Error('latest known Gorkha/Lamjung sheet missing');
}

const updated = pageText.match(/Last Updated Date\s*:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;
if (!updated) throw new Error('DMG page update date missing');
const bundle = {
  _source: 'Government of Nepal, Department of Mines and Geology (DMG)',
  _sourceUrl: PAGE,
  _sourceUpdated: updated,
  _retrieved: new Date().toISOString().slice(0, 10),
  _sha256: createHash('sha256').update(bytes).digest('hex'),
  _scale: '1:50,000',
  _crs: 'EPSG:4326',
  _coordinateOrder: '[west, south, east, north]',
  _rights: 'DMG page footer: All Rights Reserved. Catalog metadata and derived sheet footprints only; map images are not bundled.',
  _availability: 'DMG states previews are low-resolution publication information; usable-quality maps are hard-copy purchase products and digital versions cannot currently be purchased.',
  _geometryMethod: 'Sheet footprints derived from the published Nepal Survey Department and legacy Survey of India sheet-numbering systems; partial A-D/lower-half coverage is retained.',
  _note: 'Published map availability is not site geology, ground truth, a geotechnical model or permission to redistribute map imagery.',
  maps,
};

try {
  writeFileSync(TMP, `${JSON.stringify(bundle)}\n`);
  renameSync(TMP, OUT);
} catch (error) {
  rmSync(TMP, { force: true });
  throw error;
}

console.log(`wrote ${OUT}`);
console.log(`  ${maps.length} official 1:50,000 map publications; ${maps.reduce((sum, map) => sum + map.sheets.length, 0)} coverage parts`);
console.log(`  source updated ${updated}; retrieved ${bundle._retrieved}; sha256 ${bundle._sha256}`);
