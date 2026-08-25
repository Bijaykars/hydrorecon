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
import { buildFdc, minMonthlyMean, NEA_ROR_PPA, seasonalRatio } from './engine/hydro.ts';
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
const finding = (tone: 'clear' | 'watch' | 'note', html: string) =>
  `<p class="find ${tone}">${html}</p>`;

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
      `<text x="${(barLeft + (barFlip ? -6 : 6)).toFixed(1)}" y="30" style="font:9.5px Inter,Helvetica,Arial,sans-serif;fill:#a8562f;font-weight:600" text-anchor="${barFlip ? 'end' : 'start'}">largest clearing 30% dry</text>`
    : '';

  const c = sweep.chosen;
  const cx = c ? x(c.capacityMW) : 0;
  const cFlip = cx < W * 0.42;
  const chosen = c
    ? `<circle cx="${cx.toFixed(1)}" cy="${y(c.energyGwh).toFixed(1)}" r="4.5" fill="#0f4c5c"/>` +
      `<text x="${(cx + (cFlip ? 9 : -9)).toFixed(1)}" y="${(y(c.energyGwh) + 14).toFixed(1)}" style="font:10px Inter,Helvetica,Arial,sans-serif;fill:#0f4c5c;font-weight:600" text-anchor="${cFlip ? 'start' : 'end'}">as designed · Q${Math.round(c.exceedance * 100)}</text>`
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
const HAZARD_APPENDIX_ROWS = 40;

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

