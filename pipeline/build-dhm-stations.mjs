/**
 * Build the bundled Nepal DHM station inventory.
 *
 *   node scripts/build-dhm-stations.mjs
 *
 * Why this is a build step and not a runtime fetch: hydrology.gov.np/gss/api/station
 * sends `access-control-allow-origin: *` but returns **45 MB uncompressed in ~40 s**,
 * and ignores every pagination parameter tried (limit, page, per_page, fields).
 * Most of that weight is a per-station `meta_data` array we do not need.
 *
 * Station VALUES are not available: /gss/api/observation returns
 * 403 {"message":"Permission denied or Api Keys required"}. So this gives locations
 * only — enough to tell a user which real gauge to go and ask DHM for.
 */
import { writeFileSync } from 'node:fs';

const SRC = 'https://hydrology.gov.np/gss/api/station';
const OUT = 'src/dhm-stations.json';

console.log(`fetching ${SRC} (~45 MB, expect ~40 s)…`);
const t0 = Date.now();
const res = await fetch(SRC);
if (!res.ok) throw new Error(`DHM: HTTP ${res.status}`);
const raw = await res.json();
console.log(`  got ${Array.isArray(raw) ? raw.length : '?'} records in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const tagText = (s) => (s.tags ?? []).map((t) => t.name).join(' ');

const stations = raw
  .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
  // Keep the ones inside Nepal's bounding box; the feed carries a few strays.
  .filter((s) => s.latitude > 26 && s.latitude < 31 && s.longitude > 80 && s.longitude < 89)
  .map((s) => {
    const name = (s.name ?? '').trim(); // the feed has leading spaces on some names
    // Classify by NAME, not by tag. The tag vocabulary is a mix of station types
    // (HS/AWS/RF), funders (UNDP, Mercy Corps), basins (Koshi) and junk ("Test",
    // "Warranty"), and only one tag survives — too unreliable to publish.
    // Nepali river gauges are named "<X> River at <Y>" or "<X> Khola at <Y>".
    const river = /\b(river|khola|nadi|kholsi)\b/i.test(name) && !/\(rainfall\)/i.test(name);
    return {
      n: name,
      y: Math.round(s.latitude * 1e4) / 1e4,
      x: Math.round(s.longitude * 1e4) / 1e4,
      e: Number.isFinite(s.elevation) ? Math.round(s.elevation) : null,
      r: river ? 1 : 0,
    };
  })
  .sort((a, b) => a.n.localeCompare(b.n));

writeFileSync(OUT, JSON.stringify(stations));
const kb = (JSON.stringify(stations).length / 1024).toFixed(1);
console.log(`wrote ${OUT}: ${stations.length} stations, ${kb} KB`);
console.log(`  sample: ${JSON.stringify(stations[0])}`);
console.log(`  river gauges (by name): ${stations.filter((s) => s.r).length}`);
console.log(`  tags seen on record 0: ${tagText(raw[0])}`);
