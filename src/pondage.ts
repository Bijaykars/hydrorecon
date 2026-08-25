/**
 * Screening pondage from a proposed dam height and the DEM already used by the
 * app.
 *
 * This follows the useful common denominator of mature GIS implementations:
 * grow from an upstream seed through neighbouring cells below a fixed water
 * level (GRASS r.lake), close the natural river outlet with an explicit dam
 * barrier (Whitebox InsertDams/ImpoundmentSizeIndex), then integrate cell area
 * and `(water level - elevation) * cell area` for storage.
 *
 * It is deliberately a level-pool terrain screen. It is not a dam design,
 * sediment survey, freeboard calculation, backwater model or breach model.
 */
import {
  fetchTerrainWindow,
  PRIMARY_TERRAIN_SOURCE_ID,
  screenTerrainSources,
  type TerrainSourceId,
  type TerrainWindow,
} from './api.ts';

export const PONDAGE_METHOD = {
  grass: 'https://grass.osgeo.org/grass-stable/manuals/r.lake.html',
  whitebox:
    'https://github.com/jblindsay/whitebox-tools/blob/master/whitebox-tools-app/src/tools/hydro_analysis/impoundment_index.rs',
  geolibre: 'https://github.com/opengeos/geolibre-rust',
  bhand: 'https://github.com/konradhafen/beaver-dam-water-storage',
  geocaret: 'https://github.com/Reservoir-Research/geocaret',
  validation: 'https://www.nature.com/articles/s41598-025-30483-7',
  ruggedness:
    'https://community.esri.com/t5/water-resources-blog/terrain-ruggedness-index-tri-and-vector-ruggedness/ba-p/884340',
  reearth: 'https://github.com/reearth/reearth-terrain',
  awsTerrain: 'https://registry.opendata.aws/terrain-tiles/',
  copernicus:
    'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
} as const;

export type PondageStagePoint = {
  retainedHeightM: number;
  waterLevelM: number;
  areaM2: number;
  volumeM3: number;
  edgeLimited: boolean;
};

export type PondageTerrainComparison = {
  /** True when the second source was run against the primary's dam axis. */
  sameAxis?: boolean;
  source: string;
  bedElevationM: number;
  waterLevelM: number;
  areaM2: number;
  volumeM3: number;
  edgeLimited: boolean;
  /** Absolute difference divided by the mean of the two estimates. */
  areaSpreadPct: number;
  /** Absolute difference divided by the mean of the two estimates. */
  volumeSpreadPct: number;
};

export type PondageRuggedness = {
  /** ArcHydro/Riley TRI: RMS elevation difference to the eight neighbours. */
  triMeanM: number;
  triStdDevM: number;
  sampleRadiusKm: number;
  sampledCells: number;
};

export type PondageResult = {
  damHeightM: number;
  bedElevationM: number;
  waterLevelM: number;
  areaM2: number;
  volumeM3: number;
  meanDepthM: number;
  maxDepthM: number;
  shorelineM: number;
  upstreamLengthM: number;
  damLengthM: number | null;
  /** The inferred structure, so every stage can be computed against this one. */
  axis: PondageAxis;
  seedMovedM: number;
  floodedCells: number;
  flooded: Uint8Array;
  grid: TerrainWindow;
  /** The retained water touched the DEM-window edge; area and volume are minima. */
  edgeLimited: boolean;
  /** One or both valley banks were not found before the DEM-window edge. */
  damAxisLimited: boolean;
  damAxis: {
    from: { lat: number; lon: number };
    to: { lat: number; lon: number };
  } | null;
  floodedBounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  } | null;
  source: string;
  resolutionM: number;
  radiusKm: number;
  /** Derived on the final primary grid by repeating the same fill at lower stages. */
  stageCurve?: PondageStagePoint[];
  /** Same site and retained height on the other live terrain source, when available. */
  terrainComparison?: PondageTerrainComparison | null;
  /** What a plausible water-level error does to area and storage. */
  levelSensitivity?: PondageLevelSensitivity | null;
  /** Five-kilometre terrain-complexity diagnostic, not a confidence interval. */
  ruggedness?: PondageRuggedness;
};

type Point = { lat: number; lon: number };

/** Small module-level cache: changing a height must not download the same DEM. */
const terrainCache = new Map<string, Promise<TerrainWindow>>();
// Eight was right when one site meant one window. sweepPondagePosition asks
// for nine at once, so at eight the cache evicted the window it was about to
// need again and every move of the height slider re-downloaded the whole sweep.
const TERRAIN_CACHE_MAX = 24;

const terrainFor = (dam: Point, radiusKm: number, source: TerrainSourceId) => {
  const key = `${source}:${dam.lat.toFixed(5)},${dam.lon.toFixed(5)}@${radiusKm}`;
  const prior = terrainCache.get(key);
  if (prior) return prior;
  const work = fetchTerrainWindow(dam, radiusKm, 30, source).catch((error) => {
    terrainCache.delete(key);
    throw error;
  });
  terrainCache.set(key, work);
  while (terrainCache.size > TERRAIN_CACHE_MAX) {
    const oldest = terrainCache.keys().next().value as string | undefined;
    if (!oldest) break;
    terrainCache.delete(oldest);
  }
  return work;
};