/** Monthly means as a hydrograph. Twelve bars beat twelve rows. */
function monthlySvg(means: readonly number[], scale: number): string {
  const v = means.map((m) => m * scale).filter((m) => Number.isFinite(m));
  if (v.length !== 12) return '';
  const W = 540;
  const Hh = 210;
  const L = 56;
  const B = 34;
  const max = Math.max(...v) || 1;
  const bw = (W - L - 16) / 12;
  const y = (q: number) => Hh - B - (q / max) * (Hh - B - 20);
  const bars = v
    .map((q, i) => {
      const bx = L + i * bw + bw * 0.16;
      const bwid = bw * 0.68;
      const isDry = q === Math.min(...v);
      return (
        `<rect x="${bx.toFixed(1)}" y="${y(q).toFixed(1)}" width="${bwid.toFixed(1)}" height="${(Hh - B - y(q)).toFixed(1)}" fill="${isDry ? '#b3541e' : '#0f4c5c'}" opacity="${isDry ? 0.95 : 0.82}"/>` +
        `<text x="${(bx + bwid / 2).toFixed(1)}" y="${Hh - B + 15}" style="${AX}" text-anchor="middle">${MONTHS[i]}</text>` +
        `<text x="${(bx + bwid / 2).toFixed(1)}" y="${(y(q) - 5).toFixed(1)}" style="font:8.5px Inter,Helvetica,Arial,sans-serif;fill:#5c6670" text-anchor="middle">${q < 10 ? q.toFixed(2) : q.toFixed(0)}</text>`
      );
    })
    .join('');
  const grid = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const yy = y(max * f);
      return `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${W - 16}" y2="${yy.toFixed(1)}" stroke="#e6e9ec"/><text x="${L - 8}" y="${(yy + 3).toFixed(1)}" style="${AX}" text-anchor="end">${max * f < 10 ? (max * f).toFixed(1) : (max * f).toFixed(0)}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${Hh}" class="chart" xmlns="http://www.w3.org/2000/svg">
  ${grid}${bars}
  <line x1="${L}" y1="${Hh - B}" x2="${W - 16}" y2="${Hh - B}" stroke="#9aa2aa"/>
  <text x="13" y="${(Hh / 2).toFixed(0)}" style="${LB}" text-anchor="middle" transform="rotate(-90 13 ${(Hh / 2).toFixed(0)})">MEAN FLOW  m³/s</text>
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
        ${kf(approx(s.capacityMW, 1), 'MW', 'Indicative capacity', c.band ? `Range ${n(c.band.capLow, 1)}–${n(c.band.capHigh, 1)} MW · low confidence` : 'Low confidence')}
        ${kf(approx(s.energyGwh, 0), 'GWh/yr', 'Indicative annual energy', c.band ? `Range ${n(c.band.energyLow, 0)}–${n(c.band.energyHigh, 0)} GWh · low confidence` : 'Low confidence')}
        ${kf(approx(s.netHeadM, 0), 'm', 'Net head', `${n(c.demResolutionM, 0)} m DEM · moderate confidence`)}
        ${kf(approx(s.designFlowCms, 2), 'm³/s', `Reference flow · Q${Math.round(exc * 100)}`, 'Modelled · low confidence')}
        ${kf(approx(s.waterwayKm, 1), 'km', 'Indicative waterway', 'Unsurveyed route · low confidence')}
        ${kf(approx(catchmentKm2(c), 1), 'km²', 'Catchment at intake', 'Mapped · moderate confidence')}
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
    : 'No desktop fatal flaw identified; field verification remains required.';
  sec.push(
    H('EXECUTIVE DESKTOP-SCREENING SUMMARY') +
      `<p class="lede">This report screens whether the site warrants field investigation. It does not
      establish a design, surveyed quantity, cost, consent position or construction basis.</p>` +
      keyFigures +
      facts([
        ['Screening recommendation', rd ? decisionLabel[rd.decision] ?? decisionLabel.screening : decisionLabel.screening],
        ['Dominant uncertainty', 'River flow; no site discharge measurement is available.'],
        ['Principal hold points', stopSummary],
        ['Appropriate next decision', 'Whether to fund reconnaissance, gauging, survey and constraint verification.'],
      ]) +
      finding(
        rd?.decision === 'hold' ? 'watch' : 'note',
        `<b>Screening recommendation:</b> ${esc(rd ? decisionLabel[rd.decision] ?? decisionLabel.screening : decisionLabel.screening)}`
      )
  );

  // ---- 02 basis, scope and limitations -------------------------------------
  sec.push(
    H('BASIS, SCOPE AND LIMITATIONS') +
      `<p>The assessment uses global and national datasets only. Results are suitable for comparing
      options and planning fieldwork; they are not suitable for fixing structure locations, dimensions,
      quantities, tender requirements or investment returns.</p>` +
      '<h2>Evidence not obtained at desktop stage</h2>' +
      facts([
        ['Site reconnaissance', 'Not undertaken'],
        ['River-flow gauging', 'No site measurement'],
        ['Topographic survey', `Not undertaken; terrain model cell ${n(c.demResolutionM, 0)} m`],
        ['Engineering-geology mapping', 'No mapped ground traverse, drilling or geotechnical testing'],
        ['Sediment investigation', 'No suspended-load or bed-load samples'],
        ['Grid connection', 'Mapped proximity only; capacity and connection point unconfirmed'],
        ['Environmental and social baseline', 'Desktop register and land-cover screen only'],
        ['Cost, schedule and bankability', 'Not assessed'],
      ]) +
      '<h2>Screening assumptions</h2>' +
      facts([
        ['Reference design-flow exceedance', `Q${Math.round(exc * 100)}`],
        ['Overall plant efficiency', `${n((c.assumptions?.efficiency ?? 0) * 100, 1)} %`],
        ['Head-loss allowance', `${n((c.assumptions?.headLossFrac ?? 0) * 100, 1)} %`],
        ['Environmental release', `${n((c.assumptions?.residualFrac ?? 0) * 100, 0)} % of the lowest monthly mean`],
        ['Hydrological record used', `${c.flowYears} model years`],
        ['Automated layouts evaluated', String(c.evaluated)],
      ]) +
      (c.localGis && (c.localGis.municipality || c.localGis.sheet || c.localGis.isohyetMm != null)
        ? '<h2>Administrative and survey context</h2>' +
          facts([
            ['Local body', c.localGis.municipality ?? '–'],
            ['Survey sheet', c.localGis.sheet ?? '–'],
            ['Mean annual rainfall', c.localGis.isohyetMm == null ? '–' : `${n(c.localGis.isohyetMm, 0)} mm`],
          ])
        : '') +
      finding(
        'note',
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
      H('IS THIS THE RIGHT RIVER?') +
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
    H('LOCATION AND SITE LAYOUT') +
      (s
        ? `<p>The ${esc(meta.projectName)} is a proposed ${cap} run-of-river scheme. The intake lies at
        ${dms(s.intake.lat, 'N', 'S')}, ${dms(s.intake.lon, 'E', 'W')}${muni ? `, within ${esc(muni)}` : ''},
        at an elevation of ${n(c.path[s.i]?.elevationM, 0)} m. The powerhouse lies ${n(s.waterwayKm, 2)} km
        downstream along the river at ${n(c.path[s.j]?.elevationM, 0)} m, giving a gross head of
        ${n(s.grossHeadM, 1)} m. The catchment at the intake is ${n(catchmentKm2(c), 1)} km².</p>`
        : '<p>No scheme has been selected.</p>') +
      figure('Project layout — intake, waterway, powerhouse and neighbouring licence areas', figures.site) +
      figure('The site on satellite imagery', figures.satellite)
  );

  // ---- 03 topography -------------------------------------------------------
  const prof = profileSvg(c);
  sec.push(
    H('TOPOGRAPHY AND TERRAIN') +
      `<p>The diverted reach falls ${s ? n(s.grossHeadM, 1) : '–'} m over ${s ? n(s.waterwayKm, 2) : '–'} km,
      an average gradient of ${s ? n(s.slopeMPerKm, 1) : '–'} m/km. Terrain is resolved at
      ${n(c.demResolutionM, 0)} m.</p>` +
      chartBlock(prof, 'Long profile of the diverted reach') +
      figure('Topographic setting', figures.topo)
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

  let hyd =
    H('HYDROLOGY') +
    `<p>The long-term mean flow at the intake is ${n(meanAtIntake(c), 2)} m³/s over ${c.flowYears} years of
    daily record.${driest ? ` The driest month is ${driest}.` : ''} The scheme is sized on
    ${s ? n(s.designFlowCms, 2) : '–'} m³/s at Q${Math.round(exc * 100)}, after an environmental release of
    ${s ? n(s.residualCms, 2) : '–'} m³/s held continuously in the diverted reach.${
      c.gauges?.length ? ' Gauging stations near the site are listed in the appendices.' : ''
    }</p>`;

  const chart = fdcSvg(c.flow.values.map((v) => v * scale), s?.designFlowCms ?? null, exc);
  hyd += chartBlock(chart, 'Flow-duration curve at the intake');

  const mchart = monthlySvg(monthly.monthlyMeans, scale);
  hyd += chartBlock(mchart, 'Mean monthly flow at the intake — driest month highlighted');

  hyd += table(
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
  if (reg.length) hyd += table('Regional method comparison', ['Method', 'Mean flow m³/s', 'Lowest monthly mean'], reg);

  if (c.hydest?.floods?.length) {
    hyd += table(
      'Regional flood estimates',
      ['Return period', 'Peak discharge m³/s'],
      c.hydest.floods.map((f) => [`${f.t}-year`, n(f.cms, 1)])
    );
  }
  sec.push(hyd);

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
    sec.push(
      H('FLOW-DURATION SHAPE CHECK') +
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
            ))
    );
  }

  if (c.gauges?.length) {
    const RELATION: Record<string, string> = {
      upstream: 'upstream, scale up',
      downstream: 'downstream, scale down',
      'nearby catchment': 'different branch',
    };
    const near = c.gauges.slice(0, 8);
    const usable = c.gauges.filter((gg) => gg.measuresDischarge && gg.trustworthy);
    const best = usable[0] ?? null;

    let gs =
      H('GAUGING STATIONS NEAR THE SITE') +
      `<p>${c.gauges.length} Department of Hydrology and Meteorology station${c.gauges.length === 1 ? '' : 's'}
      lie${c.gauges.length === 1 ? 's' : ''} near this reach. What matters is not how close they are but whether
      their record can be carried to this intake: a station gauging discharge on a catchment of a
      similar size can be transferred by area ratio, and one gauging only water level cannot be used
      at all until its rating curve is obtained separately.</p>` +
      figure(
        `The stations on the ground — hillshaded relief, the alignment in colour, stations in blue where the record is a usable flow series and slate where it gauges water level only${
          figures.gaugeFrameKm ? `. Frame about ${n(figures.gaugeFrameKm, 0)} km across${figures.gaugesShown && figures.gaugesTotal && figures.gaugesShown < figures.gaugesTotal ? `, holding ${figures.gaugesShown} of the ${figures.gaugesTotal} stations tabulated below` : ''}` : ''
        }`,
        figures.gauges
      ) +
      chartBlock(
        gaugeTransferSvg(c.gauges),
        `Each station's catchment against the intake's, on a log scale. Inside the shaded band the record can be carried across by area ratio; markers pinned at an axis end are far outside it${
          c.gauges.filter((gg) => gg.areaRatio == null).length
            ? `. ${c.gauges.filter((gg) => gg.areaRatio == null).length} station${c.gauges.filter((gg) => gg.areaRatio == null).length === 1 ? ' is' : 's are'} off the plot because the mapped network carries no catchment there`
            : ''
        }`
      ) +
      table(
        'Gauging stations near the site',
        ['Station', 'Distance', 'Relation', 'Record', 'Catchment', 'Transfer'],
        near.map((gg) => [
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
        ])
      );

    gs += best
      ? finding(
          'clear',
          `<b>${esc(stationDisplayName(best.name).name)} is the record to obtain</b> — ${dist(best.distanceKm)} away, gauging discharge, ` +
            `on a catchment ${best.areaRatio == null ? 'of comparable size' : `whose flow scales to this intake by ×${n(best.areaRatio, 2)}`}. ` +
            `${best.seriesId ? `Quote series ${best.seriesId} when requesting it. ` : ''}` +
            'A measured record here would replace the modelled flow that every number in this study rests on, and it is the single most valuable thing that can be bought for this site.'
        )
      : finding(
          'watch',
          '<b>No nearby station combines a discharge record with a transferable catchment.</b> ' +
            `${c.gauges.some((gg) => gg.measuresDischarge) ? 'The stations that gauge discharge sit on catchments too different in size for area-ratio transfer to hold' : 'The nearby stations record water level only, which is not a flow series until its rating curve is obtained'}, ` +
            'so the flow in this study stays modelled. That is the largest single uncertainty in it.'
        );

    gs += `<p class="eqnote">Area-ratio transfer, Q here = Q gauge × (A here / A gauge), is the standard
    method for an ungauged site and what a feasibility study would do with these records. It assumes
    the two catchments generate runoff at a similar rate per km², which holds while they share a
    climate and a terrain — so it is marked defensible only inside roughly 0.5–2× and on the same
    river. Distances are straight-line to the nearest point on the studied reach, not along it.</p>`;

    sec.push(gs);
  }

  // ---- 05 power and energy -------------------------------------------------
  let pe =
    H('POWER AND ENERGY') +
    `<p>The installed capacity is ${s ? n(s.capacityMW, 3) : '–'} MW, generating ${s ? n(s.energyGwh, 2) : '–'} GWh
    a year at a plant factor of ${s ? n(s.plantFactor * 100, 1) : '–'}%, on ${s?.turbine ? esc(String(s.turbine)) : '–'}
    turbines.${c.band ? ` Capacity is indicatively ${n(c.band.capLow, 2)}–${n(c.band.capHigh, 2)} MW and energy ${n(c.band.energyLow, 1)}–${n(c.band.energyHigh, 1)} GWh.` : ''}</p>` +
    table(
      'Power and energy',
      ['Parameter', 'Unit', 'Value'],
      [
        ['Design discharge', 'm³/s', s ? n(s.designFlowCms, 3) : '–'],
        ['Environmental release', 'm³/s', s ? n(s.residualCms, 3) : '–'],
        ['Gross head', 'm', s ? n(s.grossHeadM, 1) : '–'],
        ['Head loss in the waterway', 'm', s ? n(s.grossHeadM - s.netHeadM, 1) : '–'],
        ['Net head at the turbine inlet', 'm', s ? n(s.netHeadM, 1) : '–'],
        ['Plant efficiency', '–', n(c.assumptions?.efficiency ?? null, 3)],
        ['Turbine efficiency at design flow', '–', s ? n(s.turbinePeak, 3) : '–'],
        ['Turbine type', '–', s?.turbine ? String(s.turbine) : '–'],
        ['Number of units', '–', '2'],
        ['Rated capacity per unit', 'kW', s ? n((s.capacityMW * 1000) / 2, 0) : '–'],
        ['Installed capacity', 'MW', s ? n(s.capacityMW, 3) : '–'],
        ['Average annual energy', 'GWh', s ? n(s.energyGwh, 2) : '–'],
        ['Plant factor', '%', s ? n(s.plantFactor * 100, 1) : '–'],
        ['Daily output exceeded 90% of days', 'MW', s?.powerDuration ? n(s.powerDuration.p90MW, 2) : '–'],
        ['Daily output exceeded 95% of days', 'MW', s?.powerDuration ? n(s.powerDuration.p95MW, 2) : '–'],
        ['Days with no output', '%', s?.powerDuration ? n(s.powerDuration.zeroOutputFraction * 100, 1) : '–'],
        ['Indicative capacity range', 'MW', c.band ? `${n(c.band.capLow, 2)} – ${n(c.band.capHigh, 2)}` : '–'],
        ['Indicative energy range', 'GWh', c.band ? `${n(c.band.energyLow, 1)} – ${n(c.band.energyHigh, 1)}` : '–'],
      ]
    ) +
    basisOfCalculation(c);

  if (s?.unitSensitivity?.length) {
    pe += table(
      'Equal-rated unit-count sensitivity',
      ['Units', 'Runner', 'Capacity MW', 'Energy GWh', 'Daily P90 MW', 'Daily P95 MW'],
      s.unitSensitivity.map((u) => [
        String(u.units),
        u.turbine ? String(u.turbine) : '–',
        n(u.capacityMW, 3),
        n(u.energyGwh, 2),
        n(u.dailyP90MW, 2),
        n(u.dailyP95MW, 2),
      ])
    );
  }
  sec.push(pe);

  // ---- energy reliability and PPA value ------------------------------------
  const rel = s?.reliability ?? null;
  if (rel) {
    const spread = rel.bestGwh > 0 ? rel.worstGwh / rel.bestGwh : 0;
    let en =
      H('ENERGY RELIABILITY AND PPA VALUE') +
      `<p>Across ${rel.annual.length} complete years of record the scheme generates a median of
      ${n(rel.p50Gwh, 2)} GWh. Nine years in ten it exceeds ${n(rel.p90Gwh, 2)} GWh; the weakest year in the
      record delivers ${n(rel.worstGwh, 2)} GWh and the strongest ${n(rel.bestGwh, 2)} GWh.</p>` +
      chartBlock(
        yearsSvg(rel.annual, rel.p50Gwh, rel.p90Gwh),
        'Annual energy year by year — years below P90 in orange'
      ) +
      facts([
        ['P50 annual energy — median year', `${n(rel.p50Gwh, 2)} GWh`],
        ['P90 annual energy — exceeded in 9 years of 10', `${n(rel.p90Gwh, 2)} GWh`],
        ['Weakest year in the record', `${n(rel.worstGwh, 2)} GWh`],
        ['Strongest year in the record', `${n(rel.bestGwh, 2)} GWh`],
      ]);
    en +=
      spread > 0 && spread < 0.6
        ? finding('watch', `The weakest year delivers only <b>${n(spread * 100, 0)}% of the strongest</b>. Debt sizing should be set against the P90 figure, not the average.`)
        : finding('clear', `Year-to-year variation is contained — the weakest year still delivers <b>${n(spread * 100, 0)}% of the strongest</b>.`);

    // ---- the PPA tests ----------------------------------------------------
    const tests: [string, typeof rel.ppaEightFour, number][] = [
      ['NEA 8 + 4 months', rel.ppaEightFour, 0.15],
      ['NEA 6 + 6 months', rel.ppaSixSix, 0.3],
    ];
    en +=
      '<h2>Dry-energy tests and indicative tariff value</h2>' +
      table(
        'NEA run-of-river PPA dry-energy tests',
        ['Season split', 'Wet GWh', 'Dry GWh', 'Dry share', 'Threshold', 'Result', 'Gross value NPR m/yr'],
        tests.map(([label, t, thr]) => [
          label,
          n(t.wetGwh, 2),
          n(t.dryGwh, 2),
          `${n(t.dryShare * 100, 1)} %`,
          `${n(thr * 100, 0)} %`,
          t.meets ? 'meets' : 'below',
          n(t.grossReferenceValueMillionNpr, 1),
        ])
      );
    const best = rel.ppaEightFour.meets || rel.ppaSixSix.meets;
    en += best
      ? finding('clear', `The scheme <b>meets the dry-energy threshold</b> on ${rel.ppaEightFour.meets ? 'the 8 + 4 split' : ''}${rel.ppaEightFour.meets && rel.ppaSixSix.meets ? ' and ' : ''}${rel.ppaSixSix.meets ? 'the 6 + 6 split' : ''}, so the published base rates apply as tabulated.`)
      : finding('watch', `The scheme <b>falls below the dry-energy threshold on both splits</b> — dry-season output is only ${n(rel.ppaEightFour.dryShare * 100, 1)}% of the annual total. The tariff mix, and therefore the revenue above, would be weaker than the posted rates suggest. Pondage or a lower design flow are the two levers.`);
    /**
     * THE DRY-SHARE VERDICT NOW CARRIES ITS MEASURED ERROR.
     *
     * checks/dryshare-vs-gauges.mjs scored this table for the first time: at 74
     * DHM gauges, dispatching the app's own flow series and the gauge's measured
     * record through one identical plant on the days both cover. The app
     * under-reads the dry share by a median 3.7 percentage points on a
     * Pelton-like machine and 5.6 on a Francis-like one, with a typical error of
     * 5 to 9 points. The direction is one-signed and physical: the flood model's
     * low-flow tail runs below what Nepali rivers hold, which is the same defect
     * engine/fdcshape.ts exists to guard.
     *
     * So a "below" verdict is the one more likely to be wrong, and a scheme
     * sitting within the measurement error of its threshold has not been
     * decided by this table. Saying that is not hedging — it is the difference
     * between a screening result and a claim the reader cannot audit.
     */
    const MEASURED_DRYSHARE_ERROR_PT = 5;
    const margins = tests.map(([, t, thr]) => (t.dryShare - thr) * 100);
    const closest = margins.reduce((a, b) => (Math.abs(a) < Math.abs(b) ? a : b));
    en += finding(
      'note',
      Math.abs(closest) <= MEASURED_DRYSHARE_ERROR_PT
        ? `<b>This scheme sits ${n(Math.abs(closest), 1)} points from its threshold, inside the measurement error, so the test above does not settle it.</b> Scored against 74 DHM gauges, the dry share this app computes runs a median 4 to 6 percentage points BELOW what the gauge measured, with a typical error of 5 to 9 points depending on the machine. The bias is one-signed — the flood model's low-flow tail sits under what Nepali rivers actually hold — so a marginal scheme is more likely to clear the threshold than to miss it. A year of dry-season gauging, or a neighbouring record, decides this; a desk study cannot.`
        : `Scored against 74 DHM gauges, the dry share this app computes runs a median 4 to 6 percentage points <b>below</b> what the gauge measured, with a typical error of 5 to 9 points. The bias is one-signed — the flood model's low-flow tail sits under what Nepali rivers hold — so a "below" verdict is the one more likely to be wrong. This scheme ${closest >= 0 ? 'clears' : 'misses'} its nearest threshold by ${n(Math.abs(closest), 1)} points, outside that error.`
    );
    en += `<p class="eqnote">Gross value at the published NEA base rates for run-of-river schemes,
    ${n(NEA_ROR_PPA.wetNprPerKwh, 2)} NPR/kWh wet and ${n(NEA_ROR_PPA.dryNprPerKwh, 2)} NPR/kWh dry, blended at
    ${n(rel.ppaEightFour.blendedBaseRateNprPerKwh, 2)} NPR/kWh on the 8 + 4 split. This is a reference energy
    value only — not a PPA entitlement, contracted revenue, cash flow, NPV or bankability result. The
    escalation available for schemes up to 100 MW is not applied.</p>`;
    sec.push(en);
  }

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
    let df =
      H('DESIGN FLOW — HOW BIG SHOULD THE MACHINE BE') +
      `<p>Design flow is not a property of the river; it is the decision this study
      makes on the developer's behalf, and every figure above follows from it. The layout is
      fixed — same intake, same powerhouse, same waterway — and only the size of the machine
      is varied.</p>` +
      chartBlock(
        designFlowSvg(sw),
        'Annual energy against installed capacity, at one fixed layout. The curve flattening is the diminishing return.'
      ) +
      table(
        'The trade-off, size by size',
        ['Sized at', 'Design flow', 'Capacity', 'Energy', 'Last MW earns', 'Dry share 6+6'],
        sw.points
          .slice()
          .reverse()
          .map((p) => [
            `Q${Math.round(p.exceedance * 100)}${chosen && p.exceedance === chosen.exceedance ? '  (as designed)' : ''}`,
            `${n(p.designFlowCms, 2)} m³/s`,
            `${n(p.capacityMW, 3)} MW`,
            `${n(p.energyGwh, 1)} GWh`,
            p.marginalHours === null ? '–' : `${n(p.marginalHours, 0)} h/yr`,
            p.dryShareSixSix === null ? '–' : `${n(p.dryShareSixSix * 100, 1)} %`,
          ])
      );

    const big = sw.points[sw.points.length - 1];
    const small = sw.points[0];
    df += finding(
      'note',
      `<b>Between the smallest and largest machine screened, capacity moves ${n(small.capacityMW, 2)} to ${n(big.capacityMW, 2)} MW — a factor of ${n(big.capacityMW / small.capacityMW, 1)} — while energy moves only a factor of ${n(big.energyGwh / small.energyGwh, 1)}.</b> ` +
        `That gap is the whole argument. The last megawatt at the largest size earns ${big.marginalHours === null ? 'no measurable increment' : `${n(big.marginalHours, 0)} full-load hours a year`}, against ${n(small.fullLoadHours, 0)} for the smallest plant overall. Multiply those hours by a tariff and divide by an installed cost and the choice closes; this study supplies the hours and deliberately not the cost.`
    );

    if (bar && chosen && bar.designFlowCms < chosen.designFlowCms) {
      df += finding(
        'watch',
        `<b>The scheme as designed misses NEA's 30% dry-season bar, and sizing at Q${Math.round(bar.exceedance * 100)} would clear it</b> — ${n(bar.capacityMW, 3)} MW against ${n(chosen.capacityMW, 3)} MW, giving up ${n(chosen.energyGwh - bar.energyGwh, 1)} GWh a year to move ${n((chosen.dryShareSixSix ?? 0) * 100, 1)}% dry energy to ${n((bar.dryShareSixSix ?? 0) * 100, 1)}%. ` +
          'That is the 6 + 6 tariff option bought with capacity, and it is the trade the report could previously only gesture at.'
      );
    } else if (bar && chosen && bar.designFlowCms >= chosen.designFlowCms) {
      df += finding(
        'clear',
        `<b>The scheme clears the 30% dry-season bar as designed,</b> and would still clear it up to Q${Math.round(bar.exceedance * 100)} — ${n(bar.capacityMW, 3)} MW, ${n(bar.energyGwh, 1)} GWh. There is headroom to size up without losing the 6 + 6 option.`
      );
    } else if (!bar) {
      df += finding(
        'watch',
        `<b>No machine screened clears the 30% dry-season bar on this river</b>${eight ? `, though the 15% bar on the 8 + 4 split holds up to Q${Math.round(eight.exceedance * 100)} at ${n(eight.capacityMW, 3)} MW` : ' and none clears the 15% bar either'}. Design flow is not the lever here; pondage is.`
      );
    }

    if (sw.maxEnergy.designFlowCms < sw.points[sw.points.length - 1].designFlowCms) {
      df += finding(
        'watch',
        `<b>Energy peaks at Q${Math.round(sw.maxEnergy.exceedance * 100)} and falls beyond it.</b> A larger machine spends more days below its own minimum gate and shuts down, so past this size a more expensive plant generates less. Sizing above ${n(sw.maxEnergy.capacityMW, 3)} MW is losing on both counts.`
      );
    }

    df += `<p class="eqnote">Each size re-sizes its own headrace and penstock, re-selects its own
    turbine and runs the full daily record through that machine's part-load curve — the same
    arithmetic as the headline figures, so the row marked "as designed" reproduces them exactly.
    "Last MW earns" is the extra energy divided by the extra capacity over the size below, in
    equivalent full-load hours per year for that increment alone. <b>No capital cost, discount rate
    or NPV is applied</b>, so this is the physical trade-off and not an economic optimum. The
    dry-share column carries a measured bias: scored against 74 DHM gauges it reads 4 to 6
    percentage points low, so the qualifying sizes above are conservative.</p>`;

    sec.push(df);
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
      H('PONDAGE') +
      `<p>A level-pool screen at the intake, for ${n(pond.damHeightM, 1)} m of retained water above the
      detected bed at ${n(pond.bedElevationM, 1)} m, gives ${n(pond.areaM2 / 10000, 2)} ha of water surface
      and ${n(pond.volumeM3 / 1e6, 3)} million m³ of storage, with backwater reaching
      ${n(pond.upstreamLengthM / 1000, 2)} km upstream.</p>` +
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
      Terrain is read at ${n(cellM, 0)} m, so the shoreline is resolved to about one cell.</p>` +
      chartBlock(sc, 'Stage against water area and storage');

    if (pond.edgeLimited) {
      pd += finding('watch', 'The retained water reaches the edge of the modelled window, so the area and storage above are <b>lower bounds</b>, not estimates.');
    }
    if (pond.levelSensitivity) {
      const ls = pond.levelSensitivity;
      pd +=
        `<p>Because the shoreline is resolved to a cell, the answer moves with the assumed water level.
        Perturbing it by ±${n(ls.errorM, 0)} m moves the area by ${n(ls.areaSpreadPct, 0)}% and the storage by
        ${n(ls.volumeSpreadPct, 0)}%.</p>`;
      if (ls.areaSpreadPct > 50 || ls.volumeSpreadPct > 50) {
        pd += finding('watch', 'That is a wide swing for a plausible level error: treat this pondage as <b>order-of-magnitude only</b> until a survey fixes the shoreline.');
      }
    }
    if (pond.terrainComparison) {
      const tc = pond.terrainComparison;
      pd += `<p>Screened again on a second, independently produced elevation surface at the same dam axis,
      the same pool measures ${n(tc.areaM2 / 10000, 2)} ha and ${n(tc.volumeM3 / 1e6, 3)} million m³ — a spread of
      ${n(tc.areaSpreadPct, 0)}% on area and ${n(tc.volumeSpreadPct, 0)}% on storage.</p>`;
    } else {
      pd += finding('note', 'Only one elevation surface was available, so this footprint carries no second-source check.');
    }

    // ---- is it enough -----------------------------------------------------
    if (demand) {
      const hrs = demand.hoursSupported === null ? null : Math.min(demand.hoursSupported, demand.inflowCeilingHours);
      pd +=
        '<h2>Is it enough for peaking?</h2>' +
        `<div class="eq">
          <div class="eqhead">Daily peaking balance, driest month</div>
          <div class="eqrow"><span>Usable inflow  Qa = dry-month mean − residual release</span><b>${n(demand.dryInflowCms, 3)} − ${n(s?.residualCms ?? 0, 3)} = <u>${n(demand.usableInflowCms, 3)} m³/s</u></b></div>
          <div class="eqrow"><span>Shortfall while peaking  Qd − Qa</span><b>${n(demand.designFlowCms, 3)} − ${n(demand.usableInflowCms, 3)} = <u>${n(demand.deficitCms, 3)} m³/s</u></b></div>
          <div class="eqrow"><span>Storage for ${demand.referenceHours} h at design flow  = (Qd − Qa) × h × 3600</span><b><u>${n(demand.requiredM3 / 1e6, 3)} million m³</u></b></div>
          <div class="eqrow"><span>Hours this pond delivers</span><b><u>${hrs === null ? 'no pond needed' : `${n(hrs, 1)} h`}</u></b></div>
          <div class="eqrow"><span>Ceiling from inflow alone  = 24 × Qa / Qd</span><b><u>${n(demand.inflowCeilingHours, 1)} h</u></b></div>
        </div>`;
      if (demand.deficitCms <= 0) {
        pd += finding('clear', `The driest month already carries ${n(demand.usableInflowCms, 2)} m³/s past the residual release, at or above the design flow. <b>No storage is needed to run at full output</b>; pondage here buys dispatch timing, not energy.`);
      } else if (demand.inflowLimited) {
        pd += finding('watch', `The basin holds ${n(demand.hoursSupported ?? 0, 1)} h of storage, but a dry-season day only delivers water for <b>${n(demand.inflowCeilingHours, 1)} h</b> at design flow however much is impounded. The scheme is <b>inflow-limited, not storage-limited</b> — the extra volume buys nothing.`);
      } else if (hrs !== null && hrs >= PONDAGE_REFERENCE_HOURS) {
        pd += finding('clear', `The pond covers <b>${n(hrs, 1)} h</b> of peaking at design flow, above the ${PONDAGE_REFERENCE_HOURS} h reference. The site supports a peaking run-of-river operation.`);
      } else {
        pd += finding('watch', `The pond covers only <b>${n(hrs ?? 0, 1)} h</b> at design flow, below the ${PONDAGE_REFERENCE_HOURS} h reference. A larger structure or a lower peaking target would be needed.`);
      }
      pd += '<p class="eqnote">One average day, level pool: no ramping, spill, turbine minimum, drawdown rule or flushing allowance.</p>';
    }
    sec.push(pd);
    if (pond.stageCurve?.length) {
      stageAppendix = table(
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
      H('WHERE ALONG THE REACH THE STORAGE IS') +
      `<p>The pondage above is the answer at the intake, which was placed for head and flow. A
      Himalayan valley narrows and widens every few hundred metres, so the same ${n(sw.damHeightM, 1)} m
      of retained water holds a different pond a few hundred metres up or down. The screen is
      repeated at ${sw.points.length} positions and ranked by <b>storage held per metre of dam</b> —
      not by storage, because volume grows downstream with the valley whatever the site is like, and
      a sweep ranked on it would point at the far end of the reach every time.</p>` +
      chartBlock(
        pondagePositionSvg(sw),
        `Storage per metre of dam at ${n(sw.damHeightM, 1)} m retained, along the reach. Hollow bars reached the edge of the terrain window and are minima.`
      ) +
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
          `<b>Moving the intake ${n(Math.abs(best!.offsetKm), 2)} km ${best!.offsetKm > (cur?.offsetKm ?? 0) ? 'downstream' : 'upstream'} would hold ${n(gain, 1)}× the water per metre of dam</b> — ` +
            `${n(best!.volumePerDamMetreM3!, 0)} m³/m against ${n(cur!.volumePerDamMetreM3!, 0)} at the sited position, for ${n(best!.volumeM3 / 1e6, 3)} Mm³ behind a ${n(best!.damLengthM!, 0)} m span. ` +
            'Head and flow decided this intake and storage did not get a vote; on a scheme that needs pondage to reach its dry-season energy, it should. ' +
            '<b>It is a trade, not an instruction:</b> the intake sets the head, so a move downstream buys storage and gives up gross head and the energy that goes with it. Re-run the layout at the new intake before believing either half.'
        )
      : best && cur && best.i === cur.i
        ? finding('clear', '<b>The sited intake is already the best pondage position screened.</b> No move up or down this reach holds more water per metre of dam.')
        : gain
          ? finding('note', `The best position screened holds ${n(gain, 2)}× the water per metre of dam of the sited one — inside the noise of a 30 m terrain screen, so there is no case for moving the intake on storage grounds.`)
          : finding('note', 'No position screened returned a pond bounded inside its terrain window, so the positions cannot be ranked against each other.');

    ps += `<p class="eqnote">A screen on top of a screen: every limitation of the pondage section
    above applies at every position here and compounds — a ${n(sw.points[0]?.edgeLimited ? 30 : 30, 0)} m
    elevation model, a level-pool fill, no spillway, no geology, no land take and no cost. Positions
    marked ≥ reached the edge of their terrain window, so their area and storage are minima and they
    are drawn hollow. What this ranks is positions against each other on one consistent basis; it
    does not size any of them. Terrain source: ${esc(sw.source)}.</p>`;

    sec.push(ps);
  }

  // ---- 07 alternatives -----------------------------------------------------
  if (c.schemes.length > 1) {
    sec.push(
      H('ALTERNATIVE LAYOUTS') +
        `<p>${c.evaluated} layouts were evaluated along this reach; the ${Math.min(10, c.schemes.length)}
        strongest are tabulated in the appendices. The selected layout is the one described throughout.</p>`
    );
    app.push(
      A('ALTERNATIVE LAYOUTS CONSIDERED') +
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
      H('NEIGHBOURING PROJECTS ON THIS RIVER') +
        `<p>${c.cascade.upstream.length} licensed projects lie upstream of the intake and
        ${c.cascade.downstream.length} downstream of the powerhouse. ${c.cascade.directReachRecords} licence
        records fall on the diverted reach itself, of which ${c.cascade.directAdvancedRecords} hold a
        construction licence or are already operating.${
          nearest?.name ? ` The closest is ${esc(nearest.name)}, ${n(nearest.routeKm ?? null, 1)} km away along the river.` : ''
        } The full register, with each licence's published coordinate range, is in
        Appendix ${String.fromCharCode(65 + appNo + 1)}.</p>`
    );
    app.push(
      A('REGISTER OF NEIGHBOURING LICENSED PROJECTS') +
        table(
          'Licensed projects upstream and downstream',
          ['Project', 'Direction', 'Capacity MW', 'Stage', 'Route km', 'Published range km'],
          rows
        )
    );
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
      H('ACCESS AND GRID CONNECTION') +
        access +
        (c.grid
          ? facts([
              ['Connection voltage required', `${n(c.grid.requiredKv, 0)} kV`],
              ['Nearest mapped line', `${dist(c.grid.nearestKm)} at ${n(c.grid.nearestKv, 0)} kV`],
              ['Nearest line of adequate voltage', c.grid.adequateKm == null ? '–' : `${dist(c.grid.adequateKm)} at ${n(c.grid.adequateKv, 0)} kV`],
              ['Nearest substation', c.grid.nearestSub ? `${c.grid.nearestSub.name ?? 'unnamed'} · ${dist(c.grid.nearestSub.km)} at ${n(c.grid.nearestSub.kv, 0)} kV` : '–'],
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
                    : finding('watch', `<b>No mapped line reaches the ${n(c.grid.requiredKv, 0)} kV this capacity would need.</b> The nearest line of any voltage is ${dist(c.grid.nearestKm)} away at ${n(c.grid.nearestKv, 0)} kV, so connection means either a new line at the required voltage or a smaller machine.`)) +
                (sub
                  ? `<p>The nearest mapped connection point is <b>${esc(sub.name ?? 'an unnamed substation')}</b>, ${dist(sub.km)} away at ${n(sub.kv, 0)} kV${sub.inferredKv ? ', a voltage inferred from a connecting line rather than tagged on the substation itself' : ''}. Substation capacity and spare bay availability are not in any open dataset and must be confirmed with NEA.</p>`
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
          ? finding('watch', `<b>This is an actively failing corridor.</b> ${nearSlides} landslides have been recorded within ${NEAR_CORRIDOR_KM} km of the works — ${slideRecords.length} within the full ${n(c.hazards.radiusKm, 1)} km screen — the nearest ${n(slides?.nearestKm, 1)} km from the alignment. Slope stability along the headrace is a primary design risk here, not a checklist item, and the alignment should be walked by an engineering geologist before it is fixed.${clusterNote}`)
          : nearSlides > 0
            ? finding('note', `<b>${nearSlides} landslide${nearSlides === 1 ? ' has' : 's have'} been recorded within ${NEAR_CORRIDOR_KM} km of the works,</b> the nearest ${n(slides?.nearestKm, 1)} km from the alignment, out of ${slideRecords.length} across the full ${n(c.hazards.radiusKm, 1)} km screen. The corridor sits in failing country without the works themselves being ringed by it, so slope stability is a design item to walk rather than a reason to move the layout.${clusterNote}`)
            : finding('note', `${c.hazards.total} records fall within the ${n(c.hazards.radiusKm, 1)} km screen, the nearest ${n(nearest, 1)} km from the alignment, and none within ${NEAR_CORRIDOR_KM} km of the works. The alignment should still be walked: absence of a filed record is not evidence of a stable slope.${clusterNote}`);
    sec.push(
      H('RECORDED NATURAL HAZARDS') +
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
    );
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
    // A lake is worth naming when it is big enough to matter and close enough
    // that a wave would still be a wave by the time it arrived.
    const risky = u.lakes.filter((l) => {
      const ll = l as unknown as { areaHa?: number; areaKm2?: number; routeKm?: number };
      const ha = ll.areaHa ?? (ll.areaKm2 != null ? ll.areaKm2 * 100 : 0);
      return ha >= 10 && (ll.routeKm ?? 1e9) <= 60;
    });
    sec.push(
      H('GLACIAL LAKE OUTBURST FLOOD SCREEN') +
        (u.lakes.length === 0
          ? finding('clear', `<b>No glacial lake drains through this site.</b> All ${u.lakeInventory.total.toLocaleString()} lakes in the inventory were tested against the flow path above the intake and none reaches it, so a glacial lake outburst flood is <b>not a design case</b> for this scheme.`)
          : risky.length
            ? finding('watch', `<b>${risky.length} of the ${u.lakes.length} upstream lakes are large and close enough to matter</b> — at least 10 ha within 60 km of flow path. A GLOF study and an outburst design flood are required, and the intake and powerhouse levels should be set against it rather than against the flood frequency curve alone.`)
            : finding('note', `${u.lakes.length} upstream lakes drain through the site, but none is both large (≥10 ha) and close (≤60 km of flow path). GLOF is a residual risk to note rather than a governing design case.`)) +
        `<p>${u.incidents.length} recorded upstream channel incidents lie on the same flow path.${
          u.lakes.length ? ' Each lake is listed in the appendices.' : ''
        }</p>` +
        figure(
          `The lakes that drain through this site, with every other layer switched off — each one traced down its own flow path to the intake${
            figures.lakeFrameKm ? `. Frame about ${n(figures.lakeFrameKm, 0)} km across` : ''
          }`,
          figures.lakes
        )
    );
    if (u.lakes.length) {
      lakeAppendix = table(
        'Upstream glacial lakes draining through the site',
        ['Lake', 'Area ha', 'Route km'],
        u.lakes.slice(0, 15).map((l) => {
          const ll = l as unknown as { name?: string; areaHa?: number; areaKm2?: number; routeKm?: number };
          return [ll.name ?? 'unnamed', n(ll.areaHa ?? (ll.areaKm2 != null ? ll.areaKm2 * 100 : null), 1), n(ll.routeKm ?? null, 1)];
        })
      );
    }
  }

  // ---- 12 seismic, geology, conservation, survey ----------------------------
  const seis: [string, string][] = [];
  if (c.seismic?.pga475g != null) seis.push(['Peak ground acceleration, 475-year return', `${n(c.seismic.pga475g, 2)} g`]);
  if (c.seismic?.quakeCount != null) seis.push(['Recorded earthquakes nearby', String(c.seismic.quakeCount)]);
  if (c.seismic?.largest) seis.push(['Largest recorded earthquake', c.seismic.largest]);
  if (c.faults?.nearest) seis.push(['Nearest mapped fault', `${c.faults.nearest.name ?? c.faults.nearest.type} · ${n(c.faults.nearest.distanceKm, 1)} km`]);
  if (c.faults?.crossings != null) seis.push(['Faults crossing the alignment', String(c.faults.crossings)]);
  if (seis.length) {
    const pga = c.seismic?.pga475g ?? null;
    const faultKm = c.faults?.nearest?.distanceKm ?? null;
    const sv =
      pga == null
        ? ''
        : pga >= 0.4
          ? finding('watch', `<b>A peak ground acceleration of ${n(pga, 2)} g is severe.</b> Every retaining structure, the powerhouse and the penstock anchors must be designed for it explicitly, and the surge and intake structures checked for displacement rather than shaking alone.`)
          : pga >= 0.25
            ? finding('note', `A peak ground acceleration of ${n(pga, 2)} g is high but ordinary for Nepal. Standard seismic detailing to the national code is expected to be sufficient.`)
            : finding('clear', `A peak ground acceleration of ${n(pga, 2)} g is moderate for this region.`);
    const fv =
      faultKm == null
        ? ''
        : (c.faults?.crossings ?? 0) > 0
          ? finding('watch', `<b>A mapped fault crosses the alignment.</b> A tunnel or buried penstock across an active trace needs a fault-crossing detail, not a standard section.`)
          : faultKm < 10
            ? finding('note', `The nearest mapped fault is ${n(faultKm, 1)} km away and does not cross the alignment.`)
            : '';
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
    const drawnFaults = c.faults?.nearby?.length ?? 0;
    const nearestFaultKm = c.faults?.nearest?.distanceKm ?? null;
    const seisFig = figures.seismic
      ? figure(
          `Recorded epicentres around the scheme — hillshaded relief, the alignment in colour, ` +
            `instrumented earthquakes as orange circles sized by magnitude` +
            (drawnFaults ? `, and ${drawnFaults} mapped active fault trace${drawnFaults === 1 ? '' : 's'} in dark red` : '') +
            (figures.seismicFrameKm ? `. Frame about ${n(figures.seismicFrameKm, 0)} km across` : '') +
            (!drawnFaults && nearestFaultKm != null
              ? `; no mapped fault falls inside it — the nearest is ${n(nearestFaultKm, 1)} km away`
              : ''),
          figures.seismic
        )
      : '';
    sec.push(H('SEISMICITY AND ACTIVE FAULTS') + facts(seis) + seisFig + sv + fv);
  }

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
  {
    const dmg = c.geology?.dmg ?? null;
    const covering = dmg?.maps ?? [];
    const samples = c.geology?.regional?.samples ?? [];
    const distinct = new Set(samples.flatMap((smp) => smp.units.map((u) => u.name)));
    let geo = H('ENGINEERING GEOLOGY');

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
      // 0.5 mm is about the finest line a printed map holds, so the scale
      // denominator over 2000 is that line's width on the ground: 175 m at
      // 1:350,000. Nothing scaled off the sheet can beat it.
      const denom = Number((sheet.scale.match(/1:\s*([\d,]+)/)?.[1] ?? '').replace(/,/g, ''));
      const lineM = Number.isFinite(denom) && denom > 0 ? Math.round(denom / 2000) : null;
      const km = sheet.placementKm;
      // The index keys sheets by file stem, so the province arrives lowercase.
      const prov = sheet.province.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
      geo +=
        `<p>The Department of Mines and Geology publishes a geological map of each province at
        ${esc(sheet.scale)}. The <b>${esc(prov)} Province</b> sheet covers this alignment and is
        reproduced below beneath the layout, so the mapped units, thrusts and fold axes can be read
        against the waterway directly.</p>` +
        figure(
          `Published geological map of ${prov} Province at ${sheet.scale}, beneath the scheme alignment${
            figures.geologyFrameKm
              ? `. Framed ${n(figures.geologyFrameKm, 0)} km wide: at the scheme's own scale a sheet of this kind resolves nothing`
              : ''
          }`,
          figures.geology
        ) +
        finding(
          km !== null && km <= 0.5 ? 'note' : 'watch',
          km === null
            ? `<b>The placement of this sheet has not been measured.</b> Read it as regional context and do not scale a position off it.`
            : km <= 0.5
              ? `<b>The sheet is registered to within ${n(km, 2)} km</b> — measured, not asserted. The surveyed spot heights printed on it were compared against a 30 m elevation model, and the shift that would make them agree any better is at or below ${n(km, 2)} km.${lineM ? ` At ${esc(sheet.scale)} a printed line is about ${lineM} m wide on the ground, so the sheet is hung about as precisely as it can be read.` : ''} Read units and structures from it; do not scale a contact to better than a few hundred metres.`
              : `<b>This sheet is registered to about ${n(km, 2)} km, looser than the others.</b> The same spot-height test puts its best fit that far from where it is drawn. Use it for regional context only — a contact read off it could be a kilometre from the ground.`
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

      geo +=
        `<p>Nepal's own geological map, published by the Department of Mines and Geology at
        ${esc(gu.scale)}, has been read along the waterway itself rather than at a point. The
        <b>intake stands on ${esc(unitWord(gu.intake))}</b> and the <b>powerhouse on
        ${esc(unitWord(gu.powerhouse))}</b>.</p>`;

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
        geo += finding(
          'note',
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
          `<b>${n(blankKm, 1)} km of this ${n(gu.lengthKm, 1)} km alignment — ${n(blankShare * 100, 0)}% — ` +
            `is not carried by the national digital dataset.</b> That is a gap in the data, not in Nepal's ` +
            `geology: the published 1994 map covers the whole country, and the Department's own ` +
            `1:350,000 province sheets map this ground. About 30% of the digitised extent is missing this ` +
            `way and it is concentrated in the high north, so a scheme with real head falls in it more ` +
            `often than a low one. <b>Nothing below describes those kilometres — obtain the published ` +
            `sheet for them rather than reading them as unremarkable.</b>`
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
        geo +=
          `<p>The waterway crosses <b>${gu.formationContacts} mapped formation contact${gu.formationContacts === 1 ? '' : 's'}</b>` +
          `${gu.contacts.length > gu.formationContacts ? `, plus ${gu.contacts.length - gu.formationContacts} boundary between members of one formation, which is not counted here` : ''}` +
          `${gu.coverageEdges ? `. It also runs across the edge of the mapping ${gu.coverageEdges === 1 ? 'once' : `${gu.coverageEdges} times`}, which is not a contact` : ''}.
          A contact is where the ground changes, where water is most likely to be met, and where an
          excavation stops behaving as it did — so the count matters more than the names.</p>` +
          table('Formation contacts along the waterway', ['Chainage', 'From', 'To'], rows) +
          finding(
            'watch',
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
        geo += table(
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
      geo +=
        `<p>${covering.length} published geological map${covering.length === 1 ? '' : 's'} at
        ${esc(dmg?.scale ?? '1:50,000')} cover${covering.length === 1 ? 's' : ''} this alignment.</p>` +
        table(
          'Published geological maps covering the alignment',
          ['Map', 'Published', 'Sheets touched'],
          covering.map((m) => [m.title, m.published, m.sheets.map((sh) => sh.code).join(', ')])
        ) +
        finding('note', 'These sheets are the correct basis for the engineering geology; obtain them before fixing any underground or foundation layout.');
    } else {
      geo += finding(
        'watch',
        `<b>No published ${esc(dmg?.scale ?? '1:50,000')} geological sheet covers this alignment.</b> ` +
          `${dmg ? `${dmg.catalogMaps} sheets are catalogued nationally, and none falls on this reach. ` : ''}` +
          'Systematic mapping at that scale does not cover the whole country, and this site is outside it.' +
          (sheet ? ' The provincial sheet above is the best published mapping available here.' : '')
      );
    }

    if (distinct.size) {
      const only = [...distinct];
      geo +=
        `<p>${sheet ? 'The open global coverage' : 'The only regional coverage available at this location'} resolves the intake, mid-reach and
        powerhouse to ${only.length === 1 ? 'a single unit' : `${only.length} units`}:
        ${only.map((u) => esc(u)).join('; ')}.</p>` +
        (only.length === 1
          ? finding('watch', `<b>That is one polygon spanning the entire alignment, and it is not an engineering input.</b> It cannot distinguish phyllite from quartzite from gneiss, place a contact, or say anything about rock mass, weathering, discontinuities, permeability or tunnelling behaviour — all of which govern the headrace.${sheet ? ' The provincial sheet above is the better regional basis and should be read in preference to it.' : ''} <b>Engineering geology for this scheme is unresolved and a mapped ground traverse is required.</b>`)
          : finding('note', 'Regional coverage only. It cannot place a contact or establish rock mass, weathering, discontinuities or tunnelling behaviour.'));
    }
    sec.push(geo);
  }

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
      H('PROTECTED AREAS') +
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
      H('LAND THE WATERWAY CROSSES') +
      facts([
        ['Alignment screened', dist(lc.waterwayKm)],
        ['Ground at the intake', lc.intake ?? 'unclassified'],
        ['Ground at the powerhouse', lc.powerhouse ?? 'unclassified'],
        ['Cover cell', `${lc.cellM} m`],
      ]) +
      table(
        'Land cover along the alignment',
        ['Cover', 'Length', 'Share of alignment'],
        lc.along.map((a) => [a.label, dist(a.km), `${n(a.share * 100, 0)} %`])
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
  if (c.sediment?.source && s) {
    const src = c.sediment.source;
    const basin = desander({ designFlowCms: s.designFlowCms, netHeadM: s.netHeadM });
    const bench = c.sediment.bench;
    let sed =
      H('SEDIMENT AND DESANDING') +
      `<p><b>${esc(src.label.charAt(0).toUpperCase() + src.label.slice(1))}</b> — ${n(src.highFrac * 100, 0)}% of
      the catchment lies above 3 000 m. ${esc(src.note)}</p>`;
    if (basin) {
      sed +=
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
            ? finding('clear', `The valley offers ${n(bench.widestM, 0)} m of flat ground on the ${bench.side ?? 'near'} bank, ${n(bench.liftM, 0)} m above the river — <b>enough for the ${n(basin.benchNeededM, 0)} m the basin needs</b>.`)
            : bench.verdict === 'marginal'
              ? finding('note', `The widest bench found is ${n(bench.widestM, 0)} m against the ${n(basin.benchNeededM, 0)} m required. That difference is inside the terrain model's own error, so it is unresolved rather than tight — a cross-section survey settles it.`)
              : finding('watch', `<b>No bench wide enough for the desanding basin was found.</b> The widest flat ground is ${n(bench.widestM, 0)} m against ${n(basin.benchNeededM, 0)} m required, so the basin implies either significant cut into the valley side, an underground chamber, or an intake moved to a wider reach.`);
      }
    }
    sec.push(sed);
  }

  // ---- how much to trust the numbers ---------------------------------------
  const unc = c.uncertainty;
  if (unc) {
    const capPct = s && s.capacityMW > 0 ? ((unc.capacityMW.high - unc.capacityMW.low) / 2 / s.capacityMW) * 100 : null;
    let uc =
      H('HOW MUCH TO TRUST THESE NUMBERS') +
      `<p>Every figure in this report is a screening estimate carried from global and national datasets
      without a site measurement. The capacity above is plausibly between
      ${n(unc.capacityMW.low, 3)} and ${n(unc.capacityMW.high, 3)} MW${capPct ? `, about ±${n(capPct, 0)}% of the
      figure quoted` : ''}, and the annual energy between ${n(unc.energyGwh.low, 2)} and
      ${n(unc.energyGwh.high, 2)} GWh.</p>` +
      facts([
        ['Capacity range', `${n(unc.capacityMW.low, 3)} – ${n(unc.capacityMW.high, 3)} MW`],
        ['Annual energy range', `${n(unc.energyGwh.low, 2)} – ${n(unc.energyGwh.high, 2)} GWh`],
        ['Spread carried on the flow', `± ${n(unc.flowSpreadPct, 0)} %`],
        ['Spread carried on the head', `± ${n(unc.headSpreadM, 1)} m`],
      ]);
    if (unc.drivers.length) {
      uc += table(
        'What drives the spread, largest first',
        ['Source of uncertainty', 'Swing in capacity', 'Why'],
        unc.drivers.map((d) => [d.name, `± ${n(d.swingPct, 0)} %`, d.note])
      );
      const top = unc.drivers[0];
      uc += finding(
        'note',
        `<b>${esc(top.name)} dominates</b>, worth ±${n(top.swingPct, 0)}% of the capacity on its own. ` +
          'Resolving it is worth more than refining anything else in this report, and it is what the ' +
          'fieldwork below is aimed at.'
      );
    }
    sec.push(uc);
  }

  // ---- what to do next, from the readiness screen ---------------------------
  const decisionText: Record<string, string> = {
    hold: 'A constraint found in this screening should be resolved before further spend.',
    fieldwork: 'The site is worth a field campaign; the tasks below are what it should cover.',
    screening: 'The site remains at screening stage; the gaps below are what stands between it and a field campaign.',
  };
  sec.push(
    H('CONCLUSION AND NEXT STEPS') +
      `<p>The screening indicates a ${s ? n(s.capacityMW, 3) : '–'} MW run-of-river scheme generating
      approximately ${s ? n(s.energyGwh, 2) : '–'} GWh a year, at a gross head of
      ${s ? n(s.grossHeadM, 1) : '–'} m over a ${s ? n(s.waterwayKm, 2) : '–'} km waterway.
      ${rd ? esc(decisionText[rd.decision] ?? '') : ''}</p>` +
      (rd?.stopReasons?.length
        ? finding(
            'watch',
            `<b>Held for: </b>${rd.stopReasons.map((r) => esc(r.replace(/\.\s*$/, ''))).join('; ')}.`
          )
        : '') +
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
        ? table(
            'Recommended field programme',
            ['Priority', 'Discipline', 'Task', 'Why it is needed'],
            rd.tasks.map((t) => [t.priority, t.discipline, t.title, t.reason])
          )
        : '') +
      '<p>Subject to a favourable outcome from the tasks above, a full feasibility study should follow. ' +
      'The deliverable expected from each task, and what closes each gate, are carried in full in the ' +
      'field-plan CSV export rather than reproduced here.</p>'
  );

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
      ['Gauges', 'DHM Nepal', 'Supplied; 136 daily records'],
      ['Licensed projects', 'DoED register', 'Public register; ~1,048 located'],
      ['Geological mapping', 'DMG province sheets', 'Published 1:350,000, reproduced as issued'],
      ['Hazard records', 'BIPAD portal', 'Public; filed against settlements, not scars'],
      ['Seismic hazard', 'GEM global model', 'Peak ground acceleration, 475-year return'],
      ['Tariff', 'NEA published base rates', 'Board decision 2074/01/14 (27 April 2017)'],
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
        `<p>Nothing in the body of this report was asserted. Every layer below is a published
        dataset, and every accuracy figure was measured against something independent — Nepal's own
        gauge records, its own built plants, or a second terrain product — rather than quoted from a
        specification.</p>` +
        table('What this study is built on', ['Layer', 'Source', 'Licence, resolution, vintage'], src) +
        `<p>The accuracy below is the app's own, measured on Nepali evidence. It is not a claim
        about this site: it is the spread you should expect a screening result to carry before any
        survey has been done.</p>` +
        table('Measured accuracy', ['Quantity', 'Result', 'Measured against'], acc) +
        finding(
          'watch',
          '<b>Flow is the binding constraint, not terrain.</b> Flow carries roughly a factor of 1.6 ' +
            'on an ungauged Nepali catchment while head carries 3.4%, so a 1.6× flow error is a 1.6× ' +
            'energy error. That is why the gauging-station section earlier is the most valuable page ' +
            'in this document: a measured record replaces the largest uncertainty in it.'
        ) +
        `<p class="eqnote">MERIT Hydro is CC-BY-NC, so derived per-vertex values are used and the
        original raster is not redistributed. The DMG sheet is reproduced as published, watermark
        included. Private and supplied layers are named but not shipped.</p>`
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

  /* ---- findings: the sentence that answers the section's question ---- */
  .find {
    border-left: 3px solid var(--rule); padding: 2.2mm 0 2.2mm 4mm;
    margin: 0 0 4mm; text-align: left; page-break-inside: avoid;
    font-size: 10.5pt; line-height: 1.55;
  }
  .find.clear { border-left-color: #2f7d5b; background: #2f7d5b0a; }
  .find.watch { border-left-color: var(--warm); background: #b3541e0d; }
  .find.note  { border-left-color: var(--soft); background: #8b949c0a; }
  .find b { font-weight: 700; }

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
Appendix, which forms part of this report.</p>

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
