import { chromium } from 'playwright-core';

// window.__exportCtx is a DEV-only hook, so this drives the Vite dev server.
// Override with QA_URL (e.g. a non-default port).
const base = process.env.QA_URL ?? 'http://127.0.0.1:5173/';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
// The first-run tour opens over the map and swallows clicks; mark it seen.
await page.addInitScript(() => localStorage.setItem('hydrorecon.tour.done', '1'));
const consoleErrors = [];
const failedRequests = [];
// Only the app's own origin counts: a basemap or terrain host being unreachable is not an app fault.
const own = (url) => url.startsWith(new URL(base).origin);
page.on('console', (message) => {
  if (message.type() === 'error' && own(message.location().url || base)) consoleErrors.push(message.text());
});
page.on('requestfailed', (request) => {
  if (own(request.url())) failedRequests.push(`${request.url()} — ${request.failure()?.errorText}`);
});

// Kali Gandaki mid-hills reach: complete MMP coverage and stable regional results.
await page.goto(`${base}#at=27.9700,83.5500&map=9/27.9700/83.5500`, { waitUntil: 'domcontentloaded' });
const heading = page.getByText("Nepal's regional methods · two independent screens", { exact: true });
await heading.waitFor({ timeout: 90_000 });
const panel = heading.locator('xpath=../..');
// "method & limits" blocks are collapsed <details>; innerText skips closed ones.
const openDetails = () => page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
await openDetails();
const panelText = await panel.innerText();
if (!/regional flood estimates, m³\/s/i.test(panelText)) throw new Error('regional flood label missing');
if (/design flood,\s*m³\/s/i.test(panelText)) throw new Error('regional peak is still labelled as a design flood');
for (const t of [2, 100, 500]) {
  if (!new RegExp(`Q${t}\\s+[\\d,]+`).test(panelText)) throw new Error(`visible Q${t} estimate missing`);
}
if (!/Screening comparator only — never a design, diversion or spillway check flood/i.test(panelText)) {
  throw new Error('visible regional-flood non-claim missing');
}
if (!/gauge-frequency.*historical-flood.*direct measurement.*GLOF\/CLOF/is.test(panelText)) {
  throw new Error('visible DoED confirmation requirements missing');
}
const methodHref = await panel.getByRole('link', { name: 'method catalogue' }).getAttribute('href');
const guidanceHref = await panel.getByRole('link', { name: 'current DoED headworks guidance' }).getAttribute('href');
if (!methodHref?.startsWith('https://lib.icimod.org/')) throw new Error('primary method catalogue link missing');
if (!guidanceHref?.startsWith('https://doed.gov.np/')) throw new Error('current DoED guidance link missing');

const ppaHeading = page.getByText('Nepal ROR PPA dry-energy tests', { exact: true });
await ppaHeading.waitFor({ timeout: 10_000 });
const ppaPanel = ppaHeading.locator('xpath=..');
const ppaText = await ppaPanel.innerText();
if ((ppaText.match(/NPR [\d,]+ million\/yr/g) ?? []).length !== 2) {
  throw new Error('both PPA season options must show a gross base-rate reference');
}
await openDetails();
const pageText = await page.locator('body').innerText();
if (!/Gross reference energy value.*no escalation.*not a PPA entitlement, contracted revenue, cash flow, NPV or LCOE/is.test(pageText)) {
  throw new Error('PPA base-rate non-claim or no-escalation warning missing');
}
const ppaHref = await page.getByRole('link', { name: 'NEA Board decision' }).getAttribute('href');
if (!ppaHref?.endsWith('/PPA_Rates.pdf')) throw new Error('official NEA PPA decision link missing');
if (!/Daily P90[\s\S]*Daily P95/i.test(pageText)) {
  throw new Error('daily P90/P95 hydrological output is not visible');
}
if (!/assumes one screening unit and hydrology only.*not firm capacity.*different from P90 annual energy/is.test(pageText)) {
  throw new Error('power-duration one-unit/non-firm distinction is missing');
}
const durationHref = await page.getByRole('link', { name: /ESHA.*3\.7 basis/ }).getAttribute('href');
if (!durationHref?.includes('energypedia.info/') || !durationHref.endsWith('.pdf')) {
  throw new Error('power-duration technical source link missing');
}
if (!/Equal-rated unit-count sensitivity[\s\S]*The one-unit row matches the headline[\s\S]*not an equipment recommendation/i.test(pageText)) {
  throw new Error('visible one-to-four-unit sensitivity/non-recommendation is missing');
}
const unitCaseHref = await page.getByRole('link', { name: 'Nepal operating example' }).getAttribute('href');
if (!unitCaseHref?.includes('hydropower.org/sediment-management-case-studies/nepal-jhimruk')) {
  throw new Error('Nepal multi-unit operating case link missing');
}

