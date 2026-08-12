/**
 * Pins the TypeScript turbine port to the real HydroGenerate library.  `npm run check`
 *
 * src/engine/turbine.ts was written by hand from HydroGenerate's Python source.
 * A hand translation is exactly where a silent arithmetic slip hides, so these
 * are not numbers I chose — they are the library's own outputs, produced by
 * running HydroGenerate 1.4.1 (pip, BSD-3-Clause) against five built Nepali
 * power stations and recording what it returned. Regenerate with
 * `tools/compare-hydrogenerate.py`.
 *
 * Where the port deliberately departs from the library, the departure is
 * asserted too, so it can never happen by accident.
 */
import assert from 'node:assert/strict';
import { selectTurbine, turbineCurve } from '../src/engine/turbine.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

type Golden = {
  plant: string;
  netHeadM: number;
  designFlowCms: number;
  /** What HydroGenerate 1.4.1 selected, or null when it raised. */
  turbine: 'Pelton' | 'Francis' | null;
  /** Its efficiency at each fraction of design flow. */
  eff?: Record<string, number>;
};

/** Recorded from HydroGenerate 1.4.1 on 2026-08-12. */
const GOLDEN: Golden[] = [
  {
    plant: 'Chilime',
    netHeadM: 337.46,
    designFlowCms: 7.5,
    turbine: 'Pelton',
    eff: { '0.3': 0.845, '0.5': 0.865, '0.7': 0.865, '0.85': 0.865, '1': 0.854 },
  },
  {
    plant: 'Nyadi',
    netHeadM: 317.21,
    designFlowCms: 11.02,
    turbine: 'Pelton',
    eff: { '0.3': 0.838, '0.5': 0.858, '0.7': 0.858, '0.85': 0.858, '1': 0.847 },
  },
  {
    plant: 'Kabeli A',
    netHeadM: 111.15,
    designFlowCms: 37.73,
    turbine: 'Francis',
    eff: { '0.3': 0.631, '0.5': 0.867, '0.7': 0.935, '0.85': 0.937, '1': 0.933 },
  },
  {
    plant: 'Rasuwagadhi',
    netHeadM: 159.51,
    designFlowCms: 80.0,
    turbine: 'Francis',
    eff: { '0.3': 0.663, '0.5': 0.884, '0.7': 0.939, '0.85': 0.94, '1': 0.939 },
  },
  {
    // The library raises here: "Head or flow parameters are out of range for all
    // turbine types supported in HydroGenerate". Its Pelton region stops at
    // 60 m3/s and Upper Tamakoshi runs 66. This is Nepal's largest power
    // station, so refusing to answer is not an option for this tool.
    plant: 'Upper Tamakoshi',
    netHeadM: 780.9,
    designFlowCms: 66.0,
    turbine: null,
  },
];

console.log('\nport fidelity: TypeScript turbine module vs HydroGenerate 1.4.1');

for (const g of GOLDEN) {
  ok(`${g.plant} — selects the same machine as the library`, () => {
    const ts = selectTurbine(g.designFlowCms, g.netHeadM);
    if (g.turbine === null) {
      // The library gives up; the port must not, and must still be sensible.
      assert.equal(ts, 'Pelton', `${g.plant}: expected the ESHA fallback to give Pelton`);
      return;
    }
    assert.equal(ts, g.turbine, `${g.plant}: library said ${g.turbine}, port said ${ts}`);
  });
}

/** Points where the port must reproduce the library exactly. */
const EXACT: Record<string, string[]> = {
  Chilime: ['0.3', '0.5', '0.7', '0.85', '1'],
  Nyadi: ['0.3', '0.5', '0.7', '0.85', '1'],
  // Francis departs at 0.3 (below our minimum operating flow) and near full
  // load (corrected above-peak formula); both asserted separately below.
  'Kabeli A': ['0.5', '0.7'],
  Rasuwagadhi: ['0.5', '0.7'],
};

for (const g of GOLDEN) {
  if (!g.eff) continue;
  ok(`${g.plant} — efficiency matches the library to 0.001 where it should`, () => {
    const c = turbineCurve(g.designFlowCms, g.netHeadM);
    assert.ok(c, `${g.plant}: no curve`);
    for (const f of EXACT[g.plant]) {
      const mine = c.at(Number(f) * g.designFlowCms);
      const theirs = g.eff![f];
      assert.ok(
        Math.abs(mine - theirs) < 1e-3,
        `${g.plant} @${f}Qd: port ${mine.toFixed(4)} vs library ${theirs.toFixed(4)}`
      );
    }
  });
}

console.log('\nport fidelity: the deliberate departures are still deliberate');

ok('a Francis unit is shut down below 40% of design flow', () => {
  // HydroGenerate reports ~0.63 efficiency at 0.3 Qd. A fixed-geometry Francis
  // runner cannot be run there, and crediting energy to it would overstate the
  // annual figure on exactly the dry-season days that decide a project.
  for (const g of GOLDEN.filter((x) => x.turbine === 'Francis')) {
    const c = turbineCurve(g.designFlowCms, g.netHeadM)!;
    assert.equal(c.at(0.3 * g.designFlowCms), 0, `${g.plant}: should be off at 0.3 Qd`);
    assert.ok(g.eff!['0.3'] > 0.5, 'the library really does report output there');
  }
});

ok('Francis full-load efficiency equals the published er, not the peak', () => {
  // HydroGenerate squares only the denominator of the above-peak term, so it
  // never lands on er at design flow. The published RETScreen form does:
  //   er = (1 - 0.0072 * nq^0.4) * ep
  for (const g of GOLDEN.filter((x) => x.turbine === 'Francis')) {
    const c = turbineCurve(g.designFlowCms, g.netHeadM)!;
    const nq = 600 * g.netHeadM ** -0.5;
    const expected = (1 - 0.0072 * nq ** 0.4) * c.peak;
    const mine = c.at(g.designFlowCms);
    assert.ok(
      Math.abs(mine - expected) < 2e-3,
      `${g.plant}: full load ${mine.toFixed(4)}, expected er ${expected.toFixed(4)}`
    );
    // And it must sit below what the library claims, never above.
    assert.ok(mine < g.eff!['1'], `${g.plant}: correction should lower full-load efficiency`);
  }
});

console.log(`\n${passed} port-fidelity checks passed\n`);
