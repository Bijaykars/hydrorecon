import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Quality, Traced } from '../types.ts';

export const QUALITY_COLOR: Record<Quality, string> = {
  measured: 'var(--color-green)',
  modelled: 'var(--color-blue)',
  estimated: 'var(--color-amber)',
  assumed: 'var(--color-faint)',
  overridden: 'var(--color-purple)',
  sample: 'var(--color-amber)',
};

export function QualityDot({ q }: { q: Quality }) {
  return (
    <span
      className="inline-block size-[7px] rounded-full"
      style={{ background: QUALITY_COLOR[q] }}
      title={q}
    />
  );
}

export function QualityChip({ q }: { q: Quality }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] uppercase tracking-wide"
      style={{ color: QUALITY_COLOR[q], background: `color-mix(in srgb, ${QUALITY_COLOR[q]} 12%, transparent)` }}
    >
      <QualityDot q={q} />
      {q}
    </span>
  );
}

export function fmt(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/**
 * A number that tells you its story. Click → provenance card: method, source,
 * quality, note. This is the UI face of Traced<T> (plan.md §2.3).
 */
export function TracedValue({
  t,
  digits = 1,
  size = 'md',
}: {
  t: Traced<number>;
  digits?: number;
  size?: 'md' | 'lg';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex items-baseline gap-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`num cursor-pointer border-b border-dotted border-line-strong hover:border-river hover:text-river ${
          size === 'lg' ? 'text-[17px] font-semibold' : ''
        }`}
        title="Where does this number come from?"
      >
        {fmt(t.value, digits)}
        {t.unit ? <span className="ml-0.5 text-[0.82em] text-muted">{t.unit}</span> : null}
      </button>
      <QualityDot q={t.quality} />
      {open && (
        <span className="absolute left-0 top-[calc(100%+6px)] z-50 block w-64 rounded-lg border border-line-strong bg-panel-3 p-2.5 shadow-[0_14px_40px_rgba(0,0,0,0.55)]">
          <span className="mb-1.5 flex items-center justify-between gap-2">
            <QualityChip q={t.quality} />
            <span className="num text-[12px] font-semibold">
              {fmt(t.value, Math.max(digits, 2))} {t.unit ?? ''}
            </span>
          </span>
          <span className="block text-[11.5px] leading-snug text-ink">{t.method}</span>
          {t.source && (
            <span className="mt-1 block text-[10.5px] text-muted">Source: {t.source}</span>
          )}
          {t.note && <span className="mt-1 block text-[10.5px] text-muted">{t.note}</span>}
        </span>
      )}
    </span>
  );
}

export function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-line px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
          {title}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] text-faint">{label}</div>
      <div className="mt-0.5 text-[13px]">{children}</div>
    </div>
  );
}

export function Tag({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'amber' | 'river' | 'red' }) {
  const color =
    tone === 'amber'
      ? 'var(--color-amber)'
      : tone === 'river'
        ? 'var(--color-river)'
        : tone === 'red'
          ? 'var(--color-red)'
          : 'var(--color-muted)';
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {children}
    </span>
  );
}

/** The disclaimer the vision doc wants next to the numbers, not in a footer. */
export function ScreeningNotice() {
  return (
    <div className="border-l-2 border-amber bg-[color-mix(in_srgb,var(--color-amber)_7%,transparent)] px-3 py-2 text-[11px] leading-snug text-muted">
      <span className="font-semibold text-amber">Prefeasibility screening.</span> These numbers
      compare options — they are not a feasibility study and not a basis for investment.
    </div>
  );
}

export function SampleBanner({ children }: { children?: ReactNode }) {
  return (
    <div className="border-l-2 border-amber bg-[color-mix(in_srgb,var(--color-amber)_7%,transparent)] px-3 py-2 text-[11px] leading-snug text-muted">
      <span className="font-semibold text-amber">Sample data.</span>{' '}
      {children ??
        'Computed with the validated physics kernel from a synthetic flow series scaled to this reach. The real hydrology and discovery engines land in M1–M2.'}
    </div>
  );
}
