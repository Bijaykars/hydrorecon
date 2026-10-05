import stations from './data/dhm-stations.json' with { type: 'json' };
import { type DoedProject, DOED_UPDATED } from './context.ts';
import { hazardInventory, BIPAD_RETRIEVED } from './hazards.ts';
import { glacialLakeInventory } from './glacial-lakes.ts';
import { inBounds, type MapBounds, type MapPoint } from './map-navigation.ts';

export type InventoryItem = MapPoint & {
  id: string;
  kind: 'project' | 'gauge' | 'hazard' | 'lake';
  name: string;
  detail: string;
  source: string;
  date: string;
  note: string;
  bounds?: [number, number, number, number];
};

export const GAUGE_ITEMS: InventoryItem[] = stations.stations.filter((s) => s.r === 1).map((s, i) => ({
  id: `gauge-${i}`, kind: 'gauge', lat: s.y, lon: s.x, name: s.n,
  detail: `${s.q === 1 ? 'Discharge station' : 'Water-level station'}${'b' in s && s.b ? ` · ${s.b}` : ''}`,
  source: 'https://hydrology.gov.np/', date: stations._retrieved,
  note: 'DHM station metadata. Observation records require DHM access; a station location is not a live reading.',
}));

const lakes = glacialLakeInventory();
export const LAKE_ITEMS: InventoryItem[] = lakes.lakes.map((l) => ({
  id: `lake-${l.id}`, kind: 'lake', lat: l.lat, lon: l.lon, name: l.pdgl?.name || l.id,
  detail: `${l.basin} · ${l.country} · ${l.elevationM.toLocaleString()} m${l.pdgl ? ` · PDGL rank ${l.pdgl.rank}` : ''}`,
  source: lakes.record, date: lakes.retrieved,
  note: 'Lake inventory includes transboundary headwaters. Location alone does not establish an upstream connection or GLOF risk.',
}));

export const HAZARD_ITEMS: InventoryItem[] = hazardInventory().map((h) => ({
  id: `hazard-${h.id}`, kind: 'hazard', lat: h.lat, lon: h.lon, name: h.title,
  detail: h.date, source: h.url, date: BIPAD_RETRIEVED,
  note: 'Historical BIPAD incident report, not a live alert or a susceptibility map. Missing reports do not mean no hazard.',
}));

export function projectItems(projects: readonly DoedProject[]): InventoryItem[] {
  return projects.map((p, i) => ({
    id: `project-${i}`, kind: 'project', lat: p.lat, lon: p.lon, name: p.name,
    detail: `${p.stage}${p.capacityMW !== null ? ` · ${p.capacityMW} MW` : ''} · ${p.river} · ${p.district}`,
    source: p.source, date: DOED_UPDATED, bounds: p.bounds,
    note: 'Marker is the centre of the published DoED coordinate range, not a surveyed intake or powerhouse. Verify current register status.',
  }));
}

export function itemsInBounds(items: readonly InventoryItem[], b: MapBounds) {
  return items.filter((p) => {
    if (!p.bounds) return inBounds(p, b);
    const [south, west, north, east] = p.bounds;
    return north >= b.south && south <= b.north && east >= b.west && west <= b.east;
  });
}

export function searchInventory(items: readonly InventoryItem[], text: string): InventoryItem[] {
  const terms = text.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return items.filter((p) => p.kind !== 'hazard' && terms.every((term) => `${p.name} ${p.detail}`.toLocaleLowerCase().includes(term)))
    .sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(terms[0])) - Number(a.name.toLocaleLowerCase().startsWith(terms[0])) || a.name.localeCompare(b.name));
}
