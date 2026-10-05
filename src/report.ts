/**
 * A submittable desk study, printed from the browser.
 *
 * WHY PRINT AND NOT A LIBRARY. The browser is a typesetter. jsPDF and docx each
 * add a dependency and produce a worse page than @page CSS does for free.
 *
 * ON THE TYPOGRAPHY, because it was got wrong once and the fix is a rule rather
 * than a taste. The first version boxed every cell in a 1 px black grid with
 * grey header fills — the default Word table — and it read as a spreadsheet
 * someone had printed. This version follows the convention every serious
 * technical publisher uses:
 *
 *   no vertical rules, ever. Columns are separated by alignment and space;
 *   three horizontal rules only — above the header, below it, and below the
 *   last row — the heavier ones bounding the table;
 *   numerals lining and tabular, numeric columns right-aligned, so decimal
 *   points stack and a reader can compare magnitudes down a column;
 *   key-value pairs are NOT tables. They are a definition list, because a
 *   two-column grid of boxes around eleven salient features is a cage around
 *   eleven facts.
 *
 * AND A CHART BEATS A SMALL TABLE. Twelve monthly means as twelve rows is data
 * a reader has to assemble in their head; as twelve bars it is a hydrograph
 * they read in one glance. Every table under about fifteen rows that carries a
 * shape rather than a set of lookups is drawn instead.
 *
 * WHAT IS DELIBERATELY ABSENT: sources, method and provenance. Those belong to
 * the Appendix that accompanies this document.
 *
 * FIGURES are captured from the live map by the caller and passed in as data
 * URLs; this module never touches the map itself.
 */
import type { ExportContext } from './export.ts';
import { geologySpans, type GeologyUnitHit } from './geology-units.ts';
import { stationDisplayName } from './gauges.ts';
import type { ConnectedGlacialLake } from './connectivity.ts';
import { buildFdc, minMonthlyMean, seasonalRatio } from './engine/hydro.ts';
import {
  pondageDemand,
  PONDAGE_REFERENCE_HOURS,
  type PondagePositionSweep,
} from './pondage.ts';
import { desander } from './engine/sediment.ts';
import type { DesignFlowSweep } from './engine/designflow.ts';

export type ReportMeta = {
  projectName: string;
  developer: string;
  consultant: string;
  /** Optional client/addressee. An official authority is never assumed. */
  submittedTo?: string[];
  reportId?: string;
  revision?: string;
  status?: string;
};

/** Map captures, as data URLs. Any may be absent; the section adapts. */
export type ReportFigures = {
  site?: string | null;
  topo?: string | null;
  satellite?: string | null;
  hazards?: string | null;
  geology?: string | null;
  /** The DHM stations on the ground, beside the alignment they might describe. */
  gauges?: string | null;
  /** Width of that figure's frame on the ground, km. */
  gaugeFrameKm?: number | null;
  /** The survey sheet at each structure, where contours can actually be read. */
  /** The upstream lakes, with every other layer switched off. */
  lakes?: string | null;
  lakeFrameKm?: number | null;
  /** How many of the connected lakes the frame actually holds, and of how many. */
  lakesShown?: number | null;
  lakesTotal?: number | null;
  /** The flow-path cut the frame used, when it used one. */
  lakesWithinKm?: number | null;
  /** Width of the hazard map's frame on the ground, km — the caption's scale. */
  hazardFrameKm?: number | null;
  /** How many stations the gauge figure could actually fit, and of how many. */
  gaugesShown?: number | null;
  gaugesTotal?: number | null;
  /** Mapped faults and recorded epicentres around the scheme. */
  seismic?: string | null;
  seismicFrameKm?: number | null;
  /** Transmission lines and substations around the scheme. */
  grid?: string | null;
  gridFrameKm?: number | null;
  /** Same for the geological sheet, which is deliberately framed much wider. */
  geologyFrameKm?: number | null;
  /**
   * Which published sheet the geology figure came off, and how well that sheet
   * is MEASURED to be placed - see checks/geology-georeference.py. Carried
   * beside the image rather than through ExportContext because it is a property
   * of the figure, not of the site.
   */
  geologySheet?: { province: string; placementKm: number | null; scale: string } | null;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!
  );

/** Numbers a reader can read. Non-finite becomes an en dash, never "NaN". */
const n = (v: number | null | undefined, dp = 2): string =>
  typeof v === 'number' && Number.isFinite(v)
    ? v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : '–';

/** Client-facing screening values are approximate; raw model output remains in appendices/exports. */
const approx = (v: number | null | undefined, dp = 1): string =>
  typeof v === 'number' && Number.isFinite(v) ? `~${n(v, dp)}` : '–';

const dms = (v: number, pos: string, neg: string): string => {
  if (!Number.isFinite(v)) return '–';
  const hemi = v >= 0 ? pos : neg;
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const sec = ((a - d) * 60 - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}′${sec.toFixed(1)}″${hemi}`;
};

/**
 * A distance a reader believes. The nearest 132 kV line at one real site is
 * 2.8 m from the powerhouse — true, but rounded to one decimal it prints
 * "0.0 km" and reads as a broken field. Below 100 m the honest unit is metres.
 */
const dist = (km: number | null | undefined): string =>
  typeof km !== 'number' || !Number.isFinite(km)
    ? '–'
    : km < 0.1
      ? `${Math.round(km * 1000)} m`
      : `${n(km, 1)} km`;

/** A CSS string literal. CSS wants \A for a newline, not JSON's \n. */
const cssStr = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

type Row = string[];

const meanAtIntake = (c: ExportContext): number => c.flowMeanCms * (c.selected?.flowScale ?? 1);

/** Catchment at the INTAKE vertex, not at the click — they differ by a lot. */
function catchmentKm2(c: ExportContext): number | null {
  const i = c.selected?.i;
  const v = typeof i === 'number' ? c.path[i]?.uplandKm2 : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * WHICH UPSTREAM LAKES CARRY A PUBLISHED DANGER SIGNAL.
 *
 * Lifted out of the report body so it can be tested directly. It was inline
 * once, and inline it was WRONG in the only direction that matters: it filtered
 * on `areaHa ?? areaKm2 * 100 ?? 0` through an `as unknown as` cast, and
 * `ConnectedGlacialLake` carries neither field — the builder keeps centroids and
 * drops the polygons. Area was therefore 0 on every lake, the risky set was
 * empty on every site, and the report printed "none is both large and close"
 * whatever sat upstream. A hazard screen failing OPEN, hidden from the compiler
 * by the cast, and unnoticed because the safe branch is the one that renders on
 * almost every site.
 *
 * It now screens on what the inventory actually publishes, which is better
 * evidence than an area threshold anyway:
 *
 *   LISTED — ICIMOD's 2020 assessment of 47 potentially dangerous glacial
 *   lakes has judged dam type, source glacier and surroundings. No area figure
 *   can see any of that.
 *
 *   GROWING — a glacier-fed lake with a significant published expansion trend
 *   is the remotely-sensed version of the same worry. Non-glacier-fed lakes are
 *   excluded because the mechanism is not there, and lakes the source flags as
 *   time-series outliers are excluded because the trend is not trusted by the
 *   people who measured it.
 *
 * AREA IS STILL THE MISSING TERM and it is worth having: a 2 ha pond and a
 * 200 ha lake at the same distance are not the same question. Restoring it means
 * adding the area column to `pipeline/build-glacial-lakes.mjs` and re-running it.
 * Until then the report says so rather than implying the screen is complete.
 */
export const GLOF_ROUTE_KM = 60;

export function glofDangerSignals(lakes: readonly ConnectedGlacialLake[]): {
  listed: ConnectedGlacialLake[];
  growing: ConnectedGlacialLake[];
  risky: ConnectedGlacialLake[];
} {
  const near = lakes.filter((l) => l.routeKm <= GLOF_ROUTE_KM);
  const listed = near.filter((l) => l.pdgl != null);
  const growing = near.filter(
    (l) =>
      l.pdgl == null &&
      l.connectivity === 'Glacier-fed' &&
      l.expansionSignificant === true &&
      (l.expansionRateKm2Yr ?? 0) > 0 &&
      l.timeSeriesOutlier !== true
  );
  return { listed, growing, risky: [...listed, ...growing] };
}

/**
 * WHERE THE WATER WOULD HAVE TO COME FROM.
 *
 * Every flow figure in this app arrives from a model or a regression, and none
 * of them is required to respect the one constraint that is not negotiable: a
 * catchment cannot deliver much more water than falls on it. Rain in, runoff
 * out. It is arithmetic on three numbers the report already printed in three
 * separate places, which is exactly why nobody had put them together.
 *
 * IT CAUGHT A LIVE SITE. At 27.65 N, 85.90 E the app shipped a modelled mean of
 * 1.70 m3/s on a mapped 5.5 km2 catchment with 1,589 mm of rain - a runoff
 * coefficient of 6.2, where the mapped network said 0.20 m3/s and Modified
 * HYDEST said 0.67. A 5.5 km2 catchment sits well inside one ~5 km GloFAS cell,
 * so the cell was draining something much larger, and `flowchoice.ts` chose it
 * anyway because it only ever compares the candidates against each other.
 *
 * THE CEILING IS 2.0, AND IT IS MEASURED, NOT PHYSICAL. The obvious bound is
 * 1.0, and 1.0 is wrong for Nepal. `checks/waterbalance-vs-fleet.mjs` scores the
 * coefficient of the MEASURED mean at 69 DHM gauges with ten or more complete
 * years, and the median is 0.87 with a maximum of 1.89. The whole country runs
 * near 1 - roughly 225 km3/yr off 147,181 km2 is about 1,530 mm of runoff
 * against about 1,600 mm of rain - so 1.0 sits in the middle of the
 * distribution, not above it.
 *
 * SNOW AND ICE MELT WAS THE OBVIOUS EXPLANATION FOR THE TAIL, AND IT WAS TESTED
 * AND IS NOT IT. Ranked against the share of catchment above 5,000 m - the
 * hypsometry WECS/DHM already uses, and the best proxy for perennial ice the app
 * holds - the measured coefficient correlates at only rho 0.26, and rho 0.32
 * against mean catchment altitude. The Surnagad gauges have NO ground above
 * 5,000 m at all, at mean altitudes of 1,900 and 1,782 m, and still read 1.31
 * and 1.08; the most glaciated band, over 20% above 5,000 m, tops out at 1.61
 * against 1.89 for the 5-20% band. A two-tier ceiling would need 1.52 for low
 * catchments and 1.89 for high ones, which is not a separation worth a rule.
 *
 * So the tail is spread in the INPUTS - a ~5 km climatology cannot resolve
 * orographic gradients, its rain gauges sit in valleys, and MERIT's area carries
 * its own error - and one empirical constant is all the evidence supports.
 *
 *   ceiling   fires on measured gauges   fires on the fleet
 *     1.00          22/69 = 31.9%          100/168 = 59.5%
 *     1.50           5/69 =  7.2%           22/168 = 13.1%
 *     2.00           0/69 =  0.0%            5/168 =  3.0%
 *
 * So a ceiling of 1.0 would call a third of Nepal's gauged rivers impossible.
 * 2.0 is the first round number above everything 69 measured records show, it
 * fires on 3% of the commissioned fleet, and it still catches the site above by
 * a factor of three. The constant is set by the gauge population against a
 * zero-false-positive target - not tuned until one site behaved.
 *
 * RAINFALL MUST BE THE SAME QUANTITY THE CEILING WAS FITTED TO. That is
 * `catchmentRainMm`: CHPclim's catchment-mean ANNUAL total, off the bundled
 * network. An earlier version preferred the private isohyet layer and otherwise
 * grossed up WECS/DHM's monsoon figure, and both are a different quantity -
 * the isohyet is a point band, and the monsoon share ranges 0.65 to 0.83 across
 * these same gauges, so a fixed gross-up carries 15% of its own. Where the
 * annual figure is absent this returns null and the row simply does not print,
 * which is better than printing a number the ceiling does not apply to.
 *
 * WHAT IT IS NOT. Above the ceiling is not proof of an error, and this does not
 * refuse anything: `flowchoice.ts` is untouched, so no measured result moves.
 * It is a disclosure - the report says what the arithmetic implies and leaves
 * the reader to weigh it.
 */
export const RUNOFF_PLAUSIBLE_MAX = 2.0;
/** Median at 69 gauges is 0.87; above this is high but well inside the record. */
const RUNOFF_TYPICAL_MAX = 1.2;
const SECONDS_PER_YEAR = 31_556_952;

export function waterBalance(c: ExportContext): {
  runoffMm: number;
  rainfallMm: number;
  coefficient: number;
  ceilingCms: number;
} | null {
  const areaKm2 = catchmentKm2(c);
  const meanCms = meanAtIntake(c);
  const rainfallMm = c.catchmentRainMm ?? null;
  if (!(areaKm2 && areaKm2 > 0) || !(meanCms > 0) || !(rainfallMm && rainfallMm > 0)) return null;

  const areaM2 = areaKm2 * 1e6;
  const runoffMm = (meanCms * SECONDS_PER_YEAR * 1000) / areaM2;
  return {
    runoffMm,
    rainfallMm,
    coefficient: runoffMm / rainfallMm,
    ceilingCms: ((rainfallMm * RUNOFF_PLAUSIBLE_MAX) / 1000) * areaM2 / SECONDS_PER_YEAR,
  };
}

/**
 * A VOLTAGE OF ZERO IS NOT A VOLTAGE, IT IS A MISSING TAG.
 *
 * `grid.ts` initialises `nearestKv` to 0 and OpenStreetMap frequently maps a
 * transmission line without a `voltage` tag, so a real line with an unknown
 * rating printed as "0 kV" — twice on the same page of a sample report, next to
 * "Nearest substation unnamed · 33.4 km at 0 kV". A reader who knows the grid
 * sees a number that cannot exist and stops trusting the page, and they are
 * right to: the line is there, the app simply does not know its rating.
 *
 * Saying so is both honest and more useful, because "voltage not tagged" tells
 * the reader what to go and check.
 */
const kv = (v: number | null | undefined): string =>
  typeof v === 'number' && v > 0 ? `${n(v, 0)} kV` : 'voltage not tagged in the mapped data';

const kmOf = (m: number | null | undefined) =>
  typeof m === 'number' && Number.isFinite(m) ? m / 1000 : null;

/** Diagonal of a DoED published coordinate range — the licence, not a length. */
function publishedRangeKm(bounds: readonly number[] | null | undefined): number | null {
  if (!bounds || bounds.length < 4) return null;
  const [s0, w0, n0, e0] = bounds;
  const d = Math.hypot((e0 - w0) * 111.32 * Math.cos((((n0 + s0) / 2) * Math.PI) / 180), (n0 - s0) * 111.32);
  return Number.isFinite(d) ? d : null;
}

// ---------------------------------------------------------------------------
// Typographic building blocks
// ---------------------------------------------------------------------------

let tableNo = 0;
let figureNo = 0;

/** Right-align a column when every value in it reads as a quantity. */
const numeric = (v: string) => /^[–\-+]?[\d.,]+\s*(%|m|km|ha|kV|MW|GWh|m³\/s|million m³|m\/km)?$/.test(v.trim());

function table(caption: string, head: Row, rows: Row[]): string {
  if (!rows.length) return '';
  tableNo += 1;
  const cols = head.length;
  const right: boolean[] = [];
  for (let ci = 0; ci < cols; ci++) {
    right[ci] = ci > 0 && rows.every((r) => !r[ci] || numeric(r[ci]));
  }
  const cls = (ci: number) => (right[ci] ? ' class="num"' : '');
  // thead, so a table longer than the page breaks with its header repeating
  // rather than being pushed whole onto the next sheet and leaving a gap.
  const th = `<thead><tr>${head.map((h, ci) => `<th${cls(ci)}>${esc(h)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows
    .map((r) => `<tr>${r.map((v, ci) => `<td${cls(ci)}>${esc(v)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<div class="tw"><p class="cap">Table ${tableNo} · ${esc(caption)}</p><table>${th}${body}</table></div>`;
}

/**
 * A stated finding, not an empty column.
 *
 * The report used to print "0 glacial lakes upstream drain through the site,
 * from an inventory of 4152" and leave the reader to work out that this means
 * GLOF is not a design case here. Worse, several sections rendered a table
 * header over no rows. A screening document exists to answer questions, so
 * every screen now ends in a sentence that answers its own, and a table appears
 * only when there is something in it.
 *
 * `clear` is a screen that came back negative; `watch` is one that found
 * something the reader must not skim past.
 */
/**
 * FOUR RECORD TYPES, BECAUSE THREE LABELS WERE DOING FIVE JOBS.
 *
 * `note` used to render as "Limitation", and `note` is what most of this file
 * reaches for when it has an ordinary, neutral, often REASSURING result to
 * state. So "no mapped active fault intersects the corridor", "the scheme lies
 * outside every protected area" and "both structures are on the road network"
 * were all stamped LIMITATION — a document telling the reader its good news was
 * a shortcoming. Counted on a real site, 27 of the 29 badges in sixteen pages
 * read as a warning or an apology, and eight of those were findings in the
 * project's favour.
 *
 * The fix is not to soften the caveats; it is to stop calling a result a
 * caveat. `note` states what the screen found. `limit` is kept for the places
 * where the honest content really is the boundary of the method, and those are
 * now few enough to carry weight when they appear.
 */
const finding = (tone: 'clear' | 'watch' | 'note' | 'limit', html: string) =>
  `<aside class="finding ${tone}"><div class="finding-label">${
    tone === 'clear'
      ? 'Key finding'
      : tone === 'watch'
        ? 'Required field verification'
        : tone === 'limit'
          ? 'Scope limitation'
          : 'Screening result'
  }</div><div class="finding-body">${html}</div></aside>`;

/** Key-value facts as a definition list. Not a grid; a grid is a cage. */
function facts(rows: [string, string][]): string {
  if (!rows.length) return '';
  return `<dl class="facts">${rows
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join('')}</dl>`;
}

function figure(caption: string, dataUrl: string | null | undefined): string {
  if (!dataUrl) return '';
  figureNo += 1;
  return `<figure><img src="${dataUrl}" alt="${esc(caption)}"><figcaption>Figure ${figureNo} · ${esc(caption)}</figcaption></figure>`;
}

/**
 * A chart and its caption are one block.
 *
 * Emitting them as siblings let a page break fall between: the flow-duration
 * curve printed at the foot of one page and its caption at the head of the
 * next, above an unrelated chart, so both figures were mislabelled.
 */
const chartBlock = (svg: string, caption: string): string =>
  svg ? `<figure class="cw">${svg}<figcaption>Figure ${(figureNo += 1)} · ${esc(caption)}</figcaption></figure>` : '';

/**
 * The working, substituted.
 *
 * A reader asked how the capacity was arrived at and the report did not say —
 * it printed 0.937 MW as if it had been handed down. That is a fair complaint
 * about an engineering document: the equation is standard, so showing it costs
 * nothing and withholding it makes the number unauditable.
 *
 * This is NOT provenance. Where the flow came from belongs to the Appendix;
 * what was done with it belongs here, beside the answer.
 */
function basisOfCalculation(c: ExportContext): string {
  const s = c.selected;
  if (!s) return '';
  const RHO = 1000;
  const G = 9.81;
  const etaPlant = c.assumptions?.efficiency ?? 0;
  // engine/discover.ts multiplies the plant efficiency by the turbine's own
  // efficiency AT THE DESIGN FLOW, not at its best point. Both appear here or
  // the arithmetic below would not close.
  const etaTurb = s.turbinePeak;
  const lossM = s.grossHeadM - s.netHeadM;
  const watts = RHO * G * s.designFlowCms * s.netHeadM * etaPlant * etaTurb;
  const row = (lhs: string, rhs: string) =>
    `<div class="eqrow"><span>${lhs}</span><b>${rhs}</b></div>`;
  return `<div class="eq">
    <div class="eqhead">Net head</div>
    ${row('H<sub>net</sub> = H<sub>gross</sub> − h<sub>loss</sub>', `${n(s.grossHeadM, 1)} − ${n(lossM, 1)} = <u>${n(s.netHeadM, 1)} m</u>`)}
    <div class="eqhead">Rated capacity</div>
    ${row('P = ρ · g · Q · H<sub>net</sub> · η<sub>plant</sub> · η<sub>turbine</sub>', '')}
    ${row(
      `${RHO} × ${G} × ${n(s.designFlowCms, 3)} × ${n(s.netHeadM, 1)} × ${n(etaPlant, 3)} × ${n(etaTurb, 3)}`,
      `<u>${n(watts / 1e6, 3)} MW</u>`
    )}
    <div class="eqhead">Annual energy</div>
    ${row(
      'E = Σ P(Q<sub>day</sub>) · 24 h, over ' + c.flowYears + ' years of daily record',
      `<u>${n(s.energyGwh, 2)} GWh/yr</u>`
    )}
    ${row(
      'Plant factor = E / (P × 8 760 h)',
      `${n(s.energyGwh * 1000, 0)} / (${n(s.capacityMW, 3)} × 8 760) = <u>${n(s.plantFactor * 100, 1)} %</u>`
    )}
  </div>
  <p class="eqnote">Flow is capped at the design flow and cut off below the turbine minimum, so
  E is a dispatch sum over the record rather than the rated power times a duration.
  ρ = 1 000 kg/m³ and g = 9.81 m/s² follow the ESHA convention.</p>`;
}

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

const AX = 'font:9px Inter,Helvetica,Arial,sans-serif;fill:#5c6670';
const LB = 'font:9px Inter,Helvetica,Arial,sans-serif;fill:#8b949c;letter-spacing:.08em';
/** Axis NUMBERS, darker than axis furniture: they are read, not glanced at. */
const AXD = 'font:9px Inter,Helvetica,Arial,sans-serif;fill:#3b444c';

/** Flow-duration curve: log discharge, linear exceedance, design point marked. */
function fdcSvg(values: readonly number[], designQ: number | null, exceedance: number): string {
  const pts = buildFdc(values).filter((f) => f.q > 0);
  if (pts.length < 8) return '';
  const W = 540;
  const Hh = 250;
  const L = 56;
  const B = 40;
  const lo = Math.log10(Math.max(1e-4, pts[pts.length - 1].q));
  const hi = Math.log10(pts[0].q);
  const span = Math.max(0.5, hi - lo);
  const x = (p: number) => L + p * (W - L - 16);
  const y = (q: number) => Hh - B - ((Math.log10(Math.max(1e-4, q)) - lo) / span) * (Hh - B - 18);
  const line = pts.map((f, i) => `${i ? 'L' : 'M'}${x(f.p).toFixed(1)},${y(f.q).toFixed(1)}`).join('');
  const area = `M${x(0).toFixed(1)},${(Hh - B).toFixed(1)}${line.slice(1)}L${x(1).toFixed(1)},${(Hh - B).toFixed(1)}Z`;

  const g: string[] = [];
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
    const q = 10 ** e;
    const yy = y(q);
    if (yy < 16 || yy > Hh - B) continue;
    g.push(
      `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - 16}" y2="${yy.toFixed(1)}" stroke="#e6e9ec"/>` +
        `<text x="${L - 8}" y="${(yy + 3).toFixed(1)}" style="${AX}" text-anchor="end">${q >= 1 ? q : q.toFixed(Math.abs(e))}</text>`
    );
  }
  for (let p = 0; p <= 1.0001; p += 0.25) {
    g.push(
      `<text x="${x(p).toFixed(1)}" y="${Hh - B + 16}" style="${AX}" text-anchor="middle">${(p * 100).toFixed(0)}%</text>`
    );
  }

  const mk =
    designQ && designQ > 0
      ? `<line x1="${x(exceedance).toFixed(1)}" y1="16" x2="${x(exceedance).toFixed(1)}" y2="${Hh - B}" stroke="#0f4c5c" stroke-width="1" stroke-dasharray="4 3"/>` +
        `<circle cx="${x(exceedance).toFixed(1)}" cy="${y(designQ).toFixed(1)}" r="4" fill="#0f4c5c"/>` +
        `<text x="${(x(exceedance) + 9).toFixed(1)}" y="${(y(designQ) - 9).toFixed(1)}" style="font:10px Inter,Helvetica,Arial,sans-serif;fill:#0f4c5c;font-weight:600">Q${Math.round(exceedance * 100)} · ${designQ.toFixed(2)} m³/s</text>`
      : '';

  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  ${g.join('')}
  <path d="${area}" fill="#0f4c5c" opacity=".07"/>
  <path d="${line}" fill="none" stroke="#0f4c5c" stroke-width="1.8"/>
  ${mk}
  <line x1="${L}" y1="${Hh - B}" x2="${W - 16}" y2="${Hh - B}" stroke="#9aa2aa"/>
  <text x="${(W / 2).toFixed(0)}" y="${Hh - 6}" style="${LB}" text-anchor="middle">TIME EQUALLED OR EXCEEDED</text>
  <text x="13" y="${(Hh / 2).toFixed(0)}" style="${LB}" text-anchor="middle" transform="rotate(-90 13 ${(Hh / 2).toFixed(0)})">DISCHARGE  m³/s</text>
</svg>`;
}

/**
 * Energy against the machine that earns it.
 *
 * Capacity on x deliberately, not exceedance: capacity is what a developer buys
 * and what a cost is quoted per, so the flattening of this curve IS the
 * diminishing return, read straight off the page. Plotting exceedance instead
 * puts the interesting bend in a corner and hides it.
 *
 * The dry-season bar is drawn where it falls, because for a scheme that misses
 * it the whole chart is really about that one vertical line.
 */
function designFlowSvg(sweep: DesignFlowSweep): string {
  const pts = sweep.points;
  if (pts.length < 3) return '';
  const W = 540;
  const Hh = 250;
  const L = 60;
  const B = 40;
  const pLo = pts[0].capacityMW;
  const pHi = pts[pts.length - 1].capacityMW;
  const eHi = Math.max(...pts.map((q) => q.energyGwh));
  if (!(pHi > pLo) || !(eHi > 0)) return '';
  const x = (mw: number) => L + ((mw - pLo) / (pHi - pLo)) * (W - L - 18);
  const y = (gwh: number) => Hh - B - (gwh / eHi) * (Hh - B - 22);

  const g: string[] = [];
  for (let k = 0; k <= 4; k++) {
    const gwh = (eHi * k) / 4;
    const yy = y(gwh);
    g.push(
      `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - 18}" y2="${yy.toFixed(1)}" stroke="#e6e9ec"/>` +
        `<text x="${L - 8}" y="${(yy + 3).toFixed(1)}" style="${AX}" text-anchor="end">${gwh.toFixed(gwh < 10 ? 1 : 0)}</text>`
    );
  }
  for (let k = 0; k <= 4; k++) {
    const mw = pLo + ((pHi - pLo) * k) / 4;
    g.push(
      `<text x="${x(mw).toFixed(1)}" y="${Hh - B + 16}" style="${AX}" text-anchor="middle">${mw.toFixed(mw < 10 ? 1 : 0)}</text>`
    );
  }

  const line = pts
    .map((q, i) => `${i ? 'L' : 'M'}${x(q.capacityMW).toFixed(1)},${y(q.energyGwh).toFixed(1)}`)
    .join('');
  const dots = pts
    .map((q) => `<circle cx="${x(q.capacityMW).toFixed(1)}" cy="${y(q.energyGwh).toFixed(1)}" r="2.4" fill="#0f4c5c" opacity=".5"/>`)
    .join('');

  /**
   * LABELS FLIP RATHER THAN COLLIDE.
   *
   * Both markers sit wherever the arithmetic puts them, which on the first real
   * site was hard against the left axis: "as designed · Q40" was anchored to the
   * END and ran backwards straight through the "1061" gridline label. A fixed
   * side works until the scheme moves, and the scheme always moves.
   */
  const bar = sweep.dryLimitSixSix;
  const barLeft = bar ? x(bar.capacityMW) : 0;
  const barFlip = barLeft > W * 0.62;
  const barMark = bar
    ? `<line x1="${barLeft.toFixed(1)}" y1="20" x2="${barLeft.toFixed(1)}" y2="${Hh - B}" stroke="#a8562f" stroke-width="1" stroke-dasharray="4 3"/>` +
      `<text x="${(barLeft + (barFlip ? -6 : 6)).toFixed(1)}" y="30" style="font:9.5px Inter,Helvetica,Arial,sans-serif;fill:#a8562f;font-weight:600" text-anchor="${barFlip ? 'end' : 'start'}">30% dry-season screen</text>`
    : '';

  const c = sweep.chosen;
  const cx = c ? x(c.capacityMW) : 0;
  const cFlip = cx < W * 0.42;
  const chosen = c
    ? `<circle cx="${cx.toFixed(1)}" cy="${y(c.energyGwh).toFixed(1)}" r="4.5" fill="#0f4c5c"/>` +
      `<text x="${(cx + (cFlip ? 9 : -9)).toFixed(1)}" y="${(y(c.energyGwh) + 14).toFixed(1)}" style="font:10px Inter,Helvetica,Arial,sans-serif;fill:#0f4c5c;font-weight:600" text-anchor="${cFlip ? 'start' : 'end'}">screening reference · Q${Math.round(c.exceedance * 100)}</text>`
    : '';

  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  ${g.join('')}
  <path d="${line}" fill="none" stroke="#0f4c5c" stroke-width="1.8"/>
  ${dots}
  ${barMark}
  ${chosen}
  <line x1="${L}" y1="${Hh - B}" x2="${W - 18}" y2="${Hh - B}" stroke="#9aa2aa"/>
  <text x="${(W / 2).toFixed(0)}" y="${Hh - 6}" style="${LB}" text-anchor="middle">INSTALLED CAPACITY  MW</text>
  <text x="14" y="${(Hh / 2).toFixed(0)}" style="${LB}" text-anchor="middle" transform="rotate(-90 14 ${(Hh / 2).toFixed(0)})">ANNUAL ENERGY  GWh</text>
</svg>`;
}


/**
 * How many hazard records the appendix prints.
 *
 * It was a bare 40 inside the slice while the section above it promised "every
 * record ... is listed in the appendices". At the first real site that was 40 of
 * 128, and the sentence was simply untrue. Named here so the prose can quote
 * the same number the table obeys.
 */
const HAZARD_APPENDIX_ROWS = 15;

/** The band, in km either side of the river, that counts as "at the works". */
const NEAR_CORRIDOR_KM = 2;

/**
 * Where along the reach the storage is, per metre of dam.
 *
 * Bars, not a line: these are nine separate screens of nine separate valleys,
 * not samples of one continuous function, and a line between them would imply
 * an interpolation the terrain does not support.
 */
function pondagePositionSvg(sweep: PondagePositionSweep): string {
  const pts = sweep.points.filter((q) => q.volumePerDamMetreM3 !== null);
  if (pts.length < 3) return '';
  const W = 540;
  const Hh = 236;
  const L = 66;
  const R = 20;
  const T = 24;
  const B = 46;
  const hi = Math.max(...pts.map((q) => q.volumePerDamMetreM3!));
  if (!(hi > 0)) return '';
  const lo = Math.min(...pts.map((q) => q.offsetKm));
  const up = Math.max(...pts.map((q) => q.offsetKm));
  const span = Math.max(0.2, up - lo);
  const bw = Math.max(6, ((W - L - R) / pts.length) * 0.62);
  /**
   * INSET BY HALF A BAR AT EACH END.
   *
   * The intake sits at offset 0, which is the domain minimum, so without this
   * its bar is centred exactly on the axis line and half of it hangs into the
   * left margin — straight over the y-axis numbers, which are drawn at L-8.
   * On the first printed report that hid "2.7k", "1.8k" and "899" completely
   * behind the tallest bar, and a reader said so: the marks on the left could
   * not be seen. They were there; the bar was on top of them.
   */
  const x = (km: number) => L + bw / 2 + ((km - lo) / span) * (W - L - R - bw);
  const y = (v: number) => Hh - B - (v / hi) * (Hh - B - T);

  const g: string[] = [];
  for (let k = 0; k <= 3; k++) {
    const v = (hi * k) / 3;
    const yy = y(v);
    g.push(
      `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - R}" y2="${yy.toFixed(1)}" stroke="#eef0f2"/>` +
        `<text x="${L - 8}" y="${(yy + 3).toFixed(1)}" style="${AXD}" text-anchor="end">${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}</text>`
    );
  }

  const bars = pts
    .map((q) => {
      const isCurrent = sweep.current != null && q.i === sweep.current.i;
      const isBest = sweep.best != null && q.i === sweep.best.i;
      const ink = isCurrent ? '#0f4c5c' : isBest ? '#c9a227' : '#9fb4bd';
      const top = y(q.volumePerDamMetreM3!);
      return (
        `<rect x="${(x(q.offsetKm) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${(Hh - B - top).toFixed(1)}" fill="${ink}" fill-opacity="${q.edgeLimited ? '.35' : '.9'}"${q.edgeLimited ? ' stroke="#9fb4bd" stroke-dasharray="2 2"' : ''}/>`
      );
    })
    .join('');

  const tag = (q: typeof pts[number] | null, label: string, ink: string) =>
    q && q.volumePerDamMetreM3 !== null
      ? `<text x="${x(q.offsetKm).toFixed(1)}" y="${(y(q.volumePerDamMetreM3) - 6).toFixed(1)}" style="font:9px Inter,Helvetica,Arial,sans-serif;fill:${ink};font-weight:700" text-anchor="middle">${label}</text>`
      : '';

  const ticks = pts
    .map(
      (q) =>
        `<text x="${x(q.offsetKm).toFixed(1)}" y="${Hh - B + 15}" style="${AX}" text-anchor="middle">${q.offsetKm >= 0 ? '+' : ''}${q.offsetKm.toFixed(1)}</text>`
    )
    .join('');

  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  ${g.join('')}
  ${bars}
  ${tag(sweep.current, 'as sited', '#0f4c5c')}
  ${tag(sweep.best && sweep.best.i !== sweep.current?.i ? sweep.best : null, 'best', '#8a6f16')}
  ${ticks}
  <line x1="${L}" y1="${Hh - B}" x2="${W - R}" y2="${Hh - B}" stroke="#9aa2aa"/>
  <text x="${(W / 2).toFixed(0)}" y="${Hh - 6}" style="${LB}" text-anchor="middle">POSITION ALONG THE RIVER, km FROM THE INTAKE</text>
  <text x="13" y="${((Hh - B + T) / 2).toFixed(0)}" style="${LB}" text-anchor="middle" transform="rotate(-90 13 ${((Hh - B + T) / 2).toFixed(0)})">m³ HELD PER METRE OF DAM</text>
