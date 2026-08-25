/**
 * Nepal's own measured discharge, transferred to the site you clicked.
 *
 * Flow has always been this app's dominant error — measured against these very
 * gauges at about 0.61x to 1.65x, one sigma (checks/flow-vs-gauges.mjs). Every
 * other refinement is small beside it. A real record removes the model from the
 * answer entirely for the part it can cover.
 *
 * THE METHOD is catchment-area transfer, which is what a Nepali feasibility
 * study does when the site is ungauged: take a gauged neighbour and scale its
 * record by the ratio of catchment areas.
 *
 *   Q_site(t) = Q_gauge(t) x (A_site / A_gauge)
 *
 * The exponent is 1. Runoff per unit area is roughly constant between
 * neighbouring catchments in the same rainfall regime, which is the whole
 * premise of the transfer; a fitted exponent would imply a precision this has
 * no basis for. The assumption fails as the two catchments stop resembling one
 * another, which is why the area ratio drives the quality grade below and why
 * a poor match is refused rather than quietly scaled.
 *
 * WHAT TRANSFERS AND WHAT DOES NOT: the seasonal shape and the year-to-year
 * spread transfer well — they come from the same monsoon. The absolute
 * magnitude transfers only as well as the area ratio and the rainfall
 * similarity allow. A gauge on the far side of a range from an equally large
 * catchment can still be wrong.
 *
 * SOURCE: Department of Hydrology and Meteorology. Supplied privately; the
 * daily series live in sources/dhm/ and are not redistributed.
 */
import bundle from './data/dhm-records.json' with { type: 'json' };
import { nearestReach } from './rivers.ts';
import { haversineKm } from './engine/hydro.ts';
import type { MeasuredSeries } from './measured.ts';

export type DhmStation = {
  id: string;
  river: string;
  location: string;
  lat: number | null;
  lon: number | null;
  from: number;
  to: number;
  years: number;
  completeYears: number;
  days: number;
  meanCms: number;
  monthly: (number | null)[];
  q: { q5: number; q20: number; q40: number; q50: number; q60: number; q80: number; q95: number };
  min: number;
  max: number;
};

const STATIONS = (bundle as unknown as { stations: DhmStation[] }).stations.filter(
  (s) => s.lat != null && s.lon != null
);

export const DHM_STATION_COUNT = STATIONS.length;
export const DHM_BUILT = (bundle as unknown as { _built: string })._built;

/**
 * Nepal's rivers deliver roughly 20 to 100 litres per second per square
 * kilometre. A gauge whose measured flow sits far outside that against the
 * catchment the network gives it has been snapped to the wrong channel, and
 * its area ratio would be nonsense — so it is never used as a donor.
 */
const SPECIFIC_MIN = 0.005;
const SPECIFIC_MAX = 0.25;

/**
 * A long-term mean needs a long record. Below this the donor carries whichever
 * wet or dry spell it happened to catch, which is exactly the error the
 * transfer is meant to remove.
 */
const MIN_TRANSFER_YEARS = 10;

/** How far to look for a donor gauge. Beyond this the rainfall regime drifts. */
const SEARCH_KM = 60;

export type Transfer = {
  station: DhmStation;
  /** Catchment the mapped network gives the gauge, km². */
  gaugeKm2: number;
  siteKm2: number;
  /** A_site / A_gauge — the factor the record is multiplied by. */
  ratio: number;
  straightKm: number;
  quality: 'close' | 'usable' | 'indicative';
  /** Why this grade, in the words the panel shows. */
  note: string;
};

const gradeOf = (ratio: number, km: number): Transfer['quality'] | null => {
  const off = ratio > 1 ? ratio : 1 / ratio;
  if (off > 10 || km > SEARCH_KM) return null;
  if (off <= 2 && km <= 25) return 'close';
  if (off <= 5) return 'usable';
  return 'indicative';
};

/**
 * The best gauge to borrow from, or null when none is defensible.
 *
 * Candidates are ranked on how close the catchment areas are first and
 * distance second: a gauge 40 km away on a catchment your own size beats one
 * 5 km away that is twenty times bigger, because the area ratio is what the
 * transfer actually rests on.
 */