/**
 * ArcHydro/Riley terrain ruggedness on a circular neighbourhood.
 *
 * The value at a cell is the root mean square of its eight elevation
 * differences. We then report the population standard deviation over the
 * window. A recent field comparison found that this variability, measured in a
 * 5 km buffer, dominated small-reservoir volume error. It remains a diagnostic:
 * the published error bands are not transferred from Iraq to a Himalayan site.
 */
export function pondageRuggedness(
  grid: TerrainWindow,
  requestedRadiusKm = 5
): PondageRuggedness {
  const rowMid = Math.floor(grid.rows / 2);
  const colMid = Math.floor(grid.cols / 2);
  const availableRadiusM =
    Math.max(0, Math.min(rowMid, colMid, grid.rows - rowMid - 1, grid.cols - colMid - 1) - 1) *
    grid.cellSizeM;
  const radiusM = Math.min(requestedRadiusKm * 1000, availableRadiusM);
  const radiusSq = radiusM * radiusM;
  let sampledCells = 0;
  let mean = 0;
  let m2 = 0;

  for (let row = 1; row < grid.rows - 1; row++) {
    const northM = (rowMid - row) * grid.cellSizeM;
    for (let col = 1; col < grid.cols - 1; col++) {
      const eastM = (col - colMid) * grid.cellSizeM;
      if (eastM * eastM + northM * northM > radiusSq) continue;
      const z = grid.elevations[row * grid.cols + col];
      if (!Number.isFinite(z)) continue;
      let sumSquares = 0;
      let neighbours = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nz = grid.elevations[(row + dr) * grid.cols + col + dc];
          if (!Number.isFinite(nz)) continue;
          const difference = nz - z;
          sumSquares += difference * difference;
          neighbours++;
        }
      }
      if (neighbours === 0) continue;
      const tri = Math.sqrt(sumSquares / neighbours);
      sampledCells++;
      const delta = tri - mean;
      mean += delta / sampledCells;
      m2 += delta * (tri - mean);
    }
  }

  return {
    triMeanM: mean,
    triStdDevM: sampledCells ? Math.sqrt(m2 / sampledCells) : 0,
    sampleRadiusKm: radiusM / 1000,
    sampledCells,
  };
}

const metricVector = (from: Point, to: Point) => {
  const north = (to.lat - from.lat) * 111_320;
  const east =
    (to.lon - from.lon) *
    111_320 *
    Math.max(0.01, Math.cos((from.lat * Math.PI) / 180));
  const length = Math.hypot(east, north);
  return length > 0 ? { east: east / length, north: north / length } : null;
};

const localOf = (grid: TerrainWindow, row: number, col: number) => ({
  eastM: (col - Math.floor(grid.cols / 2)) * grid.cellSizeM,
  northM: (Math.floor(grid.rows / 2) - row) * grid.cellSizeM,
});

const coordinateOf = (grid: TerrainWindow, eastM: number, northM: number) => ({
  lat: grid.center.lat + northM / 111_320,
  lon:
    grid.center.lon +
    eastM /
      (111_320 * Math.max(0.01, Math.cos((grid.center.lat * Math.PI) / 180))),
});

const indexAtLocal = (grid: TerrainWindow, eastM: number, northM: number) => {
  const col = Math.round(eastM / grid.cellSizeM) + Math.floor(grid.cols / 2);
  const row = Math.floor(grid.rows / 2) - Math.round(northM / grid.cellSizeM);
  return row >= 0 && row < grid.rows && col >= 0 && col < grid.cols
    ? row * grid.cols + col
    : -1;
};

/**
 * Find the channel floor close to the mapped intake.
 *
 * Coarse river vectors can sit on a valley wall. Elevation wins, but moving a
 * metre costs 4 cm of score so a remote DEM pit does not beat the nearby river
 * merely by being a little lower. Only the upstream side of the future dam is
 * eligible.
 */
/** Radius, in cells, over which a candidate's available drop is measured. */
const RELIEF_CELLS = 3;

/**
 * How much a metre of nearby drop costs a candidate, against a metre of its own
 * elevation.
 *
 * At 1 the two trade evenly: a cell one metre lower than another only wins if
 * the ground around it is no lower. That is the intended rule — take the lowest
 * cell that water could actually stand in — and it needs no tuning to state.
 */
const DRAIN_PENALTY = 1;