</svg>`;
}

/**
 * Which gauge record can actually be carried to this intake.
 *
 * The obvious visual for a set of gauging stations is a map, and it would be
 * the wrong one. Distance is the least important thing about a gauge: a
 * discharge record on a catchment the same size as yours is worth having from
 * twenty kilometres away, and a record on a catchment ten times bigger is worth
 * little from one. What decides it is the AREA RATIO — Q here = Q gauge x (A
 * here / A gauge) — and standard practice keeps that inside roughly 0.5-2x.
 *
 * So the axis is the ratio, on a log scale because 0.5x and 2x are the same
 * distance from 1 and a linear axis would say otherwise. The defensible window
 * is drawn as a band, 1.0 as a line, and each station sits where its own
 * catchment puts it. A filled marker gauges DISCHARGE; a hollow one gauges
 * water level only and is not a flow series until its rating curve is obtained
 * separately, which is a different and slower errand.
 *
 * Read it in one pass: anything filled and inside the band is a record worth
 * writing to DHM for.
 */
// A decade either side of the defensible window, clamped so one freak ratio
// cannot squeeze every other station into a single pixel.
const LO = 0.1;
const HI = 10;

function gaugeTransferSvg(gauges: readonly ExportContext['gauges'][number][]): string {
  const plot = gauges.filter(
    (g) => typeof g.areaRatio === 'number' && Number.isFinite(g.areaRatio) && g.areaRatio > 0
  );
  if (plot.length < 2) return '';
  /**
   * WITHDRAW WHEN EVERY POINT IS OFF-SCALE.
   *
   * The axis spans a decade either side of 1. On a small tributary beside big
   * gauged rivers every ratio is ~0.00, every marker clamps to the left edge,
   * and the figure becomes a column of dots against the axis saying nothing the
   * table's Transfer column has not already said in words. A reader told me it
   * was incomprehensible and they were right. A chart that cannot separate its
   * own points is not a chart, so it stands down and the finding carries the
   * verdict instead.
   */
  if (!plot.some((g) => g.areaRatio! >= LO && g.areaRatio! <= HI)) return '';
  const rows = plot.slice(0, 8);

  const W = 540;
  const ROW = 24;
  // Room for two stacked headers: the legend, then the band's own label. At 34
  // they overlapped and "water level only" printed through "TRANSFER
  // DEFENSIBLE".
  const T = 50;
  const B = 34;
  const LABEL = 168;
  // The distance column needs its own space, or a station clamped to the right
  // edge of the axis prints on top of its own kilometres.
  const R = 80;
  const Hh = T + rows.length * ROW + B;

  const clamp = (v: number) => Math.min(HI, Math.max(LO, v));
  const pinned = (v: number) => v > HI || v < LO;
  const x = (ratio: number) =>
    LABEL +
    ((Math.log10(clamp(ratio)) - Math.log10(LO)) / (Math.log10(HI) - Math.log10(LO))) *
      (W - LABEL - R);

  const parts: string[] = [];

  // The window transfer is defensible in, behind everything.
  parts.push(
    `<rect x="${x(0.5).toFixed(1)}" y="${(T - 8).toFixed(1)}" width="${(x(2) - x(0.5)).toFixed(1)}" height="${(rows.length * ROW + 10).toFixed(1)}" fill="#eef4ef"/>`
  );
  parts.push(
    `<text x="${((x(0.5) + x(2)) / 2).toFixed(1)}" y="${(T - 16).toFixed(1)}" style="font:8px Inter,Helvetica,Arial,sans-serif;fill:#5f8168;letter-spacing:.06em" text-anchor="middle">TRANSFER DEFENSIBLE</text>`
  );
  for (const t of [0.1, 0.5, 1, 2, 10]) {
    parts.push(
      `<line x1="${x(t).toFixed(1)}" y1="${(T - 8).toFixed(1)}" x2="${x(t).toFixed(1)}" y2="${(T + rows.length * ROW + 2).toFixed(1)}" stroke="${t === 1 ? '#5f8168' : '#e4e8ea'}" stroke-width="1"${t === 1 ? '' : ' stroke-dasharray="2 2"'}/>` +
        `<text x="${x(t).toFixed(1)}" y="${(T + rows.length * ROW + 15).toFixed(1)}" style="${AX}" text-anchor="middle">${t < 1 ? `×${t}` : `×${t}`}</text>`
    );
  }

  rows.forEach((g, k) => {
    const yy = T + k * ROW + ROW / 2;
    const usable = g.measuresDischarge && g.trustworthy;
    const ink = usable ? '#0f4c5c' : g.measuresDischarge ? '#8fa8b2' : '#b8c2c8';
    const clean = stationDisplayName(g.name).name;
    const name = clean.length > 30 ? `${clean.slice(0, 29)}…` : clean;
    parts.push(
      `<text x="${(LABEL - 10).toFixed(1)}" y="${(yy + 3.2).toFixed(1)}" style="font:8.5px Inter,Helvetica,Arial,sans-serif;fill:${usable ? '#1a1d20' : '#6b7379'}" text-anchor="end">${esc(name)}</text>` +
        // A hairline to the marker, so the eye can cross 200 px of white.
        `<line x1="${LABEL}" y1="${yy.toFixed(1)}" x2="${(W - R).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#f2f4f5"/>` +
        // A station beyond the axis is drawn ON the edge with a chevron, so
        // "pinned here" never reads as "measured here". The table beside this
        // carries its real ratio.
        (pinned(g.areaRatio!)
          ? `<path d="M${(x(g.areaRatio!) + (g.areaRatio! > HI ? 8 : -8)).toFixed(1)},${yy.toFixed(1)}l${g.areaRatio! > HI ? '-6,-4v8z' : '6,-4v8z'}" fill="${ink}" opacity=".6"/>`
          : '') +
        (g.measuresDischarge
          ? `<circle cx="${x(g.areaRatio!).toFixed(1)}" cy="${yy.toFixed(1)}" r="4.6" fill="${ink}" stroke="#ffffff" stroke-width="1"/>`
          : `<circle cx="${x(g.areaRatio!).toFixed(1)}" cy="${yy.toFixed(1)}" r="4.2" fill="#ffffff" stroke="${ink}" stroke-width="1.6"/>`) +
        `<text x="${(W - R + 18).toFixed(1)}" y="${(yy + 3.2).toFixed(1)}" style="${AX}">${dist(g.distanceKm)}</text>`
    );
  });

  parts.push(
    `<circle cx="${(LABEL + 4).toFixed(1)}" cy="11" r="4.2" fill="#0f4c5c"/>` +
      `<text x="${(LABEL + 13).toFixed(1)}" y="14" style="${AX}">gauges discharge</text>` +
      `<circle cx="${(LABEL + 116).toFixed(1)}" cy="11" r="4" fill="#ffffff" stroke="#b8c2c8" stroke-width="1.6"/>` +
      `<text x="${(LABEL + 125).toFixed(1)}" y="14" style="${AX}">water level only</text>`
  );

  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  ${parts.join('\n  ')}
  <text x="${((LABEL + W - R) / 2).toFixed(0)}" y="${Hh - 6}" style="${LB}" text-anchor="middle">CATCHMENT AT THE INTAKE ÷ CATCHMENT AT THE GAUGE</text>
  <text x="${(W - R + 18).toFixed(1)}" y="14" style="${AX}">distance</text>
</svg>`;
}

/** Interannual monthly envelope: seasonality and uncertainty belong on the same chart. */
function monthlyEnvelopeSvg(
  dates: readonly string[],
  values: readonly number[],
  scale: number,
  designQ: number | null,
  residualQ: number | null
): string {
  if (dates.length !== values.length || dates.length < 365) return '';
  const byYear = new Map<number, { sum: number[]; count: number[] }>();
  for (let i = 0; i < dates.length; i++) {
    const q = values[i] * scale;
    const match = String(dates[i]).match(/^(\d{4})-(\d{2})/);
    if (!match || !Number.isFinite(q)) continue;
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    if (!Number.isInteger(month) || month < 0 || month > 11) continue;
    const bucket = byYear.get(year) ?? { sum: Array(12).fill(0), count: Array(12).fill(0) };
    bucket.sum[month] += q;
    bucket.count[month] += 1;
    byYear.set(year, bucket);
  }
  const monthYears = Array.from({ length: 12 }, () => [] as number[]);
  for (const bucket of byYear.values()) {
    for (let month = 0; month < 12; month++) {
      if (bucket.count[month]) monthYears[month].push(bucket.sum[month] / bucket.count[month]);
    }
  }
  if (monthYears.some((month) => month.length < 3)) return '';
  const quantile = (input: readonly number[], p: number) => {
    const sorted = input.slice().sort((a, b) => a - b);
    const at = (sorted.length - 1) * p;
    const lo = Math.floor(at);
    const hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
  };
  const p10 = monthYears.map((month) => quantile(month, 0.1));
  const p50 = monthYears.map((month) => quantile(month, 0.5));
  const p90 = monthYears.map((month) => quantile(month, 0.9));
  const W = 540;
  const Hh = 228;
  const L = 56;
  const B = 36;
  const max = Math.max(...p90, designQ ?? 0) * 1.08 || 1;
  const bw = (W - L - 16) / 12;
  const x = (month: number) => L + bw * (month + 0.5);
  const y = (q: number) => Hh - B - (q / max) * (Hh - B - 30);
  const grid = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const yy = y(max * f);
      return `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - 16}" y2="${yy.toFixed(1)}" stroke="#e6e9ec"/><text x="${L - 8}" y="${(yy + 3).toFixed(1)}" style="${AX}" text-anchor="end">${max * f < 10 ? (max * f).toFixed(1) : (max * f).toFixed(0)}</text>`;
    })
    .join('');
  const drySeason = [0, 1, 2, 3, 10, 11]
    .map((month) => `<rect x="${(L + month * bw).toFixed(1)}" y="20" width="${bw.toFixed(1)}" height="${(Hh - B - 20).toFixed(1)}" fill="#b3541e" opacity=".035"/>`)
    .join('');
  const band =
    p90.map((q, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(q).toFixed(1)}`).join('') +
    p10
      .slice()
      .reverse()
      .map((q, reverseIndex) => `L${x(11 - reverseIndex).toFixed(1)},${y(q).toFixed(1)}`)
      .join('') +
    'Z';
  const median = p50.map((q, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(q).toFixed(1)}`).join('');
  const ticks = MONTHS.map((month, i) => `<text x="${x(i).toFixed(1)}" y="${Hh - B + 16}" style="${AX}" text-anchor="middle">${month}</text>`).join('');
  const markers = p50.map((q, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(q).toFixed(1)}" r="2.2" fill="#0f4c5c"/>`).join('');
  const reference = (q: number | null, label: string, colour: string, dash: string) => {
    if (q === null || !Number.isFinite(q) || q < 0 || q > max) return '';
    const yy = y(q);
    return `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - 16}" y2="${yy.toFixed(1)}" stroke="${colour}" stroke-width="1" stroke-dasharray="${dash}"/><text x="${W - 16}" y="${(yy - 4).toFixed(1)}" style="font:8.5px Inter,Helvetica,Arial,sans-serif;fill:${colour};font-weight:600" text-anchor="end">${label}</text>`;
  };
  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  ${drySeason}${grid}
  <path d="${band}" fill="#0f4c5c" opacity=".12"/>
  <path d="${median}" fill="none" stroke="#0f4c5c" stroke-width="2"/>
  ${markers}${ticks}
  ${reference(designQ, 'Q reference', '#0f4c5c', '5 3')}
  ${reference(residualQ, 'environmental release', '#b3541e', '2 3')}
  <line x1="${L}" y1="${Hh - B}" x2="${W - 16}" y2="${Hh - B}" stroke="#9aa2aa"/>
  <rect x="${L}" y="6" width="18" height="8" fill="#0f4c5c" opacity=".12"/><text x="${L + 24}" y="14" style="${AX}">P10–P90 monthly range</text>
  <line x1="${L + 156}" y1="10" x2="${L + 176}" y2="10" stroke="#0f4c5c" stroke-width="2"/><text x="${L + 182}" y="14" style="${AX}">median</text>
  <text x="13" y="${(Hh / 2).toFixed(0)}" style="${LB}" text-anchor="middle" transform="rotate(-90 13 ${(Hh / 2).toFixed(0)})">MONTHLY MEAN FLOW  m³/s</text>
</svg>`;
}

/** Composition strip for land-cover exposure; proportions, not a chainage map. */
function landcoverCompositionSvg(
  spans: readonly { code: number; label: string; km: number; share: number }[]
): string {
  const valid = spans.filter((span) => span.share > 0 && Number.isFinite(span.share));
  if (!valid.length) return '';
  const W = 540;
  const L = 18;
  const R = 18;
  const barY = 24;
  const barH = 24;
  const palette: Record<number, string> = {
    10: '#547a58',
    20: '#9db36a',
    30: '#b8a36b',
    40: '#c4a252',
    50: '#8c6b63',
    60: '#a89e8a',
    70: '#d8d6cf',
    80: '#5d8ea6',
    90: '#7aa7a0',
    95: '#8fa3b3',
    100: '#c1b8a0',
  };
  let cursor = L;
  const segments = valid
    .map((span) => {
      const width = span.share * (W - L - R);
      const colour = palette[span.code] ?? '#8b949c';
      const label = span.share >= 0.1
        ? `<text x="${(cursor + width / 2).toFixed(1)}" y="${barY + 16}" style="font:8px Inter,Helvetica,Arial,sans-serif;fill:#fff;font-weight:600" text-anchor="middle">${n(span.share * 100, 0)}%</text>`
        : '';
      const shape = `<rect x="${cursor.toFixed(1)}" y="${barY}" width="${width.toFixed(1)}" height="${barH}" fill="${colour}"/>${label}`;
      cursor += width;
      return shape;
    })
    .join('');
  const legend = valid
    .map((span, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = L + col * 252;
      const y = 68 + row * 20;
      const colour = palette[span.code] ?? '#8b949c';
      return `<rect x="${x}" y="${y - 8}" width="9" height="9" fill="${colour}"/><text x="${x + 15}" y="${y}" style="${AXD}">${esc(span.label)} · ${n(span.km, 1)} km · ${n(span.share * 100, 0)}%</text>`;
    })
    .join('');
  const Hh = 84 + Math.ceil(valid.length / 2) * 20;
  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  <text x="${L}" y="13" style="${LB}">ALIGNMENT COMPOSITION</text>
  ${segments}${legend}
</svg>`;
}