const residualSlider = page.getByLabel('Residual flow');
const nepalResidual = {
  min: Number(await residualSlider.getAttribute('min')),
  value: Number(await residualSlider.inputValue()),
};
if (nepalResidual.min !== 0.1 || nepalResidual.value < 0.1) {
  throw new Error(`Nepal environmental-flow control escaped its 10% floor: ${JSON.stringify(nepalResidual)}`);
}
if (!/cannot go below Nepal's published floor.*10% is not ecological clearance.*downstream use.*drought\/ramping.*approved EIA can require more/is.test(pageText)) {
  throw new Error('visible Nepal environmental-flow floor/EIA non-claim missing');
}
const eflowHref = await page.getByRole('link', { name: /policy/ }).getAttribute('href');
if (!eflowHref?.includes('doed.gov.np/') || !eflowHref.endsWith('.pdf')) {
  throw new Error('official Nepal environmental-flow policy link missing');
}

// The computed values behind the panel. (These were read back out of the GeoJSON and
// field-plan exports, which are gone; the exports were only a vehicle. Assertions on
// static export metadata -- the NEA rate constants, ESHA/unit-count guidance wording,
// EFlow policy constants -- tested the export envelope, not the app, and went with it.)
const ctx = await page.evaluate(() => {
  const c = window.__exportCtx;
  return { hydest: c.hydest, flowChoice: c.flowChoice, selected: c.selected, residualFrac: c.assumptions.residualFrac };
});
if (!ctx.hydest) throw new Error('regional hydrology missing from the study context');
if (ctx.hydest.floods?.length !== 7) throw new Error('regional hydrology omitted return periods');
if (!/not selected design floods/i.test(ctx.hydest.provenance?.interpretation ?? '')) {
  throw new Error('regional-hydrology non-claim missing');
}
if (!/^[a-f0-9]{64}$/.test(ctx.hydest.provenance?.bundle?.output?.sha256 ?? '')) {
  throw new Error('regional-hydrology output checksum missing');
}
if (!ctx.flowChoice?.authority) throw new Error('selected flow authority missing');
if (ctx.residualFrac < 0.1) throw new Error('Nepal environmental-flow fraction fell below the 10% floor');
const chosen = ctx.selected;
if (!chosen) throw new Error('no selected scheme in the study context');
if (!(chosen.reliability?.ppaEightFour?.grossReferenceValueMillionNpr > 0)) {
  throw new Error('selected scheme has no NEA 8+4 gross reference value');
}
const pd = chosen.powerDuration;
if (!pd || !(pd.p90MW >= 0) || !(pd.p95MW >= 0) || pd.p95MW > pd.p90MW ||
    pd.p90MW > chosen.capacityMW || !(pd.days > 365)) {
  throw new Error(`invalid selected-scheme daily power-duration results: ${JSON.stringify(pd)}`);
}
const unitSensitivity = chosen.unitSensitivity;
if (!Array.isArray(unitSensitivity) || unitSensitivity.length !== 4 ||
    unitSensitivity.map((scenario) => scenario.units).join(',') !== '1,2,3,4') {
  throw new Error('selected scheme omitted the four unit-count scenarios');
}
const oneUnit = unitSensitivity[0];
if (Math.abs(oneUnit.energyGwh - chosen.energyGwh) > 0.02 ||
    Math.abs(oneUnit.dailyP90MW - pd.p90MW) > 0.001) {
  throw new Error('one-unit sensitivity row does not reproduce headline dispatch');
}
if (!unitSensitivity.some((scenario) =>
  scenario.units > 1 && (
    scenario.dailyP90MW > oneUnit.dailyP90MW + 0.001 ||
    scenario.energyGwh > oneUnit.energyGwh + 0.01 ||
    scenario.zeroOutputFraction < oneUnit.zeroOutputFraction - 0.0001
  )
)) {
  throw new Error('multi-unit sensitivity produced no distinct dispatch outcome at the live Nepal site');
}
if (!(chosen.residualCms >= 0)) throw new Error('selected scheme has no environmental release');
if (chosen.capacityMW > 100 && !/above the posted-rate 100 MW boundary/i.test(pageText)) {
  throw new Error('selected scheme above 100 MW omitted the negotiated-rate warning');
}
const chosenLine = { properties: {
  daily_P90_hydrological_power_MW: pd.p90MW,
  daily_P95_hydrological_power_MW: pd.p95MW,
  power_duration_basis_days: pd.days,
} };

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const mobile = await page.evaluate(() => ({
  client: document.documentElement.clientWidth,
  scroll: document.documentElement.scrollWidth,
  regionalPanelVisible: document.body.textContent?.includes('regional methods · two independent screens') ?? false,
}));
if (!mobile.regionalPanelVisible || mobile.scroll > mobile.client + 1) {
  throw new Error(`mobile overflow: ${JSON.stringify(mobile)}`);
}

