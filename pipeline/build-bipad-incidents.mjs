/**
 * Build the Nepal BIPAD historical-incident screen.
 *
 *   npm run build:hazards
 *
 * BIPAD is the Government of Nepal's integrated disaster-information portal.
 * The public incident API carries locations, dates, approval/verification state
 * and much more. HydroRecon deliberately keeps only the minimum needed to answer an
 * engineering screening question: what kinds of approved, verified incidents
 * have been recorded near this proposed layout, and when?
 *
 * This is NOT a hazard-frequency or probability model. Reporting density,
 * duplicated administrative locations, changing coverage, geocoding precision,
 * missing upstream connectivity and the short observation period all prevent
 * that interpretation.
 *
 * Privacy: the API also exposes descriptions, street addresses, creator IDs and
 * detailed loss records. None is read into the output. The allow-list below is
 * intentionally limited to incident ID, category, date and point geometry.
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'src/data/nepal-hazards.json';
const TMP = `${OUT}.tmp`;
const OFFICIAL = 'https://bipadportal.gov.np';
// Production first. The second host is BIPAD's own staging mirror and has the
// same public Django REST schema; it is useful when the production origin is
// temporarily unreachable, as it was from the build network on 2026-08-13.
const ENDPOINTS = [OFFICIAL, 'https://dev.bipadportal.gov.np'];
const UA = 'HydroRecon/0.2 (open-source hydropower screening; github.com/Bijaykars)';
const CUTOFF = '2011-01-01';
const PAGE = 1000;

const WANTED = [
  { id: 17, slug: 'landslide', title: 'Landslide' },
  { id: 11, slug: 'flood', title: 'Flood' },
  { id: 8, slug: 'earthquake', title: 'Earthquake' },
  { id: 26, slug: 'glof', title: 'Glacial lake outburst' },
  { id: 3, slug: 'avalanche', title: 'Avalanche' },
  { id: 28, slug: 'inundation', title: 'Inundation' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url, attempts = 3) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!body || typeof body !== 'object') throw new Error('non-object JSON body');
      return body;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await sleep(attempt * 1500);
    }
  }
  throw new Error(`${new URL(url).host}: ${last}`);
}

async function chooseEndpoint() {
  const failures = [];
  for (const base of ENDPOINTS) {
    try {
      const hazards = await json(`${base}/api/v1/hazard/?limit=100`, 2);
      const rows = Array.isArray(hazards.results) ? hazards.results : [];
      for (const wanted of WANTED) {
        const hit = rows.find((row) => row.id === wanted.id);
        if (!hit || hit.titleEn !== wanted.title) {
          throw new Error(
            `hazard ${wanted.id} expected "${wanted.title}", got ${JSON.stringify(hit?.titleEn)}`
          );
        }
      }
      return base;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${new URL(base).host}: ${message}`);
      console.warn(`  ${failures.at(-1)}`);
    }
  }
  throw new Error(`No BIPAD endpoint passed schema validation:\n${failures.join('\n')}`);
}

const day = (value) => {
  const out = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(out) && Number.isFinite(Date.parse(`${out}T00:00:00Z`))
    ? out
    : null;
};
const r5 = (value) => Math.round(value * 1e5) / 1e5;

async function fetchCategory(base, meta) {
  const all = [];
  let offset = 0;
  let previousDate = '9999-12-31';
  let rejectedUnverified = 0;
  let rejectedGeometry = 0;
  let rejectedDate = 0;

  while (offset <= 100_000) {
    const url = new URL('/api/v1/incident/', base);
    url.searchParams.set('hazard', String(meta.id));
    // Do not trust the API's `count`: it currently reports the signed int64
    // maximum. Stable date ordering lets us validate pages and stop cleanly.
    url.searchParams.set('ordering', '-incident_on');
    url.searchParams.set('limit', String(PAGE));
    url.searchParams.set('offset', String(offset));
    const body = await json(url.toString());
    const rows = Array.isArray(body.results) ? body.results : null;
    if (!rows) throw new Error(`${meta.title}: results is not an array at offset ${offset}`);
    if (rows.length === 0) break;

    for (const row of rows) {
      // Explicit allow-list. Do not spread or retain the upstream record.
      const incidentDate = day(row.incidentOn);
      if (!incidentDate) {
        rejectedDate++;
        continue;
      }
      if (incidentDate > previousDate) {
        throw new Error(`${meta.title}: ordering changed near ${incidentDate}/${previousDate}`);
      }
      previousDate = incidentDate;
      if (incidentDate < CUTOFF) continue;
      if (row.approved !== true || row.verified !== true) {
        rejectedUnverified++;
        continue;
      }
      const coordinates = row.point?.type === 'Point' ? row.point.coordinates : null;
      const lon = Number(coordinates?.[0]);
      const lat = Number(coordinates?.[1]);
      // A broad Nepal extent is a corruption check, not a jurisdiction test.
      // Exact country mode in the app uses the bundled Natural Earth polygon.
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < 26 ||
        lat > 31 ||
        lon < 80 ||
        lon > 89
      ) {
        rejectedGeometry++;
        continue;
      }
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= 0 || Number(row.hazard) !== meta.id) {
        throw new Error(`${meta.title}: invalid incident identity at offset ${offset}`);
      }
      all.push([id, incidentDate, r5(lat), r5(lon)]);
    }

    offset += rows.length;
    if (rows.length < PAGE) break;
  }
  if (offset > 100_000) throw new Error(`${meta.title}: pagination safety limit exceeded`);

  const ids = new Set(all.map((record) => record[0]));
  if (ids.size !== all.length) throw new Error(`${meta.title}: duplicate incident IDs`);

  return {
    ...meta,
    records: all,
    rejected: { unverified: rejectedUnverified, geometry: rejectedGeometry, date: rejectedDate },
  };
}

console.log('selecting a Government of Nepal BIPAD endpoint...');
const base = await chooseEndpoint();
console.log(`  using ${base}`);

const categories = [];
for (const meta of WANTED) {
  const category = await fetchCategory(base, meta);
  categories.push(category);
  console.log(
    `  ${meta.title.padEnd(24)} ${String(category.records.length).padStart(5)} approved + verified records`
  );
}

const records = categories.flatMap((category) => category.records);
if (records.length < 5000) {
  throw new Error(`BIPAD bundle has only ${records.length} records; expected at least 5,000`);
}
const globalIds = new Set(records.map((record) => record[0]));
if (globalIds.size !== records.length) throw new Error('incident IDs repeat across hazard categories');

const dates = records.map((record) => record[1]).sort();
const retrieved = new Date().toISOString().slice(0, 10);
const bundle = {
  _source: `${OFFICIAL}/api/v1/incident/`,
  _fetchedFrom: `${base}/api/v1/incident/`,
  _retrieved: retrieved,
  _period: { from: dates[0], to: dates.at(-1) },
  _crs: 'EPSG:4326 (longitude/latitude upstream; stored as latitude/longitude tuples)',
  _terms:
    'BIPAD publishes this government data through a public API, but no explicit dataset licence was found. Attribute BIPAD/NDRRMA and verify reuse terms; the repository MIT licence does not cover this data file.',
  _note:
    'Approved and verified incident records only. Counts are reports, not independent events or probabilities. Locations may be administrative/geocoded points and may repeat. Descriptions, addresses, losses and user fields are excluded by allow-list.',
  categories,
};
const output = JSON.stringify(bundle);

// Atomic replacement: a timeout, schema change or validation failure leaves the
// previous known-good snapshot untouched.
try {
  writeFileSync(TMP, output);
  renameSync(TMP, OUT);
} finally {
  rmSync(TMP, { force: true });
}

console.log(`\nwrote ${OUT}: ${records.length} records, ${(output.length / 1024).toFixed(1)} KB`);
console.log(`  period ${bundle._period.from} to ${bundle._period.to}; retrieved ${retrieved}`);
console.log('  privacy allow-list: id, hazard, date and point only');
