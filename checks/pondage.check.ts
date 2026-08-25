/** Synthetic checks for the connected, dam-bounded pondage calculation. */
import assert from 'node:assert/strict';
import type { TerrainWindow } from '../src/api.ts';
import {
  delineatePondage,
  pondageDemand,
  pondageGeoJson,
  pondageRuggedness,
  pondageStageCurve,
} from '../src/pondage.ts';

const grid = (channelStartsAtCol = 5): TerrainWindow => {
  const rows = 21;
  const cols = 21;
  const elevations = new Float32Array(rows * cols).fill(20);
  // Three-cell-wide upstream channel/bowl. East is downstream.
  for (let row = 9; row <= 11; row++) {
    for (let col = channelStartsAtCol; col <= 10; col++) {
      elevations[row * cols + col] = 2;
    }
  }
  elevations[10 * cols + 10] = 0; // thalweg at the proposed dam
  // A low pocket below water level, but isolated behind high ground.
  for (let row = 2; row <= 3; row++) {
    for (let col = 2; col <= 3; col++) elevations[row * cols + col] = 1;
  }
  return {
    center: { lat: 28, lon: 84 },
    rows,
    cols,
    elevations,
    cellSizeM: 30,
    north: 28.003,
    south: 27.997,
    east: 84.003,
    west: 83.997,
    source: 'synthetic DEM',
    zoom: 12,
    resolutionM: 30,
    tilesFetched: 0,
  };
};

const result = delineatePondage(
  grid(),
  { lat: 28, lon: 84.001 }, // due east = downstream
  10
);

assert.equal(result.bedElevationM, 0, 'the nearby channel floor sets the height datum');
assert.equal(result.waterLevelM, 10);
assert.equal(result.floodedCells, 18, 'only the connected upstream bowl is retained');
assert.equal(result.areaM2, 18 * 30 * 30);
assert.equal(result.volumeM3, (10 + 17 * 8) * 30 * 30);
assert.equal(result.edgeLimited, false);
assert.ok(result.damLengthM && result.damLengthM > 30, 'the two banks define a dam span');

const curve = pondageStageCurve(result.grid, { lat: 28, lon: 84.001 }, 10, result);
assert.deepEqual(curve.map((point) => point.retainedHeightM), [0, 2.5, 5, 7.5, 10]);
assert.equal(curve.at(-1)?.areaM2, result.areaM2);
assert.equal(curve.at(-1)?.volumeM3, result.volumeM3);
for (let i = 1; i < curve.length; i++) {
  assert.ok(curve[i].areaM2 >= curve[i - 1].areaM2, 'stage-area must not decrease');
  assert.ok(curve[i].volumeM3 >= curve[i - 1].volumeM3, 'stage-storage must not decrease');
}

const flat = grid();
flat.elevations.fill(20);
assert.equal(pondageRuggedness(flat).triStdDevM, 0, 'flat terrain has no TRI variability');
assert.ok(pondageRuggedness(result.grid).triStdDevM > 0, 'relief produces a TRI warning signal');

// The first downstream channel cell is low, but the inserted dam plane blocks it.
const downstreamIndex = 10 * result.grid.cols + 11;
assert.equal(result.flooded[downstreamIndex], 0, 'water cannot leak through the natural outlet');
// Nor may a disconnected low depression elsewhere in the DEM appear as pondage.
assert.equal(result.flooded[2 * result.grid.cols + 2], 0, 'low but disconnected terrain stays dry');

// A river can bend back across the dam's geometric downstream half-plane while
// remaining hydraulically behind the abutment. The finite dam segment must keep
// that connected arm; an infinite half-plane would silently understate it.
const winding = grid();
for (const [row, col] of [[8, 9], [7, 9], [7, 10], [7, 11], [7, 12]]) {
  winding.elevations[row * winding.cols + col] = 2;
}
const windingResult = delineatePondage(winding, { lat: 28, lon: 84.001 }, 10);
assert.equal(
  windingResult.flooded[7 * winding.cols + 12],
  1,
  'a connected upstream arm may bend across the downstream half-plane outside the dam axis'
);
assert.equal(
  windingResult.flooded[downstreamIndex],
  0,
  'the finite barrier still closes the direct river outlet'
);

const mapped = pondageGeoJson(result);
assert.ok(mapped.features.some((f) => f.properties.kind === 'pondage'));
assert.ok(mapped.features.some((f) => f.properties.kind === 'dam-axis'));
const water = mapped.features.find((f) => f.properties.kind === 'pondage')!;
assert.equal(water.geometry.type, 'MultiPolygon');
assert.ok(water.geometry.coordinates.length < result.floodedCells, 'row runs are merged for the map');

const clipped = delineatePondage(grid(0), { lat: 28, lon: 84.001 }, 10);
assert.equal(clipped.edgeLimited, true, 'a reservoir reaching the DEM edge is flagged as a minimum');

assert.throws(() => delineatePondage(grid(), { lat: 28, lon: 84.001 }, 0), /positive/);
assert.throws(() => delineatePondage(grid(), { lat: 28, lon: 84 }, 10), /direction/);