/**
 * Energy year by year, against the long-run median.
 *
 * A single "average annual energy" hides the thing a lender asks about first:
 * how far a bad year falls below a good one. Twenty bars and a P50 line answer
 * it without a sentence.
 */
function yearsSvg(years: readonly { year: number; gwh: number }[], p50: number, p90: number): string {
  if (years.length < 3) return '';
  const W = 540;
  const Hh = 200;
  const L = 46;
  const B = 32;
  const max = Math.max(...years.map((y) => y.gwh), p50) * 1.08 || 1;
  const bw = (W - L - 14) / years.length;
  const y = (g: number) => Hh - B - (g / max) * (Hh - B - 18);
  const bars = years
    .map((yr, i) => {
      const bx = L + i * bw + bw * 0.14;
      const bwid = bw * 0.72;
      const lean = yr.gwh < p90;
      return (
        `<rect x="${bx.toFixed(1)}" y="${y(yr.gwh).toFixed(1)}" width="${bwid.toFixed(1)}" height="${(Hh - B - y(yr.gwh)).toFixed(1)}" fill="${lean ? '#b3541e' : '#0f4c5c'}" opacity="${lean ? 0.95 : 0.72}"/>` +
        (i % 3 === 0 || i === years.length - 1
          ? `<text x="${(bx + bwid / 2).toFixed(1)}" y="${Hh - B + 14}" style="${AX}" text-anchor="middle">${String(yr.year).slice(2)}</text>`
          : '')
      );
    })
    .join('');
  // P50 and P90 can sit within a few pixels of each other, so the lower label
  // goes BELOW its line rather than on top of the upper one.
  const mark = (g: number, label: string, colour: string, below: boolean) =>
    `<line x1="${L}" y1="${y(g).toFixed(1)}" x2="${W - 14}" y2="${y(g).toFixed(1)}" stroke="${colour}" stroke-width="1" stroke-dasharray="5 3"/>` +
    `<text x="${W - 14}" y="${(y(g) + (below ? 11 : -4)).toFixed(1)}" style="font:9px Inter,Helvetica,Arial,sans-serif;fill:${colour};font-weight:600" text-anchor="end">${label} ${g.toFixed(2)} GWh</text>`;
  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  ${bars}
  ${mark(p50, 'P50', '#0f4c5c', false)}
  ${mark(p90, 'P90', '#b3541e', true)}
  <line x1="${L}" y1="${Hh - B}" x2="${W - 14}" y2="${Hh - B}" stroke="#9aa2aa"/>
  <text x="13" y="${(Hh / 2).toFixed(0)}" style="${LB}" text-anchor="middle" transform="rotate(-90 13 ${(Hh / 2).toFixed(0)})">ENERGY  GWh</text>
</svg>`;
}

/** Long profile of the diverted reach — where the head comes from. */
function profileSvg(c: ExportContext): string {
  const s = c.selected;
  if (!s || !c.path.length) return '';
  const seg = c.path.slice(s.i, s.j + 1).filter((p) => Number.isFinite(p.elevationM));
  if (seg.length < 3) return '';
  const W = 540;
  const Hh = 210;
  const L = 56;
  const B = 34;
  const km0 = seg[0].km;
  const kmSpan = Math.max(0.01, seg[seg.length - 1].km - km0);
  const zs = seg.map((p) => p.elevationM);
  const zMin = Math.min(...zs);
  const zSpan = Math.max(1, Math.max(...zs) - zMin);
  const x = (km: number) => L + ((km - km0) / kmSpan) * (W - L - 16);
  const y = (z: number) => Hh - B - ((z - zMin) / zSpan) * (Hh - B - 24);
  const line = seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.km).toFixed(1)},${y(p.elevationM).toFixed(1)}`).join('');
  const area = `M${x(seg[0].km).toFixed(1)},${(Hh - B).toFixed(1)}${line.slice(1)}L${x(seg[seg.length - 1].km).toFixed(1)},${(Hh - B).toFixed(1)}Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const z = zMin + zSpan * f;
      const yy = y(z);
      return `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - 16}" y2="${yy.toFixed(1)}" stroke="#e6e9ec"/><text x="${L - 8}" y="${(yy + 3).toFixed(1)}" style="${AX}" text-anchor="end">${z.toFixed(0)}</text>`;
    })
    .join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const km = km0 + kmSpan * f;
      return `<text x="${x(km).toFixed(1)}" y="${Hh - B + 15}" style="${AX}" text-anchor="middle">${(km - km0).toFixed(1)}</text>`;
    })
    .join('');
  const a = seg[0];
  const b = seg[seg.length - 1];
  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  ${grid}${ticks}
  <path d="${area}" fill="#6b7d55" opacity=".13"/>
  <path d="${line}" fill="none" stroke="#4a5a3a" stroke-width="1.6"/>
  <circle cx="${x(a.km).toFixed(1)}" cy="${y(a.elevationM).toFixed(1)}" r="4" fill="#0f4c5c"/>
  <circle cx="${x(b.km).toFixed(1)}" cy="${y(b.elevationM).toFixed(1)}" r="4" fill="#b3541e"/>
  <text x="${(x(a.km) + 8).toFixed(1)}" y="${(y(a.elevationM) - 8).toFixed(1)}" style="font:10px Inter,Helvetica,Arial,sans-serif;fill:#0f4c5c;font-weight:600">INTAKE ${a.elevationM.toFixed(0)} m</text>
  <text x="${(x(b.km) - 8).toFixed(1)}" y="${(y(b.elevationM) - 8).toFixed(1)}" style="font:10px Inter,Helvetica,Arial,sans-serif;fill:#b3541e;font-weight:600" text-anchor="end">POWERHOUSE ${b.elevationM.toFixed(0)} m</text>
  <line x1="${L}" y1="${Hh - B}" x2="${W - 16}" y2="${Hh - B}" stroke="#9aa2aa"/>
  <text x="${(W / 2).toFixed(0)}" y="${Hh - 5}" style="${LB}" text-anchor="middle">DISTANCE ALONG RIVER  km</text>
  <text x="13" y="${(Hh / 2).toFixed(0)}" style="${LB}" text-anchor="middle" transform="rotate(-90 13 ${(Hh / 2).toFixed(0)})">ELEVATION  m</text>
