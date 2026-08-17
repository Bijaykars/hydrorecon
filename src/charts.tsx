/**
 * Hand-drawn SVG. A chart library would be ~190 KB gzipped for two figures that
 * are a polyline each, and neither is a standard chart type: the FDC has a
 * probability axis, and the long profile has to draw the diverted reach and its
 * head bracket to scale on top of the river bed.
 */
import type { FdcPoint } from './engine/hydro.ts';
import type { StudyPoint } from './App.tsx';

const INK = '#e9eaec';
const MUTED = '#9aa1a9';
const FAINT = '#6d747c';
const LINE = '#24272c';
const RIVER = '#4fc1d8';
const GREEN = '#63b981';
const AMBER = '#d2a04a';
const MONO = "'Geist Mono', ui-monospace, monospace";

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
  height = 106,
}: {
  fdc: FdcPoint[];
  designCms: number;
  residualCms: number;
  height?: number;
}) {
  if (fdc.length === 0) return null;
  // A wide, shallow viewport keeps the curve readable inside the desktop
  // workbench without letting one chart consume most of the screen.
  const W = 480;
  const H = height;
  const m = { l: 34, r: 8, t: 6, b: 17 };

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
          <text x={m.l - 5} y={y(v) + 3} textAnchor="end" fontSize="9" fontFamily={MONO} fill={FAINT}>
            {fmtAxis(v)}
          </text>
        </g>
      ))}
      {[0, 0.5, 1].map((p) => (
        <text key={p} x={x(p)} y={H - 5} textAnchor="middle" fontSize="9" fontFamily={MONO} fill={FAINT}>
          {p * 100}%
        </text>
      ))}

      <path d={d} fill="none" stroke={RIVER} strokeWidth="2" />

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
      <text x={W - m.r} y={y(designCms) - 3} textAnchor="end" fontSize="8.5" fill={GREEN}>
        Q design
      </text>
    </svg>
  );
}


/**
 * Long profile of the river, with the selected scheme drawn on it.
 *
 * This is the view that makes a scheme understandable rather than numerical:
 * you see the whole studied reach, which part of it the intake and powerhouse
 * enclose, and how much of the river's total drop that segment captures.
 */
export function RiverProfile({
  path,
  i,
  j,
  height = 148,
}: {
  path: StudyPoint[];
  i: number;
  j: number;
  height?: number;
}) {
  const valid = path.filter((p) => Number.isFinite(p.elevationM));
  if (valid.length < 2) return null;

  const W = 640;
  const H = height;
  const m = { l: 40, r: 54, t: 14, b: 20 };

  const kmMax = path[path.length - 1].km || 1;
  const zs = valid.map((p) => p.elevationM);
  let zMin = Math.min(...zs);
  let zMax = Math.max(...zs);
  const pad = Math.max(2, (zMax - zMin) * 0.12);
  zMin -= pad;
  zMax += pad;

  const x = (km: number) => m.l + ((W - m.l - m.r) * km) / kmMax;
  const y = (z: number) => m.t + ((H - m.t - m.b) * (zMax - z)) / (zMax - zMin);

  const line = (pts: StudyPoint[]) =>
    pts
      .filter((p) => Number.isFinite(p.elevationM))
      .map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.km).toFixed(1)},${y(p.elevationM).toFixed(1)}`)
      .join('');

  const bed = line(path);
  const area = `${bed}L${x(kmMax).toFixed(1)},${y(zMin).toFixed(1)}L${x(0).toFixed(1)},${y(zMin).toFixed(1)}Z`;

  const a = path[i];
  const b = path[j];
  const ok = a && b && Number.isFinite(a.elevationM) && Number.isFinite(b.elevationM);
  const gross = ok ? a.elevationM - b.elevationM : 0;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="River long profile">
      {niceTicks(zMin, zMax, 4).map((z) => (
        <g key={z}>
          <line x1={m.l} x2={W - m.r} y1={y(z)} y2={y(z)} stroke={LINE} strokeDasharray="3 4" />
          <text x={m.l - 5} y={y(z) + 3} textAnchor="end" fontSize="9.5" fontFamily={MONO} fill={FAINT}>
            {Math.round(z)}
          </text>
        </g>
      ))}
      {niceTicks(0, kmMax, 4).map((km) => (
        <text key={km} x={x(km)} y={H - 5} textAnchor="middle" fontSize="9.5" fontFamily={MONO} fill={FAINT}>
          {km.toFixed(km < 10 ? 1 : 0)} km
        </text>
      ))}

      <path d={area} fill="#17191d" />
      <path d={bed} fill="none" stroke="#4a5560" strokeWidth="1.4" />

      {ok && (
        <>
          {/* the reach the scheme diverts */}
          <path d={line(path.slice(i, j + 1))} fill="none" stroke={AMBER} strokeWidth="2.6" />
          <line
            x1={x(b.km) + 12}
            x2={x(b.km) + 12}
            y1={y(a.elevationM)}
            y2={y(b.elevationM)}
            stroke={RIVER}
            strokeWidth="1.2"
          />
          <line
            x1={x(a.km)}
            x2={x(b.km) + 12}
            y1={y(a.elevationM)}
            y2={y(a.elevationM)}
            stroke={RIVER}
            strokeWidth="0.8"
            strokeDasharray="3 3"
            opacity="0.55"
          />
          <text
            x={x(b.km) + 17}
            y={(y(a.elevationM) + y(b.elevationM)) / 2}
            fontSize="10.5"
            fontFamily={MONO}
            fill={RIVER}
            fontWeight="600"
          >
            {Math.round(gross)} m
          </text>
          <text
            x={x(b.km) + 17}
            y={(y(a.elevationM) + y(b.elevationM)) / 2 + 11}
            fontSize="8.5"
            fill={MUTED}
          >
            gross
          </text>
          <circle cx={x(a.km)} cy={y(a.elevationM)} r="3.6" fill={RIVER} />
          <circle cx={x(b.km)} cy={y(b.elevationM)} r="3.6" fill={GREEN} />
          <text x={x(a.km)} y={y(a.elevationM) - 7} fontSize="9" fill={INK} textAnchor="middle">
            intake
          </text>
          <text x={x(b.km)} y={y(b.elevationM) + 14} fontSize="9" fill={INK} textAnchor="middle">
            powerhouse
          </text>
        </>
      )}
    </svg>
  );
}
