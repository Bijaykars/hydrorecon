/**
 * Letting the engineer put a real record in.
 *
 * The app spends a lot of effort saying how uncertain its flow is, and then
 * naming the exact DHM station whose record would fix it — and until now there
 * was nowhere to put that record once you had it. That made the advice hollow.
 * A measured series is not a marginal improvement over two uncalibrated global
 * models; it is a different category of answer, and it is the only thing that
 * collapses the dominant error in the whole estimate.
 *
 * So this parses what people actually have, rather than one tidy format nobody
 * exports. Gauge records arrive as spreadsheet exports, government PDFs
 * copy-pasted into a text file, or a column of numbers a colleague sent — with
 * headers or without, comma or tab or semicolon separated, dates in four
 * conventions, missing days marked half a dozen ways.
 *
 * The rule throughout: understand what can be understood, say plainly what was
 * understood, and refuse rather than guess when guessing would corrupt the
 * result. A silently misread record is far worse than a rejected one, because
 * it would arrive wearing the authority of a measurement.
 */

export type MeasuredSeries = {
  /** ISO dates, parallel to `values`. Empty when no dates could be read. */
  dates: string[];
  /** Discharge, m³/s. */
  values: number[];
  /** daily, monthly, or unknown cadence. */
  cadence: 'daily' | 'monthly' | 'unknown';
  /** What the parser did, for the user to check before trusting it. */
  notes: string[];
  /** Rows that could not be read at all. */
  skipped: number;
  /** Span of the record, when dates were understood. */
  from: string | null;
  to: string | null;
};

export type ParseResult =
  | { ok: true; series: MeasuredSeries }
  | { ok: false; error: string; hint?: string };

/**
 * Values used by hydrological services to mean "no reading".
 *
 * Feeding any of these into a flow-duration curve destroys the low-flow tail,
 * which is precisely the part that decides firm power — so they are dropped,
 * not zeroed. -999 and friends are near universal; 0 is deliberately NOT here,
 * because a river can genuinely read zero and that is real information.
 */
const NO_DATA = new Set([-9999, -999, -99.9, -9.99, 9999, -1]);
const NO_DATA_TEXT = /^(na|n\/a|nan|null|-|--|\.|\?|missing|no ?data)$/i;

/** Plausible discharge for any river on earth, m³/s. Amazon peaks near 300,000. */
const MAX_PLAUSIBLE_CMS = 400_000;

const DELIMS = [',', '\t', ';', '|'];

/**
 * Discharge units this parser will convert, largest trap first.
 *
 * The header used to be read as decoration only. A column titled
 * "Discharge (cfs)" holding 35.3147 was taken as 35.3147 m³/s rather than
 * 1 m³/s — a 35× error that looks entirely plausible on a Nepali river, and
 * L/s and m³/day are wrong by 1,000× and 86,400×.
 *
 * Order matters: the patterns are tried in sequence and "m3/day" has to be
 * tested before the bare "m3" that would otherwise swallow it.
 */
const UNITS: { pattern: RegExp; factor: number; label: string }[] = [
  { pattern: /(m3|m³)\s*\/?\s*(d|day)/i, factor: 1 / 86_400, label: 'm³/day' },
  { pattern: /\b(cfs|ft3|ft³|cubic\s*feet)/i, factor: 0.028_316_846_592, label: 'cubic feet per second' },
  { pattern: /\b(l\/s|lps|litres?\s*\/?\s*s|liters?\s*\/?\s*s)/i, factor: 0.001, label: 'litres per second' },
  { pattern: /\b(m3\/s|m³\/s|cumec|cms)\b/i, factor: 1, label: 'm³/s' },
];

const unitOf = (header: string | undefined) =>
  header ? UNITS.find((u) => u.pattern.test(header)) ?? null : null;