</svg>`;
}

/** Stage against area and storage — two curves that share a level axis. */
function stageSvg(stage: readonly { retainedHeightM: number; areaM2: number; volumeM3: number }[]): string {
  if (stage.length < 3) return '';
  const W = 540;
  const Hh = 210;
  const L = 56;
  const R = 56;
  const B = 34;
  const hMax = Math.max(...stage.map((p) => p.retainedHeightM)) || 1;
  const aMax = Math.max(...stage.map((p) => p.areaM2 / 10000)) || 1;
  const vMax = Math.max(...stage.map((p) => p.volumeM3 / 1e6)) || 1;
  const x = (h: number) => L + (h / hMax) * (W - L - R);
  const yA = (a: number) => Hh - B - (a / aMax) * (Hh - B - 22);
  const yV = (v: number) => Hh - B - (v / vMax) * (Hh - B - 22);
  const pa = stage.map((p, i) => `${i ? 'L' : 'M'}${x(p.retainedHeightM).toFixed(1)},${yA(p.areaM2 / 10000).toFixed(1)}`).join('');
  const pv = stage.map((p, i) => `${i ? 'L' : 'M'}${x(p.retainedHeightM).toFixed(1)},${yV(p.volumeM3 / 1e6).toFixed(1)}`).join('');
  const ticks = stage
    .map((p) => `<text x="${x(p.retainedHeightM).toFixed(1)}" y="${Hh - B + 15}" style="${AX}" text-anchor="middle">${p.retainedHeightM.toFixed(1)}</text>`)
    .join('');
  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  <line x1="${L}" y1="${Hh - B}" x2="${W - R}" y2="${Hh - B}" stroke="#9aa2aa"/>
  ${ticks}
  <path d="${pa}" fill="none" stroke="#0f4c5c" stroke-width="1.8"/>
  <path d="${pv}" fill="none" stroke="#b3541e" stroke-width="1.8" stroke-dasharray="5 3"/>
  ${stage.map((p) => `<circle cx="${x(p.retainedHeightM).toFixed(1)}" cy="${yA(p.areaM2 / 10000).toFixed(1)}" r="2.6" fill="#0f4c5c"/><circle cx="${x(p.retainedHeightM).toFixed(1)}" cy="${yV(p.volumeM3 / 1e6).toFixed(1)}" r="2.6" fill="#b3541e"/>`).join('')}
  <text x="${L - 8}" y="20" style="font:9px Inter,Helvetica,Arial,sans-serif;fill:#0f4c5c;font-weight:600" text-anchor="end">AREA ha</text>
  <text x="${W - R + 8}" y="20" style="font:9px Inter,Helvetica,Arial,sans-serif;fill:#b3541e;font-weight:600">STORAGE Mm³</text>
  <text x="${L - 8}" y="${(Hh - B).toFixed(1)}" style="${AX}" text-anchor="end">0</text>
  <text x="${L - 8}" y="34" style="${AX}" text-anchor="end">${aMax.toFixed(2)}</text>
  <text x="${W - R + 8}" y="34" style="${AX}">${vMax.toFixed(3)}</text>
  <text x="${(W / 2).toFixed(0)}" y="${Hh - 5}" style="${LB}" text-anchor="middle">RETAINED WATER LEVEL ABOVE BED  m</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export function deskStudyHtml(
  c: ExportContext,
  meta: ReportMeta,
  figures: ReportFigures = {}
): string {
  tableNo = 0;
  figureNo = 0;
  const s = c.selected;
  const preparedFor = (
    meta.submittedTo?.length
      ? meta.submittedTo
      : [meta.developer && meta.developer !== '—' ? meta.developer : 'Preliminary project screening']
  )
    .map((l) => `<div>${esc(l)}</div>`)
    .join('');
  const today = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const cap = s ? `${approx(s.capacityMW, 1)} MW indicative` : '';
  const exc = c.assumptions?.exceedance ?? 0.4;
  const scale = s?.flowScale ?? 1;
  const rd = c.readiness;
  const reportId =
    meta.reportId ??
    (s
      ? `HR-DS-${Math.abs(Math.round(s.intake.lat * 1000))}-${Math.abs(Math.round(s.intake.lon * 1000))}`
      : 'HR-DS-SITE');
  const revision = meta.revision ?? '01';
  const reportStatus = meta.status ?? 'Preliminary desktop screening';

  const sec: string[] = [];
  const app: string[] = [];
  let no = 0;
  let appNo = -1;
  const H = (t: string) => `<h1><span class="hn">${String(++no).padStart(2, '0')}</span>${esc(t)}</h1>`;
  const A = (t: string) =>
    `<h1 class="appx"><span class="hn">${String.fromCharCode(65 + ++appNo)}</span>${esc(t)}</h1>`;

  // ---- key figures, presented at the precision the evidence can support ----
  const kf = (v: string, u: string, l: string, detail: string) =>
    `<div class="kf"><b>${esc(v)}</b><i>${esc(u)}</i><span>${esc(l)}</span><small>${esc(detail)}</small></div>`;
  const keyFigures = s
    ? `<section class="keys">
        ${kf(approx(s.capacityMW, 1), 'MW', 'Indicative capacity', c.band ? `Range ${n(c.band.capLow, 1)}–${n(c.band.capHigh, 1)} MW` : 'Screening estimate')}
        ${kf(approx(s.energyGwh, 0), 'GWh/yr', 'Indicative annual energy', c.band ? `Range ${n(c.band.energyLow, 0)}–${n(c.band.energyHigh, 0)} GWh` : 'Screening estimate')}
        ${kf(approx(s.netHeadM, 0), 'm', 'Net head', `${n(c.demResolutionM, 0)} m terrain model · ±3.4% measured`)}
        ${kf(approx(s.designFlowCms, 2), 'm³/s', `Reference flow · Q${Math.round(exc * 100)}`, 'Modelled · ~1.6× typical error')}
        ${kf(approx(s.waterwayKm, 1), 'km', 'Indicative waterway', 'Routed on terrain, not surveyed')}
        ${kf(approx(catchmentKm2(c), 1), 'km²', 'Catchment at intake', 'Mapped from the drainage network')}
      </section>`
    : '';

  // ---- 01 executive screening summary --------------------------------------
  const decisionLabel: Record<string, string> = {
    hold: 'Hold further design spend until the identified constraints are resolved.',
    fieldwork: 'Proceed to a targeted field reconnaissance and measurement programme.',
    screening: 'Retain at desktop-screening stage pending the evidence listed below.',
  };
  const stopSummary = rd?.stopReasons?.length
    ? rd.stopReasons.map((reason) => reason.replace(/\.\s*$/, '')).join('; ')
    : 'None identified at desktop stage; field verification remains required.';
  /**
   * The one line a reader who reads nothing else should get: the scheme this
   * screen found, in the four numbers that define it. It replaces a row that
   * said only what was missing.
   */
  const headline = s
    ? `A ${approx(s.capacityMW, 1)} MW run-of-river scheme is physically available here: ` +
      `${approx(s.grossHeadM, 0)} m of gross head over ${approx(s.waterwayKm, 1)} km of waterway, ` +
      `${approx(s.energyGwh, 0)} GWh/year at Q${Math.round(exc * 100)}.`
    : 'No scheme could be laid out at this point.';
  sec.push(
    H('EXECUTIVE DESKTOP-SCREENING SUMMARY') +
      /**
       * WHAT THIS PAGE SAID BEFORE, IN ORDER: it does not establish a design;
       * low confidence, low confidence, low confidence, low confidence; hold
       * spend; no site discharge measurement; hold points; and then a badge
       * repeating the recommendation printed three lines above it. Seven
       * negative statements and one duplicate before a single result.
       *
       * A screening report exists to say what was found. The scope boundary is
       * real and it is stated - once, in the sentence below, and again in
       * section 02, which is the section named for it. It does not need to be
       * the first, second and fourth thing on the page.
       */
      `<p class="lede">This report establishes whether the site warrants field investigation, and what
      that investigation should target. It is a desktop screen: it fixes no structure, quantity, cost or
      consent position.</p>` +
      keyFigures +
      facts([
        ['Screening recommendation', rd ? decisionLabel[rd.decision] ?? decisionLabel.screening : decisionLabel.screening],
        ['What the screen establishes', headline],
        ['Largest remaining uncertainty', 'River flow, which carries roughly 1.6× at this catchment scale, against 3.4% on head.'],
        ['Principal hold points', stopSummary],
        ['Appropriate next decision', 'Whether to fund reconnaissance, gauging, survey and constraint verification.'],
      ])
  );

  // ---- 02 basis, scope and limitations -------------------------------------
  sec.push(
    H('BASIS, SCOPE AND LIMITATIONS') +
      `<p>The assessment uses global and national datasets only. Results are suitable for comparing
      options and planning fieldwork; they are not suitable for fixing structure locations, dimensions,
      quantities, tender requirements or investment returns.</p>` +
      /**
       * THE SAME EIGHT ROWS, TURNED THE RIGHT WAY ROUND.
       *
       * This table was headed "Evidence not obtained at desktop stage" and every
       * cell in it read "Not undertaken", "No site measurement", "Not assessed".
       * Eight rows of nothing, on page three, before the report had said what it
       * DID find. It also told the reader less than it could: "Site
       * reconnaissance - Not undertaken" hides the fact that a 30 m terrain
       * model and a 10 m land-cover raster were read over the whole alignment.
       *
       * Every discipline here rests on something. Naming that something is what
       * lets a reader judge the result, and the gap then states itself at the
       * end of the same line without a heading having to shout it.
       */
      '<h2>What each discipline rests on</h2>' +
      facts([
        ['Site conditions', `${n(c.demResolutionM, 0)} m terrain model and 10 m land cover over the whole alignment; no ground visit`],
        ['River flow', `${c.flowYears} years of daily flood-model record, cross-checked against three published Nepali regressions; no site gauging`],
        ['Topography', `${esc(c.demSource ?? 'terrain model')} at ${n(c.demResolutionM, 0)} m, cross-checked against a second elevation product; no survey`],
        ['Engineering geology', 'Published national and provincial geological mapping; no ground traverse, drilling or testing'],
        ['Sediment', 'Empirical desander sizing from the modelled flow; no suspended-load or bed-load samples'],
        ['Grid connection', 'Mapped line geometry and substation ratings; connection point and available capacity unconfirmed'],
        ['Environment and social', 'Protected-area, hazard and land-cover registers; no field baseline'],
        ['Cost, schedule and bankability', 'Not assessed — this screen carries no cost model, and one built on a 1.6× flow would be false precision'],
      ]) +
      '<h2>Screening assumptions</h2>' +
      facts([
        ['Reference design-flow exceedance', `Q${Math.round(exc * 100)}`],
        /**
         * THIS ROW SAID "Overall plant efficiency 96.0 %", AND IT IS NOT THAT.
         *
         * `assumptions.efficiency` is the generator and transformer train only
         * - `src/export.ts` has always labelled it correctly and this report did
         * not. The turbine is separate: `discover.ts` multiplies this by the
         * selected runner's efficiency AT DESIGN FLOW, so the overall figure is
         * the product of the two and is nowhere near 96%.
         *
         * No hydro plant reaches 96% overall, so the row as printed was the kind
         * of number that ends a reader's trust in a document on page 3 - and the
         * arithmetic underneath it was right the whole time.
         */
        ['Generator and transformer', `${n((c.assumptions?.efficiency ?? 0) * 100, 1)} %`],
        ...(s?.turbinePeak
          ? ([
              ['Turbine at the reference flow', `${n(s.turbinePeak * 100, 1)} % — ${esc(s.turbine ?? 'screening curve')}`],
              [
                'Overall plant efficiency',
                `${n(s.turbinePeak * (c.assumptions?.efficiency ?? 0) * 100, 1)} % — the product of the two above`,
              ],
            ] as [string, string][])
          : []),
        ['Head-loss allowance', `${n((c.assumptions?.headLossFrac ?? 0) * 100, 1)} %`],
        ['Environmental release', `${n((c.assumptions?.residualFrac ?? 0) * 100, 0)} % of the lowest monthly mean`],
        ['Hydrological record used', `${c.flowYears} model years`],
        ['Automated layouts evaluated', String(c.evaluated)],
      ]) +
      (c.localGis && (c.localGis.municipality || c.localGis.sheet || c.localGis.isohyetMm != null)
        ? /**
           * THE ONLY THREE NUMBERS IN THIS REPORT WITH NO SOURCE BESIDE THEM.
           *
           * Everything else here is traceable: the source table names every
           * layer, its licence, its resolution and its vintage, and the whole
           * argument of the document is that a screening figure is worth
           * exactly what its provenance is worth. These three came from a
           * privately supplied national GIS set and were printed bare, which
           * left a reader unable to weigh them and — worse — unable to tell
           * they were from a different class of source than everything above.
           *
           * The supplier is deliberately not named: that is their condition,
           * and it is honoured. But "not named" and "not attributed" are not
           * the same thing. Saying a value is supplied, unpublished, and not
           * independently verifiable here tells the reader what they need in
           * order to judge it, without naming anyone.
           */
          '<h2>Administrative and survey context</h2>' +
          facts([
            ['Local body', c.localGis.municipality ?? '–'],
            ['Survey sheet', c.localGis.sheet ?? '–'],
            ['Mean annual rainfall', c.localGis.isohyetMm == null ? '–' : `${n(c.localGis.isohyetMm, 0)} mm`],
            [
              'Source of the three rows above',
              'A supplied national GIS set, used under its provider’s terms and not redistributed. ' +
                'Unlike every other layer in this report it is not public, so it cannot be independently ' +
                'checked from here — confirm against the published survey sheet and DHM isohyet map before use.',
            ],
          ])
        : '') +
      finding(
        'limit',
        '<b>Display precision follows evidence quality.</b> Rounded values in the main report are decision-level estimates; raw model values remain available in the technical appendices and machine-readable exports.'
      )
  );

  /**
   * IS THIS EVEN THE RIGHT RIVER? — AND IT HAS TO COME FIRST.
   *
   * The app warns on screen when the click lands on a small channel beside a
   * far larger one, because flow scales with catchment area and being on the
   * wrong channel is an error of the CATCHMENT RATIO, not a few percent. That
   * warning never reached the report, which is exactly backwards: the reader on
   * screen has the map beside them and can see both rivers; the reader of a PDF
   * has neither and is the one who needs telling.
   *
   * It goes above the layout rather than into a limitations appendix, because
   * if it is right then every number after it describes a different river.
   */
  if (c.ambiguity) {
    const amb = c.ambiguity;
    const ratio = amb.nearestKm2 > 0 ? amb.mainKm2 / amb.nearestKm2 : null;
    sec.push(
      H('RIVER AND CATCHMENT IDENTITY CHECK') +
        finding(
          'watch',
          `<b>A larger river runs ${n(amb.mainKm, 1)} km from the point studied.</b> This study is of a ` +
            `channel draining ${n(amb.nearestKm2, 0)} km²; a river draining ${n(amb.mainKm2, 0)} km²` +
            `${ratio ? ` — ${n(ratio, 1)}× the catchment — ` : ' '}lies beside it. Flow scales with ` +
            `catchment area, so if the intended site is on the larger river, every flow, capacity and ` +
            `energy figure here is low by roughly that ratio. That is not a rounding error; it is the ` +
            `difference between two projects.`
        ) +
        `<p>HydroRecon studies the river downstream of the point given, so the layout may already have
        slid onto the larger channel — check where the intake actually sits in the layout figure before
        reading on. If the smaller stream was intended, this note can be ignored.</p>`
    );
  }

  // ---- 02 location ---------------------------------------------------------
  const muni = c.localGis?.municipality ?? null;
  sec.push(
    H('SITE SETTING AND PRELIMINARY LAYOUT') +
      (s
        ? `<p>The ${esc(meta.projectName)} is a proposed ${cap} run-of-river scheme. The intake lies at
        ${dms(s.intake.lat, 'N', 'S')}, ${dms(s.intake.lon, 'E', 'W')}${muni ? `, within ${esc(muni)}` : ''},
        at an elevation of ${n(c.path[s.i]?.elevationM, 0)} m. The powerhouse lies ${n(s.waterwayKm, 2)} km
        downstream along the river at ${n(c.path[s.j]?.elevationM, 0)} m, giving a gross head of
        ${n(s.grossHeadM, 1)} m. The catchment at the intake is ${n(catchmentKm2(c), 1)} km².</p>`
        : '<p>No scheme has been selected.</p>') +
      figure('Project screening map — intake, waterway, powerhouse and neighbouring licence areas', figures.site)
  );

  // ---- 03 topography -------------------------------------------------------
  const prof = profileSvg(c);
  sec.push(
    H('TERRAIN AND LONGITUDINAL PROFILE') +
      `<p>The diverted reach falls ${s ? n(s.grossHeadM, 1) : '–'} m over ${s ? n(s.waterwayKm, 2) : '–'} km,
      an average gradient of ${s ? n(s.slopeMPerKm, 1) : '–'} m/km. Terrain is resolved at
      ${n(c.demResolutionM, 0)} m.</p>` +
      chartBlock(prof, 'Long profile of the diverted reach')
  );

  // ---- 04 hydrology --------------------------------------------------------
  const monthly = c.flow.dates.length
    ? seasonalRatio(c.flow.dates, c.flow.values)
    : { monthlyMeans: [] as number[], driestMonth: -1, wettestMonth: -1, ratio: NaN };
  const fdc = buildFdc(c.flow.values);
  const atP = (p: number) => {
    const hit = fdc.find((f) => f.p >= p);
    return hit ? hit.q * scale : null;
  };
  const driest = monthly.driestMonth >= 0 ? MONTHS[monthly.driestMonth] : null;

  const wb = waterBalance(c);
  let hyd =
    H('HYDROLOGY AND FLOW EVIDENCE') +
    `<p>The modelled long-term mean flow at the intake is ${approx(meanAtIntake(c), 2)} m³/s over
    ${c.flowYears} years.${driest ? ` The lowest long-term monthly mean occurs in ${driest}.` : ''}
    Q${Math.round(exc * 100)} is used as a <b>reference case</b>, not a selected design flow.</p>` +
    facts([
      ['Primary flow basis', 'GloFAS v4 daily model, approximately 5 km grid'],
      ['Catchment at intake', `${approx(catchmentKm2(c), 1)} km²`],
      ['Modelled mean flow', `${approx(meanAtIntake(c), 2)} m³/s`],
      ['Reference flow after release', s ? `${approx(s.designFlowCms, 2)} m³/s at Q${Math.round(exc * 100)}` : '–'],
      /**
       * MEASURED, NOT ADJECTIVAL.
       *
       * This row said "Low; no transferable measured record identified", and
       * five other rows across the report said "low confidence" too. An
       * adjective is a shrug: it tells a reader to distrust the number without
       * telling them by how much, so they cannot act on it.
       *
       * The figure below is not an estimate of this site. It is what this
       * method scores against Nepal's own gauges — 69 DHM records with ten or
       * more complete years, re-measured under the shipped engine — and it is
       * the one thing this tool can say that a desk study cannot.
       */
      [
        'Accuracy of this method',
        'Typical error 1.4× at gauged sites, 1.6× weighted to catchments the size projects sit on; ' +
          'unbiased; 90% of 69 DHM gauges within a factor of two',
      ],
      ...(wb
        ? ([
            [
              'Implied runoff',
              `${n(wb.runoffMm, 0)} mm/yr from ${n(wb.rainfallMm, 0)} mm of catchment rainfall — ` +
                `runoff coefficient ${n(wb.coefficient, 2)}, against a median of 0.87 at 69 gauged Nepali rivers`,
            ],
          ] as [string, string][])
        : []),
    ]);

  const chart = fdcSvg(c.flow.values.map((v) => v * scale), s?.designFlowCms ?? null, exc);
  hyd += chartBlock(chart, 'Modelled flow-duration curve at the intake — reference flow marked');

  const mchart = monthlyEnvelopeSvg(
    c.flow.dates,
    c.flow.values,
    scale,
    s?.designFlowCms ?? null,
    s?.residualCms ?? null
  );
  hyd += chartBlock(
    mchart,
    'Monthly flow envelope — median and P10–P90 of annual monthly means; dry-season months lightly shaded'
  );

  /**
   * THE GAUGE VERDICT USED TO BE PRINTED HERE **AND** IN THE NEXT SECTION.
   *
   * Both carried the identical sentence — "No nearby station combines a
   * discharge record with a transferable catchment" — one page apart, and the
   * second one sits beside the station table that substantiates it. Saying it
   * twice does not make it truer; it makes the report look as though it has
   * nothing else to report. It is stated once, in the section that owns the
   * evidence, and this section states its own finding instead.
   */
  if (wb) {
    /**
     * THREE TIERS, BECAUSE TWO WERE DISHONEST IN BOTH DIRECTIONS.
     *
     * The first version of this said "the modelled flow exceeds the rain that
     * falls on this catchment" for anything above 1.0, and "consistent" below.
     * Measured at 69 gauges, that binary would have called a third of Nepal's
     * gauged rivers impossible - and it would have described a coefficient of
     * 0.99, which is at the very top of what those rivers show, as consistent.
     * The middle tier exists because the middle of the distribution is real.
     */
    hyd +=
      wb.coefficient > RUNOFF_PLAUSIBLE_MAX
        ? finding(
            'watch',
            `<b>This catchment cannot deliver the modelled flow.</b> A mean of ` +
              `${approx(meanAtIntake(c), 2)} m³/s off ${approx(catchmentKm2(c), 1)} km² is a runoff depth of ` +
              `${n(wb.runoffMm, 0)} mm/yr against ${n(wb.rainfallMm, 0)} mm of catchment rainfall — a runoff ` +
              `coefficient of ${n(wb.coefficient, 2)}. No measured record at the 69 Nepali gauges this app is ` +
              `scored against exceeds 1.89, and the whole country averages about 0.95, so this is beyond ` +
              `anything the evidence supports. At the ceiling used here the catchment yields about ` +
              `${n(wb.ceilingCms, 2)} m³/s. <b>Treat the capacity, energy and design flow as unresolved</b> ` +
              `until a measured record replaces the model: a small catchment sits inside a single flood-model ` +
              `grid cell, and a cell that drains a larger area is the usual cause. The ground-based screens — ` +
              `terrain, geology, hazards, land cover and protected areas — are measured independently of the ` +
              `flow, although a corrected flow could move the layout they describe.`
          )
        : wb.coefficient > RUNOFF_TYPICAL_MAX
          ? finding(
              'note',
              `<b>The modelled flow is high for the rain on this catchment, but not beyond what Nepali rivers ` +
                `show.</b> ${n(wb.runoffMm, 0)} mm/yr of runoff from ${n(wb.rainfallMm, 0)} mm of rainfall is a ` +
                `coefficient of ${n(wb.coefficient, 2)}; the 69 gauged records this app is scored against run to ` +
                `1.89, and the spread reflects how coarsely a 5 km climatology resolves mountain rainfall as ` +
                `much as anything about the river. Worth re-testing against a measured record, but not on ` +
                `its own a reason to doubt the figure.`
            )
          : finding(
              'note',
              `<b>The modelled flow is consistent with the rain that falls on this catchment.</b> ` +
                `${n(wb.runoffMm, 0)} mm/yr of runoff from ${n(wb.rainfallMm, 0)} mm of rainfall is a coefficient of ` +
                `${n(wb.coefficient, 2)}, against a median of 0.87 at 69 gauged Nepali rivers. This tests ` +
                `magnitude only, not the seasonal shape.`
            );
  }

  sec.push(hyd);

  let hydrologyAppendix = table(
    'Flow duration at the intake',
    ['Exceedance', 'Discharge m³/s'],
    [5, 20, 40, 50, 60, 80, 95].map((p) => [`Q${p}`, n(atP(p / 100), 3)])
  );

  const reg: Row[] = [];
  if (c.hydest) {
    reg.push(['WECS/DHM 1990', n(c.hydest.modelledCms, 2), `${n(c.hydest.driest.cms, 3)} · ${MONTHS[c.hydest.driest.month] ?? '–'}`]);
  }
  if (c.mhsp) {
    const m = c.mhsp;
    reg.push([
      'MHSP 1997',
      n(m.annualMeanCms, 2),
      m.driest ? `${n(m.driest.cms, 3)} · ${MONTHS[m.driest.month] ?? '–'}` : '–',
    ]);
  }
  if (reg.length) hydrologyAppendix += table('Regional method comparison', ['Method', 'Mean flow m³/s', 'Lowest monthly mean'], reg);

  if (c.hydest?.floods?.length) {
    hydrologyAppendix += table(
      'Regional flood estimates',
      ['Return period', 'Peak discharge m³/s'],
      c.hydest.floods.map((f) => [`${f.t}-year`, n(f.cms, 1)])
    );
  }

  /**
   * THE GAUGES DESERVED BETTER THAN AN APPENDIX.
   *
   * This used to be three columns at the back — station, river, distance — with
   * the river column reading "–" four times in six because DHM does not always
   * record it. That is the empty-column failure this report was rewritten to
   * avoid, on what is arguably the most valuable page in the document: a
   * discharge gauge close by, on the same river, is the strongest hydrological
   * evidence an ungauged Nepali site can have, and it turns a modelled flow
   * into a measured one.
   *
   * Everything that decides whether a record is USABLE is already in the data
   * and was being thrown away — whether it gauges discharge or only stage, the
   * catchment above it, the area ratio to this site, and whether that ratio is
   * inside the range where transfer is defensible. So the section reports those
   * instead, and says plainly which station to ask DHM for.
   */
  /**
   * THE SHAPE CHECK THE APP RUNS AND THE REPORT NEVER MENTIONED.
   *
   * `engine/fdcshape.ts` compares the modelled flow-duration curve against a
   * national curve built from DHM gauges and corrects it where the low-flow
   * tail is implausible. It fires on about 16% of project sites, it is measured
   * to help — dry-season bias −5.8 → −3.7 points at 74 gauges — and it CHANGES
   * THE DESIGN FLOW. A headline number being quietly adjusted by a screen the
   * report does not disclose is the sort of thing that should end an engineer's
   * trust in the whole document, so it is disclosed either way: fired or not.
   */
  if (c.flowShape) {
    const fs = c.flowShape;
    const q = Math.round(fs.exceedance * 100);
    hydrologyAppendix +=
      '<h2>Flow-duration shape check</h2>' +
        `<p>Flood models are built to get floods right, and their low-flow tail is the part least
        constrained by what they were calibrated against. A design flow is a point on the
        flow-duration curve, so a wrong tail moves the machine size directly. The modelled curve is
        therefore tested against a national curve assembled from <b>${fs.stations} DHM gauge
        records</b>.</p>` +
        facts([
          ['Exceedance tested', `Q${q}`],
          [`Model puts Q${q} at`, `${n(fs.ratio, 2)} × the annual mean`],
          [
            'Nepali gauges put it between',
            `${n(fs.band[0], 2)} and ${n(fs.band[2], 2)} × the annual mean (median ${n(fs.band[1], 2)})`,
          ],
          ['Verdict', fs.implausible ? 'outside the measured range — corrected' : 'inside the measured range — used as modelled'],
        ]) +
        (fs.implausible
          ? finding(
              'watch',
              `<b>The modelled low-flow tail was implausible here and has been corrected.</b> Design flow, ` +
                `capacity and energy in this report are the corrected values rather than the raw model's — ` +
                `a factor of ${n(fs.designFactor, 3)} on design flow. The correction is measured to help, ` +
                `moving dry-season bias from −5.8 to −3.7 percentage points across 74 gauges, but it is ` +
                `still a correction: treat this as a site where obtaining a measured record matters more ` +
                `than usual.`
            )
          : finding(
              'clear',
              `<b>The modelled curve sits inside the range Nepali gauges show</b>, so no shape correction ` +
                `was applied and the flow figures are the model's own.`
            ));
  }

  if (c.gauges?.length) {
    const RELATION: Record<string, string> = {
      upstream: 'upstream, scale up',
      downstream: 'downstream, scale down',
      'nearby catchment': 'different branch',
    };
    const near = c.gauges.slice(0, 5);
    const usable = c.gauges.filter((gg) => gg.measuresDischarge && gg.trustworthy);
    const best = usable[0] ?? null;

    const gaugeRows = near.map((gg) => [
      (() => {
        const dn = stationDisplayName(gg.name);
        return dn.note ? `${dn.name} — register note: "${dn.note}"` : dn.name;
      })(),
      dist(gg.distanceKm),
      RELATION[gg.relation] ?? gg.relation,
      gg.measuresDischarge ? `discharge${gg.seriesId ? ` · series ${gg.seriesId}` : ''}` : 'water level only',
      gg.uplandKm2 == null ? '–' : `${n(gg.uplandKm2, 0)} km²`,
      !gg.measuresDischarge
        ? 'needs a rating curve'
        : gg.areaRatio == null
          ? 'catchment unknown'
          : gg.trustworthy
            ? `×${n(gg.areaRatio, 2)}, defensible`
            : `×${n(gg.areaRatio, 2)}, too different`,
    ]);

    let gs =
      H('HYDROLOGICAL DATA AVAILABILITY') +
      `<p>${c.gauges.length} Department of Hydrology and Meteorology station${c.gauges.length === 1 ? '' : 's'}
      lie${c.gauges.length === 1 ? 's' : ''} near the reach. Proximity alone does not make a record
      transferable: it must measure discharge, represent a comparable catchment and share a relevant
      hydrological regime.</p>` +
      figure(
        `Nearby DHM stations — discharge records in blue and water-level-only stations in slate${
          figures.gaugeFrameKm ? `. Frame about ${n(figures.gaugeFrameKm, 0)} km across${figures.gaugesShown && figures.gaugesTotal && figures.gaugesShown < figures.gaugesTotal ? `, holding ${figures.gaugesShown} of the ${figures.gaugesTotal} stations tabulated below` : ''}` : ''
        }`,
        figures.gauges
      );

    gs += best
      ? finding(
          'clear',
          `<b>${esc(stationDisplayName(best.name).name)} is the record to obtain</b> — ${dist(best.distanceKm)} away, gauging discharge, ` +
            `on a catchment ${best.areaRatio == null ? 'of comparable size' : `whose flow scales to this intake by ×${n(best.areaRatio, 2)}`}. ` +
            `${best.seriesId ? `Quote series ${best.seriesId} when requesting it. ` : ''}` +
            'Quality-checking this record is the first hydrological verification task.'
        )
      : finding(
          'watch',
          '<b>No nearby station combines a discharge record with a transferable catchment.</b> ' +
            `${c.gauges.some((gg) => gg.measuresDischarge) ? 'The stations that gauge discharge sit on catchments too different in size for area-ratio transfer to hold' : 'The nearby stations record water level only, which is not a flow series until its rating curve is obtained'}, ` +
            'so the flow here is modelled rather than measured. Commissioning a season of stage-discharge ' +
            'measurement at the intake is the single change that most reduces the error in this report.'
        );

    sec.push(gs);

    hydrologyAppendix +=
      '<h2>Gauge transfer screen</h2>' +
      `<figure class="cw appendix-figure">${gaugeTransferSvg(c.gauges)}<figcaption>Appendix figure · Catchment ratio at nearby gauges; the shaded band indicates the area-ratio transfer screen.</figcaption></figure>` +
      table(
        'Five closest gauging stations near the site',
        ['Station', 'Distance', 'Relation', 'Record', 'Catchment', 'Transfer'],
        gaugeRows
      );
  }

  if (hydrologyAppendix) {
    app.push(A('HYDROLOGY METHOD AND DATA AVAILABILITY') + hydrologyAppendix);
  }

  /**
   * COLLECTOR INTAKES — THE LAST GAP FROM THE PANEL-VS-PDF AUDIT, AND THE ONE
   * THAT MATTERED MOST OF THE THREE.
   *
   * A panel-against-report audit found three things the app knew and the
   * document did not say. Two were closed at the time — the wrong-river warning
   * and the flow-duration shape check. This was the third, and it was left open
   * for two sessions while being the only one of the three that changes the
   * DESIGN FLOW: a collector intake diverts a neighbouring stream into the same
   * headrace, and the app models the gain. A reader of the PDF got the raised
   * capacity with no way to know a second stream had been assumed, which is a
   * scheme they never agreed to and a consent they were not told about.
   *
   * Reported where the flow is, not with the layout, because that is what it
   * changes.
   */
  if (c.collectors && c.collectors.gainFrac > 0 && c.collectors.counted.length) {
    const col = c.collectors;
    sec.push(
      H('COLLECTOR INTAKES') +
        `<p>The design flow in this report is not drawn from the main intake alone.
        ${col.counted.length} additional stream${col.counted.length === 1 ? ' is' : 's are'} assumed to be
        collected into the same waterway, raising the design flow by
        <b>${n(col.gainFrac * 100, 1)}%</b>.</p>` +
        table(
          'Streams assumed to be collected',
          ['Stream', 'Position', 'Share of design flow'],
          col.counted.map((x) => [
            x.name ?? 'unnamed stream',
            `${n(x.lat, 4)}, ${n(x.lon, 4)}`,
            `${n(x.flowFrac * 100, 1)} %`,
          ])
        ) +
        finding(
          'watch',
          `<b>Every capacity and energy figure in this report includes these collectors.</b> ` +
            `Each one is a separate headworks with its own crossing, its own environmental release, its own ` +
            `land take and its own consent, and none of that is costed or sited here. The flow gain is ` +
            `modelled from the same network the main intake uses, so it carries the same ` +
            `uncertainty — and it is applied on top of it, not independently of it. ` +
            `Remove them to see the single-intake scheme.`
        )
    );
  }

  // ---- 05 power and energy -------------------------------------------------
  const rel = s?.reliability ?? null;
  let pe =
    H('POWER AND ENERGY SCREENING') +
    `<p>The Q${Math.round(exc * 100)} reference case indicates ${s ? approx(s.capacityMW, 1) : '–'} MW
    and ${s ? approx(s.energyGwh, 0) : '–'} GWh/year. These are energy-screening outputs, not an
    equipment selection or an economic optimum.</p>` +
    facts([
      ['Indicative installed capacity', s ? `${approx(s.capacityMW, 1)} MW${c.band ? ` (range ${n(c.band.capLow, 1)}–${n(c.band.capHigh, 1)} MW)` : ''}` : '–'],
      ['Indicative average annual energy', s ? `${approx(s.energyGwh, 0)} GWh${c.band ? ` (range ${n(c.band.energyLow, 0)}–${n(c.band.energyHigh, 0)} GWh)` : ''}` : '–'],
      ['Modelled plant factor', s ? `${n(s.plantFactor * 100, 0)} %` : '–'],
      ['Indicative turbine family', s?.turbine ? `${String(s.turbine)} — screening only` : '–'],
      ['Unit number and rating', 'Not selected at desktop stage'],
      [
        'What sets the error here',
        'The flow record, not the machine — energy inherits the flow error almost one for one, ' +
          'so a 1.6× flow is a 1.6× energy',
      ],
    ]);

  if (rel) {
    pe +=
      chartBlock(
        yearsSvg(rel.annual, rel.p50Gwh, rel.p90Gwh),
        'Modelled annual energy by year — P50 and P90 reference levels marked'
      ) +
      facts([
        ['P50 annual energy', `${approx(rel.p50Gwh, 0)} GWh`],
        ['P90 annual energy', `${approx(rel.p90Gwh, 0)} GWh`],
        ['Modelled annual range', `${approx(rel.worstGwh, 0)}–${approx(rel.bestGwh, 0).replace(/^~/, '')} GWh`],
      ]);

    const tests: [string, typeof rel.ppaEightFour, number][] = [
      ['NEA 8 + 4 months', rel.ppaEightFour, 0.15],
      ['NEA 6 + 6 months', rel.ppaSixSix, 0.3],
    ];
    pe +=
      '<h2>Dry-season energy criterion screen</h2>' +
      table(
        'Dry-season energy share against published run-of-river criteria',
        ['Season split', 'Dry energy', 'Dry share', 'Criterion', 'Screening result'],
        tests.map(([label, test, threshold]) => [
          label,
          `${n(test.dryGwh, 1)} GWh`,
          `${n(test.dryShare * 100, 1)} %`,
          `${n(threshold * 100, 0)} %`,
          test.meets ? 'above criterion' : 'below criterion',
        ])
      );
    const closest = tests
      .map(([, test, threshold]) => (test.dryShare - threshold) * 100)
      .reduce((a, b) => (Math.abs(a) < Math.abs(b) ? a : b));
    pe += Math.abs(closest) <= 5
      ? finding(
          'watch',
          `<b>The closest dry-season result is ${n(Math.abs(closest), 1)} percentage points from its criterion, within the measured model error.</b> This screen is not sufficient to determine tariff eligibility; dry-season gauging is required.`
        )
      : finding(
          'note',
          `<b>The nearest dry-season criterion is ${n(Math.abs(closest), 1)} percentage points ${closest >= 0 ? 'below the modelled share' : 'above the modelled share'}.</b> Treat this as a screening indication only; PPA eligibility, tariff and revenue are not assessed.`
        );
  }

  pe += finding(
    'limit',
    '<b>Equipment remains open.</b> Turbine family, unit arrangement, efficiencies and part-load behaviour are calculation assumptions until hydraulic transients, maintainability and supplier options are studied.'
  );
  sec.push(pe);

  let powerAppendix =
    '<h2>Model output and calculation basis</h2>' +
    table(
      'Power and energy model output',
      ['Parameter', 'Unit', 'Raw model value'],
      [
        ['Design discharge', 'm³/s', s ? n(s.designFlowCms, 3) : '–'],
        ['Environmental release', 'm³/s', s ? n(s.residualCms, 3) : '–'],
        ['Gross head', 'm', s ? n(s.grossHeadM, 1) : '–'],
        ['Head loss in the waterway', 'm', s ? n(s.grossHeadM - s.netHeadM, 1) : '–'],
        ['Net head at the turbine inlet', 'm', s ? n(s.netHeadM, 1) : '–'],
        ['Plant efficiency assumption', '–', n(c.assumptions?.efficiency ?? null, 3)],
        ['Turbine efficiency at reference flow', '–', s ? n(s.turbinePeak, 3) : '–'],
        ['Installed capacity', 'MW', s ? n(s.capacityMW, 3) : '–'],
        ['Average annual energy', 'GWh', s ? n(s.energyGwh, 2) : '–'],
        ['Plant factor', '%', s ? n(s.plantFactor * 100, 1) : '–'],
        ['Daily output exceeded 90% of days', 'MW', s?.powerDuration ? n(s.powerDuration.p90MW, 2) : '–'],
        ['Daily output exceeded 95% of days', 'MW', s?.powerDuration ? n(s.powerDuration.p95MW, 2) : '–'],
      ]
    ) +
    basisOfCalculation(c);

  app.push(A('POWER AND ENERGY CALCULATION BASIS') + powerAppendix);

  /**
   * THE ONE PARAMETER THE DEVELOPER ACTUALLY CONTROLS.
   *
   * Everything above is a consequence of a choice the report had been making
   * silently: size the machine at Q40. A reader was given one capacity, one
   * energy and one dry-season share with no way to see what a different machine
   * would have done — and design flow is not a property of the river, it is a
   * decision, and the only real one available at screening.
   *
   * No cost is applied here and none is implied. What the sweep gives instead
   * is the physical trade-off and two markers that need no economics: what the
   * last megawatt earns in full-load hours, and the largest machine that still
   * clears NEA's published dry-season bar.
   */
  if (c.designSweep && c.designSweep.points.length >= 3) {
    const sw = c.designSweep;
    const chosen = sw.chosen;
    const bar = sw.dryLimitSixSix;
    const eight = sw.dryLimitEightFour;
    const decisionExceedances = new Set(
      [0.3, 0.4, 0.45, 0.5, chosen?.exceedance, bar?.exceedance, eight?.exceedance]
        .filter((value): value is number => typeof value === 'number')
        .map((value) => value.toFixed(3))
    );
    let decisionPoints = sw.points
      .filter((point) => decisionExceedances.has(point.exceedance.toFixed(3)))
      .sort((a, b) => a.exceedance - b.exceedance);
    if (decisionPoints.length < 3) {
      decisionPoints = [sw.points[0], sw.points[Math.floor(sw.points.length / 2)], sw.points[sw.points.length - 1]]
        .filter((point, index, all) => all.findIndex((other) => other.exceedance === point.exceedance) === index)
        .sort((a, b) => a.exceedance - b.exceedance);
    }
    let df =
      H('DESIGN-FLOW SENSITIVITY') +
      `<p>The same indicative layout is tested across several reference flows. This is a physical
      sensitivity, not an optimisation: without capital cost, operating cost, outage assumptions
      and financing, it cannot identify a preferred machine size.</p>` +
      chartBlock(
        designFlowSvg(sw),
        'Annual energy against installed capacity for one fixed indicative layout'
      ) +
      table(
        'Decision-relevant reference cases',
        ['Reference', 'Design flow', 'Indicative capacity', 'Annual energy', 'Dry share 6+6'],
        decisionPoints.map((point) => [
          `Q${Math.round(point.exceedance * 100)}${chosen && point.exceedance === chosen.exceedance ? '  (screening reference)' : ''}`,
          `${n(point.designFlowCms, 2)} m³/s`,
          `${n(point.capacityMW, 1)} MW`,
          `${n(point.energyGwh, 1)} GWh`,
          point.dryShareSixSix === null ? '–' : `${n(point.dryShareSixSix * 100, 1)} %`,
        ])
      );

    if (bar && chosen && bar.designFlowCms < chosen.designFlowCms) {
      df += finding(
        'note',
        `<b>The Q${Math.round(exc * 100)} reference case is below the 30% dry-season criterion.</b> The model indicates Q${Math.round(bar.exceedance * 100)} as a smaller comparison case above the criterion (${n(bar.capacityMW, 1)} MW and ${n(bar.energyGwh, 1)} GWh/year). Hydrological verification and economics are required before selecting between them.`
      );
    } else if (bar && chosen && bar.designFlowCms >= chosen.designFlowCms) {
      df += finding(
        'clear',
        `<b>The Q${Math.round(exc * 100)} reference case is above the 30% dry-season criterion.</b> The model indicates that comparison cases up to Q${Math.round(bar.exceedance * 100)} remain above it. This does not establish PPA eligibility.`
      );
    } else if (!bar) {
      df += finding(
        'watch',
        `<b>No reference case screened is above the 30% dry-season criterion.</b>${eight ? ` The 15% criterion is met up to Q${Math.round(eight.exceedance * 100)} in the model.` : ' The 15% criterion is also not met.'} Verify the seasonal flow regime before drawing a tariff conclusion.`
      );
    }

    if (sw.maxEnergy.designFlowCms < sw.points[sw.points.length - 1].designFlowCms) {
      df += finding(
        'watch',
        `<b>Modelled energy peaks near Q${Math.round(sw.maxEnergy.exceedance * 100)} and declines for larger reference flows</b> because the assumed turbine minimum-flow constraint increases shutdown time. Equipment selection must verify this behaviour.`
      );
    }

    df += `<p class="eqnote">Each case re-sizes the screening waterway, applies an indicative turbine
    curve and dispatches the same daily model record. No capital cost, operating cost, discount rate
    or NPV is applied. Dry-season share has a measured model bias of approximately 4–6 percentage
    points and should not be used as a contractual determination.</p>`;

    sec.push(df);

    app.push(
      A('DESIGN-FLOW SENSITIVITY DATA') +
        table(
          'Full reference-flow sweep',
          ['Reference', 'Design flow', 'Capacity', 'Energy', 'Incremental full-load hours', 'Dry share 6+6'],
          sw.points
            .slice()
            .sort((a, b) => a.exceedance - b.exceedance)
            .map((point) => [
              `Q${Math.round(point.exceedance * 100)}`,
              `${n(point.designFlowCms, 2)} m³/s`,
              `${n(point.capacityMW, 3)} MW`,
              `${n(point.energyGwh, 1)} GWh`,
              point.marginalHours === null ? '–' : `${n(point.marginalHours, 0)} h/yr`,
              point.dryShareSixSix === null ? '–' : `${n(point.dryShareSixSix * 100, 1)} %`,
            ])
        )
    );
  }

  // ---- 06 pondage ----------------------------------------------------------
  let stageAppendix = '';
  const pond = c.pondage;
  if (pond) {
    const sc = stageSvg(pond.stageCurve ?? []);
    const cellM = pond.resolutionM;
    const dryInflow = c.flow.dates.length ? minMonthlyMean(c.flow.dates, c.flow.values) * scale : NaN;
    const demand =
      s && Number.isFinite(dryInflow)
        ? pondageDemand(s.designFlowCms, s.residualCms, dryInflow, pond.volumeM3)
        : null;

    let pd =
      H('PRELIMINARY PONDAGE POTENTIAL') +
      `<p>A connected level-pool test on the ${n(cellM, 0)} m terrain model indicates that pondage may
      be topographically possible near the intake. It is a site-screening result only; the terrain
      model cannot establish storage volume, dam height, inundation, freeboard or hydraulic operation.</p>` +
      facts([
        ['Terrain-screen level', `+${n(pond.damHeightM, 0)} m above detected channel bed`],
        ['Indicative water surface', `${approx(pond.areaM2 / 10000, 1)} ha`],
        ['Indicative storage', `${approx(pond.volumeM3 / 1e6, 1)} million m³`],
        ['Indicative upstream extent', `${approx(pond.upstreamLengthM / 1000, 1)} km`],
        ['Evidence level', `${n(cellM, 0)} m DEM; no topographic or bathymetric survey`],
      ]) +
      chartBlock(sc, 'Preliminary stage–area–storage sensitivity from the terrain screen') +
      finding(
        'watch',
        '<b>Do not use the reported area or volume for design.</b> A surveyed surface, verified dam axis, hydraulic boundary conditions and inundation assessment are required before storage or operating pondage can be stated.'
      );

    if (pond.edgeLimited) {
      pd += finding('note', 'The modelled water surface reaches the terrain-window edge, so even the desktop footprint is a lower bound.');
    }

    if (demand) {
      const hours = demand.hoursSupported === null ? null : Math.min(demand.hoursSupported, demand.inflowCeilingHours);
      if (demand.deficitCms <= 0) {
        pd += finding('clear', '<b>The modelled dry-month inflow is at or above the reference flow.</b> Pondage would affect dispatch timing rather than increase the modelled daily energy supply.');
      } else if (demand.inflowLimited) {
        pd += finding(
          'note',
          `<b>Dry-season operation is inflow-limited in the model.</b> The daily inflow supports approximately ${n(demand.inflowCeilingHours, 1)} hours at the reference flow, irrespective of a larger storage volume. Pondage may shift generation timing but does not resolve the seasonal water deficit.`
        );
      } else if (hours !== null && hours >= PONDAGE_REFERENCE_HOURS) {
        pd += finding('note', `<b>The terrain-screen volume exceeds the ${PONDAGE_REFERENCE_HOURS}-hour peaking reference.</b> This is a potential worth surveying, not confirmation of an operating pond.`);
      } else {
        pd += finding('note', `<b>The terrain-screen volume supports approximately ${n(hours ?? 0, 1)} hours at the reference flow.</b> Survey and hydraulic modelling are required before using this result.`);
      }
    }
    sec.push(pd);

    stageAppendix =
      '<h2>Connected level-pool calculation</h2>' +
      `<div class="eq">
        <div class="eqhead">How the pond was measured</div>
        <div class="eqrow"><span>Water level  = bed + retained height</span><b>${n(pond.bedElevationM, 1)} + ${n(pond.damHeightM, 1)} = <u>${n(pond.waterLevelM, 1)} m</u></b></div>
        <div class="eqrow"><span>Cells below that level, connected to the channel</span><b><u>${pond.floodedCells.toLocaleString()}</u></b></div>
        <div class="eqrow"><span>Area = cells × cell²</span><b>${pond.floodedCells.toLocaleString()} × ${n(cellM, 0)}² = <u>${n(pond.areaM2 / 10000, 2)} ha</u></b></div>
        <div class="eqrow"><span>Storage = Σ (level − ground) × cell²</span><b><u>${n(pond.volumeM3 / 1e6, 3)} million m³</u></b></div>
        <div class="eqrow"><span>Mean depth = storage / area</span><b>${n(pond.volumeM3, 0)} / ${n(pond.areaM2, 0)} = <u>${n(pond.meanDepthM, 1)} m</u></b></div>
      </div>
      <p class="eqnote">A flat water surface is grown outward from the channel through neighbouring
      cells that lie below the level, and the natural outlet is closed by the inferred dam axis, so a
      pool that would drain downstream is not counted. Maximum depth is ${n(pond.maxDepthM, 1)} m and the
      inferred dam-axis span is ${pond.damLengthM == null ? 'not closed within the window' : `${n(pond.damLengthM, 0)} m`}.
      Terrain is read at ${n(cellM, 0)} m, so the shoreline is resolved to about one cell.</p>`;

    if (pond.levelSensitivity) {
      const ls = pond.levelSensitivity;
      stageAppendix +=
        `<p>Because the shoreline is resolved to a cell, the answer moves with the assumed water level.
        Perturbing it by ±${n(ls.errorM, 0)} m moves the area by ${n(ls.areaSpreadPct, 0)}% and the storage by
        ${n(ls.volumeSpreadPct, 0)}%.</p>`;
    }
    if (pond.terrainComparison) {
      const tc = pond.terrainComparison;
      stageAppendix += `<p>Screened again on a second, independently produced elevation surface at the same dam axis,
      the same pool measures ${n(tc.areaM2 / 10000, 2)} ha and ${n(tc.volumeM3 / 1e6, 3)} million m³ — a spread of
      ${n(tc.areaSpreadPct, 0)}% on area and ${n(tc.volumeSpreadPct, 0)}% on storage.</p>`;
    } else {
      stageAppendix += finding('note', 'Only one elevation surface was available, so this footprint carries no second-source check.');
    }

    if (demand) {
      const hrs = demand.hoursSupported === null ? null : Math.min(demand.hoursSupported, demand.inflowCeilingHours);
      stageAppendix +=
        '<h2>Reference peaking balance</h2>' +
        `<div class="eq">
          <div class="eqhead">Daily peaking balance, driest month</div>
          <div class="eqrow"><span>Usable inflow  Qa = dry-month mean − residual release</span><b>${n(demand.dryInflowCms, 3)} − ${n(s?.residualCms ?? 0, 3)} = <u>${n(demand.usableInflowCms, 3)} m³/s</u></b></div>
          <div class="eqrow"><span>Shortfall while peaking  Qd − Qa</span><b>${n(demand.designFlowCms, 3)} − ${n(demand.usableInflowCms, 3)} = <u>${n(demand.deficitCms, 3)} m³/s</u></b></div>
          <div class="eqrow"><span>Storage for ${demand.referenceHours} h at design flow  = (Qd − Qa) × h × 3600</span><b><u>${n(demand.requiredM3 / 1e6, 3)} million m³</u></b></div>
          <div class="eqrow"><span>Hours this pond delivers</span><b><u>${hrs === null ? 'no pond needed' : `${n(hrs, 1)} h`}</u></b></div>
          <div class="eqrow"><span>Ceiling from inflow alone  = 24 × Qa / Qd</span><b><u>${n(demand.inflowCeilingHours, 1)} h</u></b></div>
        </div><p class="eqnote">One average day, level pool: no ramping, spill, turbine minimum,
        drawdown rule or flushing allowance.</p>`;
    }
    if (pond.stageCurve?.length) {
      stageAppendix += table(
        'Stage, area and storage at the intake',
        ['Retained level m', 'Water area ha', 'Storage million m³'],
        pond.stageCurve.map((p) => [n(p.retainedHeightM, 1), n(p.areaM2 / 10000, 2), n(p.volumeM3 / 1e6, 3)])
      );
    }
  }


  /**
   * WHERE THE STORAGE IS, NOT JUST HOW MUCH.
   *
   * The section above answers the pondage question at one point — the intake,
   * which the search chose for head and flow and which knows nothing about
   * storage. A valley narrows and widens every few hundred metres, so the pond
   * a site can hold varies more with WHERE the dam goes than with how tall it
   * is, and the study had no way to say so. This repeats the same screen at
   * nine positions either side.
   *
   * Ranked on storage per metre of dam rather than on storage. Raw volume grows
   * downstream with the valley and the catchment, so a sweep reported on volume
   * alone points at the far end of the reach every time, which is not advice.
   */
  if (c.pondageSweep && c.pondageSweep.points.length >= 3) {
    const sw = c.pondageSweep;
    const cur = sw.current;
    const best = sw.best;
    const gain =
      cur && best && cur.volumePerDamMetreM3 && best.volumePerDamMetreM3 && best.i !== cur.i
        ? best.volumePerDamMetreM3 / cur.volumePerDamMetreM3
        : null;

    let ps =
      '<h2>Pondage position screen</h2>' +
      `<p>The same level-pool method was repeated at ${sw.points.length} positions. Results are ranked
      by storage per metre of inferred dam span so that the comparison does not simply favour the
      downstream end of the valley.</p>` +
      `<figure class="cw appendix-figure">${pondagePositionSvg(sw)}<figcaption>Appendix figure · Storage per metre of inferred dam span at ${n(sw.damHeightM, 1)} m retained level. Hollow bars are terrain-window lower bounds.</figcaption></figure>` +
      table(
        'Pondage against position',
        ['Position', 'Water area', 'Storage', 'Dam span', 'Per metre of dam'],
        sw.points.map((q) => [
          `${q.offsetKm >= 0 ? '+' : ''}${n(q.offsetKm, 2)} km${cur && q.i === cur.i ? '  (as sited)' : ''}${q.edgeLimited ? '  ≥' : ''}`,
          `${n(q.areaM2 / 10000, 2)} ha`,
          `${n(q.volumeM3 / 1e6, 3)} Mm³`,
          q.damLengthM == null ? 'not bounded' : `${n(q.damLengthM, 0)} m`,
          q.volumePerDamMetreM3 == null ? '–' : `${n(q.volumePerDamMetreM3, 0)} m³/m`,
        ])
      );

    ps += gain && gain >= 1.25
      ? finding(
          'watch',
          `<b>A comparison position ${n(Math.abs(best!.offsetKm), 2)} km ${best!.offsetKm > (cur?.offsetKm ?? 0) ? 'downstream' : 'upstream'} has ${n(gain, 1)}× the screened storage per metre of inferred dam span.</b> This is not a relocation recommendation; head, energy, access, geology and inundation would all need to be re-screened at that position.`
        )
      : best && cur && best.i === cur.i
        ? finding('clear', '<b>The intake position ranks highest among the desktop pondage comparisons.</b> The result remains subject to DEM resolution and survey verification.')
        : gain
          ? finding('note', `The strongest comparison differs by ${n(gain, 2)}×, which is not considered material at ${n(pond?.resolutionM ?? 30, 0)} m terrain resolution.`)
          : finding('note', 'No position screened returned a pond bounded inside its terrain window, so the positions cannot be ranked against each other.');

    ps += `<p class="eqnote">A screen on top of a screen: every limitation of the pondage section
    above applies at every position here and compounds — a ${n(sw.points[0]?.edgeLimited ? 30 : 30, 0)} m
    elevation model, a level-pool fill, no spillway, no geology, no land take and no cost. Positions
    marked ≥ reached the edge of their terrain window, so their area and storage are minima and they
    are drawn hollow. What this ranks is positions against each other on one consistent basis; it
    does not size any of them. Terrain source: ${esc(sw.source)}.</p>`;

    stageAppendix += ps;
  }

  // ---- 07 alternatives -----------------------------------------------------
  if (c.schemes.length > 1) {
    sec.push(
      H('SCHEME LAYOUT ALTERNATIVES') +
        `<p>An automated reach search was used to identify comparison layouts. Three materially
        different candidates are retained in the main report; they are alternatives for field
        reconnaissance, not ranked designs.</p>` +
        table(
          'Shortlisted desktop layout alternatives',
          ['Alternative', 'Indicative capacity', 'Annual energy', 'Net head', 'Waterway'],
          c.schemes.slice(0, 3).map((layout, index) => [
            `${index + 1}${layout === s ? '  (reference)' : ''}`,
            `${n(layout.capacityMW, 1)} MW`,
            `${n(layout.energyGwh, 1)} GWh`,
            `${n(layout.netHeadM, 0)} m`,
            `${n(layout.waterwayKm, 1)} km`,
          ])
        ) +
        finding(
          'limit',
          '<b>Alternative ranking excludes constructability and cost.</b> Survey control, geology, access, headworks siting, land requirements and power evacuation may change the preferred corridor.'
        )
    );
    app.push(
      A('ALTERNATIVE LAYOUTS CONSIDERED') +
        `<p>${c.evaluated} automated candidates were screened. The table retains the leading model
        outputs for traceability; it is not a design ranking.</p>` +
        table(
          'Alternative layouts',
          ['#', 'Capacity MW', 'Energy GWh', 'Net head m', 'Waterway km', 'Turbine'],
          c.schemes.slice(0, 10).map((a, i) => [
            String(i + 1) + (a === s ? ' ▪' : ''),
            n(a.capacityMW, 3),
            n(a.energyGwh, 2),
            n(a.netHeadM, 1),
            n(a.waterwayKm, 2),
            a.turbine ? String(a.turbine) : '–',
          ])
        )
    );
  }

  // ---- 08 neighbours -------------------------------------------------------
  if (c.cascade) {
    const rows: Row[] = [...c.cascade.upstream, ...c.cascade.downstream].map((p) => {
      const pp = p as unknown as { name?: string; capacityMW?: number; stage?: string; bounds?: number[] | null };
      return [
        pp.name ?? '–',
        p.direction === 'upstream' ? 'Upstream' : 'Downstream',
        n(pp.capacityMW ?? null, 2),
        pp.stage ?? '–',
        n(p.routeKm, 1),
        n(publishedRangeKm(pp.bounds) ?? p.publishedRangeDiagonalKm ?? null, 1),
      ];
    });
    const nearest = [...c.cascade.upstream, ...c.cascade.downstream].sort((a, b) => a.routeKm - b.routeKm)[0] as
      | unknown as { name?: string; routeKm?: number }
      | undefined;
    sec.push(
      H('LICENCE AND CASCADE SCREEN') +
        `<p>${c.cascade.upstream.length} licensed projects lie upstream of the intake and
        ${c.cascade.downstream.length} downstream of the powerhouse. ${c.cascade.directReachRecords} licence
        records fall on the diverted reach itself, of which ${c.cascade.directAdvancedRecords} hold a
        construction licence or are already operating.${
          nearest?.name ? ` The closest is ${esc(nearest.name)}, ${n(nearest.routeKm ?? null, 1)} km away along the river.` : ''
        }${rows.length ? ` The routed register is provided in Appendix ${String.fromCharCode(65 + appNo + 1)}.` : ''}</p>`
    );
    if (rows.length) {
      app.push(
        A('REGISTER OF NEIGHBOURING LICENSED PROJECTS') +
          table(
            'Licensed projects upstream and downstream',
            ['Project', 'Direction', 'Capacity MW', 'Stage', 'Route km', 'Published range km'],
            rows
          )
      );
    }
  }

  // ---- 09 access and grid --------------------------------------------------
  if (c.roadAccess || c.grid) {
    const iKm = kmOf(c.roadAccess?.intake?.distanceM);
    const pKm = kmOf(c.roadAccess?.powerhouse?.distanceM);
    const worst = Math.max(iKm ?? 0, pKm ?? 0);
    const newTrack = (iKm ?? 0) + (pKm ?? 0);
    let access = '';
    if (c.roadAccess && (iKm !== null || pKm !== null)) {
      access =
        `<p>The nearest motorable road reaches within ${dist(iKm)} of the intake and ${dist(pKm)} of the
        powerhouse.</p>` +
        (worst < 0.5
          ? finding('clear', `<b>Both structures are effectively on the road network.</b> No new access road is implied at this stage, which removes one of the larger civil costs a remote site carries.`)
          : worst < 3
            ? finding('note', `<b>Access is short but not immediate.</b> Roughly ${n(newTrack, 1)} km of new track would connect both structures — routine for a scheme of this size, but it should be walked before it is costed.`)
            : finding('watch', `<b>Access is a real cost here.</b> The furthest structure is ${dist(worst)} from a motorable road, so on the order of ${n(newTrack, 1)} km of new mountain track is implied. On a ${s ? n(s.capacityMW, 1) : '–'} MW scheme this can rival the powerhouse in cost and should be surveyed early.`));
    } else if (c.roadAccess) {
      access = finding('watch', 'No motorable road was found within the searched radius of either structure. Access must be treated as an open question.');
    }
    sec.push(
      H('ACCESS AND POWER EVACUATION') +
        access +
        (c.grid
          ? facts([
              ['Connection voltage required', `${n(c.grid.requiredKv, 0)} kV`],
              ['Nearest mapped line', `${dist(c.grid.nearestKm)} at ${kv(c.grid.nearestKv)}`],
              ['Nearest line of adequate voltage', c.grid.adequateKm == null ? '–' : `${dist(c.grid.adequateKm)} at ${kv(c.grid.adequateKv)}`],
              ['Nearest substation', c.grid.nearestSub ? `${c.grid.nearestSub.name ?? 'unnamed'} · ${dist(c.grid.nearestSub.km)}, ${kv(c.grid.nearestSub.kv)}` : '–'],
            ])
          : '') +
        /**
         * THE CONNECTION IS A COST, AND IT WAS ONLY EVER A TABLE ROW.
         *
         * Four rows of distances told a reader nothing about ROUTE: whether the
         * substation is up the same valley or over a ridge, and whether the
         * line runs past the powerhouse or away from it. Those decide what a
         * connection costs, and a reader said the grid data was not in the
         * report at all — it was, in a table they scrolled past. So the numbers
         * now get a verdict and a map.
         */
        (c.grid
          ? (() => {
              const sub = c.grid.nearestSub;
              const km = c.grid.adequateKm ?? c.grid.nearestKm;
              const enough = c.grid.adequateKm != null;
              return (
                (enough && km <= 5
                  ? finding('clear', `<b>A line of adequate voltage runs within ${dist(km)}.</b> Interconnection is a short spur rather than a transmission project, which for a scheme of this size is the favourable case.`)
                  : enough
                    ? finding('watch', `<b>${dist(km)} of ${n(c.grid.adequateKv, 0)} kV interconnection is implied.</b> That is a real transmission cost and it is not in any figure in this report — price it before the civil works, because on a scheme of this size it can decide the project.`)
                    : finding('watch', `<b>No mapped line reaches the ${n(c.grid.requiredKv, 0)} kV this capacity would need.</b> The nearest line of any voltage is ${dist(c.grid.nearestKm)} away, ${kv(c.grid.nearestKv)}, so connection means either a new line at the required voltage or a smaller machine.`)) +
                (sub
                  ? `<p>The nearest mapped connection point is <b>${esc(sub.name ?? 'an unnamed substation')}</b>, ${dist(sub.km)} away, ${kv(sub.kv)}${sub.inferredKv ? ', a voltage inferred from a connecting line rather than tagged on the substation itself' : ''}. Substation capacity and spare bay availability are not in any open dataset and must be confirmed with NEA.</p>`
                  : '') +
                (figures.grid
                  ? figure(
                      `Transmission lines and substations around the scheme — hillshaded relief, the alignment in colour, lines and connection points in purple` +
                        (figures.gridFrameKm ? `. Frame about ${n(figures.gridFrameKm, 0)} km across` : ''),
                      figures.grid
                    )
                  : '')
              );
            })()
          : '')
    );
  }

  // ---- 10 hazards ----------------------------------------------------------
  let hazardAppendix = '';
  let hazardSection = '';
  const hazardHeading = () => (hazardSection ? '' : H('NATURAL HAZARD SCREENING'));
  if (c.hazards) {
    const cats = (c.hazards.categories ?? []).filter((k) => k.count > 0);
    const slides = cats.find((k) => /landslide/i.test(k.title));

    /**
     * THE VERDICT HAS TO BE ABOUT THE ALIGNMENT, NOT ABOUT THE DISTRICT.
     *
     * It used to fire on the landslide count inside the whole 15 km search
     * radius, and at the first real site that printed "this is an actively
     * failing corridor — 103 landslides". The corridor figure above is what
     * caught it. Measured on the same records:
     *
     *     0-1 km    3        5-10 km   62
     *     1-2 km   10        10+ km    22
     *     2-5 km    6
     *
     * and a SINGLE coordinate 9.85 km away carries 39 of the 103, with a second
     * at 10.48 km carrying 16. More than half the evidence for "actively
     * failing" was two distant geocoding centroids — BIPAD files an incident to
     * a settlement, not to the scar. Thirteen landslides lie within 2 km of the
     * works. That is still a slope-stability site; it is not the same claim.
     *
     * So the verdict is formed on the NEAR band and the wider count is reported
     * beside it rather than instead of it, and where one coordinate dominates
     * the report says so — a reader who is not told will read 103 scars.
     */
    const slideRecords = (c.hazards.records ?? []).filter((r) => /landslide/i.test(r.kind));
    const nearSlides = slideRecords.filter((r) => r.distanceKm <= NEAR_CORRIDOR_KM).length;
    const clusters = new Map<string, number>();
    for (const r of slideRecords) {
      const key = `${r.lat.toFixed(3)},${r.lon.toFixed(3)}`;
      clusters.set(key, (clusters.get(key) ?? 0) + 1);
    }
    const biggest = Math.max(0, ...clusters.values());
    const clustered = slideRecords.length >= 20 && biggest / slideRecords.length >= 0.25;
    const clusterNote = clustered
      ? ` <b>Read the wider count carefully:</b> ${biggest} of those ${slideRecords.length} share a single coordinate, because incidents are filed against a settlement rather than against the scar. The figure below groups them, so the number of DOTS is the number of places.`
      : '';
    const nearest = cats.reduce<number | null>(
      (best, k) => (k.nearestKm == null ? best : best == null ? k.nearestKm : Math.min(best, k.nearestKm)),
      null
    );
    const verdict =
      c.hazards.total === 0
        ? finding('clear', `<b>No hazard has been recorded within ${n(c.hazards.radiusKm, 1)} km of this corridor</b> over the period searched. That is an absence of records, not proof of a stable slope.`)
        : nearSlides >= 10
          ? finding('watch', `<b>The incident register contains ${nearSlides} landslide records within ${NEAR_CORRIDOR_KM} km of the corridor</b> — ${slideRecords.length} within the full ${n(c.hazards.radiusKm, 1)} km screen — the nearest ${n(slides?.nearestKm, 1)} km from the alignment. These are historical incident locations, not slope-failure probabilities; an engineering-geology traverse is required before routing.${clusterNote}`)
          : nearSlides > 0
            ? finding('note', `<b>${nearSlides} landslide${nearSlides === 1 ? ' has' : 's have'} been recorded within ${NEAR_CORRIDOR_KM} km of the corridor,</b> the nearest ${n(slides?.nearestKm, 1)} km from the alignment, out of ${slideRecords.length} across the full ${n(c.hazards.radiusKm, 1)} km screen. The incident data indicate slope instability in the surrounding terrain but do not establish conditions on the route; verify the alignment by ground traverse.${clusterNote}`)
            : finding('note', `${c.hazards.total} records fall within the ${n(c.hazards.radiusKm, 1)} km screen, the nearest ${n(nearest, 1)} km from the alignment, and none within ${NEAR_CORRIDOR_KM} km of the works. The alignment should still be walked: absence of a filed record is not evidence of a stable slope.${clusterNote}`);
    hazardSection +=
      hazardHeading() +
        '<h2>Recorded incident data</h2>' +
        `<p>${c.hazards.total} hazard records fall within ${n(c.hazards.radiusKm, 1)} km of the scheme corridor
        between ${esc(c.hazards.period.from)} and ${esc(c.hazards.period.to)}.${
          c.hazards.records?.length
            ? ` The ${Math.min(HAZARD_APPENDIX_ROWS, c.hazards.records.length)} nearest, with coordinates and distance to the alignment, are listed in the appendices${c.hazards.records.length > HAZARD_APPENDIX_ROWS ? `; the remaining ${c.hazards.records.length - HAZARD_APPENDIX_ROWS} are in the GeoJSON export` : ''}.`
            : ''
        }</p>` +
        verdict +
        figure(
          `Recorded hazards on the ground they sit on — hillshaded relief, the alignment in colour, every filed record at its own coordinates${
            figures.hazardFrameKm ? `. Frame about ${n(figures.hazardFrameKm, 0)} km across` : ''
          }`,
          figures.hazards
        )
    ;
    if (c.hazards.records?.length) {
      hazardAppendix = table(
        'Hazard records, nearest first',
        ['Date', 'Type', 'Latitude', 'Longitude', 'Distance km'],
        c.hazards.records
          .slice()
          .sort((a, b) => a.distanceKm - b.distanceKm)
          .slice(0, HAZARD_APPENDIX_ROWS)
          .map((r) => [r.date, r.kind, n(r.lat, 5), n(r.lon, 5), n(r.distanceKm, 2)])
      );
    }
  }

  // ---- 11 GLOF -------------------------------------------------------------
  let lakeAppendix = '';
  if (c.upstreamConnectivity) {
    const u = c.upstreamConnectivity;
const { listed, growing, risky } = glofDangerSignals(u.lakes);
    const nearest = u.lakes.reduce<(typeof u.lakes)[number] | null>(
      (best, l) => (best == null || l.routeKm < best.routeKm ? l : best),
      null
    );
        const glacierFed = u.lakes.filter((l) => l.connectivity === 'Glacier-fed').length;
    hazardSection +=
      hazardHeading() +
        '<h2>Glacial-lake outburst flood screen</h2>' +
        (u.lakes.length === 0
          ? finding('note', `<b>No mapped glacial-lake source in the screened inventory intersects the upstream flow path.</b> The connectivity test covered ${u.lakeInventory.total.toLocaleString()} mapped lakes. Verify inventory completeness and upstream routing during detailed hazard assessment; this screen does not eliminate GLOF risk.`)
          : risky.length
            ? finding(
                'watch',
                `<b>${risky.length} upstream lake${risky.length === 1 ? '' : 's'} within ${GLOF_ROUTE_KM} km of flow path ` +
                  `${risky.length === 1 ? 'carries' : 'carry'} a published danger signal.</b> ` +
                  (listed.length
                    ? `${listed.length} ${listed.length === 1 ? 'is' : 'are'} on ICIMOD's 2020 list of potentially ` +
                      `dangerous glacial lakes${
                        listed[0].pdgl ? ` — ${esc(listed[0].pdgl.name ?? listed[0].id)}, rank ${listed[0].pdgl.rank}, ${n(listed[0].routeKm, 0)} km upstream` : ''
                      }. `
                    : '') +
                  (growing.length
                    ? `${growing.length} ${growing.length === 1 ? 'is a glacier-fed lake' : 'are glacier-fed lakes'} with a ` +
                      `significant measured expansion trend. `
                    : '') +
                  `A GLOF study and an outburst design flood are required, and the intake and powerhouse levels ` +
                  `should be set against it rather than against the flood-frequency curve alone.`
              )
            : finding(
                'note',
                `<b>${u.lakes.length} upstream lake${u.lakes.length === 1 ? '' : 's'} drain${u.lakes.length === 1 ? 's' : ''} through this site${
                  nearest ? `, the nearest ${n(nearest.routeKm, 0)} km up the flow path` : ''
                }, and none carries a published danger signal.</b> ` +
                  `${glacierFed} of them ${glacierFed === 1 ? 'is' : 'are'} glacier-fed; none within ${GLOF_ROUTE_KM} km of ` +
                  `flow path appears on ICIMOD's list of 47 potentially dangerous glacial lakes, and none shows a ` +
                  `significant expansion trend. <b>This screen has no lake-area term</b> — the bundled inventory is ` +
                  `centroids only — so it cannot rank a pond against a large lake, and GLOF stays a residual risk to ` +
                  `carry rather than a case this screen has closed.`
              )) +
        (c.glaciers && c.glaciers.connected.length
          ? facts([
              ['Ice draining to the intake', `${n(c.glaciers.iceKm2, 1)} km² across ${c.glaciers.connected.length} glacier${c.glaciers.connected.length === 1 ? '' : 's'}`],
              ...(c.glaciers.glacierisedFraction != null
                ? ([['Glacierised share of the catchment', `${n(c.glaciers.glacierisedFraction * 100, 1)} %`]] as [string, string][])
                : []),
              ...(c.glaciers.nearest
                ? ([['Nearest ice by flow path', `${n(c.glaciers.nearest.routeKm, 1)} km`]] as [string, string][])
                : []),
              ...(c.glaciers.lowestFrontM != null
                ? ([['Lowest ice front', `${n(c.glaciers.lowestFrontM, 0)} m`]] as [string, string][])
                : []),
              ...(c.glaciers.largest[0]
                ? ([[
                    'Largest connected glacier',
                    `${esc(c.glaciers.largest[0].name ?? `RGI ${c.glaciers.largest[0].id}`)} — ${n(c.glaciers.largest[0].areaKm2, 1)} km²`,
                  ]] as [string, string][])
                : []),
            ]) +
            `<p>Glacier outlines are the Randolph Glacier Inventory 7.0, dated 2000–2010 by submission, so
            the ice mapped here has retreated since. A glacierised catchment carries melt into the dry
            season that a rain-fed one does not, and it is the term this screen previously had to infer
            from the share of ground above 5,000 m.</p>`
          : '') +
        `<p>${u.incidents.length} recorded upstream channel incidents lie on the same flow path.${
          u.lakes.length ? ' Each lake is listed in the appendices.' : ''
        }</p>` +
        figure(
          `The upstream lakes that decide this screen, with every other layer switched off — ice in pale blue, ` +
            `each lake traced down its own flow path to the intake and labelled with the distance it would travel` +
            `${
              figures.lakesShown && figures.lakesTotal && figures.lakesShown < figures.lakesTotal
                ? figures.lakesWithinKm
                  ? `. ${figures.lakesShown} of the ${figures.lakesTotal} connected lakes lie within ${n(figures.lakesWithinKm, 0)} km of flow path and are shown; the other ${figures.lakesTotal - figures.lakesShown} are further upstream`
                  : `. The ${figures.lakesShown} nearest of ${figures.lakesTotal} connected lakes are shown`
                : ''
            }${figures.lakeFrameKm ? `. Frame about ${n(figures.lakeFrameKm, 0)} km across` : ''}`,
          figures.lakes
        )
    ;
    if (u.lakes.length) {
      /**
       * The old table was three columns of nothing: `name` and `areaHa` do not
       * exist on this record, so every row read "unnamed — –" beside a route
       * distance. These are the fields the inventory actually publishes.
       */
      const shown = [...u.lakes].sort((a, b) => a.routeKm - b.routeKm).slice(0, 15);
      lakeAppendix = table(
        `Upstream glacial lakes draining through the site${u.lakes.length > shown.length ? ` — the ${shown.length} nearest of ${u.lakes.length}` : ''}`,
        ['Lake', 'Type', 'Elevation', 'Flow path', 'Expansion', 'ICIMOD danger list'],
        shown.map((l) => [
          l.pdgl?.name ?? l.id,
          l.connectivity,
          `${n(l.elevationM, 0)} m`,
          `${n(l.routeKm, 1)} km`,
          l.expansionRateKm2Yr == null
            ? 'not published'
            : `${l.expansionRateKm2Yr > 0 ? '+' : ''}${n(l.expansionRateKm2Yr * 100, 2)} ha/yr${
                l.expansionSignificant === true ? ', significant' : ''
              }`,
          l.pdgl ? `rank ${l.pdgl.rank}` : 'not listed',
        ])
      );
    }
  }

  // ---- 12 seismic, geology, conservation, survey ----------------------------
  const seis: [string, string][] = [];
  if (c.seismic?.pga475g != null) seis.push(['Peak ground acceleration, 475-year return', `${n(c.seismic.pga475g, 2)} g`]);
  if (c.seismic?.quakeCount != null) seis.push(['Recorded earthquakes nearby', String(c.seismic.quakeCount)]);
  if (c.seismic?.largest) seis.push(['Largest recorded earthquake', c.seismic.largest]);
  if (c.faults?.nearest) seis.push(['Nearest mapped fault', `${c.faults.nearest.name ?? c.faults.nearest.type} · ${n(c.faults.nearest.distanceKm, 1)} km`]);
  if (c.faults?.crossings != null) seis.push(['Mapped fault intersections at dataset resolution', String(c.faults.crossings)]);
  if (seis.length) {
    const pga = c.seismic?.pga475g ?? null;
    const faultKm = c.faults?.nearest?.distanceKm ?? null;
    const sv =
      pga == null
        ? ''
        : pga >= 0.4
          ? finding('watch', `<b>The regional 475-year PGA screen is ${n(pga, 2)} g.</b> Confirm the governing code parameters and site class before structural or transient design.`)
          : pga >= 0.25
            ? finding('note', `The regional 475-year PGA screen is ${n(pga, 2)} g. Site class and code parameters are not established at desktop stage.`)
            : finding('note', `The regional 475-year PGA screen is ${n(pga, 2)} g. This is regional context, not a site response assessment.`);
    const fv =
      faultKm == null
        ? ''
        : (c.faults?.crossings ?? 0) > 0
          ? finding('watch', `<b>A mapped fault crosses the alignment.</b> A tunnel or buried penstock across an active trace needs a fault-crossing detail, not a standard section.`)
          : finding('note', `<b>No mapped active fault intersects the corridor at the resolution of the screened dataset.</b> The nearest mapped trace is ${n(faultKm, 1)} km away. Field mapping and the detailed seismic assessment remain required.`);
    /**
     * A DISTANCE TO A FAULT IS NOT A PICTURE OF ONE.
     *
     * This section was five numbers and a verdict. "Main Frontal Thrust, 51.9
     * km" does not say which side of the works the thrust runs, whether the
     * recorded epicentres cluster up the valley or across it, or how the
     * regional structure is oriented against the alignment — all of which a
     * reader forms an opinion about in one glance at a map and cannot form at
     * all from a table. Same monochrome relief as the hazard figure so the two
     * are read as a pair.
     */
    /**
     * THE CAPTION MUST NOT PROMISE WHAT THE FRAME DOES NOT HOLD.
     *
     * It said "faults in dark red" whether or not any fault fell inside the
     * frame. On the first site it did not — the fault screen's radius is
     * smaller than the 51.9 km to the nearest mapped trace, so nothing was
     * drawn and the caption described a layer the reader could not find. A
     * caption that names a colour no ink on the page uses is worse than no
     * caption. So it describes what is actually there, and where a fault is
     * known but out of frame it says so with the distance.
     */
    hazardSection +=
      hazardHeading() +
      '<h2>Seismicity and mapped active faults</h2>' +
      facts(seis) +
      sv +
      fv;
  }
  if (hazardSection) sec.push(hazardSection);

  /**
   * GEOLOGY IS A GAP, AND THE REPORT HAS TO SAY SO.
   *
   * This section used to print three rows of the same Macrostrat polygon —
   * "Precambrian-Phanerozoic sedimentary rocks / sedimentary rocks" at intake,
   * mid-reach and powerhouse — which is a 550-million-year age bracket over a
   * whole mountain belt. A reviewer read it as the section being missing, and
   * that reading was right: identical boilerplate at three points is not a
   * finding, it is the absence of one wearing a table.
   *
   * Macrostrat cannot be tuned to do better here. Its `small`, `medium` and
   * `large` scale layers all return nothing over Nepal; only the coarsest
   * global layer covers the country. So the honest section reports what IS
   * known — which published DMG sheets cover the alignment, if any — and states
   * the gap plainly instead of dressing it up.
   */
  let geologyAppendix = '';
  {
    const dmg = c.geology?.dmg ?? null;
    const covering = dmg?.maps ?? [];
    const samples = c.geology?.regional?.samples ?? [];
    const distinct = new Set(samples.flatMap((smp) => smp.units.map((u) => u.name)));
    let geo = H('PRELIMINARY ENGINEERING GEOLOGY');

    /**
     * THE PROVINCIAL SHEET LEADS THE SECTION.
     *
     * It is the only real mapping this report has here — mapped units, thrusts
     * and fold axes surveyed by the national geological survey — and until it
     * existed this section opened by saying what was missing. What a reader
     * needs first is what IS known.
     *
     * The placement figure quoted is the MEASURED one, not the builder's own
     * graticule residual. That residual is a self-check: it says the projective
     * fit reproduces the sheet's own tick marks, and a sheet read consistently
     * but hung a kilometre out would satisfy it perfectly.
     */
    const sheet = figures.geologySheet ?? null;
    if (figures.geology && sheet) {
      const km = sheet.placementKm;
      // The index keys sheets by file stem, so the province arrives lowercase.
      const prov = sheet.province.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
      geo +=
        `<p>The Department of Mines and Geology ${esc(prov)} Province sheet provides regional
        geological context at ${esc(sheet.scale)}. It is shown beneath the indicative alignment.</p>` +
        figure(
          `Published ${prov} Province geological map at ${sheet.scale} beneath the indicative alignment`,
          figures.geology
        ) +
        finding(
          'limit',
          `<b>The provincial sheet is regional context, not route-level engineering mapping.</b> ${km === null ? 'Its placement has not been independently measured.' : `Its measured placement tolerance is approximately ${n(km, 2)} km.`} Do not use it to fix a portal, foundation, support change or contact chainage.`
        );
    }

    /**
     * NEPAL'S OWN SHEET, AS AN ANSWER RATHER THAN A PICTURE.
     *
     * Everything above this point is availability or imagery: which sheets
     * exist, and one of them printed under the layout. Neither can be asked
     * what the intake stands on. This can, because it is the 1:1,000,000 DMG
     * map as polygons, and it is the only thing in this report that names a
     * unit from a Nepali source rather than a global compilation.
     *
     * CONTACTS ARE THE POINT, not the unit names. A headrace inside one
     * formation is a different excavation from one crossing three contacts,
     * and until this existed the report could not tell the two apart.
     *
     * Two ways this could mislead, both handled rather than hidden. Running
     * off the edge of this DATASET is not a change of rock, and 30% of the
     * extent — the high north, where the tunnels are — carries no polygon, so
     * a short `mappedKm` leads the block instead of being a footnote. What it
     * leads with matters: the printed DMG sheet DOES cover that ground, so the
     * finding is "obtain the sheet", not "nothing is known here". And the
     * source splits some formations into numbered members, so the quoted
     * count is `formationContacts` and any internal subdivision is said
     * separately rather than folded into the headline.
     */
    const gu = c.geologyUnits;
    if (gu) {
      const blankKm = gu.lengthKm - gu.mappedKm;
      const blankShare = gu.lengthKm > 0 ? blankKm / gu.lengthKm : 0;
      const spans = geologySpans(gu).filter((sp) => !sp.unit.offSheet);
      const unitWord = (u: { name: string; named: boolean; code: string; noData: boolean }) =>
        u.noData
          ? 'unmapped on the national sheet'
          : u.named
            ? u.name
            : `unit ${u.code} (the sheet labels it "${u.name}" and publishes no legend expanding it)`;

      geo += facts([
        ['National mapping scale', gu.scale],
        ['Mapped unit at intake', unitWord(gu.intake)],
        ['Mapped unit at powerhouse', unitWord(gu.powerhouse)],
        ['Mapped formation contacts', `${gu.formationContacts}`],
        ['Mapped alignment coverage', `${n(gu.mappedKm, 1)} of ${n(gu.lengthKm, 1)} km`],
        ['Indicative contact tolerance', `approximately ±${n(gu.contactErrorKm, 1)} km`],
      ]);

      /**
       * A NAME HERE IS A CORRELATION, NOT NECESSARILY LOCAL MAPPING.
       *
       * Measured from the bundle: 17 of the 44 named units are drawn across
       * more than 4 degrees of longitude, and Kushma, Ulleri, Syangja and
       * Sangram span almost the whole country. Ranimatta, which this report
       * will happily print east of Kathmandu, is defined in the literature on
       * the Surkhet-Dailekh tract of WESTERN Nepal. That is the 1994 map doing
       * its job as a national compilation, but Lesser Himalayan stratigraphy in
       * Nepal is genuinely not agreed between regions, and a Nepali geologist
       * reading this report will notice immediately. Better to say it.
      */
      if (spans.some((sp) => sp.unit.named)) {
        geologyAppendix += '<h2>Regional nomenclature limitation</h2>' + finding(
          'limit',
          `<b>Treat the unit name as a regional correlation rather than local mapping.</b> The 1994 ` +
            `compilation applies one national nomenclature: 17 of its 44 named units are drawn across ` +
            `more than 400 km of longitude. Lesser Himalayan stratigraphy in Nepal is not agreed ` +
            `between regions, so geologists working near this site may use different names for the ` +
            `same rock. What the count of contacts says is unaffected; what the names say is weaker ` +
            `than it looks.`
        );
      }

      if (blankShare > 0.02) {
        geo += finding(
          'watch',
          `<b>${n(blankKm, 1)} km (${n(blankShare * 100, 0)}%) of the alignment is absent from the national digital unit dataset.</b> Treat this as missing evidence and verify the published mapping directly.`
        );
      }

      if (gu.formationContacts > 0) {
        // A bare `291` in a From column tells a reader nothing. Show the label
        // the sheet does print alongside its code, even though the label is
        // only two letters — that at least matches what is on the map.
        const cell = (u: GeologyUnitHit) => (u.named ? u.name : `${u.name} (${u.code})`);
        const rows = gu.contacts
          .filter((ct) => !ct.withinFormation)
          .map((ct) => [`${n(ct.atKm, 1)} km`, cell(ct.from), cell(ct.to)]);
        /**
         * THIS WAS A WARNING ABOUT ITSELF, AND IT IS THE SECTION'S RESULT.
         *
         * Counting formation contacts along a headrace is the thing nothing
         * else in this stack can do: it is the difference between one
         * excavation and three, it comes from Nepal's own DMG mapping, and it
         * works offline. It was stamped REQUIRED FIELD VERIFICATION and its
         * whole sentence was about its own tolerance.
         *
         * The tolerance is real and it is stated - in the appendix beside the
         * chainages it qualifies, which is where a tolerance belongs. The
         * finding states the finding.
         */
        geo += finding(
          'clear',
          `<b>The waterway crosses ${gu.formationContacts} mapped formation contact${gu.formationContacts === 1 ? '' : 's'}.</b> ` +
            `${esc(cell(gu.intake))} at the intake, ${esc(cell(gu.powerhouse))} at the powerhouse, from Nepal's own ` +
            `${esc(gu.scale)} geological mapping. A contact is where the ground changes and where an excavation stops ` +
            `behaving as it did, so the count is the number that matters at this stage; the chainages carry ` +
            `±${n(gu.contactErrorKm, 1)} km and are tabulated in the appendix.`
        );
        geologyAppendix +=
          '<h2>Mapped contacts and unit lengths</h2>' +
          `<p>The waterway crosses <b>${gu.formationContacts} mapped formation contact${gu.formationContacts === 1 ? '' : 's'}</b>` +
          `${gu.contacts.length > gu.formationContacts ? `, plus ${gu.contacts.length - gu.formationContacts} boundary between members of one formation, which is not counted here` : ''}` +
          `${gu.coverageEdges ? `. It also runs across the edge of the mapping ${gu.coverageEdges === 1 ? 'once' : `${gu.coverageEdges} times`}, which is not a contact` : ''}.
          A contact is where the ground changes, where water is most likely to be met, and where an
          excavation stops behaving as it did — so the count matters more than the names.</p>` +
          table('Formation contacts along the waterway', ['Chainage', 'From', 'To'], rows) +
          finding(
            'limit',
            `<b>Every chainage above carries about ${n(gu.contactErrorKm, 1)} km of positional error.</b> ` +
              `At ${esc(gu.scale)} half a millimetre of ink is 500 m of ground, so these locate a contact to ` +
              `within a few hundred metres at best. They say a contact is crossed and roughly where; they ` +
              `cannot be used to place a portal, a surge shaft or a support change.`
          );
      } else if (gu.mappedKm > 0) {
        geo += finding(
          'note',
          `<b>The national sheet puts the whole mapped length of this alignment inside one formation.</b> ` +
            `At ${esc(gu.scale)} that is weak evidence of uniform ground rather than strong evidence — the ` +
            `map simply does not resolve anything finer. It does mean no major belt boundary is crossed.`
        );
      }

      if (spans.length > 1) {
        geologyAppendix += table(
          'Ground the waterway crosses, national geological map',
          ['Unit', 'Code', 'Length', 'Share'],
          spans.map((sp) => [
            sp.unit.noData ? 'not mapped' : sp.unit.named ? sp.unit.name : `${sp.unit.name} (unexpanded)`,
            sp.unit.code || '—',
            `${n(sp.km, 1)} km`,
            `${n(sp.share * 100, 0)}%`,
          ])
        );
      }
    }

    if (covering.length) {
      geo += finding('clear', `${covering.length} published ${esc(dmg?.scale ?? '1:50,000')} geological map${covering.length === 1 ? '' : 's'} cover${covering.length === 1 ? 's' : ''} the alignment. Obtain and review the sheets before fixing underground or foundation works.`);
      geologyAppendix +=
        '<h2>Published detailed sheets</h2>' +
        table(
          'Published geological maps covering the alignment',
          ['Map', 'Published', 'Sheets touched'],
          covering.map((m) => [m.title, m.published, m.sheets.map((sh) => sh.code).join(', ')])
        );
    } else {
      geo += finding(
        'watch',
        `<b>No published ${esc(dmg?.scale ?? '1:50,000')} geological sheet covers this alignment.</b> ` +
          `${dmg ? `${dmg.catalogMaps} sheets are catalogued nationally, and none falls on this reach. ` : ''}` +
          'Systematic mapping at that scale does not cover the whole country, and this site is outside it.' +
          (sheet ? ' The provincial sheet above is the best published mapping available here.' : '')
      );
    }

    /**
     * DROPPED WHERE THE NATIONAL SHEET ALREADY NAMED THE GROUND.
     *
     * This fired on the global compilation - the same layer the section above
     * calls "one polygon spanning the entire alignment, and not an engineering
     * input" - and announced "Engineering geology remains unresolved" as a
     * third consecutive warning, under a finding that had just named the
     * formations and counted the contacts. Section 02 already says no ground
     * traverse was made. Three statements of one absence, and the loudest of
     * them came from the weakest source in the section.
     *
     * It still prints where the national units could not name the ground,
     * because there the global layer really is all there is.
     */
    if (distinct.size && !gu?.runs?.length) {
      const only = [...distinct];
      geo += finding(
        'watch',
        `<b>The ground along this corridor is not named by any mapping the app can read.</b> The open global ` +
          `layer resolves it to ${only.length === 1 ? 'one regional polygon' : `${only.length} regional polygons`}, ` +
          `which cannot establish rock mass, weathering, discontinuities, permeability or excavation behaviour. ` +
          `A mapped ground traverse, or the published sheet where one exists, is the first geological task here.`
      );
    }
    sec.push(geo);
  }

  if (geologyAppendix) app.push(A('GEOLOGICAL MAP INTERPRETATION') + geologyAppendix);

  if (c.conservation) {
    const inside = c.conservation.inside;
    const near = c.conservation.near;
    const pv = inside.length
      ? c.conservation.hard
        ? finding('watch', `<b>The scheme lies inside ${esc(inside[0].name)}, under a restrictive regime.</b> Consent is not a formality here: it governs whether the project can proceed at all, and should be resolved before any further spend.`)
        : finding('watch', `<b>The scheme lies inside ${esc(inside[0].name)}.</b> Clearance from the managing authority is required in addition to the ordinary environmental approvals.`)
      : near.length
        ? finding('note', `The scheme lies outside all protected areas; the nearest is ${esc(near[0].name)}, ${n(near[0].distanceKm, 1)} km away. Downstream and buffer-zone effects should still be addressed in the environmental assessment.`)
        : finding('clear', '<b>The scheme lies outside every protected area screened,</b> and none falls near enough to be flagged.');
    sec.push(
      H('PROTECTED-AREA SCREENING') +
        pv +
        table(
          'Protected areas',
          ['Area', 'Relationship', 'Regime', 'Distance km'],
          [
            ...c.conservation.inside.map((a) => [a.name, 'Inside', a.regime, '0.0']),
            ...c.conservation.near.map((a) => [a.name, 'Nearby', a.regime, n(a.distanceKm, 1)]),
          ]
        )
    );
  }

  /**
   * WHAT THE ALIGNMENT CROSSES.
   *
   * The report could describe the hydrology, the terrain, the geology, the
   * hazards, the grid and the licence neighbours, and could not say what the
   * waterway runs through. In Nepal that is a permitting gap, not a cosmetic
   * one: forest clearance and compensatory plantation, land acquisition and
   * resettlement are decided by ground whose coordinates the app already holds.
   *
   * Absent means NOT SCREENED, so the section simply does not appear rather
   * than printing an empty table that reads as "nothing there".
   */
  if (c.landcover && c.landcover.along.length) {
    const lc = c.landcover;
    const kmOf = (code: number) => lc.along.find((a) => a.code === code)?.km ?? 0;
    const shareOf = (code: number) => lc.along.find((a) => a.code === code)?.share ?? 0;
    // ESA WorldCover class codes. Only the three that carry a consent are named.
    const tree = kmOf(10);
    const crop = kmOf(40);
    const built = kmOf(50);

    let land =
      H('LAND-COVER AND TENURE SCREENING') +
      facts([
        ['Alignment screened', dist(lc.waterwayKm)],
        ['Ground at the intake', lc.intake ?? 'unclassified'],
        ['Ground at the powerhouse', lc.powerhouse ?? 'unclassified'],
        ['Cover cell', `${lc.cellM} m`],
      ]) +
      chartBlock(
        landcoverCompositionSvg(lc.along),
        'Mapped land-cover composition along the alignment — aggregate proportions, not spatial order or land tenure'
      );

    land += tree > 0
      ? finding(
          shareOf(10) >= 0.5 ? 'watch' : 'note',
          `<b>${dist(tree)} of the alignment — ${n(shareOf(10) * 100, 0)}% — runs on tree cover.</b> ` +
            'Forest clearance and compensatory plantation apply, and they are among the slower ' +
            'consents a run-of-river scheme waits on. The authority and the compensation differ ' +
            'for national, community and private forest, and a land-cover map cannot tell those ' +
            'apart, so the tenure has to be established on the ground before this can be costed.'
        )
      : finding('clear', '<b>No part of the centreline runs on tree cover,</b> so no forest clearance is implied by the alignment as drawn.');

    if (built > 0) {
      land += finding(
        'watch',
        `<b>${dist(built)} of the alignment crosses built-up ground.</b> That is a resettlement ` +
          'question rather than an easement, and it should be resolved before the alignment is fixed.'
      );
    }
    if (crop > 0) {
      land += finding(
        'note',
        `${dist(crop)} crosses cropland — private acquisition and crop compensation, on land whose ` +
          'owners are identifiable from the cadastre once the alignment is surveyed.'
      );
    }

    land += `<p class="eqnote">Cover from ESA WorldCover 2021 at 10 m, reduced to ${lc.cellM} m by
    the dominant class in each cell. Two limits govern how far this can be read. It is COVER, not
    TENURE — "tree cover" does not separate national forest from community forest from a private
    woodlot. And it is measured on the CENTRELINE, while a real waterway takes a right of way, spoil
    disposal, an access track and a portal yard, none of which is sited at screening. Every length
    above is therefore a floor. Cells reading as permanent water are the channel the alignment
    follows, not ground the waterway would occupy: the corridor is traced along the river, which is
    also how the canal-versus-tunnel classification reads its cross-slope.</p>`;

    sec.push(land);
  }

  // ===================================================== SEDIMENT ===========
  let sedimentAppendix = '';
  if (c.sediment?.source && s) {
    const src = c.sediment.source;
    const basin = desander({ designFlowCms: s.designFlowCms, netHeadM: s.netHeadM });
    const bench = c.sediment.bench;
    let sed =
      H('SEDIMENT AND HEADWORKS SCREENING') +
      `<p><b>${esc(src.label.charAt(0).toUpperCase() + src.label.slice(1))}</b> — ${n(src.highFrac * 100, 0)}% of
      the catchment lies above 3 000 m. ${esc(src.note)} This is a catchment proxy; no sediment
      samples or grain-size distribution are available.</p>` +
      facts([
        ['Sediment evidence', 'No site sampling or sediment rating curve'],
        ['Screening interpretation', 'Intake sediment exclusion and desanding provision likely required'],
        [
          'What this sizing is',
          'A footprint and a settling check from the modelled flow — enough to ask whether the bank has room, ' +
            'not enough to lay out a structure',
        ],
      ]);
    if (basin) {
      sedimentAppendix +=
        '<h2>Preliminary desander calculation</h2>' +
        facts([
          ['Smallest grain the basin must catch', `${n(basin.particleMm, 2)} mm`],
          ['Settling velocity of that grain', `${n(basin.settlingMmS, 1)} mm/s`],
          ['Settling length', `${n(basin.settlingLengthM, 1)} m`],
          ['Total structure length', `${n(basin.totalLengthM, 1)} m`],
          ['Total width across the valley', `${n(basin.totalWidthM, 1)} m`],
          ['Depth', `${n(basin.depthM, 1)} m`],
          [
            'Bays',
            basin.bays > 1
              ? `${basin.bays} — one flushes while the other runs`
              : `${basin.bays} — the plant shuts down to flush`,
          ],
          ['Flat ground needed', `${n(basin.benchNeededM, 0)} m across the valley`],
          ['Excavation', `${n(basin.excavationM3, 0)} m³`],
        ]) +
        `<p class="eqnote">The target grain follows the net head: at ${n(s.netHeadM, 0)} m a
        ${n(basin.particleMm, 2)} mm particle is the largest that can be allowed through without abrading
        the runner. The basin is then sized so that grain settles the full depth before it leaves —
        Zanke (1977) settling velocity at 10 °C, a through-velocity of 0.3 m/s, and a factor of 2 on the
        ideal length for turbulence and short-circuiting.</p>` +
        /**
         * WHAT A SHARED-SECTION TWO-BAY BASIN ACTUALLY DELIVERS WHILE FLUSHING.
         *
         * The section is sized for the full design flow and then divided, so
         * the bay left running while its twin flushes carries everything
         * through half the width at double the velocity. The module designs
         * inside a 0.2-0.4 m/s window and this puts it outside it. The basin
         * does not stop working, but during flushing it stops catching the
         * grain it was sized for, and a reader entitled to ask "is this
         * accurate" is entitled to know that.
         */
        (basin.flushingVelocityMs && basin.flushingVelocityMs > 0.4
          ? finding(
              'note',
              `<b>While one chamber flushes, the other carries the whole flow at ` +
                `${n(basin.flushingVelocityMs, 2)} m/s</b> — roughly double the ${n(0.3, 1)} m/s this ` +
                `sizing assumes, and above the 0.2–0.4 m/s window in which sand stays on the floor. ` +
                `The basin therefore passes coarser material during flushing. Sizing each chamber for ` +
                `the full flow removes the compromise and roughly doubles the footprint; that is a ` +
                `feasibility decision, not a screening one, and it is left open here.`
            )
          : '');
      if (bench) {
        sed +=
          bench.verdict === 'fits'
            ? finding('note', '<b>The terrain screen identifies a possible headworks bench.</b> Confirm its width, level, bank condition, flood exposure and constructability by survey and field reconnaissance.')
            : bench.verdict === 'marginal'
              ? finding('watch', '<b>Headworks bench suitability is unresolved at terrain-model resolution.</b> Survey cross-sections and inspect both banks before retaining the intake position.')
              : finding('watch', '<b>No DEM-visible bench suitable for the screening desander footprint was identified.</b> Reconsider the intake reach or headworks arrangement during field reconnaissance.');
        sedimentAppendix += facts([
          ['Widest terrain-screen bench', `${n(bench.widestM, 0)} m`],
          ['Screening footprint width', `${n(basin.benchNeededM, 0)} m`],
          ['Terrain-screen verdict', bench.verdict],
        ]);
      }
    }
    sec.push(sed);
  }
  if (sedimentAppendix) app.push(A('PRELIMINARY DESANDER CALCULATION') + sedimentAppendix);

  // ---- how much to trust the numbers ---------------------------------------
  const unc = c.uncertainty;
  if (unc) {
    let uc =
      H('UNCERTAINTY AND CONFIDENCE ASSESSMENT') +
      /**
       * THE THREE CONFIDENCE ROWS SAID "Low", "Moderate", "Low".
       *
       * This section is the one place in the report whose entire subject is how
       * much to trust the numbers, and it answered with adjectives - while the
       * project has measured every one of those quantities against Nepali
       * evidence and re-measures them whenever the engine changes. Quoting the
       * measurement is not less cautious than the adjective; it is the same
       * caution with a magnitude attached, which is the difference between a
       * reader distrusting the number and a reader knowing what to do about it.
       *
       * The figures come from the harnesses named beside them, so a reader who
       * doubts one can re-derive it.
       */
      `<p>These ranges come from re-running the engine on perturbed inputs, not from a percentage attached
      afterwards. They describe evidence quality and are not statistical design bounds.</p>` +
      facts([
        ['Indicative capacity range', `${n(unc.capacityMW.low, 1)}–${n(unc.capacityMW.high, 1)} MW`],
        ['Indicative annual-energy range', `${n(unc.energyGwh.low, 0)}–${n(unc.energyGwh.high, 0)} GWh`],
        [
          'Flow, measured against gauges',
          'Typical error 1.4×, rising to about 1.6× at the catchment sizes projects sit on; unbiased; ' +
            '90% of 69 DHM records within a factor of two',
        ],
        [
          'Head, measured against a second terrain product',
          `No systematic bias, σ 6.6 m, 3.4% of the drop; ±${n(unc.headSpreadM, 0)} m is carried here as a floor`,
        ],
        [
          'Layout',
          'Routed on the terrain model, not surveyed or walked; the waterway length is the quantity a survey moves most',
        ],
        [
          'Dry-season energy share',
          'Under-read by 3.7 percentage points on average, ±5.1, at 74 gauges — so a tariff verdict near its threshold is the one to re-test',
        ],
      ]);
    if (unc.drivers.length) {
      uc += table(
        'Principal uncertainty drivers',
        ['Evidence area', 'Relative influence', 'Basis'],
        unc.drivers.map((driver, index) => [
          driver.name,
          index === 0 ? 'Dominant' : 'Secondary',
          index === 0
            ? 'No calibrated site record; flow-model uncertainty transfers directly to capacity and energy.'
            : driver.note,
        ])
      );
    }
    sec.push(uc);
  }

  // ---- what to do next, from the readiness screen ---------------------------
  const decisionText: Record<string, string> = {
    hold: 'Hold further design expenditure until the stop-level constraints are closed.',
    fieldwork: 'Proceed to the targeted field programme below.',
    screening: 'Retain at desktop-screening stage pending the evidence listed below.',
  };
  sec.push(
    H('SCREENING CONCLUSION AND FIELD PROGRAMME') +
      `<p>The central desktop case is an indicative ${s ? approx(s.capacityMW, 1) : '–'} MW run-of-river
      scheme with ${s ? approx(s.energyGwh, 0) : '–'} GWh/year, approximately ${s ? n(s.grossHeadM, 0) : '–'} m
      gross head and an unsurveyed ${s ? approx(s.waterwayKm, 1) : '–'} km waterway.
      ${rd ? esc(decisionText[rd.decision] ?? '') : ''}</p>` +
      (rd?.stopReasons?.length
        ? finding(
            'watch',
            `<b>Held for: </b>${rd.stopReasons.map((r) => esc(r.replace(/\.\s*$/, ''))).join('; ')}.`
          )
        : '') +
      '<p>Subject to favourable closure of the tasks below, the next project stage is a field-informed ' +
      'pre-feasibility or feasibility study. Detailed deliverables and gate-closure criteria are provided ' +
      'in the field-plan CSV export.</p>' +
      /**
       * TRIMMED, AND WHAT WAS CUT IS NOT LOST.
       *
       * These two tables ran to four pages of paragraph-length cells. The
       * `What closes it` column restated the field programme immediately below
       * it, and the `Deliverable` column was a consultant's scope of works —
       * identical from site to site, and the same text a reader would get from
       * any feasibility brief. Neither was screening OUTPUT; both were generic
       * process, and they buried the two columns that actually describe THIS
       * site: which gate is blocking, and why.
       *
       * The full text of both survives in the field-plan CSV export, which is
       * where a scope of works belongs — a spreadsheet someone builds a
       * programme from, not prose in the middle of a technical summary. The
       * note below says so, so nobody goes looking for it and concludes it was
       * dropped.
       */
      (rd?.gates?.length
        ? table(
            'Readiness gates',
            ['Gate', 'Evidence level', 'What this screening found'],
            rd.gates.map((g0) => [g0.title, String(g0.level), g0.summary])
          )
        : '') +
      (rd?.tasks?.length
        ? '<p class="small">The complete prioritised field investigation programme is retained in the technical appendices.</p>'
        : '')
  );

  if (rd?.tasks?.length) {
    app.push(
      A('FIELD INVESTIGATION PROGRAMME') +
        table(
          'Recommended field programme',
          ['Priority', 'Discipline', 'Task', 'Why it is needed'],
          rd.tasks.map((task) => [task.priority, task.discipline, task.title, task.reason])
        )
    );
  }

  // ---- appendices ----------------------------------------------------------

  /**
   * THE APPENDIX AN APPENDIX IS FOR.
   *
   * The brief for this report was that the body should read cleanly and that
   * sources and method would live at the back. The back filled up with data
   * tables instead — every hazard record, every stage, every lake — and the
   * one thing an appendix exists to carry went missing: where each number came
   * from and what was done to it.
   *
   * Three things, in the order a reader needs them. What the study is built on.
   * How accurate that has been MEASURED to be, not claimed. Then the full
   * machine-readable provenance, byte for byte the same array the CSV and
   * GeoJSON exports carry, so no reader has to trust that the two agree.
   */
  {
    const src: [string, string, string][] = [
      ['Daily discharge', 'GloFAS v4 (ECMWF / CEMS)', 'Open; ~5 km grid, daily, 2006–2025'],
      ['River network', 'HydroRIVERS', 'CC-BY 4.0; ~500 m derivation, chords real bends'],
      ['Catchment area', 'MERIT Hydro', 'CC-BY-NC; 92 m, sampled per vertex'],
      ['Channel geometry', 'OpenStreetMap', 'ODbL; length correction and drawn geometry'],
      ['Terrain', 'Copernicus GLO-30 (Mapterhorn)', '30 m; best of three on head'],
      ['Bare-earth terrain', 'GEDTM30', 'CC-BY 4.0; 30 m, the cross-check source'],
      ['Land cover', 'ESA WorldCover 2021', 'CC-BY 4.0; 10 m, reduced to 30 m by dominant class'],
      ['Rainfall and hypsometry', 'CHPclim + HydroBASINS', 'Open; per catchment'],
      ['Glaciers', 'Randolph Glacier Inventory 7.0', 'CC-BY 4.0; outlines dated 2000–2010 by submission'],
      ['Glacial lakes', 'Sentinel-2 transboundary inventory + ICIMOD 2020 danger list', 'CC-BY 4.0; centroids only, no lake area'],
      ['Gauges', 'DHM Nepal', 'Supplied; 136 daily records'],
      ['Licensed projects', 'DoED register', 'Public register; ~1,048 located'],
      ['Geological mapping', 'DMG province sheets', 'Published 1:350,000, reproduced as issued'],
      ['Hazard records', 'BIPAD portal', 'Public; filed against settlements, not scars'],
      ['Seismic hazard', 'GEM global model', 'Peak ground acceleration, 475-year return'],
      ['Tariff', 'NEA published base rates', 'Board decision 2074/01/14 (27 April 2017)'],
      /**
       * NAMED AS A CLASS, NOT AS A PROVIDER.
       *
       * The municipality, survey sheet and isohyet band came from a privately
       * supplied national GIS set and appeared nowhere in this table, so the
       * three values printed in section 02 were the only figures in the report
       * with no line of provenance anywhere. The provider is not named — that
       * is their condition. What a reader needs is not the name but the CLASS:
       * that these three came from somewhere they cannot check.
       */
      [
        'Administrative and isohyet context',
        'Supplied national GIS set',
        'Not public and not redistributed; the only unverifiable layer here',
      ],
    ];

    const acc: [string, string, string][] = [
      ['Flow, typical error', '1.37×', '69 DHM gauges, blend against measured record'],
      ['Flow, project-weighted', '1.64×', 'weighted to where projects actually sit'],
      ['Flow, bias', '1.00×', 'unbiased after a measured correction'],
      ['Flow, within a factor of two', '90% of gauges', 'same 69 stations'],
      ['Head', 'no bias, σ 6.6 m (3.4%)', 'three-way DEM comparison, 120 reaches'],
      ['Dry-season energy share', '−4 to −6 points', '74 gauges; the app under-reads the dry season'],
      ['Plants reaching their licence', '147/180 = 82%', 'every eligible commissioned Nepali plant'],
      ['Plants under-predicted by 2×', '9/172 = 5.2%', 'a data-quality ceiling, not a modelling one'],
    ];

    app.push(
      A('SOURCES, METHOD AND MEASURED ACCURACY') +
        `<p>The report uses the published datasets listed below. Validation figures describe the
        screening system against independent Nepali evidence or a second terrain product; they do
        not establish accuracy at this site.</p>` +
        table('What this study is built on', ['Layer', 'Source', 'Licence, resolution, vintage'], src) +
        `<p>The accuracy below is the app's own, measured on Nepali evidence. It is not a claim
        about this site: it is the spread you should expect a screening result to carry before any
        survey has been done.</p>` +
        table('Measured accuracy', ['Quantity', 'Result', 'Measured against'], acc) +
        finding(
          'watch',
          '<b>Hydrology is the dominant validation priority.</b> The measured system-wide flow error ' +
            'is materially larger than the terrain error, and flow uncertainty transfers directly into ' +
            'capacity and energy. A quality-controlled measured record should therefore be established ' +
            'before refining the energy case.'
        ) +
        `<p class="eqnote"><b>MERIT Hydro is CC-BY-NC.</b> Only derived per-vertex catchment values are
        used and the original raster is not redistributed, which keeps this report inside the licence —
        but the non-commercial condition attaches to the catchment areas behind every flow figure here,
        so it travels with any commercial use of this document. The DMG sheet is reproduced as
        published, watermark included. The supplied GIS set is used under its provider's terms and is
        neither named nor shipped.</p>`
    );
  }

  if (stageAppendix) app.push(A('PONDAGE STAGE, AREA AND STORAGE') + stageAppendix);
  if (hazardAppendix) app.push(A('RECORDED HAZARD REGISTER') + hazardAppendix);
  if (lakeAppendix) app.push(A('UPSTREAM GLACIAL LAKE INVENTORY') + lakeAppendix);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(meta.projectName)} — Desktop Screening Report</title>
