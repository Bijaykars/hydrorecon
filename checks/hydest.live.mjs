import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const base = 'http://127.0.0.1:4173/';
const reachable = async () => fetch(base).then((response) => response.ok).catch(() => false);
let preview = null;
if (!(await reachable())) {
  preview = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4173'],
    { cwd: process.cwd(), stdio: 'ignore', windowsHide: true }
  );
  for (let attempt = 0; attempt < 50 && !(await reachable()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await reachable())) throw new Error('production preview did not start on port 4173');
}
process.on('exit', () => preview?.kill());

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const failedRequests = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('requestfailed', (request) => failedRequests.push(`${request.url()} — ${request.failure()?.errorText}`));

// Kali Gandaki mid-hills reach: complete MMP coverage and stable regional results.
await page.goto(`${base}#at=27.9700,83.5500&map=9/27.9700/83.5500`, { waitUntil: 'domcontentloaded' });
const heading = page.getByText('WECS/DHM · regional hydrology screen', { exact: true });
await heading.waitFor({ timeout: 90_000 });
const panel = heading.locator('xpath=../..');
const panelText = await panel.innerText();
if (!/regional flood estimates, m³\/s/i.test(panelText)) throw new Error('regional flood label missing');
if (/design flood,\s*m³\/s/i.test(panelText)) throw new Error('regional peak is still labelled as a design flood');
for (const t of [2, 100, 500]) {
  if (!new RegExp(`Q${t}\\s+[\\d,]+`).test(panelText)) throw new Error(`visible Q${t} estimate missing`);
}
if (!/Screening comparator only—not a selected design, diversion, spillway check flood or PMF\/PMP case/i.test(panelText)) {
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
const pageText = await page.locator('body').innerText();
if (!/Gross reference energy value.*no escalation.*not a PPA entitlement, contracted revenue, cash flow, NPV or LCOE/is.test(pageText)) {
  throw new Error('PPA base-rate non-claim or no-escalation warning missing');
}
const ppaHref = await page.getByRole('link', { name: 'NEA Board decision' }).getAttribute('href');
if (!ppaHref?.endsWith('/PPA_Rates.pdf')) throw new Error('official NEA PPA decision link missing');
if (!/Daily P90 output[\s\S]*Daily P95 output/i.test(pageText)) {
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

const [geoDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: /GeoJSON/ }).click(),
]);
const geoPath = await geoDownload.path();
if (!geoPath) throw new Error('GeoJSON download has no readable path');
const geo = JSON.parse(await readFile(geoPath, 'utf8'));
if (!geo.ghatta_hydest) throw new Error('GeoJSON omitted regional hydrology');
if (geo.ghatta_hydest.floods?.length !== 7) throw new Error('GeoJSON omitted return periods');
if (!/not selected design floods/i.test(geo.ghatta_hydest.provenance?.interpretation ?? '')) {
  throw new Error('GeoJSON regional-hydrology non-claim missing');
}
if (!/^[a-f0-9]{64}$/.test(geo.ghatta_hydest.provenance?.bundle?.output?.sha256 ?? '')) {
  throw new Error('GeoJSON output checksum missing');
}
if (!geo.ghatta_flow_choice?.authority) throw new Error('GeoJSON omitted the selected flow authority');
if (geo.ghatta_nea_ror_ppa?.wetNprPerKwh !== 4.8 || geo.ghatta_nea_ror_ppa?.dryNprPerKwh !== 8.4) {
  throw new Error('GeoJSON omitted the official NEA base-rate metadata');
}
if (!/not a PPA entitlement/i.test(geo.ghatta_nea_ror_ppa?.interpretation ?? '')) {
  throw new Error('GeoJSON PPA non-claim missing');
}
if (!/ESHA 2004.*section 3\.7/i.test(geo.ghatta_power_duration?.reference ?? '')) {
  throw new Error('GeoJSON power-duration method metadata missing');
}
if (geo.ghatta_unit_count_sensitivity?.unitCounts?.join(',') !== '1,2,3,4' ||
    !/not a selected unit arrangement/i.test(geo.ghatta_unit_count_sensitivity?.interpretation ?? '')) {
  throw new Error('GeoJSON unit-count sensitivity method/non-claim missing');
}
if (geo.ghatta_nepal_environmental_flow?.minimumFractionOfLowestMonthlyMean !== 0.1) {
  throw new Error('GeoJSON omitted the Nepal environmental-flow policy floor');
}
if (geo.ghatta_nepal_environmental_flow?.selectedFractionOfLowestMonthlyMean < 0.1) {
  throw new Error('GeoJSON exported a sub-policy Nepal environmental-flow fraction');
}
if (!/higher of at least 10%.*EIA-required minimum/is.test(geo.ghatta_nepal_environmental_flow?.interpretation ?? '')) {
  throw new Error('GeoJSON environmental-flow higher-EIA rule missing');
}
const chosenLine = geo.features.find((feature) =>
  feature.properties?.part === 'diverted reach' && feature.properties?.selected === true
);
if (!(chosenLine?.properties?.NEA_8plus4_gross_base_rate_reference_million_NPR_per_year > 0)) {
  throw new Error('selected scheme GeoJSON omitted its PPA reference value');
}
if (!(chosenLine.properties.daily_P90_hydrological_power_MW >= 0) ||
    !(chosenLine.properties.daily_P95_hydrological_power_MW >= 0) ||
    chosenLine.properties.daily_P95_hydrological_power_MW > chosenLine.properties.daily_P90_hydrological_power_MW ||
    chosenLine.properties.daily_P90_hydrological_power_MW > chosenLine.properties.capacity_MW ||
    !(chosenLine.properties.power_duration_basis_days > 365)) {
  throw new Error(`invalid selected-scheme daily power-duration results: ${JSON.stringify(chosenLine.properties)}`);
}
const unitSensitivity = chosenLine.properties.unit_count_sensitivity;
if (!Array.isArray(unitSensitivity) || unitSensitivity.length !== 4 ||
    unitSensitivity.map((scenario) => scenario.units).join(',') !== '1,2,3,4') {
  throw new Error('selected scheme omitted the four unit-count scenarios');
}
const oneUnit = unitSensitivity[0];
if (Math.abs(oneUnit.energyGwh - chosenLine.properties.annual_energy_GWh) > 0.02 ||
    Math.abs(oneUnit.dailyP90MW - chosenLine.properties.daily_P90_hydrological_power_MW) > 0.001) {
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
if (!(chosenLine?.properties?.residual_flow_m3s >= 0)) {
  throw new Error('selected scheme GeoJSON omitted its environmental release');
}
if (Math.abs(chosenLine.properties.residual_flow_m3s - geo.ghatta_nepal_environmental_flow.selectedReleaseCms) > 0.001) {
  throw new Error('selected scheme release disagrees with environmental-flow export metadata');
}
if (chosenLine.properties.capacity_MW > 100 && !/above the posted-rate 100 MW boundary/i.test(pageText)) {
  throw new Error('selected scheme above 100 MW omitted the negotiated-rate warning');
}

const [fieldDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: /Field plan CSV/ }).click(),
]);
const fieldPath = await fieldDownload.path();
if (!fieldPath) throw new Error('field-plan download has no readable path');
const field = await readFile(fieldPath, 'utf8');
for (const required of [
  /instantaneous-peak gauge frequency analysis/i,
  /historical flood marks/i,
  /slope-area reconstruction/i,
  /direct flood-discharge measurement/i,
  /GLOF\/CLOF assessment/i,
  /PMF\/PMP decisions/i,
  /signed\/expected PPA option/i,
  /COD\/escalation year/i,
  /contracted energy\/losses\/curtailment\/penalties/i,
  /approved EIA EFlow/i,
  /seasonal ecological\/hydraulic basis/i,
  /downstream uses/i,
  /drought\/ramping rules/i,
  /release works and monitoring\/compliance plan/i,
  /daily hydrological output screen: P90 .*P95/i,
  /assumes one unit.*forced outages.*multi-unit commitment/i,
  /Equal-rated 1–4-unit sensitivity spans daily P90/i,
  /no equipment cost or outage credit.*not a recommendation/i,
]) {
  if (!required.test(field)) throw new Error(`field-plan requirement missing: ${required}`);
}
if (!/regional comparator: Q100 .*not a selected design flood/i.test(field)) {
  throw new Error('field-plan regional comparator/non-claim missing');
}

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const mobile = await page.evaluate(() => ({
  client: document.documentElement.clientWidth,
  scroll: document.documentElement.scrollWidth,
  regionalPanelVisible: document.body.textContent?.includes('regional hydrology screen') ?? false,
}));
if (!mobile.regionalPanelVisible || mobile.scroll > mobile.client + 1) {
  throw new Error(`mobile overflow: ${JSON.stringify(mobile)}`);
}

