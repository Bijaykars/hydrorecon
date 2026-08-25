/**
 * The validation page: HydroRecon against plants that exist.
 *
 * For an engineering tool, credibility IS the product, and credibility is not
 * claimed, it is shown — misses included, each with its reason, each row
 * re-runnable by clicking through to the app at the same coordinates. The
 * numbers come from src/data/validation.json, produced by
 * `npm run build:validation`, which drives the app's own modules in a real
 * browser. Nothing on this page can drift from the app without the pipeline
 * being re-run.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import validation from './data/validation.json' with { type: 'json' };
import spec from '../pipeline/plants.json' with { type: 'json' };
import type { FlowChoice } from './engine/flowchoice.ts';

/** Injected by vite.config.ts from the calculation modules on disk. */
declare const __ENGINE_SIGNATURE__: string;
const ENGINE_SIGNATURE = __ENGINE_SIGNATURE__;

type Row = {
  name: string;
  river: string;
  intake: [number, number];
  intakeSource: string;
  powerhouse: [number, number];
  powerhouseSource: string;
  actual: {
    capacityMW: number;
    designQ: number | null;
    head: number | null;
    headBasis: 'gross' | 'net' | null;
    energyGwh: number;
  };
  note: string;
  sources: string[];
  result: {
    ok: boolean;
    error?: string;
    predicted?: {
      capacityMW: number;
      energyGwh: number;
      grossHeadM: number;
      netHeadM: number;
      designFlowCms: number;
      meanFlowCms: number;
      waterwayKm: number;
      turbine: string | null;
      plantFactor: number;
    };
    snapKm?: { intake: number; powerhouse: number };
    reachKm2?: number;
    flow?: FlowChoice;
    snappedIntake?: [number, number];
  };
};

const DATA = validation as unknown as {
  _generated: string;
  /** Engine fingerprint at generation time. Absent in files built before it. */
  _engine?: string;
  plants: Row[];
};

/**
 * A placement that physics rejects: no catchment on Earth yields much more
 * than ~0.35 m³/s per km² as a long-term design flow, so a plant whose
 * published design flow implies more than that from the snapped reach was
 * snapped onto the wrong stream — the network does not resolve its river.
 * This flags the row as a placement failure; it never alters any number.
 */
const MAX_SPECIFIC_RUNOFF = 0.35;
const misplaced = (r: Row) =>
  Boolean(
    r.result.ok &&
      r.actual.designQ &&
      r.result.reachKm2 &&
      r.actual.designQ / r.result.reachKm2 > MAX_SPECIFIC_RUNOFF
  );

/**
 * The honest-miss class, from two data-borne facts. Either the mapped
 * network's own discharge failed and the app fell back to the flood model, or
 * the catchment drains the Tibetan plateau (a flag carried in plants.json as
 * geography, not tuning) — where the global models can agree with each other
 * and still be wrong together, because nothing local can check them. Mere
 * disagreement is NOT this class: an off-channel flood cell corrected by the
 * network is the app's ordinary, validated behaviour (Kali Gandaki A and both
 * Marsyangdis run that way).
 */
const TRANS = new Set(
  (spec as unknown as { plants: { name: string; transHimalayan?: boolean }[] }).plants
    .filter((p) => p.transHimalayan)
    .map((p) => p.name)
);
const flowBroken = (r: Row) =>
  Boolean(
    r.result.ok &&
      ((r.result.flow && r.result.flow.authority !== 'network') || TRANS.has(r.name))
  );

const n = (v: number, d = 1) =>
  !Number.isFinite(v)
    ? '—'
    : Math.abs(v) >= 1000
      ? Math.round(v).toLocaleString('en-US')
      : v.toLocaleString('en-US', { maximumFractionDigits: d });

const appLink = (r: Row) => {
  // The snapped point reproduces the run; the raw coordinate can land a click
  // on a nearer rivulet thread and study a different stream entirely.
  const [lat, lon] = r.result.snappedIntake ?? r.intake;
  return `./#at=${lat.toFixed(5)},${lon.toFixed(5)}&map=12.5/${lat.toFixed(4)}/${lon.toFixed(4)}`;
};

function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="8" fill="none" stroke="#4fc1d8" strokeWidth="1.6" />
      {[0, 120, 240].map((r) => (
        <path
          key={r}
          d="M9 3.2C10.4 5.4 10.4 7 9 9C7.6 7 7.6 5.4 9 3.2Z"
          fill="#4fc1d8"
          transform={`rotate(${r} 9 9)`}
        />
      ))}
    </svg>
  );
}

