/**
 * Conservative upstream source-to-intake channel topology screens.
 *
 * The calculation only asks whether a point can be snapped near a mapped
 * HydroRIVERS reach and whether that reach's directed topology reaches the
 * selected intake. It does not model hillslope runout, lake outlets, breach
 * hydrographs, debris entrainment, attenuation, probability or design floods.
 */
import { glacialLakeInventory, type GlacialLake } from './glacial-lakes.ts';
import {
  hazardInventory,
  hazardsFor,
  type HazardInventoryRecord,
} from './hazards.ts';
import {
  connectUpstreamSources,
  type ChannelConnection,
} from './rivers.ts';

export const LAKE_MAX_SNAP_KM = 1;
export const INCIDENT_MAX_SNAP_KM = 1.5;
export const LAKE_MAX_ROUTE_KM = 300;
export const INCIDENT_MAX_ROUTE_KM = 150;
/** Keep every candidate point, but limit overlapping route geometry in the map/export. */
export const ROUTE_GEOMETRY_LIMIT = 40;

const RELEVANT_INCIDENTS = ['landslide', 'flood', 'glof', 'avalanche', 'inundation'] as const;

type LakeSource = GlacialLake & { sourceType: 'lake' };
type IncidentSource = HazardInventoryRecord & { sourceType: 'incident' };
type Source = LakeSource | IncidentSource;

export type ConnectedGlacialLake = GlacialLake & {
  snapKm: number;
  snapped: { lat: number; lon: number };
  routeKm: number;
  route: [number, number][];
  routeGeometryIncluded: boolean;
};

export type ConnectedIncident = HazardInventoryRecord & {
  snapKm: number;
  snapped: { lat: number; lon: number };
  routeKm: number;
  route: [number, number][];
  routeGeometryIncluded: boolean;
};

export type UpstreamConnectivityScreen = {
  target: {
    lat: number;
    lon: number;
    snapKm: number;
    snapped: { lat: number; lon: number };
  };
  lakes: ConnectedGlacialLake[];
  incidents: ConnectedIncident[];
  lakeInventory: {
    total: number;
    connected: number;
    retrieved: string;
    published: string;
    observations: { from: number; to: number; sensor: string };
    source: string;
    license: string;
    licenseUrl: string;
    quality: string;
    limitation: string;
  };
  incidentInventory: {
    screened: number;
    connected: number;
    retrieved: string;
    period: { from: string; to: string };
    source: string;
    limitation: string;
  };
  network: {
    source: string;
    sourceUrl: string;
    technicalUrl: string;
    version: string;
    resolution: string;
    streamThreshold: string;
    crs: string;
  };
  method: string;
  limitation: string;
};

/**
 * Which lakes lead the list and keep their route geometry.
 *
 * ICIMOD's national assessment outranks a remotely-sensed expansion trend: a
 * lake it placed on the 47-lake danger list has been judged on its dam, its
 * source glacier and its surroundings, which no area time series can see.
 * Rank I first, then the rest of the ranked list, then merely-expanding lakes.
 */
const lakePriority = (lake: ConnectedGlacialLake): number =>
  lake.pdgl?.rank === 1
    ? -2
    : lake.pdgl
      ? -1
      : lake.expansionSignificant === true &&
          (lake.expansionRateKm2Yr ?? 0) > 0 &&
          lake.timeSeriesOutlier !== true
        ? 0
        : lake.timeSeriesOutlier === true
          ? 2
          : 1;

function lakeConnection(connection: ChannelConnection<Source>): ConnectedGlacialLake | null {
  if (connection.source.sourceType !== 'lake' || connection.snapKm > LAKE_MAX_SNAP_KM) return null;
  const { sourceType: _sourceType, ...lake } = connection.source;
  return {
    ...lake,
    snapKm: connection.snapKm,
    snapped: connection.snapped,
    routeKm: connection.routeKm,
    route: connection.route,
    routeGeometryIncluded: true,
  };
}

