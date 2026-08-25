/**
 * Instrumented earthquakes around Nepal, from the USGS catalog.
 *
 *   node pipeline/build-quakes.mjs
 *
 * WHY: the app's earthquake evidence was BIPAD damage reports — 336 records of
 * what buildings did, not what the ground did. The USGS ComCat catalog carries
 * every instrumented event back a century: magnitude, depth, epicentre. Around
 * a site, "how many M5+ within 50 km, and how big was the biggest" is the
 * screening question, and a damage report cannot answer it.
 *
 * WHAT THIS IS NOT: a hazard model. Epicentres are where past ruptures
 * nucleated, not where future shaking will be — the 2015 Gorkha epicentre was
 * 77 km from Kathmandu and Kathmandu still shook at IX. The PGA layer is the
 * design number; this layer is the observational record behind it.
 *
 * SOURCE: USGS FDSN event API, public domain (US government work).
 * M4+ because below that the pre-digital catalog is badly incomplete here, and
 * a complete-looking scatter of small events would imply precision that the
 * 20th-century seismic network never had.
 */
import { writeFileSync } from 'node:fs';

const BBOX = { minlatitude: 26, maxlatitude: 31, minlongitude: 79.5, maxlongitude: 88.5 };
const URL =
  'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=1900-01-01&minmagnitude=4&orderby=time-asc&' +
  Object.entries(BBOX).map(([k, v]) => `${k}=${v}`).join('&');

const OUT = 'src/data/nepal-quakes.json';

const r = await fetch(URL, { signal: AbortSignal.timeout(120_000) });
if (!r.ok) throw new Error(`USGS: HTTP ${r.status}`);
const j = await r.json();

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * One event per row: [magnitude, year, lat, lon, depthKm].
 * Month and day carry no screening signal; the year does (catalog era), and
 * dropping the rest halves the file.
 */
const quakes = (j.features ?? [])
  .filter((f) => Number.isFinite(f.properties?.mag) && Array.isArray(f.geometry?.coordinates))
  .map((f) => {
    const [lon, lat, depth] = f.geometry.coordinates;
    return [r2(f.properties.mag), new Date(f.properties.time).getUTCFullYear(), r3(lat), r3(lon), Math.round(depth ?? 0)];
  });

if (quakes.length < 500) throw new Error(`only ${quakes.length} events — query looks wrong`);

// Self-check: Gorkha 2015 M7.8 must be present, or the window is wrong.
const gorkha = quakes.find((q) => q[0] >= 7.7 && q[1] === 2015);
if (!gorkha) throw new Error('Gorkha 2015 M7.8 missing from the extract');

const out = {
  _source: 'USGS Earthquake Catalog (ComCat), FDSN event API. US government work, public domain.',
  _url: 'https://earthquake.usgs.gov/fdsnws/event/1/',
  _retrieved: new Date().toISOString().slice(0, 10),
  _window: 'M4.0+, 1900–present, 26–31N 79.5–88.5E',
  _format: '[magnitude, year, lat, lon, depthKm]',
  quakes,
};
const json = JSON.stringify(out);
writeFileSync(OUT, json);

const byMag = [4, 5, 6, 7].map((m) => `M${m}+:${quakes.filter((q) => q[0] >= m).length}`).join('  ');
console.log(`wrote ${OUT}: ${(json.length / 1024).toFixed(1)} KB, ${quakes.length} events`);
console.log(`  ${byMag}`);
console.log(`  ${quakes.filter((q) => q[1] >= 2000).length} since 2000, deepest ${Math.max(...quakes.map((q) => q[4]))} km`);