// A global study must receive neither the Nepal regression nor its export object.
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${base}?qa=global-hydrology#at=46.55,8.49&map=10/46.55/8.49`, { waitUntil: 'domcontentloaded' });
await page.getByText('engineering geology sources', { exact: true }).waitFor({ timeout: 90_000 });
const globalText = await page.locator('body').innerText();
if (/WECS\/DHM · regional hydrology screen|regional flood estimates, m³\/s/i.test(globalText)) {
  throw new Error('Nepal regional hydrology leaked into global mode');
}
const [globalDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: /GeoJSON/ }).click(),
]);
const globalPath = await globalDownload.path();
if (!globalPath) throw new Error('global GeoJSON download has no readable path');
const globalGeo = JSON.parse(await readFile(globalPath, 'utf8'));
if (globalGeo.ghatta_hydest !== null) throw new Error('global GeoJSON inherited Nepal regional hydrology');
if (globalGeo.ghatta_nea_ror_ppa !== null) throw new Error('global GeoJSON inherited Nepal PPA metadata');
if (globalGeo.ghatta_nepal_environmental_flow !== null) throw new Error('global GeoJSON inherited Nepal environmental-flow policy');
const globalScheme = globalGeo.features.find((feature) => feature.properties?.part === 'diverted reach');
if (globalScheme?.properties?.NEA_8plus4_gross_base_rate_reference_million_NPR_per_year !== null) {
  throw new Error('global scheme inherited a Nepal PPA reference value');
}
if (!(globalScheme?.properties?.daily_P90_hydrological_power_MW >= 0) ||
    globalScheme.properties.daily_P95_hydrological_power_MW > globalScheme.properties.daily_P90_hydrological_power_MW) {
  throw new Error('global scheme lost the jurisdiction-neutral power-duration screen');
}
if (globalScheme.properties.unit_count_sensitivity?.length !== 4) {
  throw new Error('global scheme lost the jurisdiction-neutral unit-count sensitivity');
}
const globalResidualSlider = page.getByLabel('Residual flow');
if (Number(await globalResidualSlider.getAttribute('min')) !== 0) {
  throw new Error('global residual-flow control inherited Nepal policy floor');
}