/** predicted / actual, as a bar the eye can compare across rows. */
function Ratio({ pred, act }: { pred: number; act: number }) {
  const ratio = act > 0 ? pred / act : NaN;
  const good = ratio >= 0.85 && ratio <= 1.18;
  const mid = ratio >= 0.5 && ratio <= 2;
  // log scale from ×1/8 to ×8, centred on 1.
  const t = Number.isFinite(ratio)
    ? Math.min(1, Math.max(0, (Math.log2(Math.max(0.125, Math.min(8, ratio))) + 3) / 6))
    : 0.5;
  return (
    <div className="mt-1">
      <div className="relative h-1 w-full rounded-full bg-line">
        <div className="absolute left-1/2 top-[-2.5px] h-2 w-px bg-faint" />
        <div
          className={`absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
            good ? 'bg-green' : mid ? 'bg-amber' : 'bg-red'
          }`}
          style={{ left: `${(t * 100).toFixed(1)}%` }}
        />
      </div>
      <div
        className={`num mt-0.5 text-[10.5px] ${good ? 'text-green' : mid ? 'text-amber' : 'text-red'}`}
      >
        ×{n(ratio, 2)}
      </div>
    </div>
  );
}

function Cell({
  label,
  pred,
  act,
  unit,
  basis,
}: {
  label: string;
  pred: number | null;
  act: number | null;
  unit: string;
  basis?: string | null;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.1em] text-faint">
        {label}
        {basis ? <span className="ml-1 lowercase tracking-normal">({basis})</span> : null}
      </div>
      <div className="num mt-0.5 text-[13px] leading-tight text-ink">
        {pred === null ? '—' : n(pred, pred < 10 ? 1 : 0)}
        <span className="mx-1 text-faint">/</span>
        <span className="text-muted">{act === null ? 'n/p' : n(act, act < 10 ? 1 : 0)}</span>
        <span className="ml-1 font-sans text-[9.5px] tracking-normal text-faint">{unit}</span>
      </div>
      {pred !== null && act !== null && act > 0 && <Ratio pred={pred} act={act} />}
    </div>
  );
}

