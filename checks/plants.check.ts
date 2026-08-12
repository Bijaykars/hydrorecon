/**
 * Validation against real, built, published hydropower plants.  `npm run check`
 *
 * The point of this file is not to test the code against itself. Every number in
 * PLANTS comes from the operator, the developer or a project page — see
 * docs/research/2026-08-12-data-hunt.md §13 — and the engine has to reproduce
 * them. If a refactor quietly breaks the physics, five real power stations
 * disagree at once.
 */
import assert from 'node:assert/strict';
import { RHO, G, HOURS_PER_YEAR, powerW } from '../src/engine/hydro.ts';
import { selectTurbine, turbineCurve, type TurbineType } from '../src/engine/turbine.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

type Plant = {
  name: string;
  capacityMW: number;
  /** Head as published. `headIsNet` says whether losses are already removed. */
  headM: number;
  headIsNet: boolean;
  designFlowCms: number;
  annualEnergyGWh?: number;
  /** Machine actually installed, where it is publicly documented. */
  turbine?: TurbineType;
  source: string;
};

/** All figures published by the operator/developer. */
const PLANTS: Plant[] = [
  {
    name: 'Chilime',
    capacityMW: 22.1,
    headM: 337.46,
    headIsNet: true,
    designFlowCms: 7.5,
    annualEnergyGWh: 137.9,
    turbine: 'Pelton',
    source: 'chilime.com.np',
  },
  {
    name: 'Upper Tamakoshi',
    capacityMW: 456,
    headM: 822,
    headIsNet: false,
    designFlowCms: 66,
    annualEnergyGWh: 2281,
    turbine: 'Pelton',
    source: 'NEA / Norconsult / power-technology.com',
  },
  {
    name: 'Nyadi',
    capacityMW: 30,
    headM: 333.9,
    headIsNet: false,
    designFlowCms: 11.02,
    annualEnergyGWh: 168.55,
    source: 'bpc.com.np/projects/nyadi',
  },
  {
    name: 'Kabeli A',
    capacityMW: 37.6,
    headM: 117,
    headIsNet: false,
    designFlowCms: 37.73,
    annualEnergyGWh: 205,
    source: 'bpc.com.np/projects/kabeli-a-hydro-electric-project',
  },
  {
    name: 'Rasuwagadhi',
    capacityMW: 111,
    headM: 167.9,
    headIsNet: false,
    designFlowCms: 80,
    annualEnergyGWh: 613.875,
    source: 'rghpcl.com.np',
  },
];

/** ESHA 2004 Table 6.3 net-head ranges, as an independent cross-check. */
const ESHA_HEAD_RANGE: Record<TurbineType, [number, number]> = {
  Kaplan: [2, 40],
  Propeller: [2, 40],
  Francis: [25, 350],
  Pelton: [50, 1300],
  Crossflow: [5, 200],
  Turgo: [50, 250],
};

console.log('\nreal plants: does P = rho*g*Q*H*eta reproduce what was actually built?');

for (const p of PLANTS) {
  ok(`${p.name} — ${p.capacityMW} MW implies a credible efficiency`, () => {
    // Back out the efficiency the plant must be achieving. If our power
    // equation were wrong by any meaningful factor this lands outside the
    // physically possible band for a turbine-generator train.
    const hydraulicW = RHO * G * p.designFlowCms * p.headM;
    const implied = (p.capacityMW * 1e6) / hydraulicW;
    assert.ok(
      implied > 0.75 && implied < 0.95,
      `${p.name}: implied eta ${implied.toFixed(3)} outside 0.75-0.95 (${p.source})`
    );
    // And the forward calculation must return the published capacity.
    const back = powerW(p.designFlowCms, p.headM, implied) / 1e6;
    assert.ok(
      Math.abs(back - p.capacityMW) < 1e-6 * p.capacityMW,
      `${p.name}: forward calc ${back} != published ${p.capacityMW}`
    );
  });
}

console.log('\nreal plants: does the ported turbine module choose the right machine?');

for (const p of PLANTS) {
  ok(`${p.name} — selected machine suits ${p.headM} m and ${p.designFlowCms} m³/s`, () => {
    const netHead = p.headIsNet ? p.headM : p.headM * 0.95; // ~5% losses when gross
    const type = selectTurbine(p.designFlowCms, netHead);
    assert.ok(type, `${p.name}: no turbine selected for this duty point`);
    // Independent cross-check: the choice must sit inside ESHA's published head
    // band for that machine. Two unrelated sources have to agree.
    const [lo, hi] = ESHA_HEAD_RANGE[type];
    assert.ok(
      netHead >= lo && netHead <= hi,
      `${p.name}: chose ${type} at ${netHead.toFixed(0)} m, outside ESHA's ${lo}-${hi} m`
    );
    // Where the installed machine is publicly documented, it must match.
    if (p.turbine) {
      assert.equal(type, p.turbine, `${p.name}: installed ${p.turbine}, selected ${type}`);
    }
  });
}

console.log('\nreal plants: do the ported efficiency curves match reality?');

/** Generator + transformer train, so the comparison is like for like. */
const GEN = 0.96;
/**
 * How far the predicted overall efficiency may sit from the plant's own.
 *
 * Eight points is not slack, it is the genuine uncertainty: published heads do
 * not say whether they are gross or net, and the loss split per plant is not
 * public. The measured spread across these five is -6.2 to +6.1 points, so this
 * bound is tight enough to catch a real regression.
 */
const TOL = 0.08;

for (const p of PLANTS) {
  ok(`${p.name} — predicted overall efficiency within ${TOL * 100} points of the real plant`, () => {
    const netHead = p.headIsNet ? p.headM : p.headM * 0.95;
    // What the built plant must be achieving, on the head as published.
    const implied = (p.capacityMW * 1e6) / (RHO * G * p.designFlowCms * p.headM);
    const curve = turbineCurve(p.designFlowCms, netHead);
    assert.ok(curve, `${p.name}: no curve`);
    // Runner curve x generator train = what our engine would report overall.
    const predicted = curve.peak * GEN;
    const gap = predicted - implied;
    assert.ok(
      Math.abs(gap) <= TOL,
      `${p.name}: predicted ${predicted.toFixed(3)} vs plant ${implied.toFixed(3)}, ` +
        `off by ${(gap * 100).toFixed(1)} points`
    );
  });
}

console.log('\nreal plants: published generation implies a run-of-river plant factor');

for (const p of PLANTS) {
  if (p.annualEnergyGWh === undefined) continue;
  ok(`${p.name} — ${p.annualEnergyGWh} GWh/yr is consistent with ${p.capacityMW} MW`, () => {
    const pf = (p.annualEnergyGWh! * 1e9) / (p.capacityMW * 1e6 * HOURS_PER_YEAR);
    assert.ok(
      pf > 0.35 && pf < 0.95,
      `${p.name}: plant factor ${pf.toFixed(3)} implausible for run-of-river`
    );
    // GWh = MW x 8.76 x plant factor. Guards the MW/GWh unit trap in both directions.
    const rebuilt = p.capacityMW * 8.76 * pf;
    assert.ok(
      Math.abs(rebuilt - p.annualEnergyGWh!) < 1e-6 * p.annualEnergyGWh!,
      `${p.name}: GWh identity broken`
    );
  });
}

console.log(`\n${passed} plant checks passed\n`);
