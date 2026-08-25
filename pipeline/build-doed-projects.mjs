/**
 * Build the official Nepal DoED hydropower-project register.
 *
 *   npm run build:doed
 *
 * Nine separate public tables cover survey/construction licences,
 * applications and operating plants above and below 1 MW. The bundle is used
 * instead of a runtime request so conflict screening works offline and every
 * result carries an auditable source/update date.
 *
 * DoED publishes contact addresses and phone numbers beside the public facts.
 * They are not needed for spatial screening. The script keeps a cleaned
 * promoter name but deliberately never stores the address column, email or
 * phone numbers.
 */
import { writeFileSync } from 'node:fs';

const BASE = 'https://doed.gov.np/pages';
const OUT = 'src/data/doed-projects.json';
const UA = 'HydroRecon/0.2 (open-source hydropower screening; github.com/Bijaykars)';

const PAGES = [
  ['hydromorethan1', 'Survey licence', 'licence', 200],
  ['hydrolessthan1', 'Survey licence', 'licence', 10],
  ['clhydromorethan1', 'Construction licence', 'licence', 200],
  ['clhydrolessthan1', 'Construction licence', 'licence', 15],
  ['powerplantsmorethan1', 'Operating', 'operation', 150],
  ['powerplantslessthan1', 'Operating', 'operation', 10],
  ['appslhydromorethan1', 'Survey application', 'application', 250],
  ['appslhydrolessthan1', 'Survey application', 'application', 50],
  ['appclhydro', 'Construction application', 'application', 30],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHtml(url) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(90_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      last = e;
      if (attempt < 4) await sleep(attempt * 3_000);
    }
  }
  throw new Error(`${url}: ${last?.message ?? last}`);
}

function decode(s) {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(html) {
  const rows = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      decode(m[1])
    );
    if (/^\d+$/.test(cells[0] ?? '')) rows.push(cells);
  }
  return rows;
}

function dms(s) {
  const nums = [...String(s ?? '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (nums.length < 3) return null;
  const v = nums[0] + nums[1] / 60 + nums[2] / 3600;
  return v > 0 ? v : null;
}

const round = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);
const mid = (a, b) => (a !== null && b !== null ? (a + b) / 2 : (a ?? b));

/** Retain the organisation/person name, not the contact block sometimes pasted after it. */
function promoterName(raw) {
  const clean = raw
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '')
    .replace(/(?<!\d)(?:\+?977[- ]?)?(?:9[678]\d{8}|0?1[- ]?\d{7})(?!\d)/g, '')
    .replace(/\b(?:phone|ph|tel|contact|fax)\s*(?:no\.?\s*)?:?.*$/i, '')
    .trim();
  const entity = clean.match(
    /^.*?(?:p(?:vt|vy)\.?\s*(?:ltd|limited)\.?|private\s+limited|public\s+limited|company\s+limited|co\.?\s*ltd\.?|limited|authority|corporation|committee|cooperative(?:\s+limited)?|municipality|gaupalika)/i
  );
  return (entity?.[0] ?? clean.split(',')[0]).replace(/[\s,;.-]+$/, '').trim();
}

const projects = [];
const pages = [];

for (const [slug, stage, kind, minimum] of PAGES) {
  const url = `${BASE}/${slug}/`;
  console.log(`fetching ${url}`);
  const html = await fetchHtml(url);
  const updated = decode(html.match(/Updated\s+on\s*-\s*([^<]+)/i)?.[1] ?? 'unknown');
  const rows = tableRows(html);
  if (rows.length < minimum) {
    throw new Error(`${slug}: only ${rows.length} rows (expected at least ${minimum})`);
  }
  for (let i = 0; i < rows.length; i++) {
    if (Number(rows[i][0]) !== i + 1) {
      throw new Error(`${slug}: serial gap at row ${i + 1}; refusing an incomplete table`);
    }
  }

  let usableCoordinates = 0;
  for (const f of rows) {
    const application = kind === 'application';
    const operation = kind === 'operation';
    const lat1 = dms(f[application ? 8 : 9]);
    const lat2 = dms(f[application ? 9 : 10]);
    const lon1 = dms(f[application ? 10 : 11]);
    const lon2 = dms(f[application ? 11 : 12]);
    const lat = mid(lat1, lat2);
    const lon = mid(lon1, lon2);
    const ok = lat !== null && lon !== null && lat > 26 && lat < 31 && lon > 80 && lon < 89;
    if (ok) usableCoordinates++;
    const capacity = Number.parseFloat(f[2]);
    projects.push({
      name: f[1],
      river: f[3],
      district: f[application ? 12 : 13] ?? '',
      capacityMW: Number.isFinite(capacity) ? capacity : null,
      promoter: promoterName(f[application ? 6 : 7] ?? ''),
      stage,
      licenceNo: f[4] ?? '',
      issued: f[5] ?? '',
      validUntil: application ? null : (f[6] ?? null),
      commissioned: operation ? (f[14] ?? null) : null,
      lat: ok ? round(lat) : null,
      lon: ok ? round(lon) : null,
      bounds: ok
        ? [
            round(Math.min(lat1 ?? lat, lat2 ?? lat)),
            round(Math.min(lon1 ?? lon, lon2 ?? lon)),
            round(Math.max(lat1 ?? lat, lat2 ?? lat)),
            round(Math.max(lon1 ?? lon, lon2 ?? lon)),
          ]
        : null,
      source: url,
    });
  }
  pages.push({ url, stage, updated, records: rows.length, usableCoordinates });
  console.log(`  ${rows.length} records, ${usableCoordinates} geolocated; updated ${updated}`);
}

const out = {
  _source: 'Department of Electricity Development, Government of Nepal — official public hydropower registers',
  _retrieved: new Date().toISOString().slice(0, 10),
  _updated: [...new Set(pages.map((p) => p.updated))].join('; '),
  _note:
    'For screening only. DoED publishes coordinate ranges; lat/lon are their midpoints and bounds retain the published range. Verify legal status and coordinates against the live register before investment or design.',
  _privacy: 'Promoter contact addresses, phone numbers and email addresses are deliberately omitted.',
  pages,
  projects,
};
const json = JSON.stringify(out);
const contact = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?<!\d)(?:9[678]\d{8}|0?1[- ]?\d{7})(?!\d)/i.exec(json);
if (contact) throw new Error(`contact detail leaked into bundle: ${contact[0]}`);
writeFileSync(OUT, json);
console.log(`wrote ${OUT}: ${projects.length} records, ${(json.length / 1024).toFixed(1)} KB`);
