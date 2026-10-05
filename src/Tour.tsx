import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/*
 * First-run tour. One spotlight (a fixed div whose box-shadow dims everything
 * around it) and one tooltip, driven by the STEPS array below. Nothing here
 * intercepts a click: the overlay is pointer-events: none except the tooltip,
 * so the step that asks for a river click can actually receive one.
 */

export type TourStep = {
  id: string;
  title: string;
  body: string;
  /** Selector for the element to spotlight. Absent: centred modal. Missing from the DOM: step skipped. */
  target?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Point at the target without dimming the rest of the screen. */
  dim?: false;
  /** Window event that advances the step instead of a Next button. */
  advanceOn?: string;
  /** Selector that must exist before Next is offered — the study takes a few seconds after the click. */
  ready?: string;
  /**
   * Selector that means the wait ended without `ready` arriving — no layout fits, or the study
   * failed. The step swaps to `failedTitle`/`failedBody`, offers Next, and keeps watching: a
   * click on another river that does yield a scheme puts the normal copy back by itself.
   */
  failed?: string;
  failedTitle?: string;
  failedBody?: string;
  /** Skip the step when false — used where the thing it asks for has already happened. */
  when?: () => boolean;
};

/** Window events App dispatches; a step's `advanceOn` names one of them. */
export const TOUR_EVENTS = { site: 'hydrorecon:site' } as const;

const STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'HydroRecon',
    body: 'Run-of-river hydropower screening for Nepal. Every number it reports carries a measured error bar, and every source is named.',
  },
  {
    id: 'river',
    target: '[data-tour="map"]',
    placement: 'top',
    dim: false,
    advanceOn: TOUR_EVENTS.site,
    when: () => !document.querySelector('.reading-panel'),
    title: 'Click a river',
    body: 'Click any blue river line. That is the whole interaction — everything else follows from it.',
  },
  {
    id: 'scheme',
    target: '.reading-panel',
    placement: 'left',
    ready: '[data-tour="headline"]',
    failed: '[data-tour="no-scheme"]',
    title: 'The scheme',
    body: 'The app placed an intake and a powerhouse on the river, sized the waterway between them and selected a turbine.',
    failedTitle: 'No scheme fits here',
    failedBody: 'Big rivers in wide valleys often have no useful head drop within the layout limit — the panel says what it found. Click a steeper tributary, or raise the maximum layout length; the tour picks up again when a scheme is found.',
  },
  {
    id: 'numbers',
    target: '[data-tour="headline"]',
    placement: 'left',
    title: 'The numbers',
    body: 'Capacity and energy, each with its likely range underneath. Flow carries a 1.37× typical error, measured against 69 DHM gauges and 193 commissioned plants.',
  },
  {
    id: 'methods',
    target: '[data-tour="methods"]',
    placement: 'left',
    title: 'Four estimates of one river',
    body: 'Independent flow methods, side by side, through the same scheme. The spread between them is the uncertainty.',
  },
  {
    id: 'move',
    target: '[data-tour="intake"]',
    placement: 'right',
    // The intake marker sits at the click even when no layout was found; this step is about re-solving one.
    when: () => !!document.querySelector('[data-tour="headline"]'),
    title: 'Move the scheme',
    body: 'Drag the intake or the powerhouse to another position. The scheme re-solves where you drop it.',
  },
  {
    id: 'layers',
    target: '.map-layer-controls',
    placement: 'right',
    title: 'Map layers',
    body: 'Fourteen switchable layers: gauges, glacial lakes, hazard reports, licensed projects, geology, grid and protected areas.',
  },
  {
    id: 'export',
    target: '[data-tour="export"]',
    placement: 'left',
    title: 'Take it with you',
    body: 'A full desk-study report with figures, assumptions and sources, plus CSV and GeoJSON of every alternative.',
  },
];

const KEY = 'hydrorecon.tour.done';
const WIDE = '(min-width: 1024px)';