/** Which separator makes the rows most consistently wide? */
function sniffDelimiter(lines: string[]): string {
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMS) {
    const counts = lines.slice(0, 40).map((l) => l.split(d).length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    if (mode < 2) continue;
    // Reward wide rows, punish rows that disagree about how wide they are.
    const agree = counts.filter((c) => c === mode).length / counts.length;
    const score = mode * agree;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  // A single column of bare numbers is legitimate and has no delimiter at all.
  return bestScore < 0 ? '\n' : best;
}

/**
 * Split one row, honouring RFC 4180 quoting.
 *
 * A plain `split(delim)` cannot see that `"Ganges, at Chatara"` is one field,
 * and it turns the thousands separator in `1,234` into a column break — so a
 * flow of 1,234 m³/s was read as 1 and every column after it shifted left. The
 * `num()` helper below strips thousands separators, but only ever saw them
 * when the delimiter was a tab or semicolon.
 */
function splitDelimited(line: string, delim: string): string[] {
  if (!line.includes('"')) return line.split(delim);
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"'; // an escaped quote inside a quoted field
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

/** A number, tolerating thousands separators and stray currency-style spacing. */
function num(raw: string): number {
  const s = raw.trim().replace(/\s+/g, '').replace(/,(?=\d{3}\b)/g, '');
  if (s === '' || NO_DATA_TEXT.test(s)) return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * A date from one cell, returned as ISO.
 *
 * Handles YYYY-MM-DD, DD/MM/YYYY and MM/DD/YYYY. The last two are genuinely
 * ambiguous, and rather than pick a convention and be silently wrong for half
 * the world, `parseDates` below decides by looking at the whole column: if any
 * first field exceeds 12 it must be the day, which settles it with evidence.
 */
function parseDateCell(raw: string, dayFirst: boolean | null): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    // Unambiguous when one field cannot be a month.
    if (a > 12) return iso(+m[3], b, a);
    if (b > 12) return iso(+m[3], a, b);
    return dayFirst === false ? iso(+m[3], a, b) : iso(+m[3], b, a);
  }
  return null;
}

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * An ISO date, or null if the calendar has no such day.
 *
 * The month length is checked, not just `d <= 31`. Accepting 2023-02-31 meant
 * JavaScript's own normalisation later moved it into March while code that
 * slices the month out of the string still read "02" — the same reading
 * belonging to two different months in two different calculations.
 */
const iso = (y: number, mo: number, d: number): string | null => {
  if (!(mo >= 1 && mo <= 12) || !(d >= 1)) return null;
  const len = mo === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[mo - 1];
  if (d > len) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * Nepali records are often dated in Bikram Sambat, and BS cannot be converted
 * to a Gregorian month by arithmetic — the months have different lengths in
 * different years, so it needs a lookup table this app does not carry.
 *
 * A silent approximation would shift the hydrograph by up to a fortnight and
 * quietly move water between the wet and dry seasons, which is exactly the
 * split that decides a Nepali project's revenue. So BS is detected and said out
 * loud, the values are kept, and the dates are dropped rather than faked.
 */
const BS_YEAR_FLOOR = 2050;

const looksBikramSambat = (years: number[]): boolean => {
  if (years.length === 0) return false;
  const median = years.sort((a, b) => a - b)[Math.floor(years.length / 2)];
  /**
   * BS runs about 56.7 years ahead, so today's records are dated in the 2080s.
   * The two calendars overlap numerically — BS 2020 is a real year — but only in
   * the Gregorian future: a discharge record dated 2050 or later cannot be AD,
   * because that year has not happened. Anything below the floor is Gregorian.
   *
   * A first version tested 2000-2100 and swallowed the dates of every modern
   * Gregorian record, which is the failure this threshold exists to avoid.
   */
  return median >= BS_YEAR_FLOOR;
};

export function parseMeasured(text: string): ParseResult {
  const rawLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[#;]/.test(l));
  if (rawLines.length === 0) return { ok: false, error: 'The file is empty.' };

  const delim = sniffDelimiter(rawLines);
  const rows = rawLines.map((l) => (delim === '\n' ? [l] : splitDelimited(l, delim)));

  // A header is a first row whose cells are mostly non-numeric.
  const firstNumeric = rows[0].filter((c) => Number.isFinite(num(c))).length;
  const hasHeader = firstNumeric === 0 && rows.length > 1;
  const header = hasHeader ? rows[0].map((c) => c.trim().toLowerCase()) : null;
  const body = hasHeader ? rows.slice(1) : rows;
  if (body.length === 0) return { ok: false, error: 'The file has a header but no data rows.' };

  const width = Math.max(...body.slice(0, 200).map((r) => r.length));

  /**
   * Which column holds discharge?
   *
   * A named column wins outright. Otherwise take the LAST column that is
   * consistently numeric — in every gauge export seen, identifiers and dates
   * come first and the reading comes last.
   */
  let valueCol = -1;
  if (header) {
    valueCol = header.findIndex((h) =>
      /(discharge|flow|q[\s_(]|^q$|m3|m³|cumec|cms)/i.test(h)
    );
  }
  if (valueCol < 0) {
    for (let c = width - 1; c >= 0; c--) {
      const got = body.slice(0, 200).filter((r) => Number.isFinite(num(r[c] ?? '')));
      if (got.length > body.slice(0, 200).length * 0.8) {
        valueCol = c;
        break;
      }
    }
  }
  if (valueCol < 0) {
    return {
      ok: false,
      error: 'No column of numbers could be found.',
      hint: 'Expected a discharge column in m³/s — a header naming it, or a consistently numeric column.',
    };
  }

  // Which column holds a date, if any?
  let dateCol = -1;
  if (header) dateCol = header.findIndex((h) => /(date|day|मिति)/i.test(h));
  if (dateCol < 0) {
    for (let c = 0; c < width; c++) {
      if (c === valueCol) continue;
      const got = body.slice(0, 200).filter((r) => parseDateCell(r[c] ?? '', null));
      if (got.length > body.slice(0, 200).length * 0.8) {
        dateCol = c;
        break;
      }
    }
  }

  // Settle DD/MM versus MM/DD from the column itself rather than by convention.
  let dayFirst: boolean | null = null;
  let sawSlashDates = false;
  if (dateCol >= 0) {
    let sawBigFirst = false;
    let sawBigSecond = false;
    for (const r of body) {
      const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{4}$/.exec((r[dateCol] ?? '').trim());
      if (!m) continue;
      sawSlashDates = true;
      if (+m[1] > 12) sawBigFirst = true;
      if (+m[2] > 12) sawBigSecond = true;
    }
    if (sawBigFirst) dayFirst = true;
    else if (sawBigSecond) dayFirst = false;
    // dayFirst stays null when every row is ambiguous — parseDateCell still has
    // to choose, and it chooses day-first, but the reader is told below.
  }

  const notes: string[] = [];
  const dates: string[] = [];
  const values: number[] = [];
  const bsYears: number[] = [];
  let skipped = 0;
  let noData = 0;
  let negatives = 0;

  /** Convert to m³/s when the header names a unit this parser knows. */
  const unit = unitOf(header?.[valueCol]);

  let badDates = 0;

  for (const r of body) {
    const raw = num(r[valueCol] ?? '');
    if (!Number.isFinite(raw)) {
      skipped++;
      continue;
    }
    if (NO_DATA.has(raw)) {
      noData++;
      continue;
    }
    const v = unit ? raw * unit.factor : raw;
    if (Math.abs(v) > MAX_PLAUSIBLE_CMS) {
      skipped++;
      continue;
    }
    /**
     * A negative discharge is a sensor flag, not water. Kept as a value it
     * flowed into the monthly minimum, made the environmental release negative,
     * and the engine — which SUBTRACTS that release — then added the water back:
     * a 1 m³/s river with one -100 month produced 11 m³/s of design flow.
     */
    if (v < 0) {
      negatives++;
      continue;
    }

    let d: string | null = null;
    if (dateCol >= 0) {
      const cell = (r[dateCol] ?? '').trim();
      d = parseDateCell(cell, dayFirst);
      const y = /^(\d{4})/.exec(cell) ?? /(\d{4})$/.exec(cell);
      if (y) bsYears.push(+y[1]);
      /**
       * A value whose date could not be read is dropped, not kept with a blank
       * date. Keeping it meant gap-filling later discarded the undated row and
       * INTERPOLATED across the hole it left — so a real reading of 100 was
       * replaced by an invented 2, and the note said only that one day had been
       * filled. Losing the value is honest; inventing one is not.
       */
      if (cell && !d) {
        badDates++;
        continue;
      }
    }
    dates.push(d ?? '');
    values.push(v);
  }

  if (values.length === 0) {
    return {
      ok: false,
      error: 'No usable discharge values were found.',
      hint: 'Every row was blank, non-numeric, or a no-data marker.',
    };
  }

  // Bikram Sambat: keep the values, drop the dates, say why.
  const gotDates = dates.filter(Boolean).length;
  let usableDates = gotDates > 0;
  if (gotDates > 0 && looksBikramSambat([...bsYears])) {
    usableDates = false;
    notes.push(
      'Dates look like Bikram Sambat. BS months do not map onto Gregorian ones by arithmetic, ' +
        'so they have been dropped rather than approximated — an approximation would move water ' +
        'between the wet and dry seasons. Convert to AD dates to get the seasonal split.'
    );
  }

  const kept = usableDates ? dates : dates.map(() => '');
  const withDates = kept.filter(Boolean).sort();
  const from = withDates[0] ?? null;
  const to = withDates[withDates.length - 1] ?? null;

  /** Daily or monthly? Decided by the typical gap between consecutive dates. */
  let cadence: MeasuredSeries['cadence'] = 'unknown';
  // Two gaps is the least that can suggest a cadence; below that, say unknown.
  if (withDates.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < withDates.length && gaps.length < 400; i++) {
      const a = Date.parse(withDates[i - 1]);
      const b = Date.parse(withDates[i]);
      if (Number.isFinite(a) && Number.isFinite(b)) gaps.push((b - a) / 86_400_000);
    }
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)] ?? 0;
    cadence = med <= 2 ? 'daily' : med >= 25 && med <= 32 ? 'monthly' : 'unknown';
  }

  notes.unshift(
    `Read ${values.length.toLocaleString()} values from column ${valueCol + 1}` +
      (header ? ` ("${header[valueCol] ?? ''}")` : '') +
      (usableDates ? `, dated from column ${dateCol + 1}` : ', with no usable dates') +
      `. Separator: ${delim === '\n' ? 'single column' : delim === '\t' ? 'tab' : `"${delim}"`}.`
  );
  if (unit && unit.factor !== 1)
    notes.push(
      `Column header names ${unit.label}; every value was multiplied by ` +
        `${unit.factor} to reach m³/s. Check this is what the file means.`
    );
  else if (!unit)
    notes.push(
      'No unit could be read from the header, so the values are taken as m³/s. ' +
        'If the file is in cfs, litres per second or m³/day, retitle the column ' +
        'and re-import — nothing here can detect the difference from the numbers alone.'
    );
  if (noData > 0) notes.push(`${noData} no-data markers dropped, not read as zero.`);
  if (skipped > 0) notes.push(`${skipped} rows could not be read and were skipped.`);
  if (badDates > 0)
    notes.push(
      `${badDates} rows had a value but an unreadable date and were dropped rather ` +
        'than interpolated over.'
    );
  if (negatives > 0)
    notes.push(
      `${negatives} negative values dropped — discharge cannot be negative, and a ` +
        'sensor flag left in the record would inflate the usable flow.'
    );
  if (dateCol >= 0 && dayFirst === null && sawSlashDates)
    notes.push(
      'Dates are written D/M/Y or M/D/Y and nothing in the column settles which — ' +
        'no first field exceeded 12. They have been read DAY first. If the file is ' +
        'American, the months are wrong; re-save as YYYY-MM-DD to be certain.'
    );
  if (cadence === 'monthly')
    notes.push(
      'Monthly cadence detected. A flow-duration curve from monthly means understates ' +
        'both flood peaks and low-flow spells, so energy from it is smoother than reality.'
    );
  if (!usableDates)
    notes.push(
      'Without dates there is no wet/dry split and no monthly minimum, so residual flow ' +
        'falls back to the assumption rather than the record.'
    );

  return {
    ok: true,
    series: { dates: kept, values, cadence, notes, skipped, from, to },
  };
}

/**
 * Longest run of missing days that may be interpolated across.
 *
 * A week is the usual limit in hydrological practice, and the reasoning is
 * physical rather than statistical: a river's recession between storms is
 * smooth over a few days, so a straight line between two real readings is close
 * to what the gauge would have recorded. Over longer spans it is not — a whole
 * missing fortnight can contain a flood peak, and drawing a line through it
 * invents a river that never existed.
 */
const MAX_FILL_DAYS = 7;

const dayNum = (iso: string) => Math.round(Date.parse(iso) / 86_400_000);
const isoOf = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

export type GapReport = {
  filled: number;
  longestFilled: number;
  leftEmpty: number;
  longestGap: number;
  /** Months, 1-12, where more than a third of the missing days fell. */
  clusteredMonths: number[];
};

/**
 * Fill short gaps in a daily record, and say exactly what was invented.
 *
 * WHY THIS IS NOT OPTIONAL: gauge records are not missing days at random.
 * Nepali stations lose readings when the river is in flood — the staff cannot
 * reach the gauge, or the gauge itself is damaged — so the absences cluster in
 * the monsoon. Simply dropping them, which this parser used to do, removes high
 * flows preferentially and quietly understates both the flood tail and annual
 * energy. Interpolating short gaps is standard practice and it removes that bias.
 *
 * WHY IT IS BOUNDED: past a week, a straight line stops resembling a river. So
 * long gaps stay empty, and the report says how many days were filled, the
 * longest run filled, and whether the remaining holes cluster in particular
 * months — because a record missing every August is telling you something about
 * itself that no amount of interpolation should paper over.
 */
export function fillGaps(
  series: MeasuredSeries,
  maxGapDays = MAX_FILL_DAYS
): { series: MeasuredSeries; report: GapReport } {
  const empty: GapReport = {
    filled: 0,
    longestFilled: 0,
    leftEmpty: 0,
    longestGap: 0,
    clusteredMonths: [],
  };
  if (series.cadence !== 'daily') return { series, report: empty };

  const known = new Map<number, number>();
  for (let i = 0; i < series.values.length; i++) {
    const d = series.dates[i];
    if (!d) continue;
    const n = dayNum(d);
    if (Number.isFinite(n)) known.set(n, series.values[i]);
  }
  if (known.size < 2) return { series, report: empty };

  const days = [...known.keys()].sort((a, b) => a - b);
  const first = days[0];
  const last = days[days.length - 1];

  const outDates: string[] = [];
  const outValues: number[] = [];
  const report: GapReport = { ...empty, clusteredMonths: [] };
  const missingByMonth = new Array(13).fill(0);

  let prevKnown = first;
  for (let d = first; d <= last; d++) {
    const here = known.get(d);
    if (here !== undefined) {
      outDates.push(isoOf(d));
      outValues.push(here);
      prevKnown = d;
      continue;
    }
    // Find the next real reading to bracket this hole.
    let next = d + 1;
    while (next <= last && !known.has(next)) next++;
    const gap = next - prevKnown - 1;
    const month = Number(isoOf(d).slice(5, 7));
    missingByMonth[month]++;
    if (gap <= maxGapDays && next <= last) {
      const a = known.get(prevKnown)!;
      const b = known.get(next)!;
      const t = (d - prevKnown) / (next - prevKnown);
      outDates.push(isoOf(d));
      outValues.push(a + t * (b - a));
      report.filled++;
      report.longestFilled = Math.max(report.longestFilled, gap);
    } else {
      report.leftEmpty++;
    }
    report.longestGap = Math.max(report.longestGap, gap);
  }

  const totalMissing = missingByMonth.reduce((a, b) => a + b, 0);
  if (totalMissing > 0) {
    for (let m = 1; m <= 12; m++) {
      if (missingByMonth[m] > totalMissing / 3) report.clusteredMonths.push(m);
    }
  }

  const notes = [...series.notes];
  if (report.filled > 0) {
    notes.push(
      `${report.filled} missing days filled by interpolating between the readings either side ` +
        `(longest run ${report.longestFilled} days). These are estimates, not measurements.`
    );
  }
  if (report.leftEmpty > 0) {
    notes.push(
      `${report.leftEmpty} days left empty — the gaps are longer than ${maxGapDays} days ` +
        `(longest ${report.longestGap}), where a straight line stops resembling a river.`
    );
  }
  if (report.clusteredMonths.length > 0) {
    notes.push(
      `Missing days cluster in ${report.clusteredMonths.map((m) => MONTHS[m - 1]).join(', ')}. ` +
        'Gauges are lost in flood, so absences are rarely random — a record missing its ' +
        'monsoon under-reports high flows however the gaps are treated.'
    );
  }

  return {
    series: { ...series, dates: outDates, values: outValues, notes },
    report,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Scale a record from a gauge onto this site by catchment area.
 *
 * Q_here = Q_gauge x (A_here / A_gauge) — the standard transfer, and what a
 * feasibility study would do with a record from a neighbouring station. A ratio
 * of 1 means the record is being used as measured.
 */
export function scaleSeries(series: MeasuredSeries, ratio: number): MeasuredSeries {
  if (!(ratio > 0) || ratio === 1) return series;
  return {
    ...series,
    values: series.values.map((v) => v * ratio),
    notes: [
      ...series.notes,
      `Scaled by ${ratio.toFixed(3)}x for the catchment-area difference between the gauge and this site.`,
    ],
  };
}

/**
 * How much a measured record can still be wrong, as a fraction.
 *
 * Even at the gauge itself a discharge record is not exact: it is a stage
 * reading converted through a rating curve, and the curve is extrapolated at
 * the high flows and shifts as the channel scours. Around 15% is the working
 * figure hydrologists use.
 *
 * Transferring it to another catchment adds to that, and the further the areas
 * are apart the more it adds — the two catchments stop sharing the runoff
 * behaviour the transfer assumes. Growing the term with |ln(ratio)| keeps it
 * symmetric: scaling up by three is exactly as uncertain as scaling down by
 * three, which a linear term would get wrong.
 */
export function measuredSpread(areaRatio: number): number {
  const base = 0.15;
  if (!(areaRatio > 0)) return base;
  return base + 0.25 * Math.abs(Math.log(areaRatio));
}