<style>
  @page {
    size: A4;
    margin: 24mm 19mm 18mm 19mm;
    @top-right {
      content: ${cssStr(meta.projectName)};
      vertical-align: bottom; padding-bottom: 5mm;
      font: 8pt/1 Inter, Helvetica, Arial, sans-serif; letter-spacing: .1em; color: #8b949c;
    }
    @top-left {
      content: "DESKTOP SCREENING REPORT";
      vertical-align: bottom; padding-bottom: 5mm;
      font: 8pt/1 Inter, Helvetica, Arial, sans-serif; letter-spacing: .1em; color: #8b949c;
    }
    @bottom-left {
      content: ${cssStr(meta.consultant)};
      vertical-align: top; padding-top: 5mm;
      font: 8pt/1 Inter, Helvetica, Arial, sans-serif; color: #8b949c;
    }
    @bottom-right {
      content: counter(page);
      vertical-align: top; padding-top: 5mm;
      font: 8pt/1 Inter, Helvetica, Arial, sans-serif; color: #14171a;
    }
  }
  @page :first {
    margin: 0;
    @top-right { content: ""; } @top-left { content: ""; }
    @bottom-left { content: ""; } @bottom-right { content: ""; }
  }
  :root {
    --ink: #14171a; --mid: #5c6670; --soft: #8b949c;
    --rule: #d5dade; --accent: #0f4c5c; --warm: #b3541e;
  }
  * { box-sizing: border-box; }
  body {
    font: 10.5pt/1.6 Georgia, "Iowan Old Style", "Times New Roman", serif;
    color: var(--ink); margin: 0; -webkit-font-smoothing: antialiased;
  }
  p { margin: 0 0 3.5mm; text-align: justify; hyphens: auto; }
  .lede { font-size: 12pt; line-height: 1.5; text-align: left; max-width: 155mm; }
  .flag { color: var(--warm); font-weight: 600; }

  /* ---- cover ---- */
  .cover {
    page-break-after: always; height: 297mm; padding: 40mm 24mm 22mm;
    display: flex; flex-direction: column; position: relative;
  }
  .cover::before {
    content: ""; position: absolute; top: 0; left: 0; right: 0; height: 14mm; background: var(--accent);
  }
  .cover .eyebrow {
    font: 8.5pt/1 Inter, Helvetica, Arial, sans-serif; letter-spacing: .28em; color: var(--accent);
    text-transform: uppercase; margin-bottom: 6mm;
  }
  .cover h1 {
    font: 400 30pt/1.15 Georgia, "Times New Roman", serif; margin: 0 0 5mm; letter-spacing: -.01em;
  }
  .cover .cap {
    font: 600 15pt/1 Inter, Helvetica, Arial, sans-serif; color: var(--accent); margin-bottom: 9mm;
  }
  .cover hr { border: 0; border-top: 2px solid var(--ink); margin: 0 0 9mm; width: 34mm; }
  .cover .kind {
    font: 8.5pt/1 Inter, Helvetica, Arial, sans-serif; letter-spacing: .28em; text-transform: uppercase;
    color: var(--mid); margin-bottom: 7mm;
  }
  .cover .status {
    width: fit-content; border-top: 1.5px solid var(--warm); border-bottom: 1px solid var(--rule);
    padding: 3mm 0; margin-bottom: auto;
    font: 600 8pt/1.35 Inter, Helvetica, Arial, sans-serif; letter-spacing: .1em;
    text-transform: uppercase; color: var(--warm);
  }
  .cover .docmeta {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 7mm;
    border-top: 1px solid var(--rule); padding-top: 4mm; margin-bottom: 8mm;
  }
  .cover .docmeta b {
    display: block; margin-bottom: 1.5mm;
    font: 500 7.5pt/1 Inter, Helvetica, Arial, sans-serif; letter-spacing: .14em;
    text-transform: uppercase; color: var(--soft);
  }
  .cover .docmeta span { font: 9.5pt/1.35 Inter, Helvetica, Arial, sans-serif; color: var(--ink); }
  }
  .cover .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 9mm; margin-bottom: 10mm; }
  .cover .parties h3 {
    font: 8pt/1 Inter, Helvetica, Arial, sans-serif; letter-spacing: .16em; text-transform: uppercase;
    color: var(--soft); margin: 0 0 2.5mm; font-weight: 500;
  }
  .cover .parties div > div { font-size: 10.5pt; line-height: 1.5; }
  .cover .date {
    border-top: 1px solid var(--rule); padding-top: 4mm;
    font: 9pt/1 Inter, Helvetica, Arial, sans-serif; color: var(--mid); letter-spacing: .1em;
  }

  /* ---- headings ---- */
  h1 {
    font: 500 12.5pt/1.3 Inter, Helvetica, Arial, sans-serif; letter-spacing: .04em;
    margin: 9mm 0 4mm; padding-bottom: 2mm; border-bottom: 1.5px solid var(--ink);
    page-break-after: avoid; display: flex; align-items: baseline; gap: 4mm;
  }
  h1 .hn { color: var(--accent); font-weight: 600; font-size: 10pt; letter-spacing: .1em; }
  h1.appx { page-break-before: always; border-bottom-color: var(--accent); }
  h2 {
    font: 600 8.5pt/1 Inter, Helvetica, Arial, sans-serif; letter-spacing: .16em; text-transform: uppercase;
    color: var(--soft); margin: 6mm 0 2.5mm; page-break-after: avoid;
  }

  /* ---- key figures ---- */
  .keys {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 0;
    border-top: 1.5px solid var(--ink); border-bottom: 1.5px solid var(--ink);
    margin: 0 0 5mm; page-break-inside: avoid;
  }
  .kf { padding: 3.5mm 4mm; border-right: 1px solid var(--rule); }
  .kf:nth-child(3n) { border-right: 0; }
  .kf:nth-child(n+4) { border-top: 1px solid var(--rule); }
  .kf b { font: 600 19pt/1 Inter, Helvetica, Arial, sans-serif; color: var(--accent); font-variant-numeric: tabular-nums; }
  .kf i { font: 500 9pt/1 Inter, Helvetica, Arial, sans-serif; font-style: normal; color: var(--mid); margin-left: 1.5mm; }
  .kf span {
    display: block; margin-top: 1.5mm;
    font: 7.5pt/1.3 Inter, Helvetica, Arial, sans-serif; letter-spacing: .1em;
    text-transform: uppercase; color: var(--soft);
  }
  .kf small {
    display: block; margin-top: 1.2mm;
    font: 7.5pt/1.35 Inter, Helvetica, Arial, sans-serif; color: var(--mid);
  }

  /* ---- facts: a definition list, never a grid of boxes ---- */
  .facts { margin: 0 0 4.5mm; }
  .facts > div {
    display: grid; grid-template-columns: 62mm 1fr; gap: 4mm;
    padding: 1.6mm 0; border-bottom: 1px solid var(--rule); page-break-inside: avoid;
  }
  .facts dt { font: 9pt/1.45 Inter, Helvetica, Arial, sans-serif; color: var(--mid); }
  .facts dd { margin: 0; font-variant-numeric: tabular-nums lining-nums; }

  /* ---- tables: three rules, no cages ---- */
  /* The caption must not orphan from its table, but the table itself may
     break — pinning a 20-row table whole leaves half a page empty. */
  .tw { margin: 0 0 5mm; }
  .tw .cap { page-break-after: avoid; }
  thead { display: table-header-group; }
  tbody tr:last-child td { border-bottom: 1.5px solid var(--ink); }
  table {
    border-collapse: collapse; width: 100%;
    font: 9.5pt/1.45 Georgia, "Times New Roman", serif; font-variant-numeric: tabular-nums lining-nums;
  }
  thead, tr:first-child th { }
  th {
    font: 600 7.5pt/1.3 Inter, Helvetica, Arial, sans-serif; letter-spacing: .1em; text-transform: uppercase;
    color: var(--mid); text-align: left; padding: 0 3mm 2mm 0; vertical-align: bottom;
    border-top: 1.5px solid var(--ink); border-bottom: .75px solid var(--ink); padding-top: 2mm;
  }
  td { padding: 1.7mm 3mm 1.7mm 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th:last-child, td:last-child { padding-right: 0; }
  .num { text-align: right; }

  /* ---- findings: four repeatable engineering record types ---- */
  .finding {
    display: grid; grid-template-columns: 37mm 1fr; gap: 5mm;
    border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule);
    padding: 2.6mm 0; margin: 0 0 4mm; text-align: left; page-break-inside: avoid;
  }
  .finding-label {
    font: 600 7.4pt/1.35 Inter, Helvetica, Arial, sans-serif; letter-spacing: .1em;
    text-transform: uppercase; color: var(--mid);
  }
  .finding.watch .finding-label { color: var(--warm); }
  .finding.clear .finding-label { color: #2f6f56; }
  .finding.limit .finding-label { color: var(--mid); }
  .finding-body { font-size: 10pt; line-height: 1.5; }
  .finding-body b { font-weight: 700; }

  /* ---- the working ---- */
  .eq {
    border-top: 1.5px solid var(--ink); border-bottom: 1.5px solid var(--ink);
    padding: 3mm 0 3.5mm; margin: 0 0 2.5mm; page-break-inside: avoid;
  }
  .eqhead {
    font: 600 7.5pt/1 Inter, Helvetica, Arial, sans-serif; letter-spacing: .14em;
    text-transform: uppercase; color: var(--soft); margin: 2.5mm 0 1.5mm;
  }
  .eqhead:first-child { margin-top: 0; }
  .eqrow {
    display: grid; grid-template-columns: 1fr auto; gap: 5mm; align-items: baseline;
    padding: .8mm 0; font-variant-numeric: tabular-nums lining-nums;
  }
  .eqrow span { color: var(--ink); }
  .eqrow b { font-weight: 400; white-space: nowrap; }
  .eqrow u { text-decoration: none; font-weight: 700; color: var(--accent); }
  .eqrow sub { font-size: .72em; }
  .eqnote { font-size: 8.5pt; line-height: 1.5; color: var(--mid); margin-bottom: 4.5mm; }

  /* ---- hazard bars ---- */
  .hbars { margin: 0 0 2mm; page-break-inside: avoid; }
  .hb { display: grid; grid-template-columns: 34mm 1fr 10mm 32mm; align-items: center; gap: 3mm; padding: 1.3mm 0; }
  .hb span { font: 9pt/1 Inter, Helvetica, Arial, sans-serif; color: var(--ink); }
  .hb i { display: block; height: 3.4mm; background: var(--accent); opacity: .78; }
  .hb b { font: 600 9.5pt/1 Inter, Helvetica, Arial, sans-serif; font-variant-numeric: tabular-nums; text-align: right; }
  .hb em { font: 8pt/1 Inter, Helvetica, Arial, sans-serif; font-style: normal; color: var(--soft); }

  /* ---- captions, figures, charts ---- */
  .cap {
    font: 7.5pt/1.4 Inter, Helvetica, Arial, sans-serif; letter-spacing: .1em; text-transform: uppercase;
    color: var(--soft); margin: 0 0 2mm; text-align: left; page-break-after: avoid;
  }
  figure { margin: 0 0 5mm; page-break-inside: avoid; }
  figure.cw { margin-bottom: 6mm; }
  /**
   * NEVER CROP A CAPTURED FIGURE.
   *
   * This was max-height 100mm with object-fit cover, which silently cut the top
   * and bottom off every map. captureFigures had just been fixed to frame the
   * intake and the powerhouse, and the powerhouse was still missing — the CSS
   * was throwing away the part of the image that contained it. The capture is
   * 1400x900, so at full column width it stands about 110 mm tall and fits.
   */
  /**
   * A ceiling, with CONTAIN so it never crops.
   *
   * Without one a 1400x900 capture prints about 110 mm tall, and a section that
   * opens two thirds of the way down a page cannot fit it: the figure jumps to
   * the next page and leaves a third of a page white. That happened to the
   * geological sheet. 92 mm fits under a heading and a paragraph in the worst
   * case, and object-fit contain means the shortfall costs size and never
   * content — the cover version of this rule silently guillotined every map.
   */
  figure img { width: 100%; height: auto; max-height: 92mm; object-fit: contain; display: block; }
  figcaption {
    font: 7.5pt/1.4 Inter, Helvetica, Arial, sans-serif; letter-spacing: .1em; text-transform: uppercase;
    color: var(--soft); margin-top: 2mm;
  }
  svg.chart { display: block; width: 100%; height: auto; page-break-inside: avoid; }
  .closing {
    margin-top: 9mm; padding-top: 3mm; border-top: 1px solid var(--rule);
    font: 8.5pt/1.5 Inter, Helvetica, Arial, sans-serif; color: var(--soft); text-align: left;
  }
  /* The document carries no other links; a browser-default blue would be the
     loudest thing on the page. */
  .closing a { color: inherit; text-decoration: none; }
  @media screen { body { max-width: 210mm; margin: 0 auto; box-shadow: 0 0 0 1px #eee; } .cover { height: auto; } }
</style></head><body>

<section class="cover">
  <div class="eyebrow">Preliminary project screening</div>
  <h1>${esc(meta.projectName)}</h1>
  ${cap ? `<div class="cap">${cap}</div>` : ''}
  <hr>
  <div class="kind">Desktop Screening Report</div>
  <div class="status">Screening only · not for design, consent or construction</div>
  <div class="docmeta">
    <div><b>Report</b><span>${esc(reportId)}</span></div>
    <div><b>Revision</b><span>${esc(revision)}</span></div>
    <div><b>Status</b><span>${esc(reportStatus)}</span></div>
  </div>
  <div class="parties">
    <div><h3>Prepared for</h3>${preparedFor}</div>
    <div>
      <h3>Prepared by</h3><div>${esc(meta.consultant)}</div>
    </div>
  </div>
  <div class="date">${esc(today)}</div>
</section>

${sec.join('\n')}
${app.join('\n')}

<p class="closing">Data sources, methodology, assumptions and limitations are set out in the accompanying
Appendix, which forms part of this report.<br>
HydroRecon built by <a href="https://www.linkedin.com/in/bijay-karki-/">Bijay Karki</a> &middot; <a href="mailto:bijay.karki.work@gmail.com">bijay.karki.work@gmail.com</a></p>

</body></html>`;
}

/**
 * Hand the report to the browser's own print engine.
 *
 * An iframe rather than a new window: a popup blocker will silently swallow
 * window.open and the button would appear to do nothing, which is the worst
 * possible failure for an export control.
 */
export function printDeskStudy(
  c: ExportContext,
  meta: ReportMeta,
  figures: ReportFigures = {}
): void {
  document.getElementById('hydrorecon-report')?.remove();

  const frame = document.createElement('iframe');
  frame.id = 'hydrorecon-report';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(deskStudyHtml(c, meta, figures));
  doc.close();

  // Images have to decode before print(), or the map figures come out blank.
  const go = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  };
  void Promise.all(
    [...doc.images].map((im) =>
      im.complete ? Promise.resolve() : new Promise((r) => im.addEventListener('load', r, { once: true }))
    )
  ).then(() => setTimeout(go, 150));
}