/**
 * A STAGE CURVE MUST DESCRIBE ONE RESERVOIR.
 *
 * Smooth surfaces pass this trivially, which is why the defect survived: the
 * axis only moves where the banks are rough enough for a higher water level to
 * find a different crossing. On rugged ground the barrier was rebuilt at every
 * stage, so a higher dam could enclose LESS water than a lower one.
 *
 * The A/B is kept in the assertion rather than described in a comment, because
 * a fixture that cannot reproduce the bug proves nothing about the fix.
 */
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rugged = () => {
    const rows = 17;
    const cols = 17;
    const elevations = new Float64Array(rows * cols);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        elevations[r * cols + c] = 100 + Math.abs(c - 8) * 4 + rnd() * 18 - r * 0.5;
    return { rows, cols, cellSizeM: 30, center: { lat: 28, lon: 84 }, elevations };
  };

  const sweep = (holdAxis: boolean) => {
    seed = 12345;
    let backwards = 0;
    let cases = 0;
    for (let t = 0; t < 1500; t++) {
      const g = rugged();
      const down = { lat: 27.995, lon: 84 };
      try {
        const full = delineatePondage(g, down, 10);
        const stages = [2.5, 5, 7.5, 10].map((h) =>
          h === 10 ? full : delineatePondage(g, down, h, holdAxis ? full.axis : undefined)
        );
        cases++;
        for (let i = 1; i < stages.length; i++) {
          if (
            stages[i].areaM2 < stages[i - 1].areaM2 - 1e-6 ||
            stages[i].volumeM3 < stages[i - 1].volumeM3 - 1e-6
          ) {
            backwards++;
          }
        }
      } catch {
        // A fixture with no usable bed proves nothing either way.
      }
    }
    return { cases, backwards };
  };

  const moving = sweep(false);
  const fixed = sweep(true);
  assert.ok(moving.cases > 100, 'the sweep needs usable fixtures to mean anything');
  assert.ok(
    moving.backwards > 0,
    'this fixture must be able to reproduce a moving-axis reversal, or it is not testing the fix'
  );
  assert.equal(fixed.backwards, 0, 'a fixed axis must give a nondecreasing stage-area-storage curve');
  console.log(
    `  stage curve: moving axis reversed ${moving.backwards}× over ${moving.cases} rugged fixtures, fixed axis 0×`
  );
}

/**
 * The daily peaking balance.
 *
 * Two things have to hold or the readout misleads: a pond may never be reported
 * as covering more peak hours than the river refills in a day, and a river that
 * already exceeds design flow may never be reported as needing storage.
 */
{
  // 5 m3/s design, 0.3 residual, 2.0 dry-month mean -> 1.7 usable, 3.3 deficit.
  const d = pondageDemand(5, 0.3, 2.0, 90_000)!;
  assert.ok(d, 'a well-posed peaking case must produce an answer');
  assert.equal(Number(d.usableInflowCms.toFixed(6)), 1.7);
  assert.equal(Number(d.deficitCms.toFixed(6)), 3.3);
  // 4 h at a 3.3 m3/s deficit = 3.3 * 4 * 3600.
  assert.equal(Math.round(d.requiredM3), Math.round(3.3 * 4 * 3600));
  // 90,000 m3 against the same deficit is 7.58 h.
  assert.equal(Number(d.hoursSupported!.toFixed(4)), Number((90_000 / (3.3 * 3600)).toFixed(4)));
  // A day carries 1.7 m3/s, so 5 m3/s runs for 24 * 1.7 / 5 = 8.16 h at most.
  assert.equal(Number(d.inflowCeilingHours.toFixed(4)), 8.16);
  assert.equal(d.inflowLimited, false, '7.58 h of storage sits under the 8.16 h inflow ceiling');

  // A pond far larger than the river can refill must say so rather than promise
  // hours the inflow cannot deliver.
  const big = pondageDemand(5, 0.3, 2.0, 100_000_000)!;
  assert.ok(big.hoursSupported! > big.inflowCeilingHours);
  assert.equal(big.inflowLimited, true, 'an unrefillable pond must be flagged inflow-limited');

  // A river already above design flow needs no storage, and must not divide by
  // a zero deficit.
  const plenty = pondageDemand(1, 0.3, 9, 50_000)!;
  assert.equal(plenty.requiredM3, 0);
  assert.equal(plenty.hoursSupported, null, 'no deficit means no hours figure, not Infinity');
  assert.equal(plenty.inflowLimited, false);
  assert.equal(plenty.inflowCeilingHours, 24, 'the ceiling is a day, never more');

  // Nonsense in, nothing out.
  assert.equal(pondageDemand(0, 0.3, 2, 1000), null);
  assert.equal(pondageDemand(5, 0.3, Number.NaN, 1000), null);

  console.log(
    `  peaking balance: needs ${(d.requiredM3 / 1e6).toFixed(3)} Mm3 for ${d.referenceHours} h, ` +
      `pond covers ${d.hoursSupported!.toFixed(1)} h, inflow ceiling ${d.inflowCeilingHours.toFixed(1)} h`
  );
}

console.log('pondage.check ok');
console.log(
  `  ${(result.areaM2 / 10_000).toFixed(2)} ha, ${(result.volumeM3 / 1e6).toFixed(3)} Mm3; ` +
    'downstream outlet and isolated pocket excluded, edge truncation detected'
);