function findUpstreamBed(
  grid: TerrainWindow,
  downstream: { east: number; north: number },
  searchM = 210
) {
  const radius = Math.max(1, Math.ceil(searchM / grid.cellSizeM));
  const row0 = Math.floor(grid.rows / 2);
  const col0 = Math.floor(grid.cols / 2);
  let best = -1;
  let bestScore = Infinity;
  let movedM = 0;
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const row = row0 + dr;
      const col = col0 + dc;
      if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) continue;
      const distanceM = Math.hypot(dr, dc) * grid.cellSizeM;
      if (distanceM > searchM) continue;
      const p = localOf(grid, row, col);
      const downstreamM = p.eastM * downstream.east + p.northM * downstream.north;
      if (downstreamM > grid.cellSizeM * 0.5) continue;
      const z = grid.elevations[row * grid.cols + col];
      if (!Number.isFinite(z)) continue;
      /**
       * A POND FLOOR IS FLAT. A SPILLWAY IS NOT.
       *
       * Elevation plus a distance penalty finds the lowest cell nearby, and the
       * lowest cell nearby is very often the outflow — a chute, a gorge mouth,
       * the downstream face of an existing dam — which is BELOW the impounded
       * channel and drains away from it. Filling from there floods three cells
       * and stops.
       *
       * That is not hypothetical. The first real-reservoir test this project
       * ever ran put the seed on Kulekhani's spillway: 90 m from the dam, at
       * 1526 m with the lake surface at 1533 m and the chute falling to 1488 m
       * within three cells. The screen returned 0.003 km² against a published
       * 2.2 km².
       *
       * The signal that separates them is local relief. Water standing in a
       * channel has neighbours at or above it; a cell on a chute has ground far
       * below it a short way off. So a candidate is charged for the drop
       * available around it, which leaves a genuine flat bed untouched and
       * makes an outflow expensive.
       */
      let localMin = z;
      for (let er = -RELIEF_CELLS; er <= RELIEF_CELLS; er++) {
        for (let ec = -RELIEF_CELLS; ec <= RELIEF_CELLS; ec++) {
          const rr = row + er;
          const cc = col + ec;
          if (rr < 0 || rr >= grid.rows || cc < 0 || cc >= grid.cols) continue;
          const nz = grid.elevations[rr * grid.cols + cc];
          if (Number.isFinite(nz) && nz < localMin) localMin = nz;
        }
      }
      const drainsAwayM = z - localMin;
      const score = z + distanceM * 0.04 + drainsAwayM * DRAIN_PENALTY;
      if (score < bestScore) {
        bestScore = score;
        best = row * grid.cols + col;
        movedM = distanceM;
      }
    }
  }
  return best >= 0 ? { index: best, movedM } : null;
}

function bankOnSide(
  grid: TerrainWindow,
  origin: { eastM: number; northM: number },
  perpendicular: { east: number; north: number },
  sign: -1 | 1,
  waterLevelM: number
) {
  const stepM = grid.cellSizeM / 2;
  const limitM = Math.hypot(grid.rows, grid.cols) * grid.cellSizeM;
  let previousM = 0;
  let previousZ = grid.elevations[indexAtLocal(grid, origin.eastM, origin.northM)];
  for (let distanceM = stepM; distanceM <= limitM; distanceM += stepM) {
    const eastM = origin.eastM + perpendicular.east * distanceM * sign;
    const northM = origin.northM + perpendicular.north * distanceM * sign;
    const index = indexAtLocal(grid, eastM, northM);
    if (index < 0) return { distanceM: previousM, limited: true };
    const z = grid.elevations[index];
    if (!Number.isFinite(z)) return { distanceM: previousM, limited: true };
    if (z >= waterLevelM) {
      const dz = z - previousZ;
      const t = dz > 0 ? Math.max(0, Math.min(1, (waterLevelM - previousZ) / dz)) : 1;
      return { distanceM: previousM + (distanceM - previousM) * t, limited: false };
    }
    previousM = distanceM;
    previousZ = z;
  }
  return { distanceM: previousM, limited: true };
}

/**
 * One dam, fixed, so a stage curve describes a single reservoir.
 *
 * The bed cell and the two bank crossings ARE the structure. Re-deriving them
 * at every water level built a different dam for each point on the curve, and
 * the results stopped being nested: on a rugged fixture, raising the retained
 * level from 5 m to 10 m extended the inferred barrier from 40 m to 150 m,
 * disconnected terrain the shorter barrier had let water leak around, and the
 * flooded area FELL from 63,900 m² to 17,100 m² with storage falling from
 * 319,500 m³ to 160,200 m³. Over 20,000 randomized rugged grids, area went down
 * between adjacent stages 3,198 times. Water rising cannot shrink a reservoir;
 * only a moving dam can.
 */
export type PondageAxis = {
  bedIndex: number;
  bedMovedM: number;
  leftM: number;
  rightM: number;
  limited: boolean;
};

/**
 * The other half of the pondage question.
 *
 * Everything else in this file answers "how much water will this valley hold".
 * What a developer decides is whether that is ENOUGH, and the two are not the
 * same question. A peaking run-of-river plant in Nepal is defined by being able
 * to hold the night's flow back and run flat out through the evening peak; a
 * screened volume with nothing to compare it against cannot say whether the
 * site is one. This is the comparison.
 *
 * Single-average-day balance, which is all a level-pool terrain screen can
 * honestly support:
 *
 *   usable inflow          Qa = max(0, dry-season mean - residual release)
 *   deficit while peaking  Qd - Qa
 *   storage for h hours    (Qd - Qa) * h * 3600
 *
 * and the ceiling no pond can lift: a day delivers only Qa * 86400, so running
 * at Qd is sustainable for at most 24 * Qa / Qd hours however much is
 * impounded. That is reported separately on purpose. Without it a generous
 * valley reads as permission to peak longer than the river can supply, which is
 * the arithmetic error this whole function exists to prevent.
 *
 * Deliberately NOT a reservoir operation study. No ramping, no spill, no
 * turbine minimum, no drawdown rule, no seasonal carryover, no sediment
 * flushing allowance. One average day in the dry season.
 */
export type PondageDemand = {
  /** Dry-season mean flow at the intake, before the residual release. */
  dryInflowCms: number;
  /** What is left to the turbines once the residual release is passed on. */
  usableInflowCms: number;
  designFlowCms: number;
  /** Shortfall the pond has to cover while peaking; <= 0 needs no pond at all. */
  deficitCms: number;
  /** Storage to run at design flow for `referenceHours`, m3. */
  requiredM3: number;
  referenceHours: number;
  /** Hours at design flow the SCREENED pond covers; null when no pond is needed. */
  hoursSupported: number | null;
  /** Hours at design flow a day of inflow sustains, whatever is built. */
  inflowCeilingHours: number;
  /** The screened pond is larger than the dry-season river can refill in a day. */
  inflowLimited: boolean;
};

