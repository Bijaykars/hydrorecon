/** Hand-drawn canvas charts. No chart library. */
import type { FdcPoint } from './hydro.ts';
import type { ProfilePoint } from './api.ts';

const CSS = {
  ink: '#e8eef5',
  dim: '#8fa3b8',
  grid: 'rgba(143,163,184,0.16)',
  axis: 'rgba(143,163,184,0.45)',
  curve: '#4db8ff',
  fill: 'rgba(77,184,255,0.14)',
  mark: '#ffb454',
  design: '#7ee787',
  land: 'rgba(126,231,135,0.18)',
};

/** Size the backing store to the device pixel ratio so text stays sharp. */
function prep(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  return { ctx, w, h };
}

function niceLogTicks(min: number, max: number): number[] {
  const out: number[] = [];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  for (let e = lo; e <= hi; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out;
}

const fmt = (v: number) =>
  v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);

export type FdcMarker = { exceedance: number; label: string; colour?: string };

/**
 * Flow-duration curve. Log discharge axis, because a real FDC spans orders of
 * magnitude and a linear axis hides the low-flow tail that P90 depends on.
 */
export function drawFdc(
  canvas: HTMLCanvasElement,
  fdc: readonly FdcPoint[],
  markers: FdcMarker[] = [],
  designFlow?: number
): void {
  const s = prep(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  const pad = { l: 56, r: 12, t: 12, b: 30 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  if (fdc.length === 0) {
    ctx.fillStyle = CSS.dim;
    ctx.textAlign = 'center';
    ctx.fillText('no discharge record', w / 2, h / 2);
    return;
  }

  const positive = fdc.map((d) => d.q).filter((q) => q > 0);
  const qMax = Math.max(...fdc.map((d) => d.q), 1e-3);
  // Floor the axis rather than let a single zero-flow day collapse the log scale.
  const qMin = positive.length > 0 ? Math.max(Math.min(...positive), qMax / 1e4) : qMax / 1e4;
  const X = (p: number) => pad.l + p * pw;
  const Y = (q: number) => {
    const c = Math.min(qMax, Math.max(qMin, q));
    return pad.t + ph - ((Math.log10(c) - Math.log10(qMin)) / (Math.log10(qMax) - Math.log10(qMin))) * ph;
  };

  // grid + axes
  ctx.strokeStyle = CSS.grid;
  ctx.fillStyle = CSS.dim;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of niceLogTicks(qMin, qMax)) {
    const y = Math.round(Y(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(fmt(t), pad.l - 8, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let p = 0; p <= 100; p += 10) {
    const x = Math.round(X(p / 100)) + 0.5;
    ctx.strokeStyle = CSS.grid;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + ph);
    ctx.stroke();
    if (p % 20 === 0) ctx.fillText(String(p), x, pad.t + ph + 6);
  }
  ctx.fillStyle = CSS.dim;
  ctx.fillText('exceedance %  (flow equalled or exceeded)', pad.l + pw / 2, pad.t + ph + 18);

  // design-flow band: everything above the turbine cap is spilled, not generated
  if (designFlow && designFlow > 0 && designFlow < qMax) {
    ctx.fillStyle = CSS.land;
    ctx.fillRect(pad.l, pad.t, pw, Y(designFlow) - pad.t);
    ctx.strokeStyle = CSS.design;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(designFlow));
    ctx.lineTo(w - pad.r, Y(designFlow));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = CSS.design;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('design flow — above this is spilled', pad.l + 6, Y(designFlow) - 3);
  }

  // curve. Downsample to at most one vertex per pixel column; 35k points is pointless.
  const step = Math.max(1, Math.floor(fdc.length / pw));
  ctx.beginPath();
  for (let i = 0; i < fdc.length; i += step) {
    const x = X(fdc[i].p);
    const y = Y(fdc[i].q);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.lineTo(X(fdc[fdc.length - 1].p), Y(fdc[fdc.length - 1].q));
  ctx.strokeStyle = CSS.curve;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(X(1), pad.t + ph);
  ctx.lineTo(X(0), pad.t + ph);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
  grad.addColorStop(0, 'rgba(77,184,255,0.30)');
  grad.addColorStop(1, 'rgba(77,184,255,0.03)');
  ctx.fillStyle = grad;
  ctx.fill();

  // exceedance markers (P50, P90, Q40 ...)
  for (const m of markers) {
    const x = X(m.exceedance);
    const i = Math.min(fdc.length - 1, Math.max(0, Math.round(m.exceedance * fdc.length) - 1));
    const y = Y(fdc[i].q);
    ctx.strokeStyle = m.colour ?? CSS.mark;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = m.colour ?? CSS.mark;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = m.exceedance > 0.75 ? 'right' : 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(m.label, m.exceedance > 0.75 ? x - 5 : x + 5, pad.t + 3);
  }

  ctx.save();
  ctx.translate(13, pad.t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = CSS.dim;
  ctx.fillText('discharge m³/s (log)', 0, 0);
  ctx.restore();
}

/** Long profile between intake and powerhouse, with the gross head drawn on it. */
export function drawProfile(canvas: HTMLCanvasElement, pts: readonly ProfilePoint[]): void {
  const s = prep(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  const pad = { l: 52, r: 12, t: 14, b: 28 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  const good = pts.filter((p) => Number.isFinite(p.elevationM));
  if (good.length < 2) {
    ctx.fillStyle = CSS.dim;
    ctx.textAlign = 'center';
    ctx.fillText('elevation unavailable for this reach', w / 2, h / 2);
    return;
  }

  const eMin = Math.min(...good.map((p) => p.elevationM));
  const eMax = Math.max(...good.map((p) => p.elevationM));
  const span = Math.max(eMax - eMin, 1);
  const dMax = Math.max(...good.map((p) => p.distanceKm), 1e-6);
  const X = (d: number) => pad.l + (d / dMax) * pw;
  const Y = (e: number) => pad.t + ph - ((e - eMin + span * 0.08) / (span * 1.16)) * ph;

  ctx.strokeStyle = CSS.grid;
  ctx.fillStyle = CSS.dim;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const e = eMin + (span * i) / 4;
    const y = Math.round(Y(e)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(e.toFixed(0), pad.l - 8, y);
  }

  ctx.beginPath();
  good.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.distanceKm), Y(p.elevationM)) : ctx.lineTo(X(p.distanceKm), Y(p.elevationM))));
  ctx.strokeStyle = CSS.design;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(X(dMax), pad.t + ph);
  ctx.lineTo(X(0), pad.t + ph);
  ctx.closePath();
  ctx.fillStyle = CSS.land;
  ctx.fill();

  // gross head between the two endpoints
  const a = good[0];
  const b = good[good.length - 1];
  const head = a.elevationM - b.elevationM;
  ctx.strokeStyle = CSS.mark;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(X(a.distanceKm), Y(a.elevationM));
  ctx.lineTo(X(b.distanceKm), Y(a.elevationM));
  ctx.lineTo(X(b.distanceKm), Y(b.elevationM));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = CSS.mark;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`gross head ${head.toFixed(0)} m`, X(b.distanceKm) - 6, Y((a.elevationM + b.elevationM) / 2));

  ctx.fillStyle = CSS.dim;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`distance along reach — ${dMax.toFixed(2)} km`, pad.l + pw / 2, pad.t + ph + 8);
  ctx.save();
  ctx.translate(12, pad.t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('elevation m', 0, 0);
  ctx.restore();
}

/** Twelve-bar monthly mean, used for both flow seasonality and rainfall. */
export function drawMonthly(
  canvas: HTMLCanvasElement,
  values: readonly number[],
  unit: string,
  colour = CSS.curve
): void {
  const s = prep(canvas);
  if (!s) return;
  const { ctx, w, h } = s;
  const pad = { l: 46, r: 10, t: 10, b: 26 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    ctx.fillStyle = CSS.dim;
    ctx.textAlign = 'center';
    ctx.fillText('no data', w / 2, h / 2);
    return;
  }
  const max = Math.max(...finite, 1e-9);
  const bw = pw / 12;
  const names = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

  ctx.strokeStyle = CSS.grid;
  ctx.fillStyle = CSS.dim;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 2; i++) {
    const v = (max * i) / 2;
    const y = Math.round(pad.t + ph - (v / max) * ph) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(fmt(v), pad.l - 6, y);
  }
  // Colour by magnitude so the dry season is obvious at a glance — on a monsoon
  // river that contrast IS the story.
  const lo = Math.min(...finite);
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const bh = (v / max) * ph;
    const t = max > lo ? (v - lo) / (max - lo) : 1;
    const x = pad.l + i * bw + bw * 0.15;
    const y = pad.t + ph - bh;
    const g = ctx.createLinearGradient(0, y, 0, pad.t + ph);
    g.addColorStop(0, colour);
    g.addColorStop(1, t < 0.25 ? 'rgba(255,180,84,0.55)' : 'rgba(77,184,255,0.18)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, bw * 0.7, bh);
    // Cap the driest month in amber so it reads as the constraint it is.
    ctx.fillStyle = t < 0.05 ? CSS.mark : colour;
    ctx.fillRect(x, y, bw * 0.7, Math.min(2.5, bh));
  });
  ctx.fillStyle = CSS.dim;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  names.forEach((n, i) => ctx.fillText(n, pad.l + i * bw + bw / 2, pad.t + ph + 4));
  ctx.textAlign = 'left';
  ctx.fillText(unit, pad.l, pad.t - 2);
}