export async function bestTransfer(
  lat: number,
  lon: number,
  siteKm2: number,
  /**
   * Station to pretend does not exist.
   *
   * Only for leave-one-out validation: a transfer rule can only be tested by
   * asking it to predict a gauge it is not allowed to see. Unused by the app.
   */
  excludeId?: string
): Promise<Transfer | null> {
  if (!(siteKm2 > 0)) return null;
  const near = STATIONS.filter((s) => s.id !== excludeId)
    .map((s) => ({ s, km: haversineKm([lat, lon], [s.lat!, s.lon!]) }))
    .filter((c) => c.km <= SEARCH_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, 12);

  const scored: { t: Transfer; score: number }[] = [];
  for (const { s, km } of near) {
    const hit = await nearestReach(s.lat!, s.lon!).catch(() => null);
    const gaugeKm2 = hit?.nearest.uplandKm2 ?? 0;
    if (!(gaugeKm2 > 0)) continue;
    const specific = s.meanCms / gaugeKm2;
    if (specific < SPECIFIC_MIN || specific > SPECIFIC_MAX) continue; // mis-snapped gauge
    const ratio = siteKm2 / gaugeKm2;
    const quality = gradeOf(ratio, km);
    if (!quality) continue;
    const off = ratio > 1 ? ratio : 1 / ratio;
    scored.push({
      t: {
        station: s,
        gaugeKm2,
        siteKm2,
        ratio,
        straightKm: km,
        quality,
        note:
          quality === 'close'
            ? `${s.completeYears} complete years on a catchment ${off < 1.15 ? 'the same size as' : `within ${off.toFixed(1)}x of`} yours, ${km.toFixed(0)} km away.`
            : quality === 'usable'
              ? `${s.completeYears} complete years, but its catchment is ${off.toFixed(1)}x yours — the shape transfers better than the magnitude.`
              : `${s.completeYears} complete years on a catchment ${off.toFixed(1)}x yours. Treat the magnitude as indicative only.`,
      },
      // Area mismatch dominates; distance breaks ties.
      score: Math.abs(Math.log(ratio)) * 3 + km / 50,
    });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored[0]?.t ?? null;
}

/** The 366-slot storage layout, NOT the calendar. Slot 59 is 29 February. */
/**
 * May this donor REPLACE the models, rather than merely be shown?
 *
 * Exported because the app and the validation harness must not disagree about
 * it, and they did. `measuredSeriesFor` below enforced `close` plus a ten-year
 * record; the app's "adopt this gauge" button called `bestTransfer` directly
 * and loaded whatever it returned. Across 123 fleet sites with an offer, 80
 * failed this bar — 26 donors had under ten complete years, seven were graded
 * `indicative`, and one two-year record sat on a catchment 7.4× the site's.
 * So the screen adopted evidence the harness would have refused to score, and
 * the two supposedly shared paths enforced opposite rules.
 */
export function transferMeetsBar(transfer: Transfer | null | undefined): boolean {
  if (!transfer || transfer.quality !== 'close') return false;
  return transfer.station.completeYears >= MIN_TRANSFER_YEARS;
}

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const pad = (n: number) => String(n).padStart(2, '0');

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * Days the calendar has. The layout reserves 29 slots for February in every
 * year; only a leap year may actually use the last one.
 *
 * A previous version emitted `YYYY-02-29` from the layout unconditionally, so
 * 2,058 of 2,096 non-leap station-years carried a 29 February that does not
 * exist. Every consumer that slices a month out of the date string — monthly
 * means, the wet/dry PPA split, the environmental-flow minimum — then read it
 * as a real February day.
 */
const calendarDays = (month: number, year: number) =>
  month === 1 ? (isLeap(year) ? 29 : 28) : MONTH_DAYS[month];

/**
 * Fetch one station's daily record and lay it out as dated values.
 *
 * The bundle stores a fixed 366-slot year so February always occupies the same
 * offsets; the 29th is null in a common year, which is also how a missed
 * reading appears. Both drop out here — nullness alone is not relied on, the
 * calendar bounds the loop, so a bad build cannot emit a date that never was.
 */
export async function loadStationSeries(id: string): Promise<MeasuredSeries | null> {
  let raw: { years: Record<string, (number | null)[]>; river?: string; location?: string };
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}dhm/${encodeURIComponent(id)}.json`);
    if (!res.ok) return null;
    raw = await res.json();
  } catch {
    return null;
  }
  const dates: string[] = [];
  const values: number[] = [];
  for (const year of Object.keys(raw.years).sort()) {
    const days = raw.years[year];
    let offset = 0;
    for (let m = 0; m < 12; m++) {
      for (let d = 1; d <= calendarDays(m, Number(year)); d++) {
        const value = days[offset + d - 1];
        if (value != null && Number.isFinite(value)) {
          dates.push(`${year}-${pad(m + 1)}-${pad(d)}`);
          values.push(value);
        }
      }
      offset += MONTH_DAYS[m];
    }
  }
  if (values.length < 365) return null;
  return {
    dates,
    values,
    cadence: 'daily',
    notes: [
      `Department of Hydrology and Meteorology station ${id}, ${raw.river || 'river'} at ${raw.location || 'gauge'}.`,
      `${values.length.toLocaleString()} measured daily means.`,
    ],
    // Nothing is dropped as unreadable: the bundle was already parsed and
    // validated by pipeline/build-dhm-records.mjs, so a missing day is a gap
    // in the gauge record, not a row this code failed to understand.
    skipped: 0,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };
}

/** Every station, for the map. */
export function dhmStationsGeoJson(): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: STATIONS.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon!, s.lat!] },
      properties: {
        id: s.id,
        river: s.river,
        location: s.location,
        meanCms: s.meanCms,
        years: s.completeYears,
        label: `${s.river || 'gauge'} · ${s.completeYears} yrs`,
      },
    })),
  };
}

/**
 * The measured record for a site, already scaled to its catchment.
 *
 * This is the top of the evidence hierarchy. A global model that reads 0.61x to
 * 1.65x against these very gauges loses to a gauge on the same river every
 * time, and the app and the validation harness must agree on that — they
 * diverged once on how a river is chosen and it hid a 214x error, so the choice
 * lives here and both call it.
 *
 * `indicative` matches are excluded: past a fivefold catchment difference the
 * transfer is worth showing an engineer but not worth overriding a model with.
 */
export async function measuredSeriesFor(
  lat: number,
  lon: number,
  siteKm2: number
): Promise<{ transfer: Transfer; dates: string[]; values: number[]; meanCms: number } | null> {
  const transfer = await bestTransfer(lat, lon, siteKm2);
  /**
   * Only a LONG donor may override the model. The grade no longer decides it.
   *
   * The original bar was 'close' — catchment within a factor of two, within 25
   * km — plus MIN_TRANSFER_YEARS of record, and it was set from ten built
   * plants: a long record on the same river took Khimti from 42% out to 3%,
   * while a FIVE-year record on a neighbouring khola sent Chilime from 9% out
   * to 79%. Both bars were introduced together on that evidence.
   *
   * Leave-one-out across 94 gauges (checks/transfer-loo.mjs) says the record
   * length was carrying the argument and the grade was riding along. Asked to
   * predict a gauge it could not see, with a 10+ year donor:
   *
   *              n   median   typ.err   within 2x
   *   close     21    1.05x     1.46x       76%
   *   usable    44    1.01x     1.38x       91%
   *   both      65    1.02x     1.41x       86%
   *
   * The grade the app trusted scored WORSE than the grade it refused, and not
   * because of catchment size — 'close' donors sit on LARGER catchments here
   * (1185 km2 median against 988) and stay worse when both are restricted to
   * 500 km2 and up. Widening to 'usable' triples the sites a measurement can
   * reach, from 21 to 65, and improves both error and spread.
   *
   * 'indicative' stays excluded: it admits a tenfold area mismatch, and nothing
   * in this sample tests it.
   *
   * AND THEN THE FLEET REFUTED IT. Widening to 'usable' moved three cached
   * plants from the model onto a transferred record, and all three got worse.
   * Dwari Khola went from 6.69 MW against a licensed 3.8 to 0.68 — an
   * under-prediction by more than five times, which took the harness's
   * one-sided failure test from 0/8 to 1/8. Under-prediction is the dangerous
   * direction: it discards a viable site.
   *
   * WHY THE LEAVE-ONE-OUT WAS OPTIMISTIC, and it is the same trap this project
   * keeps finding. A gauge sits on a well-determined catchment — it snapped
   * cleanly, it is on a mapped channel, and the area used to scale the transfer
   * is close to right. A plant intake does not: its catchment comes from the
   * network and can be badly wrong. The transfer scales LINEARLY by the area
   * ratio, so an area error passes straight into the answer undamped. Testing
   * the rule only where the denominator is trustworthy measured the rule under
   * conditions it does not meet in use.
   *
   * So the bar stays at 'close'. The leave-one-out numbers above are still
   * correct about what they measured; they were the wrong thing to measure.
   */
  if (!transfer || !transferMeetsBar(transfer)) return null;
  const series = await loadStationSeries(transfer.station.id);
  if (!series || series.values.length < 730) return null; // under two years is not a regime
  const values = series.values.map((v) => v * transfer.ratio);
  return {
    transfer,
    dates: series.dates,
    values,
    meanCms: values.reduce((a, b) => a + b, 0) / values.length,
  };
}
