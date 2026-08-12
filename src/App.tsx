import { lazy, Suspense, useEffect, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Toaster } from 'sonner';
import { useStore } from './state/store.ts';
import { MapView } from './map/MapView.tsx';
import { RightRail } from './panels/RightRail.tsx';
import { ProfileDrawer } from './panels/ProfileDrawer.tsx';
import { CommandK } from './palette/CommandK.tsx';

const Scene3D = lazy(() => import('./scene/Scene3D.tsx'));

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

function TopBar() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);

  return (
    <header className="flex h-[46px] items-center gap-3 border-b border-line bg-panel px-3.5">
      <div className="flex items-baseline gap-2">
        <TurbineMark />
        <span className="text-[14px] font-bold tracking-tight">Ghatta</span>
        <span className="hidden text-[11px] text-muted sm:inline">
          open hydropower engineering workbench
        </span>
        <span className="rounded bg-panel-3 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-faint">
          M0 · UI
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="hidden items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-[11.5px] text-muted hover:border-line-strong hover:text-ink sm:flex"
        >
          <span>Search rivers…</span>
          <kbd className="rounded border border-line bg-panel px-1 text-[9.5px]">Ctrl K</kbd>
        </button>
        <div className="flex overflow-hidden rounded-md border border-line">
          {(['2d', '3d'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1.5 text-[11.5px] font-semibold uppercase ${
                mode === m ? 'bg-river-soft text-river' : 'bg-panel-2 text-muted hover:text-ink'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <a
          href="https://github.com/Bijaykars"
          target="_blank"
          rel="noreferrer"
          className="hidden rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-[11.5px] text-muted hover:border-line-strong hover:text-ink md:block"
        >
          Open source · MIT
        </a>
      </div>
    </header>
  );
}

function TurbineMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="translate-y-[2px]">
      <circle cx="9" cy="9" r="8" fill="none" stroke="#4db8ff" strokeWidth="1.6" />
      <path
        d="M9 3.2 C10.4 5.4 10.4 7 9 9 C7.6 7 7.6 5.4 9 3.2 Z"
        fill="#4db8ff"
        transform="rotate(0 9 9)"
      />
      <path
        d="M9 3.2 C10.4 5.4 10.4 7 9 9 C7.6 7 7.6 5.4 9 3.2 Z"
        fill="#4db8ff"
        transform="rotate(120 9 9)"
      />
      <path
        d="M9 3.2 C10.4 5.4 10.4 7 9 9 C7.6 7 7.6 5.4 9 3.2 Z"
        fill="#4db8ff"
        transform="rotate(240 9 9)"
      />
    </svg>
  );
}

function StageArea() {
  const mode = useStore((s) => s.mode);
  return (
    <div className="relative h-full w-full">
      <div className={`absolute inset-0 ${mode === '2d' ? '' : 'invisible'}`}>
        <MapView />
      </div>
      {mode === '3d' && (
        <div className="absolute inset-0">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center bg-[#07171d] text-[12px] text-muted">
                Loading the 3D engine (lazy ~1.7 MB, first time only)…
              </div>
            }
          >
            <Scene3D />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function DesktopLayout() {
  const scheme = useStore((s) => s.selectedScheme());
  return (
    <Group orientation="horizontal" className="min-h-0 flex-1">
      {/* string sizes = percent in react-resizable-panels v4; numbers are pixels */}
      <Panel id="stage" defaultSize="71" minSize="45" className="h-full">
        <Group orientation="vertical" className="h-full">
          <Panel id="map" minSize="35" className="h-full">
            <StageArea />
          </Panel>
          {scheme && (
            <>
              <Separator className="h-[3px] shrink-0 bg-line transition-colors hover:bg-river" />
              <Panel id="profile" defaultSize="36" minSize="20" maxSize="60" className="h-full">
                <ProfileDrawer />
              </Panel>
            </>
          )}
        </Group>
      </Panel>
      <Separator className="w-[3px] shrink-0 bg-line transition-colors hover:bg-river" />
      <Panel id="rail" defaultSize="29" minSize="22" maxSize="44" className="h-full">
        <RightRail />
      </Panel>
    </Group>
  );
}

function MobileLayout() {
  const scheme = useStore((s) => s.selectedScheme());
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="h-[44vh] shrink-0">
        <StageArea />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <RightRail />
      </div>
      {scheme && (
        <div className="fixed inset-x-0 bottom-0 z-40 h-[46vh] shadow-[0_-20px_60px_rgba(0,0,0,0.6)]">
          <ProfileDrawer />
        </div>
      )}
    </div>
  );
}

export default function App() {
  const isMobile = useMedia('(max-width: 900px)');
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      {isMobile ? <MobileLayout /> : <DesktopLayout />}
      <CommandK />
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--color-panel-3)',
            border: '1px solid var(--color-line-strong)',
            color: 'var(--color-ink)',
          },
        }}
      />
    </div>
  );
}