const relevantFailures = failedRequests.filter((line) => !/favicon|ERR_ABORTED/i.test(line));
if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`);
if (relevantFailures.length) throw new Error(`failed requests:\n${relevantFailures.join('\n')}`);

console.log(JSON.stringify({
  nepalPanel: {
    months: geo.ghatta_hydest.months.length,
    returnPeriods: geo.ghatta_hydest.floods.length,
    terminology: 'regional estimates; explicit non-design claim',
    sourceLinks: true,
  },
  exports: { geojsonProvenance: true, fieldPlanRequirements: true, flowAuthority: geo.ghatta_flow_choice.authority },
  ppaReference: {
    ratesNprPerKwh: [geo.ghatta_nea_ror_ppa.wetNprPerKwh, geo.ghatta_nea_ror_ppa.dryNprPerKwh],
    bothSeasonOptionsVisible: true,
    explicitNonRevenueClaim: true,
  },
  environmentalFlow: {
    nepalMinimumFraction: nepalResidual.min,
    selectedFraction: geo.ghatta_nepal_environmental_flow.selectedFractionOfLowestMonthlyMean,
    releaseCms: geo.ghatta_nepal_environmental_flow.selectedReleaseCms,
    higherEiaRule: true,
    globalPolicyIsolation: true,
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
  globalMode: 'regional panel absent and ghatta_hydest null',
  consoleErrors: consoleErrors.length,
  failedRequests: relevantFailures.length,
}, null, 2));

await browser.close();
preview?.kill();
