/**
 * Hand-drawn SVG. A chart library would be ~190 KB gzipped for two figures that
 * are a polyline each, and neither is a standard chart type: the FDC has an
 * inverted probability axis, the profile needs the head bracket drawn to scale.
 */
import type { FdcPoint } from './engine/hydro.ts';
import type { ProfilePoint } from './api.ts';

const INK = '#e6edf3';
const MUTED = '#8fa3b5';
const FAINT = '#5f7183';
const LINE = '#1e2a38';
const RIVER = '#4db8ff';
const GREEN = '#3fb950';
const AMBER = '#d29922';

function niceTicks(min: number, max: number, n: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [];
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(v);
  return out;
}

/**
 * Flow-duration curve. Log y, because a monsoon river spans three orders of
 * magnitude and a linear axis would flatten the entire dry season into the axis.
 */
export function Fdc({
  fdc,
  designCms,
  residualCms,
  height = 132,
}: {
  fdc: FdcPoint[];
  designCms: number;
  residualCms: number;
  height?: number;
}) {
  if (fdc.length === 0) return null;
  const W = 320;
  const H = height;
  const m = { l: 34, r: 8, t: 8, b: 18 };

  const positive = fdc.filter((p) => p.q > 0);
  const hi = positive.length ? positive[0].q : 1;
  const lo = positive.length ? positive[positive.length - 1].q : 0.01;
  const yMax = 10 ** Math.ceil(Math.log10(hi));
  const yMin = Math.max(10 ** Math.floor(Math.log10(Math.max(lo, hi / 1e4))), hi / 1e4);

  const x = (p: number) => m.l + (W - m.l - m.r) * p;
  const y = (q: number) => {
    const c = Math.min(yMax, Math.max(yMin, q));
    return m.t + (H - m.t - m.b) * (1 - Math.log10(c / yMin) / Math.log10(yMax / yMin));
  };

  // ~150 points is plenty for the shape; 7,300 would just cost pixels.
  const step = Math.max(1, Math.floor(fdc.length / 150));
  const d = fdc
    .filter((_, i) => i % step === 0)
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.p).toFixed(1)},${y(p.q).toFixed(1)}`)
    .join('');

  const decades: number[] = [];
  for (let v = yMin; v <= yMax + 1e-9; v *= 10) decades.push(v);

  const fmtAxis = (v: number) => (v >= 1 ? String(Math.round(v)) : v.toFixed(v >= 0.1 ? 1 : 2));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Flow-duration curve">
      {decades.map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={LINE} strokeDasharray="3 4" />
          <text x={m.l - 5} y={y(v) + 3} textAnchor="end" fontSize="8.5" fill={FAINT}>
            {fmtAxis(v)}
          </text>
        </g>
      ))}
      {[0, 0.25, 0.5, 0.75, 1].map((p) => (
        <text key={p} x={x(p)} y={H - 5} textAnchor="middle" fontSize="8.5" fill={FAINT}>
          {p * 100}%
        </text>
      ))}

      <path d={d} fill="none" stroke={RIVER} strokeWidth="1.7" />

      {residualCms > 0 && residualCms >= yMin && (
        <line
          x1={m.l}
          x2={W - m.r}
          y1={y(residualCms)}
          y2={y(residualCms)}
          stroke={AMBER}
          strokeWidth="1"
          strokeDasharray="4 3"
        />
      )}
      {designCms > 0 && designCms >= yMin && (
        <line
          x1={m.l}
          x2={W - m.r}
          y1={y(designCms)}
          y2={y(designCms)}
          stroke={GREEN}
          strokeWidth="1"
          strokeDasharray="4 3"
        />
      )}
      <text x={W - m.r} y={y(designCms) - 3} textAnchor="end" fontSize="8" fill={GREEN}>
        design
      </text>
    </svg>
  );
}

/**
 * Ground profile from intake to powerhouse with the head drawn to scale.
 * The point of this figure is the shape of the drop — whether the head is a
 * genuine gorge or the DEM wandering over a flat reach.
 */
export function Profile({
  points,
  height = 150,
}: {
  points: ProfilePoint[];
  height?: number;
}) {
  const valid = points.filter((p) => Number.isFinite(p.elevationM));
  if (valid.length < 2) return null;

  const W = 640;
  const H = height;
  const m = { l: 42, r: 60, t: 14, b: 20 };

  const chMax = points[points.length - 1].distanceKm;
  const zs = valid.map((p) => p.elevationM);
  let zMin = Math.min(...zs);
  let zMax = Math.max(...zs);
  const pad = Math.max(2, (zMax - zMin) * 0.12);
  zMin -= pad;
  zMax += pad;

  const x = (km: number) => m.l + ((W - m.l - m.r) * km) / (chMax || 1);
  const y = (z: number) => m.t + ((H - m.t - m.b) * (zMax - z)) / (zMax - zMin);

  const d = valid
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.distanceKm).toFixed(1)},${y(p.elevationM).toFixed(1)}`)
    .join('');
  const area = `${d}L${x(valid[valid.length - 1].distanceKm).toFixed(1)},${y(zMin).toFixed(1)}L${x(valid[0].distanceKm).toFixed(1)},${y(zMin).toFixed(1)}Z`;

  const a = valid[0];
  const b = valid[valid.length - 1];
  const gross = a.elevationM - b.elevationM;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Terrain profile">
      {niceTicks(zMin, zMax, 4).map((z) => (
        <g key={z}>
          <line x1={m.l} x2={W - m.r} y1={y(z)} y2={y(z)} stroke={LINE} strokeDasharray="3 4" />
          <text x={m.l - 5} y={y(z) + 3} textAnchor="end" fontSize="9" fill={FAINT}>
            {Math.round(z)}
          </text>
        </g>
      ))}
      {niceTicks(0, chMax, 4).map((km) => (
        <text key={km} x={x(km)} y={H - 5} textAnchor="middle" fontSize="9" fill={FAINT}>
          {km >= 1 ? `${km.toFixed(km < 10 ? 1 : 0)} km` : `${Math.round(km * 1000)} m`}
        </text>
      ))}

      <path d={area} fill="#151d26" />
      <path d={d} fill="none" stroke="#3c556e" strokeWidth="1.5" />

      {/* head bracket, drawn to scale */}
      {gross > 0 && (
        <g>
          <line
            x1={x(b.distanceKm) + 14}
            x2={x(b.distanceKm) + 14}
            y1={y(a.elevationM)}
            y2={y(b.elevationM)}
            stroke={RIVER}
            strokeWidth="1.2"
          />
          <line
            x1={x(a.distanceKm)}
            x2={x(b.distanceKm) + 14}
            y1={y(a.elevationM)}
            y2={y(a.elevationM)}
            stroke={RIVER}
            strokeWidth="0.8"
            strokeDasharray="3 3"
            opacity="0.6"
          />
          <text
            x={x(b.distanceKm) + 19}
            y={(y(a.elevationM) + y(b.elevationM)) / 2}
            fontSize="10"
            fill={RIVER}
            fontWeight="600"
          >
            {Math.round(gross)} m
          </text>
          <text
            x={x(b.distanceKm) + 19}
            y={(y(a.elevationM) + y(b.elevationM)) / 2 + 11}
            fontSize="8"
            fill={MUTED}
          >
            gross
          </text>
        </g>
      )}

      <circle cx={x(a.distanceKm)} cy={y(a.elevationM)} r="3.5" fill={RIVER} />
      <circle cx={x(b.distanceKm)} cy={y(b.elevationM)} r="3.5" fill={GREEN} />
      <text x={x(a.distanceKm) + 6} y={y(a.elevationM) - 6} fontSize="9" fill={INK}>
        intake
      </text>
      <text x={x(b.distanceKm) - 6} y={y(b.elevationM) - 8} fontSize="9" fill={INK} textAnchor="end">
        powerhouse
      </text>
    </svg>
  );
}