await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${base}?qa=global-hydrology#at=46.55,8.49&map=10/46.55/8.49`, { waitUntil: 'domcontentloaded' });
// A global study must not inherit the Nepal regression or the Nepal floor. A global
// scheme needs live terrain and flood services, so wait on the region and say plainly
// when no scheme could be built rather than passing the scheme-level checks silently.
await page.waitForFunction(() => window.__exportCtx?.region === 'global', null, { timeout: 90_000 });
await page.waitForTimeout(3_000);
const globalText = await page.locator('body').innerText();
if (/regional methods · two independent screens|regional flood estimates, m³\/s/i.test(globalText)) {
  throw new Error('Nepal regional hydrology leaked into global mode');
}
const globalCtx = await page.evaluate(() => ({ hydest: window.__exportCtx.hydest, selected: window.__exportCtx.selected }));
if (globalCtx.hydest !== null) throw new Error('global study context inherited Nepal regional hydrology');
let globalScheme = 'not built (live terrain/flood services unreachable); scheme-level global checks NOT run';
if (globalCtx.selected) {
  const gpd = globalCtx.selected.powerDuration;
  if (!(gpd?.p90MW >= 0) || gpd.p95MW > gpd.p90MW) {
    throw new Error('global scheme lost the jurisdiction-neutral power-duration screen');
  }
  if (globalCtx.selected.unitSensitivity?.length !== 4) {
    throw new Error('global scheme lost the jurisdiction-neutral unit-count sensitivity');
  }
  const globalResidualSlider = page.getByLabel('Residual flow');
  if (Number(await globalResidualSlider.getAttribute('min')) !== 0) {
    throw new Error('global residual-flow control inherited Nepal policy floor');
  }
  globalScheme = 'built; power-duration, unit sensitivity and residual-flow floor checked';
}

const relevantFailures = failedRequests.filter((line) => !/favicon|ERR_ABORTED/i.test(line));
if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`);
if (relevantFailures.length) throw new Error(`failed requests:\n${relevantFailures.join('\n')}`);

console.log(JSON.stringify({
  nepalPanel: {
    months: ctx.hydest.months.length,
    returnPeriods: ctx.hydest.floods.length,
    terminology: 'regional estimates; explicit non-design claim',
    sourceLinks: true,
  },
  flowAuthority: ctx.flowChoice.authority,
  ppaReference: {
    grossEightFourMillionNpr: chosen.reliability.ppaEightFour.grossReferenceValueMillionNpr,
    bothSeasonOptionsVisible: true,
    explicitNonRevenueClaim: true,
  },
  environmentalFlow: {
    nepalMinimumFraction: nepalResidual.min,
    selectedFraction: ctx.residualFrac,
    releaseCms: chosen.residualCms,
  },
  powerDuration: {
    dailyP90MW: chosenLine.properties.daily_P90_hydrological_power_MW,
    dailyP95MW: chosenLine.properties.daily_P95_hydrological_power_MW,
    basisDays: chosenLine.properties.power_duration_basis_days,
    distinctFromAnnualP90: true,
  },
  unitSensitivity: {
    counts: unitSensitivity.map((scenario) => scenario.units),
    dailyP90MW: unitSensitivity.map((scenario) => Number(scenario.dailyP90MW.toFixed(3))),
    annualEnergyGwh: unitSensitivity.map((scenario) => Number(scenario.energyGwh.toFixed(2))),
    zeroOutputFraction: unitSensitivity.map((scenario) => Number(scenario.zeroOutputFraction.toFixed(4))),
    oneUnitMatchesHeadline: true,
    noCostOrRecommendationClaim: true,
  },
  mobile,
  globalMode: 'regional panel absent and hydest null',
  globalScheme,
  consoleErrors: consoleErrors.length,
  failedRequests: relevantFailures.length,
}, null, 2));

await browser.close();
