/**
 * Would the licensing workbook have got these ten plants right?
 *
 *   node --experimental-strip-types --no-warnings checks/workbook-vs-plants.mjs
 *
 * The workbook needs no discharge record: catchment area, a rainfall figure and
 * a head, run through two regional regressions whose mean becomes design flow.
 * This app runs a global flood model rescaled to a mapped network. Ten built
 * Nepali plants publish what they actually installed.
 *
 * HEAD IS HELD FIXED at each plant's published value for both methods. Head is
 * a terrain question, not a hydrology one, and letting it vary would mix the two
 * error sources — this app's worst plants (Mistri Khola, 795 m against a
 * published 285) fail on head, not flow, and that would drown the comparison.
 * What is being tested here is the FLOW.
 *
 * The workbook's own constants are used, not this app's: 80% overall efficiency
 * and 5% head loss, exactly as the sheet computes it.
 */
import { readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u);
  if (p.startsWith('/')) return new Response(readFileSync(`public${p}`), { status: 200 });
  return realFetch(p, i);
};

const { nearestReach } = await import('../src/rivers.ts');
const { mhspScreen, mhspFlowAtExceedance } = await import('../src/engine/mhsp.ts');
const { allMonthlyFlows } = await import('../src/engine/hydest.ts');
const validation = JSON.parse(readFileSync('src/data/validation.json', 'utf8'));

/** The workbook's constants, verbatim. */
const ETA = 0.8;
const HEAD_LOSS = 0.05;
const RESIDUAL_FRAC = 0.1; // of the lowest monthly mean

const excelPercentile = (vals, p) => {
  const s = [...vals].sort((a, b) => a - b);
  const r = p * (s.length - 1);
  const lo = Math.floor(r);
  return lo === s.length - 1 ? s[lo] : s[lo] + (r - lo) * (s[lo + 1] - s[lo]);
};

const out = [];
for (const plant of validation.plants) {
  const [lat, lon] = plant.intake;
  const act = plant.actual;
  if (!act?.capacityMW || !act?.head) continue;
  const hit = await nearestReach(lat, lon).catch(() => null);
  if (!hit) continue;
  const r = hit.nearest;
  if (!(r.uplandKm2 > 0) || !Number.isFinite(r.monsoonMm)) continue;

  // Gross head: published figure, converted to gross if quoted net.
  const gross = act.headBasis === 'net' ? act.head / (1 - HEAD_LOSS) : act.head;
  const net = gross * (1 - HEAD_LOSS);

  const m = mhspScreen(r.uplandKm2, r.monsoonMm);
  const hy = allMonthlyFlows({
    totalKm2: r.uplandKm2,
    below5000Km2: r.uplandKm2 * r.below5000Frac,
    below3000Km2: r.uplandKm2 * r.below3000Frac,
    monsoonMm: r.monsoonMm,
  });
  if (!m || m.months.length < 12 || hy.length < 12) continue;

  // The workbook's Q45: mean of the two methods' own Q45 estimates. Modified
  // HYDEST needs a mean catchment altitude this app does not carry, so WECS/DHM
  // 1990 stands in for it — the same role, the same inputs, a different vintage.
  const q45mhsp = excelPercentile(m.months, 1 - 0.45);
  const q45hyd = excelPercentile(hy.map((x) => x.cms), 1 - 0.45);
  const q45 = (q45mhsp + q45hyd) / 2;

  // Residual release, exactly as the sheet: 10% of the lowest monthly mean,
  // averaged over the two methods.
  const residual =
    ((Math.min(...m.months) + Math.min(...hy.map((x) => x.cms))) / 2) * RESIDUAL_FRAC;
  const qDesign = Math.max(0, q45 - residual);

  const workbookMw = (ETA * qDesign * 9.81 * net) / 1000;
  const appMw = plant.result?.predicted?.capacityMW ?? null;
  /**
   * Both methods re-powered on the published head AND the same efficiency.
   *
   * An earlier version of this gave the app its own 88% train against the
   * workbook's 80%, which inflated the app's numbers by a tenth and made its
   * over-prediction look worse than it is. With head and efficiency held equal
   * for both, the capacity columns are a pure restatement of the flow columns,
   * which is the point.
   */
  const appQ = plant.result?.predicted?.designFlowCms ?? null;
  const appOnSameHead = appQ != null ? (ETA * appQ * 9.81 * net) / 1000 : null;

  out.push({
    name: plant.name,
    A: r.uplandKm2,
    actMw: act.capacityMW,
    actQ: act.designQ ?? null,
    q45,
    qDesign,
    workbookMw,
    appQ,
    appOnSameHead,
    appMw,
    trans: !!plant.transHimalayan,
  });
}

