/**
 * Importing a real gauge record.  part of `npm run check`
 *
 * This parser is the one place where being clever is dangerous. A misread
 * record does not fail loudly — it produces a plausible-looking flow series
 * wearing the authority of a measurement, and every number downstream inherits
 * that. So most of these checks are about the ways a file can be misunderstood
 * quietly: a no-data marker read as zero, a day read as a month, a Nepali date
 * read as Gregorian.
 */
import assert from 'node:assert/strict';
import { fillGaps, measuredSpread, parseMeasured, scaleSeries } from '../src/measured.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};
const good = (text: string) => {
  const r = parseMeasured(text);
  assert.ok(r.ok, `expected a parse, got: ${r.ok ? '' : r.error}`);
  return r.series;
};

console.log('\nmeasured: the shapes a record actually arrives in');

ok('a plain CSV with a header', () => {
  const s = good('Date,Discharge (m3/s)\n2020-01-01,12.4\n2020-01-02,11.9\n2020-01-03,11.2\n');
  assert.deepEqual(s.values, [12.4, 11.9, 11.2]);
  assert.deepEqual(s.dates, ['2020-01-01', '2020-01-02', '2020-01-03']);
  assert.equal(s.cadence, 'daily');
  assert.equal(s.from, '2020-01-01');
});

ok('tab separated, extra columns, station id first', () => {
  const s = good('Station\tDate\tStage\tDischarge\n445\t2019-06-01\t2.11\t180.5\n445\t2019-06-02\t2.30\t205.1\n');
  assert.deepEqual(s.values, [180.5, 205.1], 'must take discharge, not stage');
});

ok('a bare column of numbers with no header and no dates', () => {
  const s = good('14.2\n13.8\n12.9\n11.4\n');
  assert.deepEqual(s.values, [14.2, 13.8, 12.9, 11.4]);
  assert.equal(s.from, null, 'no dates to report');
  assert.ok(
    s.notes.some((n) => /no wet\/dry split/i.test(n)),
    'must say what is lost without dates'
  );
});

ok('semicolon separated with comma decimals is not silently mangled', () => {
  // A European export. The value column is unambiguous; what matters is that
  // 1,234 is read as one thousand two hundred, not as two fields.
  const s = good('Date;Q\n2020-01-01;1,234\n2020-01-02;987\n');
  assert.deepEqual(s.values, [1234, 987]);
});

console.log('\nmeasured: the misreadings that would be silent');

ok('no-data markers are dropped, never read as zero', () => {
  // -9999 read as a flow would put a false zero in the low-flow tail, which is
  // exactly the part of the curve that decides firm power.
  const s = good('Date,Q\n2020-01-01,12.4\n2020-01-02,-9999\n2020-01-03,NA\n2020-01-04,11.2\n');
  assert.deepEqual(s.values, [12.4, 11.2], 'sentinels must not survive as values');
  assert.ok(!s.values.includes(0), 'a missing day must never become a zero flow');
  assert.ok(s.notes.some((n) => /no-data/i.test(n)), 'the drop must be reported');
});

ok('a genuine zero is kept, because a dry river is real information', () => {
  const s = good('Date,Q\n2020-04-01,0\n2020-04-02,0.4\n');
  assert.deepEqual(s.values, [0, 0.4]);
});

ok('day-first versus month-first is settled by evidence, not convention', () => {
  // 25 cannot be a month, so this column must be DD/MM/YYYY throughout.
  const dayFirst = good('Date,Q\n25/06/2019,10\n01/07/2019,11\n');
  assert.deepEqual(dayFirst.dates, ['2019-06-25', '2019-07-01']);
  // 25 in the second field settles it the other way.
  const monthFirst = good('Date,Q\n06/25/2019,10\n07/01/2019,11\n');
  assert.deepEqual(monthFirst.dates, ['2019-06-25', '2019-07-01']);
});

ok('Bikram Sambat dates are detected and dropped, not approximated', () => {
  // BS months do not map onto Gregorian ones by arithmetic. Approximating would
  // shift the hydrograph by up to a fortnight and move water across the wet/dry
  // boundary that sets a Nepali project's tariff.
  const s = good('Date,Q\n2081-03-15,44.2\n2081-03-16,43.8\n2081-03-17,41.0\n');
  assert.deepEqual(s.values, [44.2, 43.8, 41.0], 'the values are still good');
  assert.equal(s.from, null, 'the dates must not be used');
  assert.ok(
    s.notes.some((n) => /bikram sambat/i.test(n)),
    'the user must be told why the dates went away'
  );
});

ok('monthly records are recognised and their limits stated', () => {
  const rows = Array.from({ length: 24 }, (_, i) => {
    const y = 2018 + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, '0');
    return `${y}-${m}-01,${20 + (i % 7)}`;
  }).join('\n');
  const s = good(`Date,Q\n${rows}\n`);
  assert.equal(s.cadence, 'monthly');
  assert.ok(
    s.notes.some((n) => /monthly/i.test(n) && /understate/i.test(n)),
    'monthly means smooth away the low-flow spells that decide firm power'
  );
});

console.log('\nmeasured: refusing rather than guessing');

ok('a file with no numbers is rejected with a reason', () => {
  const r = parseMeasured('Notes about the station\nCollected by the district office\n');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /no column of numbers|no usable/i);
    assert.ok(r.hint, 'a rejection must say what was expected');
  }
});

ok('an empty file is rejected', () => {
  assert.equal(parseMeasured('').ok, false);
  assert.equal(parseMeasured('\n\n  \n').ok, false);
});

