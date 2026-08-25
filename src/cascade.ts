/**
 * Nepal DoED upstream/downstream project-interaction candidates.
 *
 * DoED publishes a coordinate range for each record, not an intake, powerhouse,
 * dam, tailrace or licensed alignment. The registry midpoint is therefore used
 * only as a guarded network probe. Returned relations are candidates for
 * document/field confirmation, never legal overlap, water availability or an
 * operating-cascade conclusion.
 */
import {
  DOED_REGISTER_URL,
  DOED_RETRIEVED,
  DOED_UPDATED,
  type DoedProject,
  type Licence,
} from './context.ts';
import type { Scheme } from './engine/discover.ts';
import { haversineKm } from './engine/hydro.ts';
import {
  connectDownstreamTargets,
  connectUpstreamSources,
  type ChannelConnection,
} from './rivers.ts';

export const CASCADE_MAX_SNAP_KM = 2;
export const CASCADE_MAX_ROUTE_KM = 200;
export const CASCADE_ROUTE_GEOMETRY_LIMIT = 30;

export type CascadeDirection = 'upstream' | 'downstream';

export type CascadeProject = DoedProject & {
  direction: CascadeDirection;
  /** Network distance from project probe to intake, or powerhouse to probe. */
  routeKm: number;
  /** Project midpoint to nearest stored HydroRIVERS vertex. */
  snapKm: number;
  snapped: { lat: number; lon: number };
  /** Diagonal of DoED's published coordinate range, not a project length. */
  publishedRangeDiagonalKm: number;
  route: [number, number][];
  routeGeometryIncluded: boolean;
};

export type CascadeScreen = {
  upstream: CascadeProject[];
  downstream: CascadeProject[];
  directReachRecords: number;
  directAdvancedRecords: number;
  registry: {
    geolocatedRecords: number;
    canonicalRecords: number;
    duplicateRowsCollapsed: number;
    updated: string;
    retrieved: string;
    source: string;
  };
  network: {
    source: string;
    sourceUrl: string;
    version: string;
    resolution: string;
    streamThreshold: string;
    crs: string;
  };
  thresholds: {
    midpointSnapKm: number;
    routeKm: number;
    directReachRadiusKm: number;
    routeGeometryLimit: number;
  };
  method: string;
  limitation: string;
  guidance: {
    study: string;
    optimization: string;
  };
};

const normalize = (value: string): string =>
  value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

/**
 * Identity for collapsing the same project carried in several licence tables.
 *
 * Name and capacity alone are not an identity. Two SEPARATE survey applications
 * — licence 10327, Nicholas Energy on Lapha Gad, and licence 10403, Namaste
 * Energy on Lapatgad — are both "Laphagad Hydropower Project, 4.6 MW", and
 * merging them deleted a real project from every cascade and neighbour screen.
 * The river disambiguates them, and it is the one attribute that cannot differ
 * between two records of the SAME scheme moving from survey to construction.
 *
 * Promoter deliberately is not in the key: it legitimately changes when a
 * licence transfers, and keying on it would split one project into two.
 */
export const doedProjectKey = (
  project: Pick<DoedProject, 'name' | 'capacityMW'> & { river?: string }
): string =>
  `${normalize(project.name)}|${project.capacityMW ?? 'na'}|${normalize(project.river ?? '')}`;

export const doedStageRank = (stage: Licence['stage']): number => {
  if (stage === 'Operating') return 0;
  if (stage === 'Construction licence') return 1;
  if (stage === 'Construction application') return 2;
  if (stage === 'Survey licence') return 3;
  return 4;
};

export const isAdvancedDoedStage = (stage: Licence['stage']): boolean =>
  stage === 'Operating' || stage === 'Construction licence';

/** Collapse the same project carried in more than one lifecycle table. */
export function canonicalDoedProjects(projects: readonly DoedProject[]): DoedProject[] {
  const byKey = new Map<string, DoedProject>();
  for (const project of projects) {
    const key = doedProjectKey(project);
    const prior = byKey.get(key);
    if (
      !prior ||
      doedStageRank(project.stage) < doedStageRank(prior.stage) ||
      (project.stage === prior.stage && project.issued > prior.issued)
    ) {
      byKey.set(key, project);
    }
  }
  return [...byKey.values()];
}

const rangeDiagonalKm = (project: DoedProject): number =>
  haversineKm(
    [project.bounds[0], project.bounds[1]],
    [project.bounds[2], project.bounds[3]]
  );

function candidate(
  connection: ChannelConnection<DoedProject>,
  direction: CascadeDirection
): CascadeProject {
  return {
    ...connection.source,
    direction,
    routeKm: connection.routeKm,
    snapKm: connection.snapKm,
    snapped: connection.snapped,
    publishedRangeDiagonalKm: rangeDiagonalKm(connection.source),
    route: connection.route,
    routeGeometryIncluded: true,
  };
}

const relationSort = (a: CascadeProject, b: CascadeProject): number =>
  doedStageRank(a.stage) - doedStageRank(b.stage) ||
  a.routeKm - b.routeKm ||
  a.name.localeCompare(b.name);

