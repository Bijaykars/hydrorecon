/**
 * Rebuild src/data/dhm-records.json from the daily series in sources/dhm/.
 *
 *   node pipeline/build-dhm-index.mjs
 *
 * build-dhm-records.mjs writes both the dailies and this index in one pass from
 * the private yearbook folder. This does the index half alone, from the dailies
 * already on disk, so a repair to those dailies (repair-dhm-shift.mjs) can be
 * carried into the derived statistics without needing the private source.
 *
 * Station identity — position, river, location — is not derivable from the
 * dailies, so it is carried over from the existing index rather than invented.
 * Everything below it is recomputed.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = 'sources/dhm';
const OUT = 'src/data/dhm-records.json';

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const calendarDays = (m, y) => (m === 1 ? (isLeap(y) ? 29 : 28) : MONTH_DAYS[m]);

const quantile = (sorted, frac) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(frac * (sorted.length - 1))));
  return sorted[i];
};
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

const prior = JSON.parse(readFileSync(OUT, 'utf8'));
const identity = new Map(prior.stations.map((s) => [String(s.id), s]));

const index = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const station = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'));
  const known = identity.get(String(station.id)) ?? {};

  const years = Object.keys(station.years)
    .map(Number)
    .sort((a, b) => a - b);
  const all = [];
  const monthSums = new Array(12).fill(0);
  const monthCounts = new Array(12).fill(0);
  let completeYears = 0;

  for (const year of years) {
    const days = station.years[year];
    if (!Array.isArray(days)) continue;
    let present = 0;
    let offset = 0;
    for (let m = 0; m < 12; m++) {
      // Bounded by the CALENDAR, not the 366-slot layout, so a leap-day slot in
      // a common year can never enter a monthly mean.
      for (let d = 0; d < calendarDays(m, year); d++) {
        const value = days[offset + d];
        if (value != null && Number.isFinite(value)) {
          monthSums[m] += value;
          monthCounts[m]++;
          all.push(value);
          present++;
        }
      }
      offset += MONTH_DAYS[m];
    }
    if (present === 0) continue;
    // 350 of 365 leaves room for a few missing days without letting a
    // three-month record masquerade as a complete year.
    if (present >= 350) completeYears++;
  }

  if (all.length < 365) continue;
  all.sort((a, b) => a - b);
  const mean = all.reduce((s, v) => s + v, 0) / all.length;

  index.push({
    id: station.id,
    river: station.river ?? known.river ?? '',
    location: station.location ?? known.location ?? '',
    lat: known.lat ?? null,
    lon: known.lon ?? null,
    from: years[0],
    to: years[years.length - 1],
    years: years.length,
    completeYears,
    days: all.length,
    meanCms: r3(mean),
    monthly: monthSums.map((s, m) => (monthCounts[m] ? r3(s / monthCounts[m]) : null)),
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
}

index.sort((a, b) => Number(a.id) - Number(b.id));
const bundle = { ...prior, _built: new Date().toISOString().slice(0, 10), stations: index };
writeFileSync(OUT, JSON.stringify(bundle));

const missing = index.filter((s) => s.lat == null).length;
console.log(`wrote ${OUT}: ${index.length} stations (was ${prior.stations.length})`);
console.log(
  `  station-years ${index.reduce((a, s) => a + s.years, 0)} · daily values ${index
    .reduce((a, s) => a + s.days, 0)
    .toLocaleString()}`
);
console.log(`  ${index.filter((s) => s.completeYears >= 10).length} stations hold 10+ complete years`);
if (missing) console.log(`  WARNING: ${missing} stations have no position carried over`);
