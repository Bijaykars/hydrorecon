/**
 * Un-shift the DHM daily records built by the old whitespace-splitting parser.
 *
 *   node pipeline/repair-dhm-shift.mjs [--write]
 *
 * WHY THIS EXISTS RATHER THAN JUST REBUILDING. The correct fix is to re-run
 * build-dhm-records.mjs against the privately supplied yearbook folder, which
 * recovers everything including the four values this script cannot. That folder
 * is not on every machine that has the repo, and until it is re-run every
 * measurement in the project is scored against misfiled ground truth. So this
 * repairs what is repairable in place, and says plainly what it cannot.
 *
 * THE DEFECT. The yearbook prints one row per day, one column per month, with
 * blanks under months that have no such day. The old parser split rows on
 * whitespace — which collapses those blanks — and then assigned token k to
 * month k. Every reading after the first blank was filed one month early.
 *
 * It is deterministic, so it is reversible. For a day-d row the printed columns
 * are exactly the months that HAVE day d, and the old parser wrote token k into
 * month k whenever d fitted its (wrongly 29-day-February) month length. Running
 * that map backwards recovers the original column for every surviving value.
 *
 * WHAT CANNOT BE RECOVERED. Four values per station-year were written into a
 * month too short to hold them and were dropped at parse time:
 *
 *   30 March, 31 March, 31 July, 31 October
 *
 * They are set to null rather than guessed. Interpolating them would put an
 * invented number into the one dataset this project treats as ground truth.
 *
 * VERIFICATION. Before the repair, `Jul 31 / Jul 30` sits at a median ratio of
 * 0.106 across 2,716 station-years — a December low flow in a monsoon slot. The
 * script prints that diagnostic before and after; afterwards the surviving
 * day-31 ratios should sit near the day-30 ratios of the same month.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = 'sources/dhm';
const WRITE = process.argv.includes('--write');

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const calendarDays = (m, y) => (m === 1 ? (isLeap(y) ? 29 : 28) : MONTH_DAYS[m]);

const OFFSET = [];
{
  let o = 0;
  for (let m = 0; m < 12; m++) {
    OFFSET.push(o);
    o += MONTH_DAYS[m];
  }
}
const slot = (m, d) => OFFSET[m] + d - 1;

/**
 * Where the old parser put each printed column, for one day of the month.
 *
 * Returns [trueMonth, storedMonth | null] pairs in printing order. A null
 * stored month is a value the old parser dropped and this script cannot get
 * back.
 */
function oldMapping(day, year) {
  const printed = [];
  for (let m = 0; m < 12; m++) if (day <= calendarDays(m, year)) printed.push(m);
  return printed.map((trueMonth, k) => [
    trueMonth,
    // Token k was assigned to month k, then kept only if the day fitted that
    // month under the old table — which gave February 29 days in every year.
    k < 12 && day <= MONTH_DAYS[k] ? k : null,
  ]);
}

let filesTouched = 0;
let yearsRepaired = 0;
let moved = 0;
let unrecoverable = 0;

/** Median ratio of one day to the day before it, over every station-year. */
function diagnose(load) {
  const acc = {};
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    const years = load(file);
    for (const [year, days] of Object.entries(years)) {
      if (!Array.isArray(days)) continue;
      const y = Number(year);
      for (const m of [0, 2, 4, 6, 7, 9, 11]) {
        if (calendarDays(m, y) < 31) continue;
        const a = days[slot(m, 31)];
        const b = days[slot(m, 30)];
        if (a > 0 && b > 0) (acc[NAMES[m]] ??= []).push(a / b);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(acc).map(([k, v]) => {
      v.sort((a, b) => a - b);
      return [k, { n: v.length, median: v[v.length >> 1] }];
    })
  );
}

const cache = new Map();
const read = (file) => {
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8')));
  return cache.get(file);
};

console.log('BEFORE — median (day 31 / day 30), by month:');
const before = diagnose((f) => read(f).years);
for (const [m, s] of Object.entries(before)) {
  console.log(`  ${m}  n=${String(s.n).padStart(5)}  ${s.median.toFixed(3)}`);
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const station = read(file);
  let changed = false;

  for (const [year, days] of Object.entries(station.years)) {
    if (!Array.isArray(days)) continue;
    const y = Number(year);
    const repaired = new Array(366).fill(null);

    for (let day = 1; day <= 31; day++) {
      for (const [trueMonth, storedMonth] of oldMapping(day, y)) {
        if (storedMonth === null) {
          unrecoverable++;
          continue;
        }
        const value = days[slot(storedMonth, day)];
        if (value == null) continue;
        repaired[slot(trueMonth, day)] = value;
        if (trueMonth !== storedMonth) moved++;
      }
    }

    if (repaired.some((v, i) => v !== (days[i] ?? null))) {
      station.years[year] = repaired;
      changed = true;
      yearsRepaired++;
    }
  }

  if (changed) {
    filesTouched++;
    if (WRITE) writeFileSync(`${DIR}/${file}`, JSON.stringify(station));
  }
}

console.log('\nAFTER — median (day 31 / day 30), by month:');
const after = diagnose((f) => read(f).years);
for (const [m, s] of Object.entries(after)) {
  console.log(`  ${m}  n=${String(s.n).padStart(5)}  ${s.median.toFixed(3)}`);
}

console.log(
  `\n${filesTouched} stations · ${yearsRepaired} station-years · ${moved.toLocaleString()} values moved to their real month`
);
console.log(
  `${unrecoverable.toLocaleString()} values (30 Mar, 31 Mar, 31 Jul, 31 Oct) were dropped by the old parser and are left null`
);
console.log(
  WRITE
    ? `\nwritten to ${DIR}/ — now re-run: node pipeline/build-dhm-index.mjs`
    : '\nDRY RUN. Nothing written. Re-run with --write to apply.'
);
