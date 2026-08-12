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

const iso = (y: number, mo: number, d: number): string | null =>
  mo >= 1 && mo <= 12 && d >= 1 && d <= 31
    ? `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    : null;

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
  const rows = rawLines.map((l) => (delim === '\n' ? [l] : l.split(delim)));

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
  if (dateCol >= 0) {
    let sawBigFirst = false;
    let sawBigSecond = false;
    for (const r of body) {
      const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{4}$/.exec((r[dateCol] ?? '').trim());
      if (!m) continue;
      if (+m[1] > 12) sawBigFirst = true;
      if (+m[2] > 12) sawBigSecond = true;
    }
    if (sawBigFirst) dayFirst = true;
    else if (sawBigSecond) dayFirst = false;
  }

  const notes: string[] = [];
  const dates: string[] = [];
  const values: number[] = [];
  const bsYears: number[] = [];
  let skipped = 0;
  let noData = 0;
  let negatives = 0;

  for (const r of body) {
    const v = num(r[valueCol] ?? '');
    if (!Number.isFinite(v)) {
      skipped++;
      continue;
    }
    if (NO_DATA.has(v)) {
      noData++;
      continue;
    }
    if (Math.abs(v) > MAX_PLAUSIBLE_CMS) {
      skipped++;
      continue;
    }
    if (v < 0) negatives++;

    let d: string | null = null;
    if (dateCol >= 0) {
      const cell = (r[dateCol] ?? '').trim();
      d = parseDateCell(cell, dayFirst);
      const y = /^(\d{4})/.exec(cell) ?? /(\d{4})$/.exec(cell);
      if (y) bsYears.push(+y[1]);
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
  if (noData > 0) notes.push(`${noData} no-data markers dropped, not read as zero.`);
  if (skipped > 0) notes.push(`${skipped} rows could not be read and were skipped.`);
  if (negatives > 0)
    notes.push(`${negatives} negative values kept as recorded — they yield no power.`);
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