function incidentConnection(connection: ChannelConnection<Source>): ConnectedIncident | null {
  if (
    connection.source.sourceType !== 'incident' ||
    connection.snapKm > INCIDENT_MAX_SNAP_KM ||
    connection.routeKm > INCIDENT_MAX_ROUTE_KM
  ) return null;
  const { sourceType: _sourceType, ...incident } = connection.source;
  return {
    ...incident,
    snapKm: connection.snapKm,
    snapped: connection.snapped,
    routeKm: connection.routeKm,
    route: connection.route,
    routeGeometryIncluded: true,
  };
}

/** Build the Nepal upstream-lake and historical-report screen for one intake. */
export async function upstreamConnectivityFor(
  intake: { lat: number; lon: number }
): Promise<UpstreamConnectivityScreen | null> {
  const lakeInventory = glacialLakeInventory();
  const incidents = hazardInventory(RELEVANT_INCIDENTS);
  const sources: Source[] = [
    ...lakeInventory.lakes.map((lake) => ({ ...lake, sourceType: 'lake' as const })),
    ...incidents.map((incident) => ({ ...incident, sourceType: 'incident' as const })),
  ];
  const connected = await connectUpstreamSources(intake, sources, {
    maxSnapKm: INCIDENT_MAX_SNAP_KM,
    maxRouteKm: LAKE_MAX_ROUTE_KM,
  });
  if (!connected) return null;

  let lakes = connected.connections
    .map(lakeConnection)
    .filter((lake): lake is ConnectedGlacialLake => lake !== null)
    .sort((a, b) => lakePriority(a) - lakePriority(b) || a.routeKm - b.routeKm || a.id.localeCompare(b.id));
  let connectedIncidents = connected.connections
    .map(incidentConnection)
    .filter((incident): incident is ConnectedIncident => incident !== null)
    .sort((a, b) => a.routeKm - b.routeKm || b.date.localeCompare(a.date) || a.id - b.id);
  // Hundreds of valid sources can share the same lower-basin path. Preserve
  // every candidate point and metric, but retain only a declared, prioritized
  // subset of overlapping route geometry so map state and GeoJSON stay usable.
  let lakeRoutes = Math.min(24, lakes.length);
  let incidentRoutes = Math.min(16, connectedIncidents.length);
  let remaining = ROUTE_GEOMETRY_LIMIT - lakeRoutes - incidentRoutes;
  if (remaining > 0) {
    const extraLakes = Math.min(remaining, lakes.length - lakeRoutes);
    lakeRoutes += extraLakes;
    remaining -= extraLakes;
    incidentRoutes += Math.min(remaining, connectedIncidents.length - incidentRoutes);
  }
  lakes = lakes.map((lake, index) => index < lakeRoutes
    ? lake
    : { ...lake, route: [], routeGeometryIncluded: false });
  connectedIncidents = connectedIncidents.map((incident, index) => index < incidentRoutes
    ? incident
    : { ...incident, route: [], routeGeometryIncluded: false });
  const bipad = hazardsFor([], 15);

  return {
    target: connected.target,
    lakes,
    incidents: connectedIncidents,
    lakeInventory: {
      total: lakeInventory.counts.total,
      connected: lakes.length,
      retrieved: lakeInventory.retrieved,
      published: lakeInventory.published,
      observations: lakeInventory.observations,
      source: lakeInventory.source,
      license: lakeInventory.license,
      licenseUrl: lakeInventory.licenseUrl,
      quality: lakeInventory.quality,
      limitation: lakeInventory.limitation,
    },
    incidentInventory: {
      screened: incidents.length,
      connected: connectedIncidents.length,
      retrieved: bipad.retrieved,
      period: bipad.period,
      source: bipad.source,
      limitation:
        'Approved and verified BIPAD points only. A report point may be administrative rather than the physical source, and connection does not prove material or floodwater entered the channel.',
    },
    network: {
      source: 'HydroRIVERS',
      sourceUrl: 'https://www.hydrosheds.org/products/hydrorivers',
      technicalUrl: 'https://data.hydrosheds.org/file/technical-documentation/HydroRIVERS_TechDoc_v10.pdf',
      version: '1.0',
      resolution: '15 arc-seconds (about 500 m)',
      streamThreshold: 'at least 10 km2 upstream area or 0.1 m3/s long-term mean discharge',
      crs: 'EPSG:4326 (WGS 84); great-circle route lengths',
    },
    method:
      `Lake centroids within ${LAKE_MAX_SNAP_KM} km and BIPAD points within ${INCIDENT_MAX_SNAP_KM} km of a stored HydroRIVERS vertex are walked downstream through the bundled directed network. Lake routes are capped at ${LAKE_MAX_ROUTE_KM} km; incident routes at ${INCIDENT_MAX_ROUTE_KM} km.`,
    limitation:
      'Connectivity candidate only—not a susceptibility, source, runout, dam-stability, breach, GLOF/debris-flow, attenuation, probability or design-flood model. A centroid/report snap can cross a drainage divide. HydroRIVERS omits smaller streams, and its mapped topology must be checked against a DEM, lake outlet, recent imagery and field evidence.',
  };
}

