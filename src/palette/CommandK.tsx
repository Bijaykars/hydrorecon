import { useEffect } from 'react';
import { Command } from 'cmdk';
import { useStore } from '../state/store.ts';

const RIVERS: { name: string; note: string; lon: number; lat: number; zoom: number }[] = [
  { name: 'Kabeli', note: 'Panchthar · Tamor basin', lon: 87.77, lat: 27.2, zoom: 11 },
  { name: 'Nyadi', note: 'Lamjung · Marsyangdi basin', lon: 84.42, lat: 28.36, zoom: 11.5 },
  { name: 'Tamakoshi at Lamabagar', note: 'Dolakha · Koshi basin', lon: 86.27, lat: 27.9, zoom: 11 },
  { name: 'Chilime', note: 'Rasuwa · Trishuli basin', lon: 85.3, lat: 28.13, zoom: 11.5 },
  { name: 'Trishuli at Betrawati', note: 'Rasuwa/Nuwakot', lon: 85.18, lat: 27.97, zoom: 11 },
  { name: 'Marsyangdi', note: 'Lamjung', lon: 84.42, lat: 28.23, zoom: 10.8 },
  { name: 'Karnali at Chisapani', note: 'far-west main stem', lon: 81.29, lat: 28.64, zoom: 10.5 },
  { name: 'Arun', note: 'Sankhuwasabha · Koshi basin', lon: 87.28, lat: 27.55, zoom: 10.5 },
  { name: 'Seti Gandaki', note: 'Kaski', lon: 83.99, lat: 28.24, zoom: 11 },
];

export function CommandK() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const requestFly = useStore((s) => s.requestFly);
  const setMode = useStore((s) => s.setMode);
  const mode = useStore((s) => s.mode);
  const toggleLayer = useStore((s) => s.toggleLayer);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useStore.getState().paletteOpen);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  if (!open) return null;

  const run = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/55 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <Command
        label="Command palette"
        className="w-[min(560px,92vw)] overflow-hidden rounded-xl border border-line-strong bg-panel shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        <Command.Input
          autoFocus
          placeholder="Jump to a river, toggle a view…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-[14px] text-ink outline-none placeholder:text-faint"
        />
        <Command.List className="max-h-[46vh] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-[12px] text-faint">
            Nothing matches.
          </Command.Empty>
          <Command.Group
            heading="Rivers"
            className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-faint"
          >
            {RIVERS.map((r) => (
              <Command.Item
                key={r.name}
                value={`${r.name} ${r.note}`}
                onSelect={() => run(() => requestFly({ lon: r.lon, lat: r.lat, zoom: r.zoom }))}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 text-[13px] data-[selected=true]:bg-panel-3"
              >
                <span>{r.name}</span>
                <span className="text-[11px] text-faint">{r.note}</span>
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group
            heading="Views"
            className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-faint"
          >
            <Command.Item
              value="toggle 3d terrain scene"
              onSelect={() => run(() => setMode(mode === '2d' ? '3d' : '2d'))}
              className="cursor-pointer rounded-md px-2.5 py-2 text-[13px] data-[selected=true]:bg-panel-3"
            >
              Switch to {mode === '2d' ? '3D scene' : '2D map'}
            </Command.Item>
            <Command.Item
              value="toggle satellite imagery"
              onSelect={() => run(() => toggleLayer('satellite'))}
              className="cursor-pointer rounded-md px-2.5 py-2 text-[13px] data-[selected=true]:bg-panel-3"
            >
              Toggle satellite imagery
            </Command.Item>
            <Command.Item
              value="toggle dhm stations"
              onSelect={() => run(() => toggleLayer('stations'))}
              className="cursor-pointer rounded-md px-2.5 py-2 text-[13px] data-[selected=true]:bg-panel-3"
            >
              Toggle DHM stations
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
