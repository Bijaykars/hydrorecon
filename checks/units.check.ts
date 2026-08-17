import assert from 'node:assert/strict';
import { annualEnergy, netHead, powerDurationSummary, type PlantParams } from '../src/engine/hydro.ts';
import { turbineCurve } from '../src/engine/turbine.ts';
import {
  UNIT_SENSITIVITY_GUIDANCE,
  unitCountSensitivity,
} from '../src/engine/units.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};
const near = (a: number, b: number, rel = 1e-9) =>
  assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${a} != ${b}`);

console.log('\nidentical-unit operating sensitivity');

const series = [...new Array(200).fill(20), ...new Array(165).fill(4)];
const common = {
  seriesCms: series,
  grossHeadM: 100,
  headLossFrac: 0.05,
  totalDesignFlowCms: 20,
  residualFlowCms: 0,
  generatorTransformerEfficiency: 0.96,
  fallbackMinFlowFrac: 0.2,
};

ok('the default sensitivity evaluates one through four equal-rated units', () => {
  const result = unitCountSensitivity(common);
  assert.deepEqual(result.map((scenario) => scenario.units), [1, 2, 3, 4]);
  for (const scenario of result) {
    assert.equal(scenario.days, 365);
    assert.ok(scenario.unitDesignFlowCms > 0);
    assert.ok(scenario.capacityMW > 0);
  }
});

ok('the one-unit row reproduces the headline dispatch exactly', () => {
  const one = unitCountSensitivity(common)[0];
  const curve = turbineCurve(common.totalDesignFlowCms, 95)!;
  const params: PlantParams = {
    grossHeadM: common.grossHeadM,
    headLossFrac: common.headLossFrac,
    efficiency: curve.peak * common.generatorTransformerEfficiency,
    efficiencyAt: (flow) => curve.at(flow) * common.generatorTransformerEfficiency,
    designFlowCms: common.totalDesignFlowCms,
    residualFlowCms: common.residualFlowCms,
    minFlowFrac: curve.minFlowFrac,
  };
  const energy = annualEnergy(series, params);
  const duration = powerDurationSummary(series, params)!;
  near(one.capacityMW, energy.ratedPowerW / 1e6);
  near(one.energyGwh, energy.gwhPerYear);
  near(one.dailyP90MW, duration.dailyP90W / 1e6);
  near(one.dailyP95MW, duration.dailyP95W / 1e6);
});

ok('multiple smaller units reveal low-flow output hidden by a single Francis shutdown', () => {
  const [one, two] = unitCountSensitivity(common);
  assert.equal(one.turbine, 'Francis');
  assert.equal(one.dailyP90MW, 0);
  assert.ok(two.dailyP90MW > 0, `two-unit P90 was ${two.dailyP90MW}`);
  assert.ok(two.energyGwh > one.energyGwh, `${two.energyGwh} <= ${one.energyGwh}`);
  assert.ok(two.zeroOutputFraction < one.zeroOutputFraction);
});

ok('every scenario stays ordered and below its own rated capacity', () => {
  for (const scenario of unitCountSensitivity(common)) {
    assert.ok(scenario.dailyP95MW <= scenario.dailyP90MW + 1e-12);
    assert.ok(scenario.dailyP90MW <= scenario.capacityMW + 1e-12);
    assert.ok(scenario.plantFactor >= 0 && scenario.plantFactor <= 1);
  }
  assert.equal(netHead({ grossHeadM: common.grossHeadM, headLossFrac: common.headLossFrac }), 95);
});

ok('invalid inputs fail closed and method metadata forbids a free equipment recommendation', () => {
  assert.deepEqual(unitCountSensitivity({ ...common, seriesCms: [] }), []);
  assert.deepEqual(unitCountSensitivity({ ...common, totalDesignFlowCms: 0 }), []);
  assert.match(UNIT_SENSITIVITY_GUIDANCE.method, /equal-rated identical-unit sensitivity/i);
  assert.match(UNIT_SENSITIVITY_GUIDANCE.interpretation, /not a selected unit arrangement.*cost optimum.*firm-capacity.*transient study/i);
  assert.match(UNIT_SENSITIVITY_GUIDANCE.nepalOperatingCase, /hydropower\.org\/sediment-management-case-studies\/nepal-jhimruk/);
});

console.log(`\n${passed} unit-sensitivity checks passed\n`);