/**
 * Four hours is the reference, not a rule.
 *
 * It is the usual design point quoted for Nepali peaking run-of-river schemes
 * and it makes the required volume a number rather than a formula. `pondage-
 * Demand` reports `hoursSupported` alongside it precisely so the reader can
 * re-read the answer at whatever peak their own PPA defines.
 */
export const PONDAGE_REFERENCE_HOURS = 4;

export function pondageDemand(
  designFlowCms: number,
  residualCms: number,
  dryInflowCms: number,
  storedM3: number,
  referenceHours: number = PONDAGE_REFERENCE_HOURS
): PondageDemand | null {
  if (!Number.isFinite(designFlowCms) || designFlowCms <= 0) return null;
  if (!Number.isFinite(dryInflowCms) || dryInflowCms < 0) return null;
  if (!Number.isFinite(storedM3) || storedM3 < 0) return null;

  const usableInflowCms = Math.max(0, dryInflowCms - Math.max(0, residualCms || 0));
  const deficitCms = designFlowCms - usableInflowCms;
  const requiredM3 = deficitCms > 0 ? deficitCms * referenceHours * 3600 : 0;
  // Dividing by a deficit of zero is not an infinity, it is "no pond required".
  const hoursSupported = deficitCms > 0 ? storedM3 / (deficitCms * 3600) : null;
  const inflowCeilingHours = Math.min(24, (24 * usableInflowCms) / designFlowCms);

  return {
    dryInflowCms,
    usableInflowCms,
    designFlowCms,
    deficitCms,
    requiredM3,
    referenceHours,
    hoursSupported,
    inflowCeilingHours,
    inflowLimited: hoursSupported !== null && hoursSupported > inflowCeilingHours,
  };
}

