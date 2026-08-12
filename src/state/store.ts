import { create } from 'zustand';
import { toast } from 'sonner';
import type { SelectedSite, Scheme } from '../types.ts';
import { analyseSite, sampleSeries, type SiteAnalysis } from '../data/sample.ts';
import { nearestReach } from '../map/rivers.ts';

export type MapView = { lon: number; lat: number; zoom: number };

export type LayerKey = 'hillshade' | 'rivers' | 'satellite' | 'stations';

export type RailTab = 'site' | 'hydrology' | 'schemes' | 'compare';

type Store = {
  view: MapView;
  setView: (v: MapView) => void;
  /** One-shot fly-to request consumed by the map. */
  flyTo: (MapView & { seq: number }) | null;
  requestFly: (v: MapView) => void;

  mode: '2d' | '3d';
  setMode: (m: '2d' | '3d') => void;

  layers: Record<LayerKey, boolean>;
  toggleLayer: (k: LayerKey) => void;

  site: SelectedSite | null;
  analysis: SiteAnalysis | null;
  siteBusy: boolean;
  selectSite: (lat: number, lon: number) => Promise<void>;
  useMainStem: () => void;

  selectedSchemeId: string | null;
  selectScheme: (id: string | null) => void;
  selectedScheme: () => Scheme | null;

  railTab: RailTab;
  setRailTab: (t: RailTab) => void;

  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
};

/** Build site + analysis from a reach choice. */
function analyse(lat: number, lon: number, hit: NonNullable<Awaited<ReturnType<typeof nearestReach>>>, useMain: boolean) {
  const reach = useMain && hit.mainStem ? hit.mainStem : hit.nearest;
  const { dates, valuesCms } = sampleSeries(reach.meanDischargeCms);
  const site: SelectedSite = {
    lat,
    lon,
    reach,
    mainStem: hit.mainStem,
    usedMainStem: useMain,
    dates,
    valuesCms,
  };
  return { site, analysis: analyseSite(dates, valuesCms) };
}

let lastHit: NonNullable<Awaited<ReturnType<typeof nearestReach>>> | null = null;

export const useStore = create<Store>((set, get) => ({
  view: { lon: 84.2, lat: 28.25, zoom: 6.6 },
  setView: (view) => set({ view }),
  flyTo: null,
  requestFly: (v) => set((s) => ({ flyTo: { ...v, seq: (s.flyTo?.seq ?? 0) + 1 } })),

  mode: '2d',
  setMode: (mode) => set({ mode }),

  layers: { hillshade: true, rivers: true, satellite: false, stations: false },
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),

  site: null,
  analysis: null,
  siteBusy: false,

  selectSite: async (lat, lon) => {
    set({ siteBusy: true });
    try {
      const hit = await nearestReach(lat, lon);
      if (!hit) {
        toast.warning('No mapped river reach near that point', {
          description: 'The bundled HydroRIVERS extract covers Nepal. Global coverage lands in M1.',
        });
        set({ siteBusy: false });
        return;
      }
      lastHit = hit;
      const { site, analysis } = analyse(lat, lon, hit, false);
      set({
        site,
        analysis,
        siteBusy: false,
        selectedSchemeId: null,
        railTab: 'site',
      });
      if (hit.mainStem) {
        toast.info('A much larger channel runs nearby', {
          description: `${hit.mainStem.uplandKm2.toLocaleString()} km² vs ${hit.nearest.uplandKm2.toLocaleString()} km² — switch from the Site tab if you meant the main stem.`,
        });
      }
    } catch (e) {
      set({ siteBusy: false });
      toast.error('Site lookup failed', { description: e instanceof Error ? e.message : String(e) });
    }
  },

  useMainStem: () => {
    const { site } = get();
    if (!site || !lastHit?.mainStem) return;
    const { site: next, analysis } = analyse(site.lat, site.lon, lastHit, !site.usedMainStem);
    set({ site: next, analysis, selectedSchemeId: null });
  },

  selectedSchemeId: null,
  selectScheme: (selectedSchemeId) => set({ selectedSchemeId }),
  selectedScheme: () => {
    const { analysis, selectedSchemeId } = get();
    return analysis?.schemes.find((s) => s.id === selectedSchemeId) ?? null;
  },

  railTab: 'site',
  setRailTab: (railTab) => set({ railTab }),

  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));