function PlantCard({ r }: { r: Row }) {
  const p = r.result.predicted;
  const failed = !r.result.ok || misplaced(r);
  const broken = !failed && flowBroken(r);
  return (
    <article
      className={`rounded-xl border p-4 ${
        failed
          ? 'border-line bg-panel'
          : broken
            ? 'border-[color-mix(in_srgb,var(--color-amber)_35%,var(--color-line))] bg-panel'
            : 'border-line bg-panel'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 className="text-[15px] font-semibold tracking-tight text-ink">{r.name}</h3>
        <span className="text-[11px] text-faint">{r.river}</span>
        <span className="num text-[11px] text-muted">{n(r.actual.capacityMW, 1)} MW built</span>
        <a
          href={appLink(r)}
          className="ml-auto rounded text-[11px] text-river underline-offset-2 hover:underline"
        >
          re-run it in HydroRecon →
        </a>
      </div>

      {!r.result.ok ? (
        <p className="mt-2 text-[12px] leading-relaxed text-amber">
          <b>Could not run:</b> {r.result.error}
        </p>
      ) : misplaced(r) ? (
        <p className="mt-2 text-[12px] leading-relaxed text-amber">
          <b>Placement failed, and the numbers below are not a prediction.</b> The intake snapped
          to a {n(r.result.reachKm2!, 0)} km² reach, but the plant&apos;s published{' '}
          {n(r.actual.designQ!, 1)} m³/s cannot come from {n(r.result.reachKm2!, 0)} km² — the
          mapped river network does not resolve this stream. HydroRecon on this khola needs a hand-placed
          intake and a gauge record.
        </p>
      ) : null}

      {p && (
        <div className={`mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 ${misplaced(r) ? 'opacity-45' : ''}`}>
          <Cell label="capacity" pred={p.capacityMW} act={r.actual.capacityMW} unit="MW" />
          <Cell
            label="head"
            pred={r.actual.headBasis === 'net' ? p.grossHeadM : r.actual.head !== null ? p.grossHeadM : null}
            act={r.actual.head}
            unit="m"
            basis={r.actual.headBasis === 'net' ? 'HydroRecon gross vs plant net' : r.actual.headBasis}
          />
          <Cell label="design flow" pred={p.designFlowCms} act={r.actual.designQ} unit="m³/s" />
          <Cell label="energy" pred={p.energyGwh} act={r.actual.energyGwh} unit="GWh/yr" />
        </div>
      )}

      {r.result.ok && (
        <div className="mt-3 space-y-1 border-t border-line pt-2.5 text-[10.5px] leading-relaxed text-faint">
          {TRANS.has(r.name) && !misplaced(r) && (
            <div className="text-amber">
              <b>Trans-Himalayan catchment.</b> Most of this river&apos;s water comes from north of
              the border, where the global flow products can agree with each other and still be
              wrong together — and a WECS/DHM regression fitted to Nepali catchments is outside
              its intended evidence base there.
            </div>
          )}
          {r.result.flow && r.result.flow.disagreement > 3 && (
            <div className={misplaced(r) ? '' : r.result.flow.authority === 'model' ? 'text-amber' : ''}>
              <b>Flow sources disagreed {n(r.result.flow.disagreement, 0)}× here.</b>{' '}
              {r.result.flow.authority === 'network' ? (
                <>
                  The flood model&apos;s ~5 km cell is not on this channel; the mapped network
                  carried the magnitude instead. That is the app&apos;s standard correction, and
                  this row is what it looks like when it works.
                </>
              ) : (
                <>
                  {r.result.flow.note}. The app shows this warning on screen and widens its band —
                  this is the class of site where it tells you only a gauge record will do.
                </>
              )}
            </div>
          )}
          <div>{r.note}</div>
          <div>
            intake {r.intakeSource} · powerhouse {r.powerhouseSource} · snapped{' '}
            {n(r.result.snapKm!.intake, 1)} / {n(r.result.snapKm!.powerhouse, 1)} km onto the
            traced river
            {p?.turbine ? (
              <>
                {' '}
                · HydroRecon picked a <b className="text-muted">{p.turbine}</b>
              </>
            ) : null}
          </div>
          <div>
            sources:{' '}
            {r.sources.map((s, i) => (
              <a
                key={s}
                href={s}
                className="text-river underline-offset-2 hover:underline"
                rel="noopener"
              >
                [{i + 1}]
              </a>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function Page() {
  const rows = DATA.plants;
  const clean = rows.filter((r) => r.result.ok && !misplaced(r) && !flowBroken(r));
  const warned = rows.filter((r) => r.result.ok && !misplaced(r) && flowBroken(r));
  const failed = rows.filter((r) => !r.result.ok || misplaced(r));

  const capRatios = clean
    .map((r) => r.result.predicted!.capacityMW / r.actual.capacityMW)
    .sort((a, b) => a - b);
  const within = (lo: number, hi: number) =>
    capRatios.filter((x) => x >= lo && x <= hi).length;

  return (
    <div className="min-h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-[880px] px-5 pb-16 pt-8">
        <header className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight">HydroRecon</span>
          <span className="text-[12px] text-muted">validation</span>
          <a href="./" className="ml-auto rounded text-[12px] text-river underline-offset-2 hover:underline">
            ← open the app
          </a>
        </header>

        <h1 className="mt-7 text-[26px] font-semibold leading-tight tracking-tight text-ink [text-wrap:balance]">
          Ten plants that exist, and what this tool would have said about them.
        </h1>
        <p className="mt-3 max-w-[62ch] text-[13.5px] leading-relaxed text-muted">
          Each plant below was run through HydroRecon&apos;s own engine — same code, same public data,
          shipped defaults, no per-plant tuning — by clicking where its builders actually put the
          intake and powerhouse. Coordinates come from OpenStreetMap, GeoNames and published
          records, each named per plant. The misses are shown with the same prominence as the
          hits, because a screening tool you can trust is one that knows where it breaks.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <div className="rounded-xl bg-panel p-4">
            <div className="num text-[26px] font-medium text-green">
              {within(0.85, 1.18)}<span className="text-[15px] text-muted">/{clean.length}</span>
            </div>
            <div className="mt-1 text-[11.5px] leading-snug text-muted">
              plants within ±15% on capacity, where the flow data holds
            </div>
          </div>
          <div className="rounded-xl bg-panel p-4">
            <div className="num text-[26px] font-medium text-amber">{warned.length + failed.length}</div>
            <div className="mt-1 text-[11.5px] leading-snug text-muted">
              sites where global flow data breaks — and the app warns you on screen that it has
            </div>
          </div>
          <div className="rounded-xl bg-panel p-4">
            <div className="num text-[26px] font-medium text-ink">0</div>
            <div className="mt-1 text-[11.5px] leading-snug text-muted">
              numbers tuned, coordinates nudged, or misses hidden to make this page look better
            </div>
          </div>
        </div>

        <h2 className="mt-9 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
          Where the mapped data holds
        </h2>
        <div className="mt-3 space-y-2.5">
          {clean.map((r) => (
            <PlantCard key={r.name} r={r} />
          ))}
        </div>

        <h2 className="mt-9 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
          Where the global flow data breaks — and what the app does about it
        </h2>
        <p className="mt-2 max-w-[62ch] text-[12px] leading-relaxed text-muted">
          Rivers draining the arid Tibetan plateau defeat the flow sources this app can reach —
          sometimes loudly, with the two global products a factor of eight apart, sometimes
          quietly, with them agreeing with each other and still running three times low together,
          as at Upper Tamakoshi. Loud disagreements are compared with the legacy WECS/DHM regional
          regression, now completed with monsoon rainfall where the catchment layer covers — the upgrade that
          moved Chilime from a ×6.9 miss into the clean set above. The quiet kind no regression
          fitted to Nepali catchments can fix, because the water comes from outside them. There
          the band goes wide and the advice on screen is the one these plants&apos; own
          feasibility studies followed: gauge the river.
        </p>
        <div className="mt-3 space-y-2.5">
          {warned.map((r) => (
            <PlantCard key={r.name} r={r} />
          ))}
          {failed.map((r) => (
            <PlantCard key={r.name} r={r} />
          ))}
        </div>

        <h2 className="mt-9 text-[13px] font-semibold uppercase tracking-[0.12em] text-faint">
          What this proves, and what it does not
        </h2>
        <div className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-muted">
          <p>
            <b className="text-ink">It proves the physics and terrain chain.</b> Where the flow
            data is sane, capacity lands within ~15% of the built plant, and DEM-derived head
            tracks published head — on schemes from 50 to 144 MW designed by international
            consultants with survey crews and gauge records.
          </p>
          <p>
            <b className="text-ink">Pondage is outside the model, visibly.</b> Marsyangdi,
            Chameliya and Kali Gandaki A pond their rivers behind real dams; HydroRecon models a low
            weir and reads the riverbed, so it under-reads exactly there — by roughly the dam
            height. The waterway lengths differ too: HydroRecon follows the river; tunnels cut
            corners.
          </p>
          <p>
            <b className="text-ink">It does not prove HydroRecon replaces a feasibility study.</b>{' '}
            Every one of these plants was built on years of site gauging. The claim is narrower
            and more useful: at the screening stage, on an ungauged mid-hills river, the number on
            screen is the right order and the band around it is honest — and where it cannot be,
            the app says so out loud.
          </p>
        </div>

        {/* The claim above is only true while the stamp still matches the engine
            that is loaded. Without this the page asserted current-code validity
            from a JSON file four days behind the modules beside it. */}
        {DATA._engine !== ENGINE_SIGNATURE && (
          <div className="mt-8 rounded-lg border border-amber/50 bg-amber/10 px-4 py-3 text-[11.5px] leading-relaxed text-amber">
            <b>These results are older than the engine.</b> They were produced on{' '}
            {DATA._generated} by engine <code>{DATA._engine ?? 'unstamped'}</code>, and the
            calculation modules loaded here are <code>{ENGINE_SIGNATURE}</code>. Read them as a
            record of that run, not as validation of the code you are using now — re-run{' '}
            <code>npm run build:validation</code> to refresh.
          </div>
        )}

        <footer className="mt-10 border-t border-line pt-4 text-[10.5px] leading-relaxed text-faint">
          Generated {DATA._generated} by <code>npm run build:validation</code> — a headless browser
          driving the same modules the app runs, from{' '}
          <code>pipeline/plants.json</code> (every coordinate and figure sourced there). Plant data:
          OpenStreetMap © contributors (ODbL), GeoNames (CC BY), operators&apos; and public
          records as linked per plant. HydroRecon is open source under MIT.
        </footer>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>
);
