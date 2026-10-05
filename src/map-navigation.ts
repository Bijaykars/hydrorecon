/** WGS84 inputs use latitude, longitude; GeoJSON uses longitude, latitude. */
export type MapPoint = { lat: number; lon: number };
export type MapBounds = { south: number; west: number; north: number; east: number };
export const NEPAL_VIEW = { lat: 28.3, lon: 84.1, zoom: 6.7 };
export const NEPAL_BOUNDS: MapBounds = { south: 26.3, west: 80.05, north: 30.5, east: 88.2 };

export function validPoint(p: MapPoint): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 85.051129 && Math.abs(p.lon) <= 180;
}

export function parseCoordinates(text: string): MapPoint | null {
  const parts = text.trim().split(/[\s,;]+/);
  if (parts.length !== 2 || parts.some((p) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(p))) return null;
  const p = { lat: Number(parts[0]), lon: Number(parts[1]) };
  return validPoint(p) ? p : null;
}

export function parseBounds(text: string): MapBounds | null {
  const parts = text.trim().split(/[\s,;]+/);
  if (parts.length !== 4) return null;
  const a = parseCoordinates(parts.slice(0, 2).join(','));
  const b = parseCoordinates(parts.slice(2).join(','));
  if (!a || !b || a.lat >= b.lat || a.lon >= b.lon) return null;
  return { south: a.lat, west: a.lon, north: b.lat, east: b.lon };
}

export function boundsBetween(a: MapPoint, b: MapPoint): MapBounds {
  return { south: Math.min(a.lat, b.lat), west: Math.min(a.lon, b.lon), north: Math.max(a.lat, b.lat), east: Math.max(a.lon, b.lon) };
}

export function inBounds(p: MapPoint, b: MapBounds): boolean {
  // A world-wrapped viewport may extend beyond ±180; stored areas never do.
  const lon = p.lon + 360 * Math.round(((b.west + b.east) / 2 - p.lon) / 360);
  return p.lat >= b.south && p.lat <= b.north && lon >= b.west && lon <= b.east;
}

export function boundsFeature(b: MapBounds): GeoJSON.Feature<GeoJSON.Polygon> {
  return { type: 'Feature', properties: { name: 'Area of interest', purpose: 'Browsing extent; not a watershed or licence boundary', coordinateSystem: 'WGS84' }, geometry: { type: 'Polygon', coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]] } };
}

export function areaKm2(b: MapBounds): number {
  const rad = Math.PI / 180;
  return 6371.0088 ** 2 * (b.east - b.west) * rad * (Math.sin(b.north * rad) - Math.sin(b.south * rad));
}

export function mapPadding() {
  return window.innerWidth >= 1024
    ? { top: 74, bottom: 60, left: 334, right: Math.max(340, window.innerWidth * 0.34 + 24) }
    : { top: 58, bottom: 30, left: 24, right: 24 };
}

export function readPreference<T extends Record<string, boolean>>(key: string, defaults: T): T {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}');
    return Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, typeof stored?.[name] === 'boolean' ? stored[name] : value])) as T;
  } catch { return { ...defaults }; }
}

export function savePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Browsing works without storage. */ }
}