/** Coverage of the current ICIMOD 2026 Koshi landslide inventory. */
export function inKoshiLandslideInventory(point: { lat: number; lon: number }): boolean {
  return point.lon >= 85 && point.lon <= 88.1 && point.lat >= 26.6 && point.lat <= 28.2;
}

export const ICIMOD_POTENTIALLY_DANGEROUS_LAKES =
  'https://rds.icimod.org/metadata/799aab42-e816-4e7d-87bb-8b2147eb6a1a';
export const ICIMOD_GLOF_DATABASE =
  'https://rds.icimod.org/metadata/8881454b-6f7c-461b-95c2-eaf7618230d9';
export const ICIMOD_KOSHI_LANDSLIDES =
  'https://rds.icimod.org/metadata/af73da0a-885b-459d-95ba-2ea0662a7e7c';

/*
 * MOVED from the desk-study report when that feature was removed. Nothing in the app calls it now;
 * it stays because checks/glof.check.ts guards the filter and the report had been its only caller.
 */
/**
 * WHICH UPSTREAM LAKES CARRY A PUBLISHED DANGER SIGNAL.
 *
 * Lifted out of the report body so it can be tested directly. It was inline
 * once, and inline it was WRONG in the only direction that matters: it filtered
 * on `areaHa ?? areaKm2 * 100 ?? 0` through an `as unknown as` cast, and
 * `ConnectedGlacialLake` carries neither field — the builder keeps centroids and
 * drops the polygons. Area was therefore 0 on every lake, the risky set was
 * empty on every site, and the report printed "none is both large and close"
 * whatever sat upstream. A hazard screen failing OPEN, hidden from the compiler
 * by the cast, and unnoticed because the safe branch is the one that renders on
 * almost every site.
 *
 * It now screens on what the inventory actually publishes, which is better
 * evidence than an area threshold anyway:
 *
 *   LISTED — ICIMOD's 2020 assessment of 47 potentially dangerous glacial
 *   lakes has judged dam type, source glacier and surroundings. No area figure
 *   can see any of that.
 *
 *   GROWING — a glacier-fed lake with a significant published expansion trend
 *   is the remotely-sensed version of the same worry. Non-glacier-fed lakes are
 *   excluded because the mechanism is not there, and lakes the source flags as
 *   time-series outliers are excluded because the trend is not trusted by the
 *   people who measured it.
 *
 * AREA IS STILL THE MISSING TERM and it is worth having: a 2 ha pond and a
 * 200 ha lake at the same distance are not the same question. Restoring it means
 * adding the area column to `pipeline/build-glacial-lakes.mjs` and re-running it.
 * Until then the report says so rather than implying the screen is complete.
 */
export const GLOF_ROUTE_KM = 60;

export function glofDangerSignals(lakes: readonly ConnectedGlacialLake[]): {
  listed: ConnectedGlacialLake[];
  growing: ConnectedGlacialLake[];
  risky: ConnectedGlacialLake[];
} {
  const near = lakes.filter((l) => l.routeKm <= GLOF_ROUTE_KM);
  const listed = near.filter((l) => l.pdgl != null);
  const growing = near.filter(
    (l) =>
      l.pdgl == null &&
      l.connectivity === 'Glacier-fed' &&
      l.expansionSignificant === true &&
      (l.expansionRateKm2Yr ?? 0) > 0 &&
      l.timeSeriesOutlier !== true
  );
  return { listed, growing, risky: [...listed, ...growing] };
}