/** Pure raster calculation, exported so synthetic terrain can be unit-tested. */
export function delineatePondage(
  grid: TerrainWindow,
  downstreamPoint: Point,
  damHeightM: number,
  /** Reuse a previously inferred axis instead of deriving a new one. */
  fixedAxis?: PondageAxis
): PondageResult {
  if (!(damHeightM > 0) || !Number.isFinite(damHeightM)) {
    throw new Error('Dam height must be a positive finite number.');
  }
  const downstream = metricVector(grid.center, downstreamPoint);
  if (!downstream) throw new Error('The dam axis needs a downstream river direction.');
  const bed = fixedAxis
    ? { index: fixedAxis.bedIndex, movedM: fixedAxis.bedMovedM }
    : findUpstreamBed(grid, downstream);
  if (!bed) throw new Error('No usable channel-floor cell was found at the intake.');

  const bedRow = Math.floor(bed.index / grid.cols);
  const bedCol = bed.index % grid.cols;
  const origin = localOf(grid, bedRow, bedCol);
  const bedElevationM = grid.elevations[bed.index];
  const waterLevelM = bedElevationM + damHeightM;
  const perpendicular = { east: -downstream.north, north: downstream.east };
  const left = fixedAxis
    ? { distanceM: fixedAxis.leftM, limited: fixedAxis.limited }
    : bankOnSide(grid, origin, perpendicular, -1, waterLevelM);
  const right = fixedAxis
    ? { distanceM: fixedAxis.rightM, limited: fixedAxis.limited }
    : bankOnSide(grid, origin, perpendicular, 1, waterLevelM);
  const damAxisLimited = left.limited || right.limited;
  const size = grid.rows * grid.cols;
  const flooded = new Uint8Array(size);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  flooded[bed.index] = 1;
  queue[tail++] = bed.index;

  let floodedCells = 0;
  let depthSumM = 0;
  let maxDepthM = 0;
  let upstreamLengthM = 0;
  let edgeLimited = false;
  let minRow = grid.rows;
  let maxRow = -1;
  let minCol = grid.cols;
  let maxCol = -1;
  const neighbours = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],             [0, 1],
    [1, -1],  [1, 0],  [1, 1],
  ] as const;

  while (head < tail) {
    const index = queue[head++];
    const row = Math.floor(index / grid.cols);
    const col = index % grid.cols;
    const z = grid.elevations[index];
    const depthM = waterLevelM - z;
    if (!(depthM > 0)) continue;
    floodedCells++;
    depthSumM += depthM;
    maxDepthM = Math.max(maxDepthM, depthM);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
    if (row === 0 || col === 0 || row === grid.rows - 1 || col === grid.cols - 1) {
      edgeLimited = true;
    }
    const p = localOf(grid, row, col);
    const alongM =
      (p.eastM - origin.eastM) * downstream.east +
      (p.northM - origin.northM) * downstream.north;
    const lateralM =
      (p.eastM - origin.eastM) * perpendicular.east +
      (p.northM - origin.northM) * perpendicular.north;
    upstreamLengthM = Math.max(upstreamLengthM, -alongM);

    for (const [dr, dc] of neighbours) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= grid.rows || nc < 0 || nc >= grid.cols) continue;
      const ni = nr * grid.cols + nc;
      if (flooded[ni]) continue;
      const np = localOf(grid, nr, nc);
      const downstreamM =
        (np.eastM - origin.eastM) * downstream.east +
        (np.northM - origin.northM) * downstream.north;
      if (damAxisLimited) {
        // If either abutment lies outside the DEM window, use a conservative
        // half-plane so the level pool cannot leak through the natural outlet.
        if (downstreamM > grid.cellSizeM * 0.5) continue;
      } else {
        // Insert a finite barrier between the two water-level bank crossings.
        // Blocking transitions across the axis (instead of deleting the whole
        // downstream half-plane) keeps connected water in a winding valley.
        const crossesAxis =
          (alongM <= 0 && downstreamM > 0) ||
          (alongM > 0 && downstreamM <= 0);
        if (crossesAxis) {
          const t = -alongM / (downstreamM - alongM);
          const nextLateralM =
            (np.eastM - origin.eastM) * perpendicular.east +
            (np.northM - origin.northM) * perpendicular.north;
          const crossingLateralM = lateralM + (nextLateralM - lateralM) * t;
          const joinToleranceM = grid.cellSizeM * 0.75;
          if (
            crossingLateralM >= -left.distanceM - joinToleranceM &&
            crossingLateralM <= right.distanceM + joinToleranceM
          ) {
            continue;
          }
        }
      }
      const nz = grid.elevations[ni];
      if (!Number.isFinite(nz) || nz >= waterLevelM) continue;
      flooded[ni] = 1;
      queue[tail++] = ni;
    }
  }

  // The seed is marked before its elevation check. Clear it in the impossible
  // case rather than drawing one false cell.
  if (floodedCells === 0) flooded[bed.index] = 0;

  let shorelineEdges = 0;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const i = row * grid.cols + col;
      if (!flooded[i]) continue;
      if (row === 0 || !flooded[(row - 1) * grid.cols + col]) shorelineEdges++;
      if (row === grid.rows - 1 || !flooded[(row + 1) * grid.cols + col]) shorelineEdges++;
      if (col === 0 || !flooded[row * grid.cols + col - 1]) shorelineEdges++;
      if (col === grid.cols - 1 || !flooded[row * grid.cols + col + 1]) shorelineEdges++;
    }
  }

  const damAxis =
    left.distanceM > 0 && right.distanceM > 0
      ? {
          from: coordinateOf(
            grid,
            origin.eastM - perpendicular.east * left.distanceM,
            origin.northM - perpendicular.north * left.distanceM
          ),
          to: coordinateOf(
            grid,
            origin.eastM + perpendicular.east * right.distanceM,
            origin.northM + perpendicular.north * right.distanceM
          ),
        }
      : null;

  const latStep = grid.cellSizeM / 111_320;
  const lonStep =
    grid.cellSizeM /
    (111_320 * Math.max(0.01, Math.cos((grid.center.lat * Math.PI) / 180)));
  const floodedBounds =
    maxRow >= 0
      ? {
          north: grid.center.lat + (Math.floor(grid.rows / 2) - minRow + 0.5) * latStep,
          south: grid.center.lat + (Math.floor(grid.rows / 2) - maxRow - 0.5) * latStep,
          west: grid.center.lon + (minCol - Math.floor(grid.cols / 2) - 0.5) * lonStep,
          east: grid.center.lon + (maxCol - Math.floor(grid.cols / 2) + 0.5) * lonStep,
        }
      : null;
  const cellAreaM2 = grid.cellSizeM * grid.cellSizeM;

  return {
    damHeightM,
    bedElevationM,
    waterLevelM,
    areaM2: floodedCells * cellAreaM2,
    volumeM3: depthSumM * cellAreaM2,
    meanDepthM: floodedCells ? depthSumM / floodedCells : 0,
    maxDepthM,
    shorelineM: shorelineEdges * grid.cellSizeM,
    upstreamLengthM,
    damLengthM: damAxisLimited ? null : left.distanceM + right.distanceM,
    // The structure this result was computed against, so a stage curve can hold
    // it fixed rather than inferring a different dam at every water level.
    axis: {
      bedIndex: bed.index,
      bedMovedM: bed.movedM,
      leftM: left.distanceM,
      rightM: right.distanceM,
      limited: damAxisLimited,
    },
    seedMovedM: bed.movedM,
    floodedCells,
    flooded,
    grid,
    edgeLimited,
    damAxisLimited,
    damAxis,
    floodedBounds,
    source: grid.source,
    resolutionM: grid.resolutionM,
    radiusKm:
      (Math.floor(grid.rows / 2) * grid.cellSizeM) / 1000,
  };
}

/**
 * Repeat the same connected, dam-bounded calculation at operating stages.
 * This is the standard stage-area-storage view used by reservoir tools; it is
 * more informative than pretending the selected crest level is the only
 * possible operating point.
 */
export function pondageStageCurve(
  grid: TerrainWindow,
  downstreamPoint: Point,
  retainedHeightM: number,
  fullStage?: PondageResult
): PondageStagePoint[] {
  const full =
    fullStage &&
    fullStage.grid === grid &&
    Math.abs(fullStage.damHeightM - retainedHeightM) < 1e-9
      ? fullStage
      : delineatePondage(grid, downstreamPoint, retainedHeightM);
  const points: PondageStagePoint[] = [
    {
      retainedHeightM: 0,
      waterLevelM: full.bedElevationM,
      areaM2: 0,
      volumeM3: 0,
      edgeLimited: false,
    },
  ];
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    // `full.axis`: one dam, every stage. Deriving the barrier afresh per stage
    // made the curve non-monotonic — see PondageAxis for the measured case.
    const result =
      fraction === 1
        ? full
        : delineatePondage(grid, downstreamPoint, retainedHeightM * fraction, full.axis);
    points.push({
      retainedHeightM: result.damHeightM,
      waterLevelM: result.waterLevelM,
      areaM2: result.areaM2,
      volumeM3: result.volumeM3,
      edgeLimited: result.edgeLimited,
    });
  }
  return points;
}