function retainRouteGeometry(
  upstream: CascadeProject[],
  downstream: CascadeProject[]
): [CascadeProject[], CascadeProject[]] {
  let upRoutes = Math.min(15, upstream.length);
  let downRoutes = Math.min(15, downstream.length);
  let remaining = CASCADE_ROUTE_GEOMETRY_LIMIT - upRoutes - downRoutes;
  if (remaining > 0) {
    const extraUp = Math.min(remaining, upstream.length - upRoutes);
    upRoutes += extraUp;
    remaining -= extraUp;
    downRoutes += Math.min(remaining, downstream.length - downRoutes);
  }
  return [
    upstream.map((project, index) => index < upRoutes
      ? project
      : { ...project, route: [], routeGeometryIncluded: false }),
    downstream.map((project, index) => index < downRoutes
      ? project
      : { ...project, route: [], routeGeometryIncluded: false }),
  ];
}

/** Build a conservative DoED project-interaction screen for one selected scheme. */
export async function cascadeFor(
  scheme: Pick<Scheme, 'intake' | 'power'>,
  allProjects: readonly DoedProject[],
  directReachProjects: readonly Licence[]
): Promise<CascadeScreen | null> {
  const canonical = canonicalDoedProjects(allProjects);
  const directKeys = new Set(directReachProjects.map(doedProjectKey));
  const candidates = canonical.filter((project) => !directKeys.has(doedProjectKey(project)));

  const [upstreamResult, downstreamResult] = await Promise.all([
    connectUpstreamSources(scheme.intake, candidates, {
      maxSnapKm: CASCADE_MAX_SNAP_KM,
      maxRouteKm: CASCADE_MAX_ROUTE_KM,
    }),
    connectDownstreamTargets(scheme.power, candidates, {
      maxSnapKm: CASCADE_MAX_SNAP_KM,
      maxRouteKm: CASCADE_MAX_ROUTE_KM,
    }),
  ]);
  if (!upstreamResult || !downstreamResult) return null;

  const upstreamByKey = new Map(
    upstreamResult.connections.map((connection) => [
      doedProjectKey(connection.source),
      candidate(connection, 'upstream'),
    ])
  );
  const downstreamByKey = new Map<string, CascadeProject>();
  for (const connection of downstreamResult.connections) {
    const key = doedProjectKey(connection.source);
    // A project cannot be both up- and downstream in an acyclic river network.
    // If coarse midpoint snapping produces that contradiction, omit the weaker
    // relation rather than presenting an impossible cascade.
    if (upstreamByKey.has(key)) continue;
    downstreamByKey.set(key, candidate(connection, 'downstream'));
  }

  const upstream = [...upstreamByKey.values()].sort(relationSort);
  const downstream = [...downstreamByKey.values()].sort(relationSort);
  const [keptUpstream, keptDownstream] = retainRouteGeometry(upstream, downstream);

  return {
    upstream: keptUpstream,
    downstream: keptDownstream,
    directReachRecords: directReachProjects.length,
    directAdvancedRecords: directReachProjects.filter((project) => isAdvancedDoedStage(project.stage)).length,
    registry: {
      geolocatedRecords: allProjects.length,
      canonicalRecords: canonical.length,
      duplicateRowsCollapsed: allProjects.length - canonical.length,
      updated: DOED_UPDATED,
      retrieved: DOED_RETRIEVED,
      source: DOED_REGISTER_URL,
    },
    network: {
      source: 'HydroRIVERS',
      sourceUrl: 'https://www.hydrosheds.org/products/hydrorivers',
      version: '1.0',
      resolution: '15 arc-seconds (about 500 m)',
      streamThreshold: 'at least 10 km2 upstream area or 0.1 m3/s long-term mean discharge',
      crs: 'EPSG:4326 (WGS 84); great-circle route lengths',
    },
    thresholds: {
      midpointSnapKm: CASCADE_MAX_SNAP_KM,
      routeKm: CASCADE_MAX_ROUTE_KM,
      directReachRadiusKm: 6,
      routeGeometryLimit: CASCADE_ROUTE_GEOMETRY_LIMIT,
    },
    method:
      `DoED geolocated records are deduplicated by normalized project name and capacity. Records already in the 6 km selected-reach range screen are excluded. Each remaining published coordinate-range midpoint must snap within ${CASCADE_MAX_SNAP_KM} km of a stored HydroRIVERS vertex. A directed route of at most ${CASCADE_MAX_ROUTE_KM} km must then reach the intake (upstream) or be reached from the powerhouse (downstream).`,
    limitation:
      'Candidate river-network relationship only. DoED publishes coordinate ranges, not project components or alignments; the derived midpoint can snap to the wrong branch, particularly for wide ranges. Stage may have changed since the registry update. Network relation does not prove shared water, legal overlap, cascade operation, abstraction/release, tailwater/backwater, sediment-flushing interaction, cumulative impact or available grid capacity. Verify current licence files, surveyed components and operating rules with DoED, the promoter and NEA.',
    guidance: {
      study: 'https://doed.gov.np/content/35/guidelines-for-study-of-hydropower-projects--2018/',
      optimization: 'https://doed.gov.np/content/32/guideline-for-power-system-optimization-of-hydropower/',
    },
  };
}
