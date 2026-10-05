/**
 * Nepal's measured daily discharge, from DHM's own published records.
 *
 *   node pipeline/build-dhm-records.mjs "<path to hydrological data folder>"
 *
 * WHY THIS IS THE MOST IMPORTANT DATA IN THE APP
 *
 * Flow is the dominant error in every estimate HydroRecon makes — about +/-50%,
 * against +/-1% from terrain on a high-head site. Both flow sources are
 * uncalibrated global models with nothing gauged at the site, and no amount of
 * better arithmetic fixes that. src/gauges.ts has said so since it was written
 * and could only name which station to request: DHM's observation API answers
 * 403 to everyone, including DHM's own portal.
 *
 * These are those records. Daily mean discharge, station by station, in the
 * published fixed-width yearbook format.
 *
 * WHAT IS WRITTEN
 *   src/data/dhm-records.json  — one row per station: position, years held,
 *     monthly mean regime, flow-duration quantiles, annual mean. Small enough
 *     to bundle, and enough to answer "what does this river actually do".
 *     GITIGNORED: those statistics are derived from a privately supplied,
 *     unlicensed source and may not be published (LICENSES.md, blocker 1).
 *   src/data/dhm-records.public.json  — the same rows with every discharge
 *     statistic removed. Tracked, published, and the only copy a fresh clone
 *     has. Written by pipeline/dhm-public-index.mjs.
 *   sources/dhm/<station>.json  — the full daily series, fetched only when a
 *     site is near that station.
 *
 * So running this is what a licence holder does to turn a published checkout
 * back into the full-accuracy tool.
 *
 * PROVENANCE: Department of Hydrology and Meteorology, Government of Nepal.
 * Supplied privately. The daily series land in sources/dhm/, which is gitignored
 * exactly like the topo sheets: derived statistics travel, the records do not.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FULL_INDEX, writePublicIndex } from './dhm-public-index.mjs';

const ROOT = process.argv[2];
if (!ROOT || !existsSync(ROOT)) {
  console.error('usage: node pipeline/build-dhm-records.mjs "<path to hydrological data>"');
  process.exit(1);
}
const OUT_INDEX = FULL_INDEX;
const OUT_DIR = 'sources/dhm';
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.txt$/i.test(entry)) files.push(path);
  }
})(ROOT);

/** "29 30 12" -> 29.5033. DHM prints degrees, minutes, seconds. */
const dms = (s) => {
  const m = s.trim().match(/^(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600 : null;
};

/**
 * Storage layout: a fixed 366-slot year so February always occupies the same
 * offsets. Slot 59 is 29 February and stays null in a common year.
 */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Days the CALENDAR actually has, which is not the storage layout. */
const daysInMonth = (month, year) =>
  month === 1 ? (isLeap(year) ? 29 : 28) : MONTH_DAYS[month];

/**
 * Which months contain this day of the month, in printing order.
 *
 * THE BUG THIS EXISTS TO KILL. The yearbook prints one row per day and one
 * column per month, so a day-31 row has blanks under February, April, June,
 * September and November. Splitting that row on whitespace COLLAPSES those
 * blanks, and assigning token k to month k then files July's reading under
 * March and December's under July.
 *
 * It was not theoretical. Across the 136 bundled stations it put a value in
 * 29 February for 2,058 of 2,096 non-leap station-years, emptied 31 August,
 * 31 October and 30/31 December in 100% of years, and left `Jul 31 / Jul 30`
 * at a median ratio of 0.106 — the signature of a December low flow sitting in
 * a monsoon slot.
 *
 * Mapping the tokens onto the months that actually HAVE that day is correct
 * whether the row arrived fixed-width or whitespace-collapsed, because the
 * calendar decides the column count rather than the whitespace.
 */
const monthsWithDay = (day, year) => {
  const out = [];
  for (let m = 0; m < 12; m++) if (day <= daysInMonth(m, year)) out.push(m);
  return out;
};

/** Offset of a month's first slot in the 366-day layout. */
const monthOffset = (month) => {
  let o = 0;
  for (let m = 0; m < month; m++) o += MONTH_DAYS[m];
  return o;
};

const stations = new Map();
let parsed = 0;
let skipped = 0;
let misshapenRows = 0;

for (const file of files) {
  const text = readFileSync(file, 'latin1');
  const idMatch = text.match(/Station number:\s*(\S+)/);
  const yearMatch = text.match(/Year:\s*(\d{4})/);
  if (!idMatch || !yearMatch) {
    skipped++;
    continue;
  }
  const id = idMatch[1];
  const year = Number(yearMatch[1]);
  if (!stations.has(id)) {
    const lat = text.match(/Latitude:\s*([\d\s.]+?)\s*$/m);
    const lon = text.match(/Longitude:\s*([\d\s.]+?)\s*$/m);
    const loc = text.match(/Location:\s*(.+?)\s{2,}/);
    const river = text.match(/River:\s*(.+?)\s{2,}/);
    stations.set(id, {
      id,
      location: loc?.[1]?.trim() ?? '',
      river: river?.[1]?.trim() ?? '',
      lat: lat ? dms(lat[1]) : null,
      lon: lon ? dms(lon[1]) : null,
      years: new Map(),
    });
  }
  const station = stations.get(id);

  /**
   * The yearbook prints one row per day of the month and one column per month,
   * so a row is [day, Jan..Dec] MINUS the months that have no such day. A gauge
   * that missed a reading still prints a non-numeric placeholder and keeps its
   * column; only a day the calendar does not have is blank.
   *
   * So the token count is decided by the calendar, and `monthsWithDay` is the
   * only correct way to line the tokens back up. A row whose width does not
   * match the calendar means the format changed — it is dropped and counted
   * rather than filed one month to the left in silence.
   */
  const days = station.years.get(year) ?? new Array(366).fill(null);
  for (const line of text.split(/\r?\n/)) {
    const row = line.trim().split(/\s+/);
    if (!/^\d{1,2}$/.test(row[0] ?? '')) continue;
    const day = Number(row[0]);
    if (day < 1 || day > 31) continue;
    const months = monthsWithDay(day, year);
    const tokens = row.slice(1);
    if (tokens.length !== months.length) {
      misshapenRows++;
      continue;
    }
    for (let k = 0; k < months.length; k++) {
      const token = tokens[k];
      if (!/^\d+(\.\d+)?$/.test(token)) continue;
      const value = Number(token);
      // A negative or absurd reading is a transcription artefact, not a flow.
      if (!Number.isFinite(value) || value < 0 || value > 100000) continue;
      days[monthOffset(months[k]) + day - 1] = value;
    }
  }
  station.years.set(year, days);
  parsed++;
}

/** Value below which `frac` of the record sits — the flow-duration curve. */
const quantile = (sorted, frac) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(frac * (sorted.length - 1))));
  return sorted[i];
};
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

