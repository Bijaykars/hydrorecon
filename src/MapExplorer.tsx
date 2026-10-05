import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Map as LibreMap, GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import type { DoedProject } from './context.ts';
import { GAUGE_ITEMS, HAZARD_ITEMS, LAKE_ITEMS, itemsInBounds, projectItems, searchInventory, type InventoryItem } from './map-inventory.ts';
import { NEPAL_BOUNDS, areaKm2, boundsBetween, boundsFeature, mapPadding, parseBounds, parseCoordinates, type MapBounds, type MapPoint } from './map-navigation.ts';
import { download } from './export.ts';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const formatBounds = (b: MapBounds) => [b.south, b.west, b.north, b.east].map((n) => n.toFixed(5)).join(', ');
const colors = { project: '#e8987b', gauge: '#63b981', hazard: '#d2a04a', lake: '#79bce8' };

export function MapExplorer({ map, at, projects, gaugesOn, lakesOn, labelsOn, onStudy, onLocate, children }: {
  map: LibreMap | null;
  at: MapPoint | null;
  projects: DoedProject[] | null;
  gaugesOn: boolean;
  lakesOn: boolean;
  labelsOn: boolean;
  onStudy: (lat: number, lon: number) => void;
  onLocate: (lat: number, lon: number) => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [queryError, setQueryError] = useState('');
  const [target, setTarget] = useState<MapPoint | null>(null);
  const [areaText, setAreaText] = useState('');
  const [area, setArea] = useState<MapBounds | null>(null);
  const [areaError, setAreaError] = useState('');
  const [areaOpen, setAreaOpen] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [corner, setCorner] = useState<MapPoint | null>(null);
  const [preview, setPreview] = useState<MapBounds | null>(null);
  const [extent, setExtent] = useState<MapBounds>(NEPAL_BOUNDS);
  const [cursor, setCursor] = useState<MapPoint | null>(null);
  const [inspected, setInspected] = useState<InventoryItem | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<InventoryItem['kind']>('project');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(1);
  const lastMove = useRef(0);
  const items = useMemo(() => [...projectItems(projects ?? []), ...GAUGE_ITEMS, ...LAKE_ITEMS, ...HAZARD_ITEMS], [projects]);
  const byId = useMemo(() => new Map(items.map((p) => [p.id, p])), [items]);
  const results = useMemo(() => searchInventory(items, query), [items, query]);
  const point = parseCoordinates(query);
  const scope = area ?? extent;
  const scoped = useMemo(() => itemsInBounds(items, scope), [items, scope]);
  const counts = useMemo(() => scoped.reduce((s, p) => ({ ...s, [p.kind]: s[p.kind] + 1 }), { project: 0, gauge: 0, hazard: 0, lake: 0 }), [scoped]);
  const listed = useMemo(() => scoped.filter((p) => p.kind === tab), [scoped, tab]);
  useEffect(() => setPage(1), [scope, tab]);

  const fit = (b: MapBounds) => map?.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: mapPadding(), maxZoom: 14, duration: 600 });
  const locate = (p: MapPoint) => { setTarget(p); onLocate(p.lat, p.lon); setExpanded(false); };

  useEffect(() => {
    if (!map) return;
    const update = () => {
      const b = map.getBounds();
      setExtent({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
    };
    update();
    map.on('moveend', update);
    const font = map.getStyle().layers.find((l) => l.type === 'symbol' && l.layout?.['text-font']);
    for (const [id, data, color] of [['inventory-gauges', GAUGE_ITEMS, colors.gauge], ['inventory-lakes', LAKE_ITEMS, colors.lake]] as const) {
      map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: data.map((p) => ({ type: 'Feature', properties: { inventoryId: p.id, name: p.name }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })) }, attribution: id === 'inventory-gauges' ? 'DHM Nepal station metadata' : 'Glacial lake inventory: see source in explorer' });
      map.addLayer({ id, source: id, type: 'circle', paint: { 'circle-color': color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 12, 5], 'circle-stroke-width': 1, 'circle-stroke-color': '#101618' } });
      map.addLayer({ id: `${id}-labels`, source: id, type: 'symbol', minzoom: 10, layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top', ...(font?.type === 'symbol' ? { 'text-font': font.layout?.['text-font'] } : {}) }, paint: { 'text-color': color, 'text-halo-color': '#101618', 'text-halo-width': 1.5 } });
    }
    map.addSource('explorer-area', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'explorer-area-fill', source: 'explorer-area', type: 'fill', paint: { 'fill-color': '#4fc1d8', 'fill-opacity': 0.09 } });
    map.addLayer({ id: 'explorer-area-line', source: 'explorer-area', type: 'line', paint: { 'line-color': '#4fc1d8', 'line-width': 2, 'line-dasharray': [3, 2] } });
    return () => {
      map.off('moveend', update);
      for (const id of ['inventory-gauges', 'inventory-lakes', 'explorer-area']) {
        for (const layer of [`${id}-labels`, `${id}-line`, `${id}-fill`, id]) if (map.getLayer(layer)) map.removeLayer(layer);
        if (map.getSource(id)) map.removeSource(id);
      }
    };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    for (const [id, on] of [['inventory-gauges', gaugesOn], ['inventory-lakes', lakesOn]] as const) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      if (map.getLayer(`${id}-labels`)) map.setLayoutProperty(`${id}-labels`, 'visibility', on && labelsOn ? 'visible' : 'none');
    }
  }, [map, gaugesOn, lakesOn, labelsOn]);

  useEffect(() => {
    const b = preview ?? area;
    (map?.getSource('explorer-area') as GeoJSONSource | undefined)?.setData(b ? { type: 'FeatureCollection', features: [boundsFeature(b)] } : EMPTY);
  }, [map, area, preview]);

  useEffect(() => {
    if (!map) return;
    const canvas = map.getCanvas();
    const getItem = (p: { x: number; y: number }) => {
      const layers = ['inventory-gauges', 'inventory-lakes', 'licences', 'hazards'].filter((id) => !!map.getLayer(id));
      const features = map.queryRenderedFeatures([p.x, p.y], { layers });
      for (const f of features) {
        const id = f.properties.inventoryId ?? (f.layer.id === 'hazards' ? `hazard-${f.properties.id}` : null);
        const item = id ? byId.get(id) : items.find((p) => p.kind === 'project' && p.name === f.properties.name);
        if (item) return item;
      }
      return null;
    };
    const move = (e: MapMouseEvent) => {
      if (performance.now() - lastMove.current < 90) return;
      lastMove.current = performance.now();
      const p = { lat: e.lngLat.lat, lon: e.lngLat.wrap().lng };
      setCursor(p);
      if (drawing) {
        if (corner) setPreview(boundsBetween(corner, p));
        return;
      }
      const item = getItem(e.point);
      if (item) setInspected(item);
    };
    const click = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const xy = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (drawing) {
        e.stopImmediatePropagation();
        e.preventDefault();
        const ll = map.unproject([xy.x, xy.y]).wrap();
        const p = { lat: ll.lat, lon: ll.lng };
        if (!corner) { setCorner(p); return; }
        const b = boundsBetween(corner, p);
        if (b.east - b.west > 180) { setAreaError('Choose an area that does not cross the antimeridian. Press Esc to start again.'); return; }
        if (b.north - b.south < 0.00001 || b.east - b.west < 0.00001) { setAreaError('Choose two different corners to make an area.'); return; }
        setArea(b); setAreaText(formatBounds(b)); setPreview(null); setCorner(null); setDrawing(false); setAreaError('');
        return;
      }
      const item = getItem(xy);
      if (item) {
        setInspected(item);
        // Inventory inspection also works on touch without starting a river study.
        if (item.kind === 'gauge' || item.kind === 'lake') e.stopImmediatePropagation();
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setDrawing(false); setCorner(null); setPreview(null); setAreaError(''); }
    };
    const previousCursor = canvas.style.cursor;
    const doubleClickEnabled = map.doubleClickZoom.isEnabled();
    if (drawing) { canvas.style.cursor = 'crosshair'; map.doubleClickZoom.disable(); }
    canvas.addEventListener('click', click, true);
    map.on('mousemove', move);
    document.addEventListener('keydown', escape);
    return () => {
      canvas.removeEventListener('click', click, true);
      map.off('mousemove', move);
      document.removeEventListener('keydown', escape);
      canvas.style.cursor = previousCursor;
      if (drawing && doubleClickEnabled) map.doubleClickZoom.enable();
    };
  }, [map, items, byId, drawing, corner]);

  const share = async () => {
    try { await navigator.clipboard.writeText(location.href); setNotice('Map link copied.'); }
    catch { setNotice('Copy the map link from your address bar.'); }
  };

  return <>
    <aside className="map-explorer" data-expanded={expanded} aria-label="Map tools">
      <div className="explorer-heading"><div><strong>Explore Nepal</strong><span>Rivers, infrastructure & terrain</span></div><button className="mobile-tools" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? 'Close tools' : 'Search & layers'}</button></div>
      <div className="explorer-body">
        <form onSubmit={(e) => { e.preventDefault(); if (point) { locate(point); setQueryError(''); } else setQueryError(results.length ? 'Choose a matching record below.' : 'Enter latitude, longitude in decimal degrees, or search a project, river, district or station.'); }}>
          <label htmlFor="map-search">Find a place or coordinate</label>
          <div className="explorer-input-row"><input id="map-search" value={query} onChange={(e) => { setQuery(e.target.value); setQueryError(''); }} placeholder="28.2096, 83.9856 or Trishuli" autoComplete="off" /><button type="submit" disabled={!map}>Go</button></div>
          <p className="explorer-hint">WGS84 · latitude, longitude · decimal degrees</p>
          {queryError && <p role="alert" className="explorer-error">{queryError}</p>}
          {query.trim() && !point && <div className="search-results" aria-label="Search results">
            {results.slice(0, 8).map((p) => <button type="button" key={p.id} onClick={() => { setInspected(p); locate(p); }}><strong>{p.name}</strong><span>{p.detail}</span></button>)}
            <p className="explorer-hint">{results.length ? `${results.length} matches${results.length > 8 ? ' · showing first 8; refine your search' : ''}` : 'No matching inventory records. Try a river, district or coordinates.'}</p>
          </div>}
        </form>
        <div className="explorer-actions"><button onClick={() => fit(NEPAL_BOUNDS)} disabled={!map}>⌂ Nepal</button><button onClick={share}>Copy map link</button></div>
        {notice && <p role="status" className="explorer-hint">{notice}</p>}
        {target && <div className="coordinate-target"><span>{target.lat.toFixed(5)}, {target.lon.toFixed(5)}</span><button onClick={() => onStudy(target.lat, target.lon)}>Study river here</button><small>Analysis snaps to a nearby mapped watercourse.</small></div>}
        <details className="explorer-section" open={areaOpen} onToggle={(e) => setAreaOpen(e.currentTarget.open)}>
          <summary>Area of interest {area && <span>{areaKm2(area).toLocaleString(undefined, { maximumFractionDigits: 1 })} km²</span>}</summary>
          <p className="explorer-hint">Draw a rectangle with two corner clicks, or enter its limits.</p>
          <div className="explorer-actions"><button aria-pressed={drawing} disabled={!map} onClick={() => { setDrawing(!drawing); setCorner(null); setPreview(null); setExpanded(false); }}> {drawing ? 'Cancel drawing' : 'Draw bounding box'}</button><button disabled={!map} onClick={() => { const b = parseBounds(formatBounds(extent)); if (!b) { setAreaError('Zoom in or pan to an extent within latitude ±85.051129° and longitude ±180°.'); return; } setArea(b); setAreaText(formatBounds(b)); setAreaError(''); }}>Use map extent</button></div>
          <form onSubmit={(e) => { e.preventDefault(); const b = parseBounds(areaText); if (!b) { setAreaError('Use south, west, north, east. South must be below north, west below east; latitude ±85.051129°, longitude ±180°.'); return; } setArea(b); setAreaError(''); fit(b); }}>
            <label htmlFor="area-bounds">South, west, north, east</label>
            <input id="area-bounds" value={areaText} onChange={(e) => setAreaText(e.target.value)} placeholder="27.8, 83.5, 28.5, 84.5" />
            <button type="submit" disabled={!map}>Apply bounds</button>
          </form>
          {areaError && <p role="alert" className="explorer-error">{areaError}</p>}
          {area && at && <p className="explorer-hint">In this area: {counts.project} project ranges · {counts.gauge} gauges · {counts.lake} lakes · {counts.hazard} historical reports.</p>}
          {area && <><p className="explorer-hint">{formatBounds(area)}<br/>Browsing extent only; not a delineated catchment.</p><div className="explorer-actions"><button onClick={() => fit(area)}>Fit area</button><button onClick={() => download('hydrorecon-area.geojson', 'application/geo+json', JSON.stringify({ type: 'FeatureCollection', features: [boundsFeature(area)] }, null, 2))}>Export GeoJSON</button><button onClick={() => { setArea(null); setAreaText(''); setPreview(null); setDrawing(false); setCorner(null); }}>Clear area</button></div></>}
        </details>
        <div className="map-inspector" aria-label="Feature information">
          <span className="explorer-eyebrow">Map information</span>
          {inspected ? <><strong>{inspected.name}</strong><p>{inspected.detail}</p><span className="coordinate-readout">{inspected.lat.toFixed(5)}, {inspected.lon.toFixed(5)}</span><p>{inspected.note}</p><a href={inspected.source} target="_blank" rel="noopener noreferrer">Source · {inspected.date} ↗</a><div className="explorer-actions"><button onClick={() => locate(inspected)}>Locate</button><button onClick={() => { setInspected(null); }}>Dismiss</button></div></> : <p>Move over a project, gauge, lake or incident to read its details here. On touch screens, tap a symbol.</p>}
          <span className="coordinate-readout">{cursor ? `${cursor.lat.toFixed(5)}, ${cursor.lon.toFixed(5)}` : 'Move over the map for coordinates'} · WGS84</span>
        </div>
        {children}
      </div>
    </aside>
    {drawing && <div className="drawing-instruction" role="status">{corner ? 'Click the opposite corner' : 'Click the first corner'} <button onClick={() => { setDrawing(false); setCorner(null); setPreview(null); }}>Cancel</button><span>Esc to cancel</span></div>}
    {!at && <aside className="explorer-overview" aria-label="Nepal GIS overview">
      <div className="explorer-eyebrow">HydroRecon / GIS workspace</div>
      <h1>Start with the landscape.</h1>
      <p>Explore the available evidence, then select a river to screen a hydropower scheme.</p>
      <div className="overview-scope"><strong>{area ? 'Inside your area' : 'Current map extent'}</strong><span>Bundled records · all layer states</span></div>
      <div className="inventory-stats">{(['project', 'gauge', 'lake', 'hazard'] as const).map((kind) => <button key={kind} aria-pressed={tab === kind} onClick={() => setTab(kind)}><b style={{ color: colors[kind] }}>{counts[kind].toLocaleString()}</b><span>{kind === 'project' ? 'DoED projects' : kind === 'gauge' ? 'DHM gauges' : kind === 'lake' ? 'Glacial lakes' : 'Hazard reports'}</span></button>)}</div>
      <p className="explorer-hint">Projects count published ranges touching the extent; other records count point locations. Snapshots, not live feeds.</p>
      <div className="inventory-list" aria-label="Records in extent">
        {listed.slice(0, page * 8).map((p) => <button key={p.id} onClick={() => { setInspected(p); locate(p); }}><i style={{ background: colors[p.kind] }} /><span><strong>{p.name}</strong><small>{p.detail}</small></span><span aria-hidden>↗</span></button>)}
        {!listed.length && <p className="explorer-hint">No {tab} records in this extent. Zoom out or return to Nepal. An empty inventory is not clearance.</p>}
      </div>
      {listed.length > page * 8 && <button className="inventory-more" onClick={() => setPage(page + 1)}>Show more · {listed.length - page * 8} remaining</button>}
      <details className="explorer-section"><summary>Nepal GIS sources</summary><p className="explorer-hint">DoED project ranges, DHM station metadata, BIPAD historical incidents and glacial-lake inventories are available before selecting a river. Grid and protected areas use bundled OpenStreetMap data.</p><div className="source-links"><a href="https://hydrology.gov.np/" target="_blank" rel="noopener noreferrer">DHM hydrology portal ↗</a><a href="https://geoapps.icimod.org/icimodarcgis/rest/services/Nepal" target="_blank" rel="noopener noreferrer">ICIMOD Nepal GIS services ↗</a><a href="https://doed.gov.np/" target="_blank" rel="noopener noreferrer">DoED project register ↗</a></div><p className="explorer-hint">Local survey and geology sheets appear when installed. Engineering estimates require a selected river; map records alone do not establish feasibility.</p></details>
    </aside>}
  </>;
}