ok('absurd magnitudes are dropped rather than believed', () => {
  // A stray row of milliseconds or a merged cell must not become a flood.
  const s = good('Date,Q\n2020-01-01,12.4\n2020-01-02,1700000000\n2020-01-03,11.2\n');
  assert.deepEqual(s.values, [12.4, 11.2]);
});

console.log('\nmeasured: transfer and what it costs in confidence');

ok('scaling multiplies every value and records that it happened', () => {
  const s = scaleSeries(good('Q\n10\n20\n'), 0.5);
  assert.deepEqual(s.values, [5, 10]);
  assert.ok(s.notes.some((n) => /scaled by 0\.500x/i.test(n)));
  // A ratio of exactly 1 must leave the series and its notes untouched.
  const same = good('Q\n10\n20\n');
  assert.equal(scaleSeries(same, 1).notes.length, same.notes.length);
});

ok('a measured record is far more trusted than a model, but never exact', () => {
  // At the gauge itself: rating-curve error, not zero.
  const atSite = measuredSpread(1);
  assert.ok(atSite > 0.05 && atSite < 0.25, `${atSite} is not a credible rating-curve error`);
  // Still well inside the 0.3/0.5 spreads the modelled sources carry.
  assert.ok(atSite < 0.3, 'a gauged record must beat two agreeing global models');
  // Transfer costs confidence, symmetrically in the ratio.
  assert.ok(measuredSpread(2) > atSite, 'scaling up must widen the band');
  assert.ok(
    Math.abs(measuredSpread(3) - measuredSpread(1 / 3)) < 1e-12,
    'scaling up by 3 is exactly as uncertain as scaling down by 3'
  );
});


console.log('\nmeasured: filling gaps without inventing a river');

/** A daily record with a hole cut out of it. */
const withHole = (missingFrom: number, missingDays: number, year = 2020) => {
  const rows = ['Date,Q'];
  for (let d = 0; d < 120; d++) {
    if (d >= missingFrom && d < missingFrom + missingDays) continue;
    const date = new Date(Date.UTC(year, 0, 1 + d)).toISOString().slice(0, 10);
    rows.push(`${date},${(10 + d).toFixed(1)}`);
  }
  return good(rows.join('\n'));
};

ok('a short gap is interpolated, and the values land on the straight line', () => {
  const { series, report } = fillGaps(withHole(50, 3));
  assert.equal(report.filled, 3);
  assert.equal(report.leftEmpty, 0);
  assert.equal(report.longestFilled, 3);
  // The synthetic record is linear in the day index, so a correct interpolation
  // reproduces it exactly — any other scheme would show up here.
  const i = series.dates.indexOf('2020-02-21'); // day 51
  assert.ok(i >= 0, 'the filled day must be present');
  assert.ok(Math.abs(series.values[i] - 61) < 1e-9, `got ${series.values[i]}, expected 61`);
  assert.ok(series.notes.some((n) => /estimates, not measurements/i.test(n)));
});

ok('a long gap is left empty rather than drawn through', () => {
  const { series, report } = fillGaps(withHole(40, 30));
  assert.equal(report.filled, 0, 'a 30-day hole must not be interpolated');
  assert.equal(report.leftEmpty, 30);
  assert.ok(report.longestGap >= 30);
  assert.ok(
    series.notes.some((n) => /stops resembling a river/i.test(n)),
    'the refusal must be explained'
  );
});

ok('filling adds days rather than replacing real ones', () => {
  const before = withHole(50, 3);
  const { series } = fillGaps(before);
  assert.equal(series.values.length, before.values.length + 3);
  // Every original reading survives unchanged.
  for (let i = 0; i < before.dates.length; i++) {
    const j = series.dates.indexOf(before.dates[i]);
    assert.ok(j >= 0 && Math.abs(series.values[j] - before.values[i]) < 1e-12);
  }
});

ok('seasonally clustered gaps are called out, because they bias the curve', () => {
  // Two years of daily data with every August missing — the monsoon pattern a
  // washed-out Nepali gauge produces, and the one that quietly removes high flows.
  const rows = ['Date,Q'];
  for (let y = 2018; y <= 2019; y++) {
    for (let d = 0; d < 365; d++) {
      const date = new Date(Date.UTC(y, 0, 1 + d)).toISOString().slice(0, 10);
      if (date.slice(5, 7) === '08') continue;
      rows.push(`${date},${20 + (d % 11)}`);
    }
  }
  const { report, series } = fillGaps(good(rows.join('\n')));
  assert.ok(report.clusteredMonths.includes(8), `clustered months: ${report.clusteredMonths}`);
  assert.ok(
    series.notes.some((n) => /Aug/.test(n) && /flood/i.test(n)),
    'a record missing its monsoon must say so'
  );
});

ok('a record with no gaps is returned untouched', () => {
  const clean = withHole(0, 0);
  const { series, report } = fillGaps(clean);
  assert.equal(report.filled, 0);
  assert.equal(report.leftEmpty, 0);
  assert.equal(series.values.length, clean.values.length);
  assert.equal(series.notes.length, clean.notes.length, 'nothing to report, nothing said');
});

ok('a monthly record is never gap-filled as if it were daily', () => {
  const rows = ['Date,Q'];
  for (let i = 0; i < 24; i++) {
    const y = 2018 + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, '0');
    rows.push(`${y}-${m}-01,${20 + (i % 7)}`);
  }
  const monthly = good(rows.join('\n'));
  assert.equal(monthly.cadence, 'monthly');
  const { report } = fillGaps(monthly);
  assert.equal(report.filled, 0, 'the 29 days between monthly readings are not gaps');
});

console.log(`\n${passed} measured checks passed\n`);