const pairSpreadPct = (a: number, b: number) => {
  const mean = (Math.abs(a) + Math.abs(b)) / 2;
  return mean > 0 ? (Math.abs(a - b) / mean) * 100 : 0;
};

/**
 * Screen one named source. A 6 km first window provides the five-kilometre
 * circular ruggedness context used by the validation literature. It expands to
 * 10 km when the connected pool reaches the edge.
 */
async function screenPondageSource(
  dam: Point,
  downstreamPoint: Point,
  damHeightM: number,
  source: TerrainSourceId
): Promise<PondageResult> {
  let result: PondageResult | null = null;
  for (const radiusKm of [6, 10]) {
    const grid = await terrainFor(dam, radiusKm, source);
    result = delineatePondage(grid, downstreamPoint, damHeightM);
    if (!result.edgeLimited) return result;
  }
  return result!;
}

/**
 * WHERE ALONG THE REACH THE STORAGE ACTUALLY IS.
 *
 * `screenPondage` answers "how much water will this valley hold" at ONE point —
 * the intake the search happened to choose, which was chosen for head and flow
 * and knows nothing about storage. A valley narrows and widens every few
 * hundred metres, so the pond that a site can hold varies far more with WHERE
 * the dam goes than with how tall it is, and the app had no way to say so.
 *
 * THE METRIC IS STORAGE PER METRE OF DAM, not storage.
 *
 * Raw volume always rewards moving downstream, because the catchment and the
 * valley both grow — so a sweep reported on volume alone would simply point at
 * the far end of the reach every time, which is not advice. What makes a
 * pondage site cheap is holding a lot of water behind a short structure, and
 * `damLengthM` is the bank-to-bank span the same delineation already infers.
 * Volume over span is a number the ground decides and no cost model is needed
 * to read it — which matters, because this app has no cost model and inventing
 * one on top of a flow that carries 1.6x would be false precision.
 *
 * IT IS A SCREEN ON TOP OF A SCREEN. Every caveat on `screenPondage` applies to
 * every point here and compounds: a 30 m DEM, a level-pool fill, no spillway,
 * no geology, no land take. `edgeLimited` points are minima. What the sweep is
 * for is ranking positions against each other on one consistent basis, not
 * sizing any of them.
 */
export type PondagePositionPoint = {
  /** Index into the study path. */
  i: number;
  lat: number;
  lon: number;
  /** Distance from the current intake along the river, km. Negative upstream. */
  offsetKm: number;
  areaM2: number;
  volumeM3: number;
  bedElevationM: number;
  /** Bank-to-bank span the fill implies, m. Null where a bank was not found. */
  damLengthM: number | null;
  /** Cubic metres held per metre of dam. The ranking number. */
  volumePerDamMetreM3: number | null;
  /** The fill touched the terrain window edge, so area and volume are minima. */
  edgeLimited: boolean;
};

export type PondagePositionSweep = {
  points: PondagePositionPoint[];
  /** The point the scheme currently sits on, if the sweep covered it. */
  current: PondagePositionPoint | null;
  /** Best storage per metre of dam among the points that are not edge-limited. */
  best: PondagePositionPoint | null;
  damHeightM: number;
  source: string;
  /** How many candidates were asked for and how many returned an answer. */
  asked: number;
};

/** How far up and down the reach to look, and how many stops to make. */
const SWEEP_SPAN_KM = 3;
const SWEEP_SAMPLES = 9;

export async function sweepPondagePosition(
  path: readonly { lat: number; lon: number; km: number }[],
  currentIndex: number,
  damHeightM: number,
  options?: { spanKm?: number; samples?: number; signal?: AbortSignal }
): Promise<PondagePositionSweep | null> {
  if (path.length < 3 || currentIndex < 0 || currentIndex >= path.length) return null;
  if (!(damHeightM > 0)) return null;
  const spanKm = options?.spanKm ?? SWEEP_SPAN_KM;
  const samples = Math.max(3, options?.samples ?? SWEEP_SAMPLES);
  const originKm = path[currentIndex].km;

  // Candidate indices, evenly spread in CHAINAGE rather than in index, because
  // the path is not always evenly spaced and an index sweep would bunch.
  const wanted = new Set<number>([currentIndex]);
  for (let k = 0; k < samples; k++) {
    const targetKm = originKm - spanKm + (2 * spanKm * k) / (samples - 1);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < path.length - 2; i++) {
      const d = Math.abs(path[i].km - targetKm);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) wanted.add(best);
  }
  const candidates = [...wanted].sort((a, b) => a - b);

  const points: PondagePositionPoint[] = [];
  for (const i of candidates) {
    if (options?.signal?.aborted) break;
    const dam = path[i];
    const downstream = path[Math.min(path.length - 1, i + 2)];
    if (!downstream || (downstream.lat === dam.lat && downstream.lon === dam.lon)) continue;
    try {
      // The PRIMARY source only, and one radius. A second opinion and a wider
      // retry are what `screenPondage` spends its time on, and neither changes
      // the ranking this function exists to produce.
      const grid = await terrainFor(dam, 6, PRIMARY_TERRAIN_SOURCE_ID);
      const r = delineatePondage(grid, downstream, damHeightM);
      points.push({
        i,
        lat: dam.lat,
        lon: dam.lon,
        offsetKm: dam.km - originKm,
        areaM2: r.areaM2,
        volumeM3: r.volumeM3,
        bedElevationM: r.bedElevationM,
        damLengthM: r.damLengthM,
        volumePerDamMetreM3:
          r.damLengthM && r.damLengthM > 0 ? r.volumeM3 / r.damLengthM : null,
        edgeLimited: r.edgeLimited,
      });
    } catch {
      // A position whose terrain will not load is dropped, not guessed at.
    }
  }
  if (points.length < 3) return null;

  const usable = points.filter((q) => !q.edgeLimited && q.volumePerDamMetreM3 !== null);
  const best = usable.length
    ? usable.reduce((a, b) => (b.volumePerDamMetreM3! > a.volumePerDamMetreM3! ? b : a))
    : null;

  return {
    points,
    current: points.find((q) => q.i === currentIndex) ?? null,
    best,
    damHeightM,
    source: PRIMARY_TERRAIN_SOURCE_ID,
    asked: candidates.length,
  };
}

