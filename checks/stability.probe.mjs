/** Watch one site and report WHICH field of the export context keeps moving. */
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const LAT = Number(process.argv[2] ?? 27.65);
const LON = Number(process.argv[3] ?? 85.9);
const SECONDS = Number(process.argv[4] ?? 60);
const PORT = 5203;

const server = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'error',
});
await server.listen();
const ctx = await chromium.launchPersistentContext(
  'pipeline/.cache/probe-profile',
  { channel: 'chrome', headless: true, viewport: { width: 1400, height: 900 } }
);
const page = ctx.pages()[0] ?? (await ctx.newPage());
let maxDepth = 0;
page.on('console', (m) => {
  if (/Maximum update depth/.test(m.text())) maxDepth++;
});
page.on('pageerror', (e) => console.log('  page error:', e.message.slice(0, 120)));

await page.goto(
  `http://localhost:${PORT}/#map=12.00/${LAT.toFixed(4)}/${LON.toFixed(4)}&at=${LAT.toFixed(5)},${LON.toFixed(5)}`,
  { waitUntil: 'load' }
);
console.log(`watching ${LAT}, ${LON} for ${SECONDS}s`);

const result = await page.evaluate(async (seconds) => {
  const snap = () => {
    const c = window.__exportCtx ?? {};
    const s = c.selected;
    return {
      i: s?.i ?? null,
      j: s?.j ?? null,
      mw: s ? Number(s.capacityMW.toFixed(3)) : null,
      waterwayKm: s ? Number(s.waterwayKm.toFixed(3)) : null,
      headM: s ? Number((s.grossHeadM ?? s.headM ?? 0).toFixed(2)) : null,
      designQ: s ? Number((s.designFlowCms ?? 0).toFixed(4)) : null,
      schemes: c.schemes?.length ?? null,
      pathLen: c.study?.path?.length ?? null,
      flowMean: c.flow?.values?.length ?? null,
      flowAuthority: c.flowChoice?.authority ?? null,
      lakes: c.upstreamConnectivity?.lakes?.length ?? null,
      demSource: c.study?.dem?.source ?? null,
    };
  };
  const changes = {};
  const series = [];
  let prev = snap();
  series.push({ t: 0, ...prev });
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 400));
    const now = snap();
    for (const k of Object.keys(now)) {
      if (JSON.stringify(now[k]) !== JSON.stringify(prev[k])) {
        changes[k] = (changes[k] ?? 0) + 1;
        series.push({ t: Math.round((Date.now() - t0) / 100) / 10, k, from: prev[k], to: now[k] });
      }
    }
    prev = now;
  }
  return { changes, series: series.slice(0, 60), final: prev };
}, SECONDS);

console.log('\nfield changes over the window:');
for (const [k, v] of Object.entries(result.changes).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${v}`);
}
console.log(`\n"Maximum update depth exceeded" logged ${maxDepth} times`);
console.log('\nfirst transitions:');
for (const s of result.series.slice(1, 26)) {
  console.log(`  ${String(s.t).padStart(6)}s  ${s.k}: ${JSON.stringify(s.from)} -> ${JSON.stringify(s.to)}`);
}
console.log('\nfinal:', JSON.stringify(result.final));

await ctx.close();
await server.close();