const index = [];
let written = 0;
for (const station of stations.values()) {
  const years = [...station.years.keys()].sort((a, b) => a - b);
  const all = [];
  const monthSums = new Array(12).fill(0);
  const monthCounts = new Array(12).fill(0);
  const perYear = {};
  let completeYears = 0;
  for (const year of years) {
    const days = station.years.get(year);
    const present = days.filter((v) => v != null).length;
    if (present === 0) continue;
    // 350 of 365 leaves room for a few missing days without letting a
    // three-month record masquerade as a complete year.
    if (present >= 350) completeYears++;
    perYear[year] = days.map(r3);
    let offset = 0;
    for (let m = 0; m < 12; m++) {
      for (let d = 0; d < MONTH_DAYS[m]; d++) {
        const value = days[offset + d];
        if (value != null) {
          monthSums[m] += value;
          monthCounts[m]++;
          all.push(value);
        }
      }
      offset += MONTH_DAYS[m];
    }
  }
  if (all.length < 365) continue;
  all.sort((a, b) => a - b);
  const mean = all.reduce((s, v) => s + v, 0) / all.length;
  index.push({
    id: station.id,
    river: station.river,
    location: station.location,
    lat: station.lat == null ? null : Math.round(station.lat * 1e5) / 1e5,
    lon: station.lon == null ? null : Math.round(station.lon * 1e5) / 1e5,
    from: years[0],
    to: years[years.length - 1],
    years: years.length,
    completeYears,
    days: all.length,
    meanCms: r3(mean),
    /** What the river does through the year, measured rather than modelled. */
    monthly: monthSums.map((s, m) => (monthCounts[m] ? r3(s / monthCounts[m]) : null)),
    /**
     * Exceedance, not percentile: q40 is the flow equalled or exceeded on 40%
     * of days, which sits at the 60th percentile of the sorted record.
     */
    q: {
      q5: r3(quantile(all, 0.95)),
      q20: r3(quantile(all, 0.8)),
      q40: r3(quantile(all, 0.6)),
      q50: r3(quantile(all, 0.5)),
      q60: r3(quantile(all, 0.4)),
      q80: r3(quantile(all, 0.2)),
      q95: r3(quantile(all, 0.05)),
    },
    min: r3(all[0]),
    max: r3(all[all.length - 1]),
  });
  writeFileSync(
    `${OUT_DIR}/${station.id}.json`,
    JSON.stringify({
      id: station.id,
      river: station.river,
      location: station.location,
      years: perYear,
    })
  );
  written++;
}

index.sort((a, b) => Number(a.id) - Number(b.id));
const bundle = {
  _source:
    'Department of Hydrology and Meteorology, Government of Nepal — published daily discharge records.',
  _note:
    'Supplied privately. Daily series are written to sources/dhm/ and gitignored; this index carries derived statistics only.',
  _built: new Date().toISOString().slice(0, 10),
  _units: 'm3/s',
  stations: index,
};
writeFileSync(OUT_INDEX, JSON.stringify(bundle));
writePublicIndex(bundle);

console.log(`scanned ${files.length} files · parsed ${parsed} · ${skipped} had no station header`);
if (misshapenRows > 0) {
  // Loud, because the alternative is filing a month's readings one column left.
  console.log(
    `  WARNING: ${misshapenRows} day rows had a token count the calendar does not explain and were dropped.` +
      ' The yearbook format may have changed — check before trusting this build.'
  );
}
console.log(`wrote ${OUT_INDEX}: ${index.length} stations, ${(JSON.stringify(bundle).length / 1024).toFixed(0)} KB`);
console.log(`wrote ${written} daily series to ${OUT_DIR}/`);
console.log(
  `  station-years ${index.reduce((a, s) => a + s.years, 0)} · daily values ${index
    .reduce((a, s) => a + s.days, 0)
    .toLocaleString()}`
);
console.log(`  ${index.filter((s) => s.completeYears >= 10).length} stations hold 10+ complete years`);