/**
 * How far the water level has to be wrong before the answer is, in metres.
 *
 * A pondage is `{cells whose elevation is below bed + retained height}`, so
 * what governs it is the DIFFERENCE between each cell's elevation and the bed
 * cell's — a short baseline, within one raster, over a few hundred metres. That
 * is the error regime engine/corridor.ts relies on and probe:dem measures: the
 * absolute elevation of a radar DEM can be a dozen metres out and still give a
 * short-range difference good to a few metres, because the large errors are
 * strongly correlated at short range and cancel in the subtraction.
 *
 * Three metres is the honest figure for that on a 30 m product over this
 * distance. It is NOT the ±15 m absolute error quoted elsewhere in the app —
 * using that here would be double-counting a term the subtraction removes.
 */
const LEVEL_ERROR_M = 3;

export type PondageLevelSensitivity = {
  /** The perturbation applied, m. */
  errorM: number;
  areaLowM2: number;
  areaHighM2: number;
  volumeLowM3: number;
  volumeHighM3: number;
  /** Half-range as a percentage of the central figure. */
  areaSpreadPct: number;
  volumeSpreadPct: number;
};

/**
 * What a plausible error in the water level does to the answer.
 *
 * This is the honest alternative to running the fill twice and averaging: two
 * flood-fill variants over ONE elevation surface share every dominant error —
 * the DEM, the seed, the axis, the 30 m quantisation — so they agree closely
 * and corroborate nothing. Perturbing the level says how much the result rests
 * on terrain being right, which is the question a reader actually has.
 *
 * The axis is held fixed across the perturbation for the same reason it is held
 * fixed across a stage curve: otherwise this measures a moving dam.
 */
function levelSensitivity(
  grid: TerrainWindow,
  downstreamPoint: Point,
  damHeightM: number,
  central: PondageResult
): PondageLevelSensitivity | null {
  const at = (h: number) => {
    if (!(h > 0)) return null;
    try {
      return delineatePondage(grid, downstreamPoint, h, central.axis);
    } catch {
      return null;
    }
  };
  const low = at(damHeightM - LEVEL_ERROR_M);
  const high = at(damHeightM + LEVEL_ERROR_M);
  if (!low || !high) return null;
  const half = (a: number, b: number, mid: number) =>
    mid > 0 ? (100 * Math.abs(b - a)) / 2 / mid : 0;
  return {
    errorM: LEVEL_ERROR_M,
    areaLowM2: low.areaM2,
    areaHighM2: high.areaM2,
    volumeLowM3: low.volumeM3,
    volumeHighM3: high.volumeM3,
    areaSpreadPct: half(low.areaM2, high.areaM2, central.areaM2),
    volumeSpreadPct: half(low.volumeM3, high.volumeM3, central.volumeM3),
  };
}

/**
 * Run the proposed pond on both live terrain source chains. The preferred
 * Mapterhorn result supplies the map; the second result is retained as a
 * site-specific disagreement diagnostic, not mislabeled as a confidence band.
 */