const pct = (a, b) => (b > 0 ? ((a / b - 1) * 100).toFixed(0) + '%' : '—');
console.log('\nWORKBOOK METHOD vs THIS APP, both on the PUBLISHED head');
console.log('(so the comparison is flow only; head error is removed)\n');
const hdr =
  `${'plant'.padEnd(20)}${'A km2'.padStart(7)}${'Q act'.padStart(7)}${'Q book'.padStart(7)}${'Q app'.padStart(7)}` +
  ` | ${'MW act'.padStart(7)}${'MW book'.padStart(8)}${'MW app'.padStart(7)} | ${'book'.padStart(6)}${'app'.padStart(7)}`;
console.log(hdr);
console.log('-'.repeat(hdr.length));
const eB = [];
const eA = [];
const qB = [];
const qA = [];
for (const p of out) {
  const errB = Math.abs(p.workbookMw / p.actMw - 1) * 100;
  const errA = p.appOnSameHead != null ? Math.abs(p.appOnSameHead / p.actMw - 1) * 100 : null;
  eB.push(errB);
  if (errA != null) eA.push(errA);
  if (p.actQ > 0) {
    qB.push(Math.abs(p.qDesign / p.actQ - 1) * 100);
    if (p.appQ != null) qA.push(Math.abs(p.appQ / p.actQ - 1) * 100);
  }
  console.log(
    `${(p.name + (p.trans ? ' *' : '')).padEnd(20)}${p.A.toFixed(0).padStart(7)}` +
      `${(p.actQ ?? 0).toFixed(1).padStart(7)}${p.qDesign.toFixed(1).padStart(7)}` +
      `${(p.appQ ?? 0).toFixed(1).padStart(7)} | ${p.actMw.toFixed(0).padStart(7)}` +
      `${p.workbookMw.toFixed(0).padStart(8)}${(p.appOnSameHead ?? 0).toFixed(0).padStart(7)}` +
      ` | ${pct(p.workbookMw, p.actMw).padStart(6)}${(errA != null ? pct(p.appOnSameHead, p.actMw) : '—').padStart(7)}`
  );
}
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(`\n* catchment mostly north of the border, where every global product runs low`);
console.log(`\nmedian |capacity error|   workbook ${med(eB).toFixed(0)}%   app ${med(eA).toFixed(0)}%`);
const within = (v, f) => v.filter((x) => x <= f).length;
console.log(`within 25%               workbook ${within(eB, 25)}/${eB.length}        app ${within(eA, 25)}/${eA.length}`);
console.log(`within 50%               workbook ${within(eB, 50)}/${eB.length}        app ${within(eA, 50)}/${eA.length}`);
console.log(`\nagainst each plant's CHOSEN design flow (${qB.length} plants that publish one):`);
console.log(`median |flow error|      workbook ${med(qB).toFixed(0)}%       app ${med(qA).toFixed(0)}%`);
console.log(`within 25%               workbook ${within(qB, 25)}/${qB.length}         app ${within(qA, 25)}/${qA.length}`);
console.log(
  '\nDesign flow is an economic choice, not a property of the river, so the' +
    '\nabsolute level here is soft. The COMPARISON is fair: same target, same head,' +
    '\nsame efficiency, two ways of estimating the water.'
);