/** False on any storage failure, so a broken store shows the tour again rather than never. */
export function tourDone(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export const tourWide = () => window.matchMedia(WIDE).matches;

const GAP = 14;
const PAD = 8;
const MARGIN = 12;
/** A study takes 4–5 s measured; past this the step says so and offers Next rather than pulsing forever. */
const SLOW_MS = 30_000;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** What a step is waiting on. `failed` and `slow` both offer Next; only `wait` withholds it. */
type Status = 'ready' | 'wait' | 'slow' | 'failed';

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState<Status>('ready');
  const waitedSince = useRef<number | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const step = STEPS[index];

  const usable = (i: number) => {
    const s = STEPS[i];
    if (!s) return false;
    if (s.when && !s.when()) return false;
    return !s.target || !!document.querySelector(s.target);
  };
  // Walk past steps whose target is not on this layout rather than spotlight nothing.
  const go = (from: number, dir: 1 | -1) => {
    let i = from;
    while (i >= 0 && i < STEPS.length && !usable(i)) i += dir;
    if (i < 0) return;
    if (i >= STEPS.length) onClose(); else setIndex(i);
  };
  const next = () => go(index + 1, 1);
  const back = () => go(index - 1, -1);

  useEffect(() => { if (open) go(0, 1); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track the target: it scrolls inside a panel, and async sections above it shift it.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = step.target ? document.querySelector(step.target) : null;
      setRect(el ? el.getBoundingClientRect() : null);
      // A found scheme wins over a stale failure notice; the clock only runs while neither is on the page.
      const ready = !step.ready || !!document.querySelector(step.ready);
      const failed = !ready && !!step.failed && !!document.querySelector(step.failed);
      if (ready || failed) waitedSince.current = null; else waitedSince.current ??= Date.now();
      setStatus(ready ? 'ready' : failed ? 'failed' : Date.now() - (waitedSince.current ?? 0) > SLOW_MS ? 'slow' : 'wait');
    };
    if (step.target) document.querySelector(step.target)?.scrollIntoView({ block: 'center' });
    measure();
    const timer = window.setInterval(measure, 200);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.clearInterval(timer); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const media = window.matchMedia(WIDE);
    const narrow = () => { if (!media.matches) onClose(); };
    window.addEventListener('keydown', key);
    media.addEventListener('change', narrow);
    const advance = step.advanceOn;
    if (advance) window.addEventListener(advance, next);
    return () => { window.removeEventListener('keydown', key); media.removeEventListener('change', narrow); if (advance) window.removeEventListener(advance, next); };
  }, [open, step]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!open || !tip.current) return;
    const { offsetWidth: w, offsetHeight: h } = tip.current;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!rect) { setPos({ x: (vw - w) / 2, y: (vh - h) / 2 }); return; }
    const r = { top: rect.top - PAD, left: rect.left - PAD, right: rect.right + PAD, bottom: rect.bottom + PAD };
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const p = step.placement === 'left' ? { x: r.left - GAP - w, y: cy - h / 2 }
      : step.placement === 'right' ? { x: r.right + GAP, y: cy - h / 2 }
      : step.placement === 'top' ? { x: cx - w / 2, y: r.top - GAP - h }
      : { x: cx - w / 2, y: r.bottom + GAP };
    setPos({ x: clamp(p.x, MARGIN, vw - w - MARGIN), y: clamp(p.y, MARGIN, vh - h - MARGIN) });
  }, [open, rect, step]);

  useEffect(() => { if (open) tip.current?.focus(); }, [open, index]);

  if (!open) return null;
  const dim = step.dim !== false;
  const failed = status === 'failed';
  const slow = status === 'slow';
  const title = failed ? step.failedTitle ?? step.title : slow ? 'Still studying the river' : step.title;
  const body = failed ? step.failedBody ?? step.body
    : slow ? 'A study usually takes about five seconds; this one is taking longer. Give it a moment, click another river, or move on.'
    : step.body;
  // "Done" on the last step this layout actually has, not the last one in the list.
  const last = !STEPS.some((_, k) => k > index && usable(k));
  return (
    <div className="tour" aria-hidden={false}>
      {dim && (
        <div
          className="tour-spotlight"
          style={rect
            ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD }
            : { top: '50%', left: '50%', width: 0, height: 0, borderWidth: 0 }}
        />
      )}
      <div
        ref={tip}
        role="dialog"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        className="tour-tip"
        style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      >
        <span className="explorer-eyebrow">Tour · {index + 1} of {STEPS.length}</span>
        <strong id="tour-title">{title}</strong>
        <p id="tour-body">{body}</p>
        <div className="tour-actions">
          <button type="button" className="tour-skip" onClick={onClose}>Skip</button>
          {step.advanceOn || status === 'wait'
            ? <span className="tour-wait"><i /> {step.advanceOn ? 'Waiting for a river click' : 'Studying the river'}</span>
            : <span className="tour-nav">
                {index > 0 && <button type="button" onClick={back}>Back</button>}
                <button type="button" className="tour-next" onClick={next}>{last ? 'Done' : 'Next'}</button>
              </span>}
        </div>
      </div>
    </div>
  );
}