export async function screenPondage(
  dam: Point,
  downstreamPoint: Point,
  damHeightM: number
): Promise<PondageResult> {
  const attempts = await Promise.allSettled(
    (await screenTerrainSources()).map((source) =>
      screenPondageSource(dam, downstreamPoint, damHeightM, source)
    )
  );
  const results = attempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : []
  );
  if (results.length === 0) {
    throw new Error('No terrain data covers the pondage window.');
  }

  const primary =
    results.find((result) => result.source === PRIMARY_TERRAIN_SOURCE_ID) ?? results[0];
  const second = results.find((result) => result.source !== primary.source);

  /**
   * CHANGE THE ELEVATION SURFACE AND NOTHING ELSE.
   *
   * Each source used to rediscover its own bed cell, its own bank crossings and
   * its own barrier, so the "terrain comparison" mixed two different questions:
   * how much the ground disagrees, and how much a re-inferred dam disagrees.
   * A reader shown a 40% spread could not tell which they were looking at, and
   * the second one is not a property of the terrain at all.
   *
   * Re-running the second source against the PRIMARY's axis makes it the
   * measurement it claims to be. Both windows are built at the same centre,
   * radius and 30 m spacing, so a cell index means the same place in each.
   */
  const sameAxisSecond =
    second && second.grid.rows === primary.grid.rows && second.grid.cols === primary.grid.cols
      ? (() => {
          try {
            return delineatePondage(second.grid, downstreamPoint, damHeightM, primary.axis);
          } catch {
            // A fixed axis can be unusable on the other surface; fall back to
            // the independent result rather than reporting nothing.
            return second;
          }
        })()
      : second;

  const terrainComparison: PondageTerrainComparison | null = sameAxisSecond
    ? {
        source: second!.source,
        bedElevationM: sameAxisSecond.bedElevationM,
        waterLevelM: sameAxisSecond.waterLevelM,
        areaM2: sameAxisSecond.areaM2,
        volumeM3: sameAxisSecond.volumeM3,
        edgeLimited: sameAxisSecond.edgeLimited,
        areaSpreadPct: pairSpreadPct(primary.areaM2, sameAxisSecond.areaM2),
        volumeSpreadPct: pairSpreadPct(primary.volumeM3, sameAxisSecond.volumeM3),
        /** True when the comparison could hold the dam fixed, as intended. */
        sameAxis: sameAxisSecond !== second,
      }
    : null;

  return {
    ...primary,
    stageCurve: pondageStageCurve(primary.grid, downstreamPoint, damHeightM, primary),
    terrainComparison,
    levelSensitivity: levelSensitivity(primary.grid, downstreamPoint, damHeightM, primary),
    ruggedness: pondageRuggedness(primary.grid, 5),
  };
}

type GeoJsonFeature = {
  type: 'Feature';
  properties: Record<string, string | number | boolean | null>;
  geometry:
    | { type: 'MultiPolygon'; coordinates: number[][][][] }
    | { type: 'LineString'; coordinates: number[][] };
};

/**
 * Turn the raster mask into vertically merged rectangles. This preserves the
 * exact screened cells while avoiding one GeoJSON polygon per 30 m pixel.
 */
export function pondageGeoJson(result: PondageResult): {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
} {
  type Rect = { r0: number; r1: number; c0: number; c1: number };
  const rectangles: Rect[] = [];
  let active = new Map<string, Rect>();
  for (let row = 0; row < result.grid.rows; row++) {
    const runs: { c0: number; c1: number }[] = [];
    let col = 0;
    while (col < result.grid.cols) {
      while (col < result.grid.cols && !result.flooded[row * result.grid.cols + col]) col++;
      if (col >= result.grid.cols) break;
      const c0 = col;
      while (col + 1 < result.grid.cols && result.flooded[row * result.grid.cols + col + 1]) col++;
      runs.push({ c0, c1: col });
      col++;
    }
    const next = new Map<string, Rect>();
    for (const run of runs) {
      const key = `${run.c0}:${run.c1}`;
      const prior = active.get(key);
      next.set(key, prior ? { ...prior, r1: row } : { r0: row, r1: row, ...run });
    }
    for (const [key, rect] of active) if (!next.has(key)) rectangles.push(rect);
    active = next;
  }
  rectangles.push(...active.values());

  const latStep = result.grid.cellSizeM / 111_320;
  const lonStep =
    result.grid.cellSizeM /
    (111_320 * Math.max(0.01, Math.cos((result.grid.center.lat * Math.PI) / 180)));
  const rowMid = Math.floor(result.grid.rows / 2);
  const colMid = Math.floor(result.grid.cols / 2);
  const polygons = rectangles.map((rect) => {
    const north = result.grid.center.lat + (rowMid - rect.r0 + 0.5) * latStep;
    const south = result.grid.center.lat + (rowMid - rect.r1 - 0.5) * latStep;
    const west = result.grid.center.lon + (rect.c0 - colMid - 0.5) * lonStep;
    const east = result.grid.center.lon + (rect.c1 - colMid + 0.5) * lonStep;
    // Counterclockwise in lon/lat, per RFC 7946 §3.1.6 for exterior rings.
    return [[[west, south], [east, south], [east, north], [west, north], [west, south]]];
  });

  const features: GeoJsonFeature[] = [
    {
      type: 'Feature',
      properties: {
        kind: 'pondage',
        damHeightM: result.damHeightM,
        areaM2: result.areaM2,
        volumeM3: result.volumeM3,
        edgeLimited: result.edgeLimited,
        secondTerrainSource: result.terrainComparison?.source ?? null,
        secondTerrainAreaM2: result.terrainComparison?.areaM2 ?? null,
        secondTerrainVolumeM3: result.terrainComparison?.volumeM3 ?? null,
        terrainAreaSpreadPct: result.terrainComparison?.areaSpreadPct ?? null,
        terrainVolumeSpreadPct: result.terrainComparison?.volumeSpreadPct ?? null,
        terrainTriStdDevM: result.ruggedness?.triStdDevM ?? null,
      },
      geometry: { type: 'MultiPolygon', coordinates: polygons },
    },
  ];
  if (result.damAxis) {
    features.push({
      type: 'Feature',
      properties: {
        kind: 'dam-axis',
        damHeightM: result.damHeightM,
        damLengthM: result.damLengthM,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [result.damAxis.from.lon, result.damAxis.from.lat],
          [result.damAxis.to.lon, result.damAxis.to.lat],
        ],
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
