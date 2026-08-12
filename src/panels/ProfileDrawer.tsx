import { useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store.ts';
import { fmt, Tag } from '../ui/primitives.tsx';
import type { ProfilePoint } from '../types.ts';

const SEG_COLOR = { canal: '#3fb950', tunnel: '#bc8cff', penstock: '#f85149' } as const;
const MIN_COVER_M = 30;

/**
 * The signature engineering view: chainage vs elevation with ground, invert,
 * HGL and tunnel cover in one picture. Bespoke SVG on purpose (plan.md §6.3) —
 * chart libraries can't draw this honestly.
 */
export function ProfileDrawer() {
  const scheme = useStore((s) => s.selectedScheme());
  const selectScheme = useStore((s) => s.selectScheme);
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 800, h: 240 });

  const pts = scheme?.profile ?? [];

  const geom = useMemo(() => {
    if (pts.length === 0) return null;
    const m = { l: 48, r: 14, t: 12, b: 26 };
    const w = size.w;
    const h = size.h;
    const chMax = pts[pts.length - 1].ch;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (const p of pts) {
      zMin = Math.min(zMin, p.invert, p.ground);
      zMax = Math.max(zMax, p.ground, p.hgl);
    }
    const pad = (zMax - zMin) * 0.08;
    zMin -= pad;
    zMax += pad;
    const x = (ch: number) => m.l + ((w - m.l - m.r) * ch) / chMax;
    const y = (z: number) => m.t + ((h - m.t - m.b) * (zMax - z)) / (zMax - zMin);
    return { m, w, h, chMax, zMin, zMax, x, y };
  }, [pts, size]);

  if (!scheme || !geom) return null;

  const { x, y, m, w, h, chMax, zMin, zMax } = geom;

  const path = (get: (p: ProfilePoint) => number) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ch).toFixed(1)},${y(get(p)).toFixed(1)}`).join('');

  const groundArea = `${path((p) => p.ground)}L${x(chMax).toFixed(1)},${y(zMin).toFixed(1)}L${x(0).toFixed(1)},${y(zMin).toFixed(1)}Z`;

  // Invert as per-segment strokes so colors switch at the forebay.
  const segments: { seg: ProfilePoint['seg']; d: string }[] = [];
  let cur: { seg: ProfilePoint['seg']; d: string } | null = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const cmd: string = `${cur && cur.seg === p.seg ? 'L' : 'M'}${x(p.ch).toFixed(1)},${y(p.invert).toFixed(1)}`;
    if (cur && cur.seg === p.seg) cur.d += cmd;
    else {
      if (cur) {
        // Bridge the joint so the line is continuous.
        cur.d += `L${x(p.ch).toFixed(1)},${y(p.invert).toFixed(1)}`;
        segments.push(cur);
      }
      cur = { seg: p.seg, d: cmd };
    }
  }
  if (cur) segments.push(cur);

  const tunnelPts = pts.filter((p) => p.seg === 'tunnel');
  const minCover =
    tunnelPts.length > 0 ? Math.min(...tunnelPts.map((p) => p.ground - p.invert)) : null;
  const warnings = tunnelPts.filter((p) => p.ground - p.invert < MIN_COVER_M);

  const staticHead = pts[0].invert - pts[pts.length - 1].invert;
  const hp = hover !== null ? pts[hover] : null;

  const zTicks = niceTicks(zMin, zMax, 5);
  const chTicks = niceTicks(0, chMax, 6);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const ch = ((px - m.l) / (w - m.l - m.r)) * chMax;
    if (ch < 0 || ch > chMax) return setHover(null);
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i].ch - ch);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    setHover(best);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden border-t border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-3.5 py-1.5">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
          Longitudinal profile
        </h3>
        <span className="text-[12px] text-ink">{scheme.id} · {scheme.familyLabel}</span>
        <Tag tone="amber">sample geometry</Tag>
        <div className="ml-auto flex items-center gap-3 text-[10.5px] text-faint">
          <span>
            L <span className="num text-muted">{fmt((scheme.waterwayM.value + scheme.penstockM.value) / 1000, 1)} km</span>
          </span>
          <span>
            static head <span className="num text-muted">{fmt(staticHead, 0)} m</span>
          </span>
          {minCover !== null && (
            <span>
              min cover{' '}
              <span className={`num ${minCover < MIN_COVER_M ? 'text-red' : 'text-muted'}`}>
                {fmt(minCover, 0)} m
              </span>
            </span>
          )}
          <button
            type="button"
            onClick={() => selectScheme(null)}
            className="rounded border border-line px-1.5 py-0.5 text-muted hover:border-line-strong hover:text-ink"
            title="Close profile"
          >
            ✕
          </button>
        </div>
      </header>
      <div
        ref={(el) => {
          wrap.current = el;
          if (!el) return;
          const ro = new ResizeObserver(() => {
            const r = el.getBoundingClientRect();
            setSize((s) =>
              Math.abs(s.w - r.width) > 1 || Math.abs(s.h - r.height) > 1
                ? { w: r.width, h: r.height }
                : s
            );
          });
          ro.observe(el);
          return () => ro.disconnect(); // React 19 ref cleanup
        }}
        className="min-h-0 flex-1"
      >
        <svg
          width={w}
          height={h}
          className="block"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* grid + axes */}
          {zTicks.map((z) => (
            <g key={`z${z}`}>
              <line x1={m.l} x2={w - m.r} y1={y(z)} y2={y(z)} stroke="#1e2a38" strokeDasharray="3 4" />
              <text x={m.l - 6} y={y(z) + 3} textAnchor="end" fontSize={9.5} fill="#64788c" className="num">
                {fmt(z, 0)}
              </text>
            </g>
          ))}
          {chTicks.map((c) => (
            <text key={`c${c}`} x={x(c)} y={h - 8} textAnchor="middle" fontSize={9.5} fill="#64788c" className="num">
              {c >= 1000 ? `${fmt(c / 1000, 1)} km` : `${fmt(c, 0)} m`}
            </text>
          ))}
          <text x={m.l - 34} y={m.t + 8} fontSize={9} fill="#64788c" transform={`rotate(-90 ${m.l - 34} ${m.t + 8})`} textAnchor="end">
            elev, m
          </text>

          {/* ground */}
          <path d={groundArea} fill="#151d26" stroke="none" />
          <path d={path((p) => p.ground)} fill="none" stroke="#2c3d52" strokeWidth={1.4} />

          {/* HGL */}
          <path d={path((p) => p.hgl)} fill="none" stroke="#4db8ff" strokeWidth={1.3} strokeDasharray="5 4" />

          {/* invert per segment */}
          {segments.map((s, i) => (
            <path
              key={i}
              d={s.d}
              fill="none"
              stroke={SEG_COLOR[s.seg]}
              strokeWidth={2.2}
              strokeDasharray={s.seg === 'tunnel' ? '7 4' : undefined}
              strokeLinecap="round"
            />
          ))}

          {/* low-cover warnings */}
          {warnings.map((p, i) => (
            <g key={i} transform={`translate(${x(p.ch)},${y(p.ground) - 8})`}>
              <path d="M0,-5 L5,4 L-5,4 Z" fill="#d29922" />
              <text y={2.6} textAnchor="middle" fontSize={7} fill="#0b0f14" fontWeight={700}>
                !
              </text>
            </g>
          ))}

          {/* endpoint labels */}
          <ProfileLabel x={x(0)} y={y(pts[0].invert) - 8} text="intake" anchor="start" />
          <ProfileLabel x={x(chMax)} y={y(pts[pts.length - 1].invert) - 8} text="powerhouse" anchor="end" />

          {/* hover crosshair */}
          {hp && (
            <g>
              <line x1={x(hp.ch)} x2={x(hp.ch)} y1={m.t} y2={h - m.b} stroke="#e6edf3" strokeOpacity={0.35} />
              <circle cx={x(hp.ch)} cy={y(hp.invert)} r={3} fill={SEG_COLOR[hp.seg]} />
              <g transform={`translate(${Math.min(x(hp.ch) + 10, w - 168)},${m.t + 6})`}>
                <rect width={158} height={62} rx={6} fill="#1a2430" stroke="#2c3d52" />
                <text x={8} y={14} fontSize={9.5} fill="#8fa3b5">
                  ch <tspan className="num" fill="#e6edf3">{fmt(hp.ch / 1000, 2)} km</tspan> · {hp.seg}
                </text>
                <text x={8} y={27} fontSize={9.5} fill="#8fa3b5">
                  ground <tspan className="num" fill="#e6edf3">{fmt(hp.ground, 0)} m</tspan>
                </text>
                <text x={8} y={40} fontSize={9.5} fill="#8fa3b5">
                  invert <tspan className="num" fill="#e6edf3">{fmt(hp.invert, 0)} m</tspan>
                  {hp.seg === 'tunnel' && (
                    <tspan fill="#8fa3b5"> · cover <tspan className="num" fill={hp.ground - hp.invert < MIN_COVER_M ? '#f85149' : '#e6edf3'}>{fmt(hp.ground - hp.invert, 0)} m</tspan></tspan>
                  )}
                </text>
                <text x={8} y={53} fontSize={9.5} fill="#8fa3b5">
                  HGL <tspan className="num" fill="#4db8ff">{fmt(hp.hgl, 0)} m</tspan>
                </text>
              </g>
            </g>
          )}

          {/* legend */}
          <g transform={`translate(${m.l + 8},${m.t + 4})`} fontSize={9}>
            <LegendSwatch x={0} color="#2c3d52" label="ground" />
            <LegendSwatch x={62} color="#3fb950" label="canal" />
            <LegendSwatch x={116} color="#bc8cff" label="tunnel" dashed />
            <LegendSwatch x={172} color="#f85149" label="penstock" />
            <LegendSwatch x={242} color="#4db8ff" label="HGL (design)" dashed />
          </g>
        </svg>
      </div>
    </div>
  );
}

function ProfileLabel({ x, y, text, anchor }: { x: number; y: number; text: string; anchor: 'start' | 'end' }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={9.5} fill="#8fa3b5" fontWeight={600}>
      {text}
    </text>
  );
}

function LegendSwatch({ x, color, label, dashed }: { x: number; color: string; label: string; dashed?: boolean }) {
  return (
    <g transform={`translate(${x},0)`}>
      <line x1={0} x2={14} y1={0} y2={0} stroke={color} strokeWidth={2.2} strokeDasharray={dashed ? '5 3' : undefined} />
      <text x={18} y={3} fill="#64788c">
        {label}
      </text>
    </g>
  );
}

function niceTicks(min: number, max: number, n: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [];
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= step0) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}
