/**
 * Taking the work away.
 *
 * A screening tool that cannot hand its result to the next person is a toy. Two
 * formats, because engineers want two different things: a CSV of the numbers to
 * put in front of a colleague, and a GeoJSON of the geometry to drop into QGIS
 * next to their own layers.
 *
 * Both carry a header naming every source, assumption and limitation, so the
 * file still explains itself a year later when nobody remembers what produced it.
 */
import type { Scheme } from './engine/discover.ts';
import { DOED_RETRIEVED, DOED_UPDATED, type Licence } from './context.ts';
import { DHM_STATIONS_RETRIEVED, recordKind, transferAdvice, type Gauge } from './gauges.ts';
import { GRID_RETRIEVED, type GridLink } from './grid.ts';
import { PROTECTED_RETRIEVED } from './protected.ts';
import { desander, type BenchFit, type SedimentSource } from './engine/sediment.ts';
import type { EngineeringReadiness } from './readiness.ts';
import type { HazardScreen } from './hazards.ts';
import type { FaultScreen } from './faults.ts';
import type { GeologyScreen } from './geology.ts';
import { GEOLOGY_UNITS_LICENSE, type GeologyTraverse } from './geology-units.ts';
import type { UpstreamConnectivityScreen } from './connectivity.ts';
import { isAdvancedDoedStage, type CascadeScreen } from './cascade.ts';
import type { RegionMode } from './region.ts';
import type { HydestScreen } from './engine/hydest.ts';
import type { GlacierScreen } from './glaciers.ts';
import type { MhspScreen } from './engine/mhsp.ts';
import type { ShapeVerdict } from './engine/fdcshape.ts';
import type { Uncertainty } from './engine/uncertainty.ts';
import { UNIT_SENSITIVITY_GUIDANCE } from './engine/units.ts';
import type { FlowChoice } from './engine/flowchoice.ts';
import {
  PONDAGE_METHOD,
  pondageGeoJson,
  type PondagePositionSweep,
  type PondageResult,
} from './pondage.ts';
import { ROAD_ACCESS_METHOD, roadAccessGeoJson, type RoadAccessScreen } from './access.ts';
import type { LandcoverScreen } from './landcover.ts';
import type { DesignFlowSweep } from './engine/designflow.ts';
import {
  NEA_ROR_PPA,
  NEPAL_EFLOW_POLICY,
  POWER_DURATION_GUIDANCE,
} from './engine/hydro.ts';

export type ExportContext = {
  at: { lat: number; lon: number };
  region: RegionMode;
  boundaryDistanceKm: number | null;
  readiness: EngineeringReadiness;
  hazards: HazardScreen | null;
  upstreamConnectivity: UpstreamConnectivityScreen | null;
  cascade: CascadeScreen | null;
  faults: FaultScreen | null;
  geology: GeologyScreen | null;
  /**
   * Units the waterway crosses on Nepal's own 1:1,000,000 sheet. Null means
   * NOT RUN; a traverse whose `mappedKm` is short of `lengthKm` means the
   * national map is blank there, which is a different statement and one the
   * high country makes often.
   */
  geologyUnits: GeologyTraverse | null;
  hydest: HydestScreen | null;
  /** Ice routed to the intake down the mapped network. Null off the network. */
  glaciers?: GlacierScreen | null;
  /** The second published Nepali regression, shown beside the first. */
  mhsp: MhspScreen | null;
  /** Whether the flow-duration shape is plausible against the national band. */
  flowShape: ShapeVerdict | null;
  /**
   * A far larger river beside the one this study picked.
   *
   * Non-null means the click may be on the wrong channel, and since flow scales
   * with catchment area that is not a small error — it is the ratio of the two
   * catchments. It was on screen and absent from the report, which is the wrong
   * way round: the screen has the map beside it and the report does not.
   */
  ambiguity: { nearestKm2: number; mainKm2: number; mainKm: number; lat: number; lon: number } | null;
  /** The full spread and what drives it, not just the endpoints in `band`. */
  uncertainty: Uncertainty | null;
  /**
   * The daily record itself.
   *
   * The report draws a flow-duration curve and a monthly table, and neither can
   * be recovered from summary statistics. Carrying the series means the report
   * uses the engine's own buildFdc rather than a second implementation of it.
   */
  flow: { dates: string[]; values: number[] };
  flowChoice: FlowChoice | null;
  /** Level-pool screen for the selected intake and user-selected dam height. */
  pondage?: PondageResult | null;
  /** The same screen repeated along the reach: where the storage actually is. */
  pondageSweep?: PondagePositionSweep | null;
  /** Nearest points on the live OSM car-routing graph for the selected layout. */
  roadAccess?: RoadAccessScreen | null;
  /** What the waterway crosses: forest, cropland, settlement. */
  landcover?: LandcoverScreen | null;
  /** The design-flow trade-off for the layout on screen. */
  designSweep?: DesignFlowSweep | null;
  schemes: Scheme[];
  selected: Scheme | null;
  /**
   * Set when the scheme search and the flow arbitration would not settle and
   * the layout had to be frozen mid-cycle. `a` is the layout on screen, `b` the
   * one it kept flipping to. Null on every site that converges.
   */
  pickUnstable?: { a: string; b: string } | null;
  /** `uplandKm2` is present at runtime (App passes StudyPoint) and the report reads it. */
  path: {
    km: number;
    lat: number;
    lon: number;
    elevationM: number;
    meanCms: number;
    uplandKm2?: number;
  }[];
  demSource: string;
  demResolutionM: number;
  flowYears: number;
  flowMeanCms: number;
  networkMeanCms: number | null;
  /** Plausible range on the selected scheme, if one could be computed. */
  band: { capLow: number; capHigh: number; energyLow: number; energyHigh: number } | null;
  tracedFromTerrain: boolean;
  evaluated: number;
  licences: Licence[];
  gauges: Gauge[];
  /** Grid connection for the selected scheme, if one is selected. */
  grid: GridLink | null;
  /**
   * Sediment context for the SITE. The basin itself is per-scheme and computed
   * in the table below; this is what the catchment delivers and whether the
   * valley at the selected intake has room, neither of which is per-scheme.
   */
  sediment: { source: SedimentSource | null; bench: BenchFit | null } | null;
  /**
   * Evidence the screen calculates and shows but the file used to drop.
   *
   * A downloaded handoff was losing the 475-year PGA, the earthquake history,
   * the named protected areas and their regimes, and the private survey-sheet
   * context — so a reviewer could see the readiness conclusion but not the
   * values that produced it. Optional because a global-mode study has none of
   * them, not because they are decoration.
   */
  seismic?: { pga475g: number | null; quakeCount: number; largest: string | null } | null;
  conservation?: {
    inside: { name: string; regime: string }[];
    near: { name: string; regime: string; distanceKm: number }[];
    hard: boolean;
  } | null;
  localGis?: { municipality: string | null; sheet: string | null; isohyetMm: number | null } | null;
  /**
   * Added intakes and the gain they buy, when the screen is showing a boosted
   * headline. Without these the exported MW and GWh silently described the base
   * scheme while the page described the combined one.
   */
  collectors?: {
    gainFrac: number;
    counted: { name: string | null; lat: number; lon: number; flowFrac: number }[];
  } | null;
  /**
   * A measured record, when the engineer supplied one. Its presence changes what
   * the provenance header may claim: a file built on a gauge record must not say
   * its flow came from a global model.
   */
  measured: {
    name: string;
    values: number;
    from: string | null;
    to: string | null;
    ratio: number;
    notes: string[];
  } | null;
  /**
   * Catchment-mean ANNUAL precipitation at the studied reach, mm — CHPclim, via
   * the bundled network. Named for what it is rather than for its source,
   * because `waterBalance` in the report is calibrated against exactly this
   * quantity and must not be fed a different one.
   */
  catchmentRainMm?: number | null;
  assumptions: {
    exceedance: number;
    efficiency: number;
    headLossFrac: number;
    residualFrac: number;
  };
};

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** Every line a reader needs to judge how much to trust the rows below. */
/**
 * The machine record that rides on every exported FILE.
 *
 * It was briefly rendered into the report as an appendix too, and reverted:
 * every number in it is already stated in the body, in prose, next to the
 * thing it describes. An appendix that repeats the report is not an appendix,
 * it is eleven pages of noise. The data files are where an unedited record
 * belongs, because nothing there has a body to repeat.
 */
function provenance(c: ExportContext): string[] {
  const lines = [
    'HydroRecon — run-of-river screening',
    'https://github.com/Bijaykars  ·  MIT licence',
    `generated: ${stamp()}`,
    `study point: ${c.at.lat.toFixed(5)}, ${c.at.lon.toFixed(5)}`,
    `mode: ${c.region === 'nepal' ? 'NEPAL — national datasets and rules enabled' : 'GLOBAL — physical open-data screening only'}`,
    ...(c.boundaryDistanceKm !== null && c.boundaryDistanceKm <= 10
      ? [`border warning: ${c.boundaryDistanceKm.toFixed(1)} km from the generalized country outline; verify jurisdiction from authoritative survey/control points`]
      : []),
    '',
    'THIS IS SCREENING, NOT A FEASIBILITY STUDY.',
    'No waterway has been routed, no geotechnics done, nothing costed.',
    'Use it to rank ideas and decide what to survey, nothing further.',
    '',
    `river course: ${
      c.tracedFromTerrain
        ? 'traced downhill from terrain (no mapped river network covers this area)'
        : 'followed along the mapped HydroRIVERS centreline'
    }`,
    `terrain: ${c.demSource}, ~${Math.round(c.demResolutionM)} m sample spacing`,
    'terrain error: global DEMs carry roughly +/-10-16 m vertically in steep ground,',
    '  which propagates directly into head and therefore into capacity',
    ...(c.pondage
      ? [
          `PONDAGE LEVEL-POOL SCREEN: ${c.pondage.damHeightM.toFixed(1)} m retained height; ${(
            c.pondage.areaM2 / 10_000
          ).toFixed(2)} ha; ${(c.pondage.volumeM3 / 1_000_000).toFixed(3)} million m3${
            c.pondage.edgeLimited ? '; DEM-window edge reached, so area and storage are minima' : ''
          }`,
          `  terrain: ${c.pondage.source}; ~${Math.round(c.pondage.resolutionM)} m cells; full-supply level ${c.pondage.waterLevelM.toFixed(1)} m`,
          ...(c.pondage.terrainComparison
            ? [
                `  second terrain: ${c.pondage.terrainComparison.source}; ${c.pondage.terrainComparison.edgeLimited ? '>=' : ''}${(c.pondage.terrainComparison.areaM2 / 10_000).toFixed(2)} ha; ${c.pondage.terrainComparison.edgeLimited ? '>=' : ''}${(c.pondage.terrainComparison.volumeM3 / 1_000_000).toFixed(3)} million m3`,
                c.pondage.terrainComparison.edgeLimited
                  ? '  two-terrain comparison: second pool reaches the 10 km DEM edge; values are unresolved minimums and no range is claimed'
                  : `  two-terrain spread: ${c.pondage.terrainComparison.areaSpreadPct.toFixed(0)}% area; ${c.pondage.terrainComparison.volumeSpreadPct.toFixed(0)}% storage (diagnostic, not a confidence interval)`,
              ]
            : ['  second terrain: unavailable; result is not source-corroborated']),
          ...(c.pondage.ruggedness
            ? [
                `  terrain ruggedness: ArcHydro/Riley TRI SD ${c.pondage.ruggedness.triStdDevM.toFixed(1)} m in a ${c.pondage.ruggedness.sampleRadiusKm.toFixed(1)} km radius; warning metric, not an error percentage`,
              ]
            : []),
          `  method: connected 8-neighbour level-pool flood fill behind a finite inferred dam axis; ${PONDAGE_METHOD.grass}; ${PONDAGE_METHOD.whitebox}`,
          '  limitation: terrain-only screening; no surveyed thalweg/abutments, bathymetry, freeboard, sediment, backwater hydraulics, stability, spillway or inundation clearance',
        ]
      : []),
    ...(c.pondageSweep && c.pondageSweep.points.length >= 3
      ? [
          `PONDAGE POSITION SWEEP at ${c.pondageSweep.damHeightM.toFixed(1)} m retained, ${c.pondageSweep.points.length} of ${c.pondageSweep.asked} positions returning, source ${c.pondageSweep.source}: ` +
            c.pondageSweep.points
              .map((q: PondagePositionSweep['points'][number]) => `${q.offsetKm >= 0 ? '+' : ''}${q.offsetKm.toFixed(2)} km ${(q.volumeM3 / 1e6).toFixed(3)} Mm3 / dam ${q.damLengthM == null ? 'unbounded' : `${q.damLengthM.toFixed(0)} m`}${q.volumePerDamMetreM3 == null ? '' : ` / ${q.volumePerDamMetreM3.toFixed(0)} m3 per dam metre`}${q.edgeLimited ? ' (edge-limited, minimum)' : ''}`)
              .join('; '),
          c.pondageSweep.best
            ? `  best storage per metre of dam: ${c.pondageSweep.best.offsetKm >= 0 ? '+' : ''}${c.pondageSweep.best.offsetKm.toFixed(2)} km from the intake`
            : '  no position returned an unbounded pond, so none is ranked',
          '  ranking metric is volume per metre of dam, because raw volume always grows downstream and would simply point at the far end of the reach; no cost model is applied',
          '  a screen on top of a screen: every limitation of the level-pool pondage screen applies to every position here and compounds',
        ]
      : []),
    ...(c.designSweep && c.designSweep.points.length >= 3
      ? [
          `DESIGN-FLOW SWEEP at one fixed layout, ${c.designSweep.points.length} sizes from Q${Math.round(c.designSweep.points[c.designSweep.points.length - 1].exceedance * 100)} to Q${Math.round(c.designSweep.points[0].exceedance * 100)}: ` +
            c.designSweep.points
              .map((p) => `Q${Math.round(p.exceedance * 100)} ${p.capacityMW.toFixed(3)} MW / ${p.energyGwh.toFixed(1)} GWh / dry6+6 ${((p.dryShareSixSix ?? 0) * 100).toFixed(1)}%${p.marginalHours === null ? '' : ` / marginal ${p.marginalHours.toFixed(0)} h`}`)
              .join('; '),
          c.designSweep.dryLimitSixSix
            ? `  largest size clearing the NEA 30% dry bar: Q${Math.round(c.designSweep.dryLimitSixSix.exceedance * 100)} at ${c.designSweep.dryLimitSixSix.capacityMW.toFixed(3)} MW`
            : '  no size screened clears the NEA 30% dry bar',
          `  energy peaks at Q${Math.round(c.designSweep.maxEnergy.exceedance * 100)}, ${c.designSweep.maxEnergy.energyGwh.toFixed(1)} GWh`,
          '  method: each size re-sizes its own waterway, re-selects its own turbine and dispatches the full daily record; no capital cost, discount rate or NPV is applied, so this is a physical trade-off and not an economic optimum',
          '  the dry-share column reads 4-6 percentage points low against 74 DHM gauges (checks/dryshare-vs-gauges.mjs), so qualifying sizes are conservative',
        ]
      : []),
    ...(c.landcover
      ? [
          `LAND COVER ALONG THE ALIGNMENT, ${c.landcover.waterwayKm.toFixed(2)} km sampled at ${c.landcover.cellM} m: ` +
            c.landcover.along
              .map((a) => `${a.label} ${a.km.toFixed(2)} km (${(a.share * 100).toFixed(0)}%)`)
              .join('; '),
          `  intake on ${c.landcover.intake ?? 'unclassified ground'}; powerhouse on ${c.landcover.powerhouse ?? 'unclassified ground'}`,
          `  source: ${c.landcover.source}`,
          `  limitation: ${c.landcover.limitation} Measured on the centreline only, so a right of way, spoil disposal and access track are not included and the forest figure is a floor.`,
        ]
      : []),
    ...(c.roadAccess
      ? [
          `MOTOR-ROAD PROXIMITY SCREEN: intake ${c.roadAccess.intake ? `${c.roadAccess.intake.distanceM.toFixed(0)} m` : 'no car-graph road within 20 km'}; powerhouse ${c.roadAccess.powerhouse ? `${c.roadAccess.powerhouse.distanceM.toFixed(0)} m` : 'no car-graph road within 20 km'}`,
          `  source/method: ${c.roadAccess.source}; ${ROAD_ACCESS_METHOD.osrm}; OpenStreetMap contributors (${ROAD_ACCESS_METHOD.osmCopyright})`,
          `  limitation: ${c.roadAccess.limitation}`,
        ]
      : []),
    ...(c.region === 'nepal'
      ? [
          `Nepal context: DoED updated ${DOED_UPDATED} (bundled ${DOED_RETRIEVED}); ` +
            `DHM stations ${DHM_STATIONS_RETRIEVED}; OSM grid ${GRID_RETRIEVED}; ` +
            `OSM protected areas ${PROTECTED_RETRIEVED}`,
          ...(c.hazards
            ? [
                `BIPAD incidents: approved + verified records ${c.hazards.period.from} to ${c.hazards.period.to}; bundled ${c.hazards.retrieved}`,
              ]
            : []),
          ...(c.upstreamConnectivity
            ? [
                `upstream channel screen: GLO lakes ${c.upstreamConnectivity.lakes.length}; BIPAD reports ${c.upstreamConnectivity.incidents.length}; HydroRIVERS v${c.upstreamConnectivity.network.version}`,
              ]
            : []),
          ...(c.cascade
            ? [
                `DoED directed project screen: ${c.cascade.upstream.length} upstream and ${c.cascade.downstream.length} downstream midpoint candidate(s); ${c.cascade.registry.canonicalRecords} canonical geolocated records`,
              ]
            : []),
          ...(c.faults
            ? [
                `GEM active faults: ${c.faults.regionalFaultSources} Nepal-plus-buffer source traces; bundled ${c.faults.retrieved}; ${c.faults.license}`,
              ]
            : []),
        ]
      : [
          'country context: not assessed — Nepal-only DoED, DHM, grid, protected-area and PPA rules are disabled',
          'global inputs are limited to easily available open terrain, flow, river and basemap data',
        ]),
    ...(c.measured
      ? [
          `flow: MEASURED — imported from ${c.measured.name}`,
          `  ${c.measured.values} values` +
            `${c.measured.from ? `, ${c.measured.from} to ${c.measured.to}` : ', undated'}` +
            `${c.measured.ratio !== 1 ? `, scaled ${c.measured.ratio.toFixed(3)}x for catchment area` : ''}`,
          '  this record replaces both global models; the figures below are built on it',
          ...c.measured.notes.map((nn) => `  note: ${nn}`),
        ]
      : [
          `flow: GloFAS v4 consolidated history via Open-Meteo, ${c.flowYears.toFixed(0)} complete calendar years, modelled not gauged`,
          `flow mean at the model cell: ${c.flowMeanCms.toFixed(2)} m3/s`,
      ]),
  ];
  if (c.geology?.dmg) {
    lines.push(
      `DMG geology catalog: ${c.geology.dmg.maps.length} published 1:50,000 map product(s) touch the selected reach; source updated ${c.geology.dmg.updated}; bundled ${c.geology.dmg.retrieved}`,
      `  availability: ${c.geology.dmg.availability}`,
      '  catalog footprints are not site geology and the all-rights-reserved map imagery is not bundled'
    );
  }
  if (c.geology?.regional) {
    lines.push(
      `regional geology: Macrostrat point samples at intake, mid-reach and powerhouse; ${c.geology.regional.license}`,
      `  limitation: ${c.geology.regional.limitation}`
    );
  }
  if (c.geologyUnits) {
    const g = c.geologyUnits;
    lines.push(
      `national geology: ${g.source}, ${g.scale}, ${GEOLOGY_UNITS_LICENSE}`,
      `  traverse: ${g.formationContacts} formation contact(s) over ${g.lengthKm.toFixed(1)} km; ${g.mappedKm.toFixed(1)} km mapped`,
      `  intake on ${g.intake.name}; powerhouse on ${g.powerhouse.name}`,
      `  contact chainages carry about ${g.contactErrorKm.toFixed(1)} km of positional error at this scale`,
      `  limitation: ${g.limitation}`
    );
  }
  if (c.networkMeanCms !== null && !c.measured) {
    const ratio = Math.max(c.networkMeanCms / c.flowMeanCms, c.flowMeanCms / c.networkMeanCms);
    lines.push(
      `mapped network long-term mean here: ${c.networkMeanCms.toFixed(2)} m3/s`,
      `  the two global sources disagree by ${ratio.toFixed(1)}x`,
      ...(c.flowChoice?.authority === 'model'
        ? [
            '  magnitude below is taken from the flood model without network rescaling;',
            `  WECS/DHM regional comparison: ${c.flowChoice.note}`,
          ]
        : c.flowChoice?.authority === 'hydest'
          ? [
              `  magnitude below is provisionally rescaled to the WECS/DHM regional annual mean (${c.flowChoice.targetMeanCms?.toFixed(2) ?? 'unknown'} m3/s);`,
              '  day-to-day shape remains from the flood model; this is a screening fallback, not an observation',
              `  regional comparison: ${c.flowChoice.note}`,
            ]
          : [
              '  magnitude below is taken from the mapped network; day-to-day shape comes from the flood model',
              ...(c.flowChoice ? [`  comparison: ${c.flowChoice.note}`] : []),
            ])
    );
  }
  lines.push(
    '',
    'turbine selection and part-load curves ported from HydroGenerate',
    '  (Idaho National Laboratory, BSD-3-Clause), CANMET/RETScreen 2004 correlations',
    '',
    'assumptions (editable in the app):',
    `  design flow exceedance: Q${Math.round(c.assumptions.exceedance * 100)}`,
    `  generator and transformer: ${(c.assumptions.efficiency * 100).toFixed(0)}%`,
    '  hydraulic head loss: SIZED per scheme, not assumed — headrace and penstock',
    '    are dimensioned for each duty point (ESHA 2004 economic diameter capped at',
    '    5 m/s, Darcy-Weisbach with Swamee-Jain friction, Manning headrace, plus',
    '    rack/entrance/bend/valve local losses). See the per-scheme columns below.',
    `  residual flow: ${(c.assumptions.residualFrac * 100).toFixed(0)}% of the lowest monthly mean`,
    ...(c.region === 'nepal'
      ? [
          `  Nepal environmental-release policy floor: at least ${(NEPAL_EFLOW_POLICY.minimumFractionOfLowestMonthlyMean * 100).toFixed(0)}% of minimum monthly average discharge OR the higher EIA-required minimum`,
          `  source: ${NEPAL_EFLOW_POLICY.source}; reviewed ${NEPAL_EFLOW_POLICY.reviewed}`,
          '  the calculated release is a policy-floor screen, not an approved ecological-flow determination',
        ]
      : []),
    `  daily power-duration outputs: P90/P95 across usable record days; ${POWER_DURATION_GUIDANCE.interpretation}`,
    `  power-duration method: ${POWER_DURATION_GUIDANCE.reference}; ${POWER_DURATION_GUIDANCE.source}`,
    `  unit-count sensitivity: ${UNIT_SENSITIVITY_GUIDANCE.method}`,
    `  ${UNIT_SENSITIVITY_GUIDANCE.interpretation}`,
    '',
    `${c.evaluated} intake/powerhouse pairs evaluated; ${c.schemes.length} kept as non-dominated`
  );
  if (c.band && c.selected) {
    lines.push(
      '',
      'PLAUSIBLE RANGE on the selected scheme, from the uncertainty its inputs carry:',
      `  capacity: ${c.band.capLow.toFixed(1)} - ${c.band.capHigh.toFixed(1)} MW ` +
        `(reported ${c.selected.capacityMW.toFixed(1)})`,
      `  energy:   ${c.band.energyLow.toFixed(0)} - ${c.band.energyHigh.toFixed(0)} GWh/yr ` +
        `(reported ${c.selected.energyGwh.toFixed(0)})`,
      '  the single figures in the table below are midpoints, not measurements'
    );
  }
  if (c.collectors && c.collectors.gainFrac > 0) {
    lines.push(
      '',
      `COLLECTOR INTAKES: ${c.collectors.counted.length} added, raising design flow by ` +
        `${(c.collectors.gainFrac * 100).toFixed(0)}%`,
      ...c.collectors.counted.map(
        (k) =>
          `  ${k.name ?? 'tributary'} at ${k.lat.toFixed(5)}, ${k.lon.toFixed(5)} — ` +
          `+${(k.flowFrac * 100).toFixed(0)}% of the main flow`
      ),
      '  the per-scheme rows below are the BASE plant. The combined figure shown on',
      '  screen scales capacity and energy by the gain above and does NOT resize the',
      '  waterway, so its head loss (which rises with the square of flow), turbine',
      '  selection and residual release are those of the base scheme.'
    );
  }
  if (c.seismic) {
    lines.push(
      '',
      'SEISMIC CONTEXT at the selected reach:',
      c.seismic.pga475g != null
        ? `  peak ground acceleration, 475-year return: ${c.seismic.pga475g.toFixed(3)} g`
        : '  peak ground acceleration: not available here',
      `  recorded earthquakes in the catalogue nearby: ${c.seismic.quakeCount}`,
      ...(c.seismic.largest ? [`  largest: ${c.seismic.largest}`] : [])
    );
  }
  if (c.conservation) {
    lines.push(
      '',
      c.conservation.hard
        ? 'PROTECTED AREAS — HARD STOP: the layout falls inside a regime that does not permit this.'
        : 'PROTECTED AREAS near the selected layout:',
      ...c.conservation.inside.map((a) => `  INSIDE: ${a.name} (${a.regime})`),
      ...c.conservation.near.map(
        (a) => `  within ${a.distanceKm.toFixed(1)} km: ${a.name} (${a.regime})`
      ),
      '  boundaries are simplified; a site near one needs the gazetted boundary, not this.'
    );
  }
  if (c.localGis) {
    lines.push(
      '',
      'LOCAL CONTEXT (privately supplied survey layers, not redistributed):',
      ...(c.localGis.municipality ? [`  municipality: ${c.localGis.municipality}`] : []),
      ...(c.localGis.sheet ? [`  survey sheet: ${c.localGis.sheet}`] : []),
      ...(c.localGis.isohyetMm != null
        ? [`  isohyet band: ${c.localGis.isohyetMm} mm/yr`]
        : [])
    );
  }
  if (c.hazards) {
    const found = c.hazards.categories.filter((category) => category.count > 0);
    lines.push(
      '',
      `RECORDED NATURAL HAZARDS: ${c.hazards.total} approved, verified BIPAD report(s) within ${c.hazards.radiusKm} km of the selected reach`,
      found.length
        ? `  breakdown: ${found.map((category) => `${category.title} ${category.count}`).join(', ')}`
        : '  no mapped report was found in the screened categories; this does not clear the site',
      `  inventory: ${c.hazards.period.from} to ${c.hazards.period.to}; bundled ${c.hazards.retrieved}`,
      `  source: ${c.hazards.source}`,
      `  limitation: ${c.hazards.limitation}`
    );
  }
  if (c.upstreamConnectivity) {
    const expanding = c.upstreamConnectivity.lakes.filter((lake) =>
      lake.expansionSignificant === true &&
      (lake.expansionRateKm2Yr ?? 0) > 0 &&
      lake.timeSeriesOutlier !== true
    );
    lines.push(
      '',
      `UPSTREAM CHANNEL-CONNECTIVITY CANDIDATES: ${c.upstreamConnectivity.lakes.length} glacial-lake centroid(s); ${c.upstreamConnectivity.incidents.length} BIPAD report point(s)`,
      `  lake inventory: ${c.upstreamConnectivity.lakeInventory.total} unique Sentinel-2 centroids, ${c.upstreamConnectivity.lakeInventory.observations.from}-${c.upstreamConnectivity.lakeInventory.observations.to}; published ${c.upstreamConnectivity.lakeInventory.published}; bundled ${c.upstreamConnectivity.lakeInventory.retrieved}`,
      `  unflagged significant positive expansion signals among connected lakes: ${expanding.length}; expansion is not breach likelihood`,
      ...c.upstreamConnectivity.lakes.slice(0, 8).map((lake) =>
        `  lake: ${lake.id}, ${lake.basin}/${lake.country}, ${lake.routeKm.toFixed(1)} km directed route, ${lake.snapKm.toFixed(2)} km snap, ${lake.elevationM.toFixed(0)} m${lake.expansionRateKm2Yr == null ? '' : `, trend ${lake.expansionRateKm2Yr.toFixed(4)} km2/yr${lake.expansionSignificant === true ? ' significant' : ''}${lake.timeSeriesOutlier === true ? ' OUTLIER-FLAGGED' : ''}`}`
      ),
      ...c.upstreamConnectivity.incidents.slice(0, 8).map((incident) =>
        `  report: BIPAD ${incident.id}, ${incident.title}, ${incident.date}, ${incident.routeKm.toFixed(1)} km directed route, ${incident.snapKm.toFixed(2)} km snap`
      ),
      `  method: ${c.upstreamConnectivity.method}`,
      `  network: ${c.upstreamConnectivity.network.source} v${c.upstreamConnectivity.network.version}, ${c.upstreamConnectivity.network.resolution}; ${c.upstreamConnectivity.network.streamThreshold}`,
      `  lake source: ${c.upstreamConnectivity.lakeInventory.source}; ${c.upstreamConnectivity.lakeInventory.license}`,
      `  limitation: ${c.upstreamConnectivity.limitation}`
    );
  }
  if (c.faults) {
    const nearest = c.faults.nearest;
    lines.push(
      '',
      `REGIONAL ACTIVE-FAULT CONTEXT: ${c.faults.nearby.length} GEM trace(s) within ${c.faults.radiusKm} km; ${c.faults.crossings} mapped river-reach intersection(s)`,
      nearest
        ? `  nearest: ${nearest.name ?? nearest.sourceId} (${nearest.type}), ${nearest.distanceKm.toFixed(2)} km from the reach${nearest.intersectsReach ? ` near chainage ${nearest.chainageKm.toFixed(2)} km` : ''}`
        : '  no nearest trace result is available',
      `  source: ${c.faults.sourceUrl} @ ${c.faults.commit}`,
      `  data licence: ${c.faults.license}; ${c.faults.licenseUrl}`,
      `  limitation: ${c.faults.limitation}`
    );
  }
  if (c.geology) {
    lines.push('', 'ENGINEERING GEOLOGY SOURCES:');
    if (c.geology.dmg) {
      lines.push(
        c.geology.dmg.maps.length
          ? `  official DMG 1:50,000 publications: ${c.geology.dmg.maps.map((map) => `${map.sheets.map((sheet) => sheet.code).join('/')}—${map.title}`).join('; ')}`
          : `  ${c.geology.dmg.limitation}`,
        `  rights: ${c.geology.dmg.rights}`,
        `  source: ${c.geology.dmg.sourceUrl}`
      );
    }
    if (c.geology.regional) {
      lines.push(
        ...c.geology.regional.samples.map((sample) =>
          `  ${sample.role}: ${sample.units.length ? sample.units.map((unit) => `${unit.name} (${unit.lithology})`).join('; ') : 'no mapped regional unit returned'}`
        ),
        `  original references: ${Object.entries(c.geology.regional.references).map(([id, reference]) => `${id}: ${reference}`).join('; ') || 'none returned'}`,
        `  source: ${c.geology.regional.sourceUrl}; ${c.geology.regional.license}`
      );
    } else if (c.geology.regionalError) {
      lines.push(`  regional source unavailable: ${c.geology.regionalError}`);
    }
  }
  if (c.hydest) {
    const h = c.hydest;
    lines.push(
      '',
      'WECS/DHM REGIONAL HYDROLOGY SCREEN — NOT A PROJECT DESIGN-FLOOD SELECTION:',
      `  inputs: total catchment ${h.input.totalKm2.toFixed(3)} km2; below 5000 m ${h.input.below5000Km2.toFixed(3)} km2; below 3000 m ${h.input.below3000Km2.toFixed(3)} km2; monsoon precipitation ${h.input.monsoonMm == null ? 'unavailable' : `${h.input.monsoonMm.toFixed(0)} mm`}`,
      `  lowest regional monthly mean: month ${h.driest.month + 1}, ${h.driest.cms.toFixed(3)} m3/s`,
      `  regional monthly means: ${h.months.map((month) => `${month.month + 1}=${month.cms.toFixed(3)}`).join('; ')} m3/s`,
      `  regional return-period estimates: ${h.floods.map((flood) => `Q${flood.t}=${flood.cms.toFixed(3)}`).join('; ')} m3/s`,
      ...(h.agreement
        ? [`  dry-season model comparison: ${h.agreement.ratio.toFixed(3)}x; ${h.agreement.agree ? 'consistent for screening' : 'material disagreement — prioritize gauge transfer and measurement'}`]
        : ['  dry-season model comparison: unavailable']),
      `  monthly equation: ${h.provenance.equations.monthly}`,
      `  flood anchors: ${h.provenance.equations.q2}; ${h.provenance.equations.q100}`,
      `  interpolation: ${h.provenance.equations.interpolation}`,
      `  method: ${h.provenance.primaryCitation.title}, ${h.provenance.primaryCitation.publisher} (${h.provenance.primaryCitation.year})`,
      `  method catalogue: ${h.provenance.primaryCitation.catalogue}`,
      `  current guidance: ${h.provenance.guidance.headworks}; ${h.provenance.guidance.floodManual}`,
      `  rainfall input: ${h.provenance.rainfall.product}, ${h.provenance.rainfall.resolution}; ${h.provenance.rainfall.productUrl}`,
      ...h.provenance.rainfall.files.map((file) => `  rainfall source month ${file.month}: ${file.url}; ${file.bytes} bytes; SHA-256 ${file.sha256}`),
      `  rainfall rights: ${h.provenance.rainfall.rights}`,
      `  catchment source: ${h.provenance.hydrobasins.product}; ${h.provenance.hydrobasins.url}; SHA-256 ${h.provenance.hydrobasins.sha256}`,
      `  hypsometry source: ${h.provenance.hypsometry.terrain}, zoom ${h.provenance.hypsometry.terrainZoom}, ${h.provenance.hypsometry.rasterStepDegrees}° raster; ${h.provenance.hypsometry.terrainUrl}`,
      `  reach bundle: built ${h.provenance.bundle.built}; SHA-256 ${h.provenance.bundle.output.sha256}`,
      ...h.provenance.limitations.map((limitation) => `  limitation: ${limitation}`)
    );
  }
  if (c.readiness.gates.length) {
    lines.push(
      '',
      `ENGINEERING READINESS: ${c.readiness.label}`,
      '  No aggregate score is reported; one fatal gate must not be averaged away.',
      ...c.readiness.gates.flatMap((g) => [
        `  [${g.level.toUpperCase()}] ${g.title}: ${g.summary}`,
        `    next: ${g.next}`,
      ]),
      '',
      `FIELD INVESTIGATION CAMPAIGN (${c.readiness.tasks.length} work packages):`,
      ...c.readiness.tasks.flatMap((t, i) => [
        `  ${i + 1}. [${t.priority}] ${t.discipline} — ${t.title}`,
        `     why: ${t.reason}`,
        `     deliverable: ${t.deliverable}`,
      ])
    );
  }
  if (c.selected?.reliability) {
    const r = c.selected.reliability;
    lines.push(
      '',
      `INTERANNUAL ENERGY (${r.annual.length} complete dispatched years):`,
      `  P50: ${r.p50Gwh.toFixed(1)} GWh/yr`,
      `  P90: ${r.p90Gwh.toFixed(1)} GWh/yr (equalled or exceeded in 90% of modelled years)`,
      `  observed model-year range: ${r.worstGwh.toFixed(1)}-${r.bestGwh.toFixed(1)} GWh/yr`,
      ...(c.region === 'nepal'
        ? [
            `  NEA ROR PPA 6+6 option: ${(r.ppaSixSix.dryShare * 100).toFixed(1)}% dry energy ` +
              `(${r.ppaSixSix.meets ? 'meets' : 'below'} 30%)`,
            `  NEA ROR PPA 8+4 option: ${(r.ppaEightFour.dryShare * 100).toFixed(1)}% dry energy ` +
              `(${r.ppaEightFour.meets ? 'meets' : 'below'} 15%)`,
            `  gross published-base-rate reference, 6+6: NPR ${r.ppaSixSix.grossReferenceValueMillionNpr.toFixed(1)} million/year; blended ${r.ppaSixSix.blendedBaseRateNprPerKwh.toFixed(3)} NPR/kWh`,
            `  gross published-base-rate reference, 8+4: NPR ${r.ppaEightFour.grossReferenceValueMillionNpr.toFixed(1)} million/year; blended ${r.ppaEightFour.blendedBaseRateNprPerKwh.toFixed(3)} NPR/kWh`,
            `  rates: wet ${NEA_ROR_PPA.wetNprPerKwh.toFixed(2)}, dry ${NEA_ROR_PPA.dryNprPerKwh.toFixed(2)} NPR/kWh; effective ${NEA_ROR_PPA.effectiveBs} BS (${NEA_ROR_PPA.effectiveAd} AD); reviewed ${NEA_ROR_PPA.reviewed}`,
            `  source: ${NEA_ROR_PPA.decisionPdf}`,
            `  ${NEA_ROR_PPA.interpretation}`,
            `  escalation: ${NEA_ROR_PPA.escalation}`,
            ...(c.selected && c.selected.capacityMW > NEA_ROR_PPA.postedRateCapacityUpToMW
              ? [`  ABOVE POSTED-RATE CAPACITY BOUNDARY: ${c.selected.capacityMW.toFixed(1)} MW; ${NEA_ROR_PPA.above100MW}`]
              : []),
          ]
        : []),
      '  P90 describes interannual hydrology, not contractual firm capacity.',
      ...(c.region === 'nepal'
        ? ['  Bikram Sambat PPA season boundaries are approximated to the nearest Gregorian day.']
        : [])
    );
  }
  if (c.grid) {
    lines.push(
      '',
      'GRID CONNECTION from the powerhouse (straight line — a floor, not a route):',
      `  nearest mapped line: ${c.grid.nearestKm.toFixed(1)} km` +
        `${c.grid.nearestKv ? ` at ${c.grid.nearestKv} kV` : ' (voltage not tagged)'}`,
      c.grid.adequateKm !== null
        ? `  nearest at ${c.grid.requiredKv} kV or above: ${c.grid.adequateKm.toFixed(1)} km at ${c.grid.adequateKv} kV`
        : `  NO mapped line at ${c.grid.requiredKv} kV or above within range`,
      ...(c.grid.nearestSub
        ? [
            `  nearest substation: ${c.grid.nearestSub.km.toFixed(1)} km, ` +
              `${c.grid.nearestSub.name ?? 'unnamed'}${c.grid.nearestSub.kv ? `, ${c.grid.nearestSub.kv} kV` : ''}`,
          ]
        : []),
      '  grid data: OpenStreetMap via Overpass, (c) OpenStreetMap contributors, ODbL 1.0.',
      '  Coverage is good on the transmission backbone and patchy below 66 kV —',
      '  an absent line means unmapped, not absent.'
    );
  }
  if (c.sediment?.source || c.sediment?.bench) {
    lines.push('', 'SEDIMENT:');
    if (c.sediment.source) {
      lines.push(
        `  ${c.sediment.source.label} — ${(c.sediment.source.highFrac * 100).toFixed(0)}% of the catchment above 3000 m`,
        `  ${c.sediment.source.note}`
      );
    }
    if (c.sediment.bench) {
      const b = c.sediment.bench;
      lines.push(
        b.verdict === 'fits'
          ? `  room for the basin: about ${b.widestM.toFixed(0)} m of workable bench on the ${b.side} bank, ${b.liftM.toFixed(0)} m above the river`
          : b.verdict === 'no-room'
            ? `  NO ROOM for the basin beside the selected intake — widest workable ground ${b.widestM.toFixed(0)} m`
            : `  room for the basin is too close to call: ${b.widestM.toFixed(0)} m found, against terrain known to ~${b.resolutionM.toFixed(0)} m`
      );
    }
    lines.push(
      '  Basin sizes in the table are screening estimates: Zanke settling velocity for',
      '  quartz, ideal basin x2 for turbulence, gravity-fed bench within 20 m of the river.',
      ...(c.region === 'nepal'
        ? [
            '  No open Nepal suspended-sediment series is bundled, so source conditions are',
            '  inferred from catchment altitude, not measured. A real design needs sampling.',
          ]
        : [
            '  No site sediment series is used. A real design needs a local sampling programme.',
          ])
    );
  }
  if (c.gauges.length > 0) {
    lines.push(
      '',
      'TO NARROW THE FLOW UNCERTAINTY, request these gauged records from Nepal DHM:',
      ...c.gauges
        .slice(0, 3)
        .map(
          (g) =>
            `  ${g.name} — ${g.relation}, ${g.distanceKm.toFixed(1)} km away` +
            `${g.uplandKm2 ? `, ${g.uplandKm2.toFixed(0)} km2 catchment` : ''}` +
            `${g.basin ? `, ${g.basin} basin` : ''}\n` +
            `    holds: ${recordKind(g)}\n` +
            `    ${transferAdvice(g)}`
        ),
      '  station values are not public (the DHM API requires a key, and refuses',
      "  DHM's own portal too); locations and what each station measures are."
    );
  }
  if (c.licences.length > 0) {
    const hard = c.licences.filter(
      (l) => l.stage === 'Operating' || l.stage === 'Construction licence'
    ).length;
    lines.push(
      '',
      `WARNING — DOED CONFLICT SCREEN: ${c.licences.length} official project record(s) within 6 km of this reach; ${hard} operating/construction licence record(s):`,
      ...c.licences
        .slice(0, 8)
        .map(
          (l) =>
            `  ${l.name} — ${l.stage}${l.capacityMW ? `, ${l.capacityMW} MW` : ''}, ` +
            (l.distanceKm < 0.05
              ? 'published coordinate range overlaps the reach'
              : `${l.distanceKm.toFixed(1)} km from the published coordinate range`)
        ),
      `  source: official Nepal DoED registers, updated ${DOED_UPDATED}; bundled ${DOED_RETRIEVED}`,
      '  DoED publishes coordinate ranges, not project alignments. Verify legal status and geometry live.'
    );
  }
  if (c.cascade) {
    const projects = [...c.cascade.upstream, ...c.cascade.downstream];
    const advanced = projects.filter((project) => isAdvancedDoedStage(project.stage)).length;
    lines.push(
      '',
      `DOED DIRECTED PROJECT-INTERACTION SCREEN: ${c.cascade.upstream.length} upstream and ${c.cascade.downstream.length} downstream candidate(s); ${advanced} operating/construction-stage record(s).`,
      ...(projects.length
        ? projects.slice(0, 16).map(
            (project) =>
              `  ${project.name} — candidate ${project.direction}; ${project.stage}${project.capacityMW != null ? `, ${project.capacityMW} MW` : ''}; ${project.routeKm.toFixed(1)} km directed route; ${project.snapKm.toFixed(2)} km midpoint snap; DoED published-range diagonal ${project.publishedRangeDiagonalKm.toFixed(1)} km`
          )
        : ['  No midpoint passed the guarded directed-network thresholds. This is not cascade clearance.']),
      `  method: ${c.cascade.method}`,
      `  limitation: ${c.cascade.limitation}`,
      `  sources: ${c.cascade.registry.source}; ${c.cascade.network.sourceUrl}`,
      `  official guidance: ${c.cascade.guidance.study}; ${c.cascade.guidance.optimization}`
    );
  }
  return lines;
}

/** Quote anything a spreadsheet would otherwise split or reinterpret. */
const cell = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function schemesToCsv(c: ExportContext): string {
  const head = provenance(c).map((l) => `# ${l}`);
  const cols = [
    'id',
    'selected',
    'capacity_MW',
    'annual_energy_GWh',
    'P50_annual_energy_GWh',
    'P90_annual_energy_GWh',
    'daily_P90_hydrological_power_MW',
    'daily_P95_hydrological_power_MW',
    'zero_output_days_fraction',
    'power_duration_basis_days',
    ...UNIT_SENSITIVITY_GUIDANCE.unitCounts.flatMap((units) => [
      `${units}_unit_turbine`,
      `${units}_unit_capacity_MW`,
      `${units}_unit_energy_GWh`,
      `${units}_unit_daily_P90_MW`,
      `${units}_unit_daily_P95_MW`,
      `${units}_unit_zero_output_fraction`,
    ]),
    'NEA_6plus6_dry_energy_share',
    'NEA_6plus6_meets_30pct',
    'NEA_8plus4_dry_energy_share',
    'NEA_8plus4_meets_15pct',
    'NEA_6plus6_gross_base_rate_reference_million_NPR_per_year',
    'NEA_6plus6_blended_base_rate_NPR_per_kWh',
    'NEA_8plus4_gross_base_rate_reference_million_NPR_per_year',
    'NEA_8plus4_blended_base_rate_NPR_per_kWh',
    'gross_head_m',
    'net_head_m',
    'design_flow_m3s',
    'source_record_scale_to_intake',
    'residual_flow_m3s',
    'waterway_km',
    'drop_rate_m_per_km',
    'plant_factor',
    'head_loss_m',
    'head_loss_pct_of_gross',
    'penstock_diameter_m',
    'penstock_velocity_ms',
    'headrace_diameter_m',
    'turbine',
    'turbine_best_point',
    'desander_target_mm',
    'desander_length_m',
    'desander_width_m',
    'desander_bench_needed_m',
    'intake_lat',
    'intake_lon',
    'powerhouse_lat',
    'powerhouse_lon',
    // Retained WATER LEVEL above the detected bed, which is what the UI
    // controls and what the slider says. Structural dam height is that plus
    // freeboard and any non-retaining crest allowance, neither of which this
    // tool knows — so it must not be exported under that name.
    'selected_pondage_retained_water_level_m',
    'selected_pondage_area_ha',
    'selected_pondage_storage_million_m3',
    'selected_pondage_edge_limited',
    'selected_pondage_second_terrain_source',
    'selected_pondage_second_area_ha',
    'selected_pondage_second_storage_million_m3',
    'selected_pondage_second_edge_limited',
    'selected_pondage_two_terrain_area_spread_pct',
    'selected_pondage_two_terrain_storage_spread_pct',
    'selected_pondage_tri_sd_m',
    'selected_pondage_stage_curve_height_m_area_ha_storage_million_m3',
    'selected_intake_motor_road_gap_m',
    'selected_powerhouse_motor_road_gap_m',
    'why_kept',
  ];
  const rows = c.schemes.map((s) => {
    const d = desander({ designFlowCms: s.designFlowCms, netHeadM: s.netHeadM });
    const chosen = Boolean(c.selected && s.i === c.selected.i && s.j === c.selected.j);
    return [
      `S${c.schemes.indexOf(s) + 1}`,
      chosen ? 'yes' : '',
      s.capacityMW.toFixed(3),
      s.energyGwh.toFixed(2),
      s.reliability?.p50Gwh.toFixed(2) ?? '',
      s.reliability?.p90Gwh.toFixed(2) ?? '',
      s.powerDuration?.p90MW.toFixed(3) ?? '',
      s.powerDuration?.p95MW.toFixed(3) ?? '',
      s.powerDuration?.zeroOutputFraction.toFixed(4) ?? '',
      s.powerDuration?.days ?? '',
      ...UNIT_SENSITIVITY_GUIDANCE.unitCounts.flatMap((units) => {
        const scenario = s.unitSensitivity?.find((item) => item.units === units);
        return scenario
          ? [
              scenario.turbine ?? 'review',
              scenario.capacityMW.toFixed(3),
              scenario.energyGwh.toFixed(2),
              scenario.dailyP90MW.toFixed(3),
              scenario.dailyP95MW.toFixed(3),
              scenario.zeroOutputFraction.toFixed(4),
            ]
          : ['', '', '', '', '', ''];
      }),
      c.region === 'nepal' ? (s.reliability?.ppaSixSix.dryShare.toFixed(4) ?? '') : '',
      c.region === 'nepal' && s.reliability ? (s.reliability.ppaSixSix.meets ? 'yes' : 'no') : '',
      c.region === 'nepal' ? (s.reliability?.ppaEightFour.dryShare.toFixed(4) ?? '') : '',
      c.region === 'nepal' && s.reliability ? (s.reliability.ppaEightFour.meets ? 'yes' : 'no') : '',
      c.region === 'nepal' ? (s.reliability?.ppaSixSix.grossReferenceValueMillionNpr.toFixed(3) ?? '') : '',
      c.region === 'nepal' ? (s.reliability?.ppaSixSix.blendedBaseRateNprPerKwh.toFixed(4) ?? '') : '',
      c.region === 'nepal' ? (s.reliability?.ppaEightFour.grossReferenceValueMillionNpr.toFixed(3) ?? '') : '',
      c.region === 'nepal' ? (s.reliability?.ppaEightFour.blendedBaseRateNprPerKwh.toFixed(4) ?? '') : '',
      s.grossHeadM.toFixed(1),
      s.netHeadM.toFixed(1),
      s.designFlowCms.toFixed(3),
      s.flowScale.toFixed(5),
      s.residualCms.toFixed(3),
      s.waterwayKm.toFixed(3),
      s.slopeMPerKm.toFixed(1),
      s.plantFactor.toFixed(3),
      (s.grossHeadM - s.netHeadM).toFixed(2),
      s.waterway ? (s.waterway.lossFrac * 100).toFixed(2) : '',
      s.waterway?.segments.find((x) => x.kind === 'penstock')?.diameterM.toFixed(2) ?? '',
      s.waterway?.segments.find((x) => x.kind === 'penstock')?.velocityMs.toFixed(2) ?? '',
      s.waterway?.segments.find((x) => x.kind === 'headrace')?.diameterM.toFixed(2) ?? '',
      s.turbine ?? 'none in range',
      s.turbinePeak.toFixed(3),
      d ? d.particleMm.toFixed(2) : '',
      d ? d.totalLengthM.toFixed(0) : '',
      d ? d.totalWidthM.toFixed(1) : '',
      d ? d.benchNeededM.toFixed(0) : '',
      s.intake.lat.toFixed(5),
      s.intake.lon.toFixed(5),
      s.power.lat.toFixed(5),
      s.power.lon.toFixed(5),
      chosen && c.pondage ? c.pondage.damHeightM.toFixed(1) : '',
      chosen && c.pondage ? (c.pondage.areaM2 / 10_000).toFixed(3) : '',
      chosen && c.pondage ? (c.pondage.volumeM3 / 1_000_000).toFixed(5) : '',
      chosen && c.pondage ? (c.pondage.edgeLimited ? 'yes' : 'no') : '',
      chosen && c.pondage?.terrainComparison ? c.pondage.terrainComparison.source : '',
      chosen && c.pondage?.terrainComparison
        ? (c.pondage.terrainComparison.areaM2 / 10_000).toFixed(3)
        : '',
      chosen && c.pondage?.terrainComparison
        ? (c.pondage.terrainComparison.volumeM3 / 1_000_000).toFixed(5)
        : '',
      chosen && c.pondage?.terrainComparison
        ? c.pondage.terrainComparison.edgeLimited
          ? 'yes'
          : 'no'
        : '',
      chosen && c.pondage?.terrainComparison
        ? c.pondage.terrainComparison.areaSpreadPct.toFixed(1)
        : '',
      chosen && c.pondage?.terrainComparison
        ? c.pondage.terrainComparison.volumeSpreadPct.toFixed(1)
        : '',
      chosen && c.pondage?.ruggedness ? c.pondage.ruggedness.triStdDevM.toFixed(2) : '',
      chosen && c.pondage?.stageCurve
        ? c.pondage.stageCurve
            .map(
              (point) =>
                `${point.retainedHeightM.toFixed(2)}:${(point.areaM2 / 10_000).toFixed(3)}:${(point.volumeM3 / 1_000_000).toFixed(5)}`
            )
            .join('|')
        : '',
      chosen && c.roadAccess?.intake ? c.roadAccess.intake.distanceM.toFixed(1) : '',
      chosen && c.roadAccess?.powerhouse ? c.roadAccess.powerhouse.distanceM.toFixed(1) : '',
      s.reasons.join('; '),
    ]
      .map(cell)
      .join(',');
  });
  return [...head, '', cols.join(','), ...rows].join('\n') + '\n';
}

/** A field-ready work package register that can be assigned and costed. */
export function fieldPlanToCsv(c: ExportContext): string {
  const head = [
    '# HydroRecon engineering field investigation plan',
    `# generated: ${stamp()}`,
    `# study point: ${c.at.lat.toFixed(5)}, ${c.at.lon.toFixed(5)}`,
    `# mode: ${c.region}`,
    `# decision: ${c.readiness.label}`,
    '# This is a pre-feasibility investigation brief, not a design or permit clearance.',
    ...(c.hydest
      ? [
          `# WECS/DHM regional comparator: Q100 ${c.hydest.floods.find((flood) => flood.t === 100)?.cms.toFixed(0) ?? 'unavailable'} m3/s; not a selected design flood.`,
          `# Flood guidance: ${c.hydest.provenance.guidance.headworks}`,
        ]
      : []),
    ...(c.region === 'nepal'
      ? [
          `# Environmental-release screen: ${(c.assumptions.residualFrac * 100).toFixed(0)}% of lowest monthly mean; EIA-required minimum governs when higher.`,
          `# Policy source: ${NEPAL_EFLOW_POLICY.source}`,
        ]
      : []),
  ];
  const cols = [
    'record_type',
    'priority_or_level',
    'discipline',
    'work_package_or_gate',
    'finding_or_reason',
    'deliverable_or_next_action',
  ];
  const gateRows = c.readiness.gates.map((g) =>
    ['gate', g.level, g.title, g.title, `${g.summary} Evidence: ${g.evidence.join(' ')}`, g.next]
      .map(cell)
      .join(',')
  );
  const taskRows = c.readiness.tasks.map((t) =>
    ['field_task', t.priority, t.discipline, t.title, t.reason, t.deliverable]
      .map(cell)
      .join(',')
  );
  return [...head, '', cols.join(','), ...gateRows, ...taskRows].join('\n') + '\n';
}

/**
 * Scheme geometry for a GIS. The diverted reach as a line, the intake and
 * powerhouse as points, every attribute carried along so the file stands alone.
 */
export function schemesToGeoJson(c: ExportContext): string {
  const features: GeoJSON.Feature[] = [];

  c.schemes.forEach((s, idx) => {
    const id = `S${idx + 1}`;
    const chosen = Boolean(c.selected && s.i === c.selected.i && s.j === c.selected.j);
    const props = {
      id,
      selected: chosen,
      capacity_MW: Number(s.capacityMW.toFixed(3)),
      annual_energy_GWh: Number(s.energyGwh.toFixed(2)),
      P50_annual_energy_GWh: s.reliability ? Number(s.reliability.p50Gwh.toFixed(2)) : null,
      P90_annual_energy_GWh: s.reliability ? Number(s.reliability.p90Gwh.toFixed(2)) : null,
      daily_P90_hydrological_power_MW: s.powerDuration
        ? Number(s.powerDuration.p90MW.toFixed(3))
        : null,
      daily_P95_hydrological_power_MW: s.powerDuration
        ? Number(s.powerDuration.p95MW.toFixed(3))
        : null,
      zero_output_days_fraction: s.powerDuration
        ? Number(s.powerDuration.zeroOutputFraction.toFixed(4))
        : null,
      power_duration_basis_days: s.powerDuration?.days ?? null,
      unit_count_sensitivity: s.unitSensitivity ?? null,
      NEA_6plus6_dry_energy_share: c.region === 'nepal' && s.reliability
        ? Number(s.reliability.ppaSixSix.dryShare.toFixed(4))
        : null,
      NEA_6plus6_meets_30pct:
        c.region === 'nepal' ? (s.reliability?.ppaSixSix.meets ?? null) : null,
      NEA_8plus4_dry_energy_share: c.region === 'nepal' && s.reliability
        ? Number(s.reliability.ppaEightFour.dryShare.toFixed(4))
        : null,
      NEA_8plus4_meets_15pct:
        c.region === 'nepal' ? (s.reliability?.ppaEightFour.meets ?? null) : null,
      NEA_6plus6_gross_base_rate_reference_million_NPR_per_year:
        c.region === 'nepal' && s.reliability
          ? Number(s.reliability.ppaSixSix.grossReferenceValueMillionNpr.toFixed(3))
          : null,
      NEA_6plus6_blended_base_rate_NPR_per_kWh:
        c.region === 'nepal' && s.reliability
          ? Number(s.reliability.ppaSixSix.blendedBaseRateNprPerKwh.toFixed(4))
          : null,
      NEA_8plus4_gross_base_rate_reference_million_NPR_per_year:
        c.region === 'nepal' && s.reliability
          ? Number(s.reliability.ppaEightFour.grossReferenceValueMillionNpr.toFixed(3))
          : null,
      NEA_8plus4_blended_base_rate_NPR_per_kWh:
        c.region === 'nepal' && s.reliability
          ? Number(s.reliability.ppaEightFour.blendedBaseRateNprPerKwh.toFixed(4))
          : null,
      gross_head_m: Number(s.grossHeadM.toFixed(1)),
      net_head_m: Number(s.netHeadM.toFixed(1)),
      design_flow_m3s: Number(s.designFlowCms.toFixed(3)),
      source_record_scale_to_intake: Number(s.flowScale.toFixed(5)),
      residual_flow_m3s: Number(s.residualCms.toFixed(3)),
      waterway_km: Number(s.waterwayKm.toFixed(3)),
      drop_rate_m_per_km: Number(s.slopeMPerKm.toFixed(1)),
      plant_factor: Number(s.plantFactor.toFixed(3)),
      turbine: s.turbine ?? 'none in range',
      why_kept: s.reasons.join('; '),
    };
    features.push({
      type: 'Feature',
      properties: { ...props, part: 'diverted reach' },
      geometry: {
        type: 'LineString',
        coordinates: c.path.slice(s.i, s.j + 1).map((p) => [p.lon, p.lat, p.elevationM]),
      },
    });
    features.push({
      type: 'Feature',
      properties: { ...props, part: 'intake' },
      geometry: { type: 'Point', coordinates: [s.intake.lon, s.intake.lat] },
    });
    features.push({
      type: 'Feature',
      properties: { ...props, part: 'powerhouse' },
      geometry: { type: 'Point', coordinates: [s.power.lon, s.power.lat] },
    });
  });

  if (c.pondage) {
    for (const feature of pondageGeoJson(c.pondage).features) {
      features.push({
        ...feature,
        properties: {
          ...feature.properties,
          part:
            feature.properties.kind === 'pondage'
              ? 'possible level-pool pondage for selected intake'
              : 'screened dam axis for selected intake',
          terrain_source: c.pondage.source,
          terrain_resolution_m: c.pondage.resolutionM,
          interpretation:
            'terrain-only screening geometry; not surveyed inundation, a dam design, storage guarantee or clearance',
        },
      });
    }
  }

  if (c.roadAccess) {
    for (const feature of roadAccessGeoJson(c.roadAccess).features) {
      const properties = feature.properties ?? {};
      features.push({
        ...feature,
        properties: {
          ...properties,
          part:
            properties.kind === 'connector'
              ? `${String(properties.role)} straight-line gap to motor-road graph`
              : `${String(properties.role)} nearest motor-road graph point`,
          source: c.roadAccess.source,
          interpretation: c.roadAccess.limitation,
        },
      });
    }
  }

  for (const l of c.licences) {
    features.push({
      type: 'Feature',
      properties: {
        part: 'DoED project record',
        name: l.name,
        stage: l.stage,
        capacity_MW: l.capacityMW,
        promoter: l.promoter,
        river: l.river,
        distance_km: Number(l.distanceKm.toFixed(2)),
        coordinate_range_south: l.bounds[0],
        coordinate_range_west: l.bounds[1],
        coordinate_range_north: l.bounds[2],
        coordinate_range_east: l.bounds[3],
        source: l.source,
        source_updated: DOED_UPDATED,
        bundled: DOED_RETRIEVED,
      },
      geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
    });
  }

  for (const project of [
    ...(c.cascade?.upstream ?? []),
    ...(c.cascade?.downstream ?? []),
  ]) {
    const common = {
      project_key: `${project.name}|${project.capacityMW ?? 'na'}`,
      name: project.name,
      river: project.river,
      district: project.district,
      capacity_MW: project.capacityMW,
      promoter: project.promoter,
      stage: project.stage,
      licence_number: project.licenceNo,
      issued: project.issued,
      candidate_direction: project.direction,
      directed_route_km: Number(project.routeKm.toFixed(3)),
      midpoint_snap_to_HydroRIVERS_vertex_km: Number(project.snapKm.toFixed(3)),
      published_coordinate_range_diagonal_km: Number(project.publishedRangeDiagonalKm.toFixed(3)),
      coordinate_range_south: project.bounds[0],
      coordinate_range_west: project.bounds[1],
      coordinate_range_north: project.bounds[2],
      coordinate_range_east: project.bounds[3],
      route_geometry_included: project.routeGeometryIncluded,
      registry_source: c.cascade?.registry.source,
      registry_updated: c.cascade?.registry.updated,
      registry_retrieved: c.cascade?.registry.retrieved,
      network_source: c.cascade?.network.sourceUrl,
      interpretation:
        'directed river-network candidate only; not a confirmed cascade, component location, shared-water finding, legal overlap, operating interface, release effect, tailwater/backwater effect, sediment interaction or cumulative-impact conclusion',
    };
    features.push({
      type: 'Feature',
      properties: { ...common, part: 'DoED project coordinate-range midpoint interaction candidate' },
      geometry: { type: 'Point', coordinates: [project.lon, project.lat] },
    });
    if (project.routeGeometryIncluded && project.route.length > 1) {
      features.push({
        type: 'Feature',
        properties: { ...common, part: 'generalized directed HydroRIVERS route to or from project candidate' },
        geometry: { type: 'LineString', coordinates: project.route },
      });
    }
  }

  for (const record of c.hazards?.records ?? []) {
    features.push({
      type: 'Feature',
      properties: {
        part: 'BIPAD incident report',
        incident_id: record.id,
        hazard: record.title,
        hazard_code: record.kind,
        incident_date: record.date,
        approved: true,
        verified: true,
        distance_to_selected_reach_km: Number(record.distanceKm.toFixed(3)),
        source: record.url,
        inventory_retrieved: c.hazards?.retrieved,
        interpretation: 'historical report, not hazard probability',
      },
      geometry: { type: 'Point', coordinates: [record.lon, record.lat] },
    });
  }

  for (const lake of c.upstreamConnectivity?.lakes ?? []) {
    const common = {
      source_id: lake.id,
      basin: lake.basin,
      country: lake.country,
      lake_connectivity_class: lake.connectivity,
      elevation_m: Number(lake.elevationM.toFixed(1)),
      expansion_rate_km2_per_year: lake.expansionRateKm2Yr,
      expansion_uncertainty_km2_per_year: lake.expansionUncertaintyKm2Yr,
      expansion_significant: lake.expansionSignificant,
      time_series_outlier: lake.timeSeriesOutlier,
      snap_to_HydroRIVERS_vertex_km: Number(lake.snapKm.toFixed(3)),
      directed_route_to_intake_km: Number(lake.routeKm.toFixed(3)),
      route_geometry_included: lake.routeGeometryIncluded,
      source: c.upstreamConnectivity?.lakeInventory.source,
      source_published: c.upstreamConnectivity?.lakeInventory.published,
      inventory_retrieved: c.upstreamConnectivity?.lakeInventory.retrieved,
      data_licence: c.upstreamConnectivity?.lakeInventory.license,
      interpretation:
        'upstream channel-connectivity candidate; not dangerous-lake classification, dam stability, breach probability, GLOF hydrograph, runout or project exposure',
    };
    features.push({
      type: 'Feature',
      properties: { ...common, part: 'GLO glacial-lake centroid connectivity candidate' },
      geometry: { type: 'Point', coordinates: [lake.lon, lake.lat] },
    });
    if (lake.route.length > 1) {
      features.push({
        type: 'Feature',
        properties: { ...common, part: 'generalized directed HydroRIVERS route from lake candidate' },
        geometry: { type: 'LineString', coordinates: lake.route },
      });
    }
  }

  for (const incident of c.upstreamConnectivity?.incidents ?? []) {
    const common = {
      incident_id: incident.id,
      hazard: incident.title,
      hazard_code: incident.kind,
      incident_date: incident.date,
      approved: true,
      verified: true,
      snap_to_HydroRIVERS_vertex_km: Number(incident.snapKm.toFixed(3)),
      directed_route_to_intake_km: Number(incident.routeKm.toFixed(3)),
      route_geometry_included: incident.routeGeometryIncluded,
      source: incident.url,
      inventory_retrieved: c.upstreamConnectivity?.incidentInventory.retrieved,
      interpretation:
        'historical report channel-connectivity candidate; report may not be physical source and connection does not prove channel entry, runout, flood wave, recurrence or design action',
    };
    features.push({
      type: 'Feature',
      properties: { ...common, part: 'upstream-connected BIPAD report candidate' },
      geometry: { type: 'Point', coordinates: [incident.lon, incident.lat] },
    });
    if (incident.route.length > 1) {
      features.push({
        type: 'Feature',
        properties: { ...common, part: 'generalized directed HydroRIVERS route from BIPAD candidate' },
        geometry: { type: 'LineString', coordinates: incident.route },
      });
    }
  }

  for (const fault of c.faults?.nearby ?? []) {
    features.push({
      type: 'Feature',
      properties: {
        part: 'GEM regional active-fault trace',
        trace_id: fault.id,
        source_id: fault.sourceId,
        name: fault.name,
        slip_type: fault.type,
        reference: fault.reference,
        distance_to_selected_reach_km: Number(fault.distanceKm.toFixed(3)),
        intersects_selected_mapped_river_reach: fault.intersectsReach,
        nearest_reach_chainage_km: Number(fault.chainageKm.toFixed(3)),
        source: c.faults?.sourceUrl,
        source_commit: c.faults?.commit,
        inventory_retrieved: c.faults?.retrieved,
        data_licence: c.faults?.license,
        interpretation:
          'regional mapped trace, not surveyed location, waterway crossing, site clearance or seismic design action',
      },
      geometry: {
        type: 'LineString',
        coordinates: fault.points.map(([lon, lat]) => [lon, lat]),
      },
    });
  }

  for (const publication of c.geology?.dmg?.maps ?? []) {
    for (const sheet of publication.sheets) {
      const [west, south, east, north] = sheet.bounds;
      features.push({
        type: 'Feature',
        properties: {
          part: 'DMG published 1:50,000 geology sheet footprint',
          catalog_id: publication.id,
          title: publication.title,
          sheet_code: sheet.code,
          published: publication.published,
          official_preview: publication.previewUrl,
          source: c.geology?.dmg?.sourceUrl,
          source_updated: c.geology?.dmg?.updated,
          catalog_retrieved: c.geology?.dmg?.retrieved,
          rights: c.geology?.dmg?.rights,
          interpretation: 'derived publication-availability footprint, not site geology, ground truth or permission to redistribute map imagery',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        },
      });
    }
  }

  for (const sample of c.geology?.regional?.samples ?? []) {
    for (const unit of sample.units) {
      features.push({
        type: 'Feature',
        properties: {
          part: 'Macrostrat regional geology sample',
          sample_role: sample.role,
          map_id: unit.mapId,
          source_id: unit.sourceId,
          unit_name: unit.name,
          lithology: unit.lithology,
          top_interval: unit.topInterval,
          bottom_interval: unit.bottomInterval,
          top_age_Ma: unit.topAgeMa,
          bottom_age_Ma: unit.bottomAgeMa,
          original_reference: c.geology?.regional?.references[String(unit.sourceId)] ?? null,
          source: c.geology?.regional?.sourceUrl,
          data_licence: c.geology?.regional?.license,
          interpretation: 'small-scale regional point sample, not a surveyed contact, site lithology, foundation or tunnel condition',
        },
        geometry: { type: 'Point', coordinates: [sample.lon, sample.lat] },
      });
    }
  }

  // GeoJSON has no comment syntax, so provenance rides as a member of the
  // FeatureCollection. QGIS ignores it; a human reading the file does not.
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      hydrorecon: provenance(c),
      hydrorecon_readiness: c.readiness,
      hydrorecon_hydest: c.hydest,
      hydrorecon_flow_choice: c.flowChoice,
      hydrorecon_pondage: c.pondage
        ? {
            damHeightM: c.pondage.damHeightM,
            bedElevationM: c.pondage.bedElevationM,
            waterLevelM: c.pondage.waterLevelM,
            areaM2: c.pondage.areaM2,
            volumeM3: c.pondage.volumeM3,
            meanDepthM: c.pondage.meanDepthM,
            maxDepthM: c.pondage.maxDepthM,
            upstreamLengthM: c.pondage.upstreamLengthM,
            shorelineM: c.pondage.shorelineM,
            damLengthM: c.pondage.damLengthM,
            edgeLimited: c.pondage.edgeLimited,
            damAxisLimited: c.pondage.damAxisLimited,
            terrain: {
              source: c.pondage.source,
              resolutionM: c.pondage.resolutionM,
              radiusKm: c.pondage.radiusKm,
            },
            terrainComparison: c.pondage.terrainComparison ?? null,
            ruggedness: c.pondage.ruggedness ?? null,
            stageCurve: c.pondage.stageCurve ?? null,
            method: PONDAGE_METHOD,
            interpretation:
              'connected level-pool terrain screen; not surveyed storage, hydraulic modelling, dam design or inundation clearance',
          }
        : null,
      hydrorecon_road_access: c.roadAccess
        ? {
            ...c.roadAccess,
            method: ROAD_ACCESS_METHOD,
          }
        : null,
      hydrorecon_nea_ror_ppa: c.region === 'nepal' ? NEA_ROR_PPA : null,
      hydrorecon_power_duration: POWER_DURATION_GUIDANCE,
      hydrorecon_unit_count_sensitivity: UNIT_SENSITIVITY_GUIDANCE,
      hydrorecon_nepal_environmental_flow: c.region === 'nepal'
        ? {
            ...NEPAL_EFLOW_POLICY,
            selectedFractionOfLowestMonthlyMean: c.assumptions.residualFrac,
            selectedReleaseCms: c.selected?.residualCms ?? null,
          }
        : null,
      hydrorecon_hazards: c.hazards
        ? {
            radiusKm: c.hazards.radiusKm,
            total: c.hazards.total,
            categories: c.hazards.categories,
            source: c.hazards.source,
            fetchedFrom: c.hazards.fetchedFrom,
            retrieved: c.hazards.retrieved,
            period: c.hazards.period,
            crs: c.hazards.crs,
            limitation: c.hazards.limitation,
          }
        : null,
      hydrorecon_upstream_connectivity: c.upstreamConnectivity
        ? {
            target: c.upstreamConnectivity.target,
            lakeCandidates: c.upstreamConnectivity.lakes.length,
            incidentCandidates: c.upstreamConnectivity.incidents.length,
            lakeRoutesIncluded: c.upstreamConnectivity.lakes.filter((lake) => lake.routeGeometryIncluded).length,
            incidentRoutesIncluded: c.upstreamConnectivity.incidents.filter((incident) => incident.routeGeometryIncluded).length,
            lakeInventory: c.upstreamConnectivity.lakeInventory,
            incidentInventory: c.upstreamConnectivity.incidentInventory,
            network: c.upstreamConnectivity.network,
            method: c.upstreamConnectivity.method,
            limitation: c.upstreamConnectivity.limitation,
          }
        : null,
      hydrorecon_cascade: c.cascade
        ? {
            upstreamCandidates: c.cascade.upstream.length,
            downstreamCandidates: c.cascade.downstream.length,
            directReachRecords: c.cascade.directReachRecords,
            directAdvancedRecords: c.cascade.directAdvancedRecords,
            upstreamRoutesIncluded: c.cascade.upstream.filter((project) => project.routeGeometryIncluded).length,
            downstreamRoutesIncluded: c.cascade.downstream.filter((project) => project.routeGeometryIncluded).length,
            registry: c.cascade.registry,
            network: c.cascade.network,
            thresholds: c.cascade.thresholds,
            method: c.cascade.method,
            limitation: c.cascade.limitation,
            guidance: c.cascade.guidance,
          }
        : null,
      hydrorecon_faults: c.faults
        ? {
            radiusKm: c.faults.radiusKm,
            nearby: c.faults.nearby.length,
            crossings: c.faults.crossings,
            nearest: c.faults.nearest
              ? {
                  sourceId: c.faults.nearest.sourceId,
                  name: c.faults.nearest.name,
                  type: c.faults.nearest.type,
                  distanceKm: c.faults.nearest.distanceKm,
                  intersectsReach: c.faults.nearest.intersectsReach,
                  chainageKm: c.faults.nearest.chainageKm,
                }
              : null,
            source: c.faults.source,
            sourceUrl: c.faults.sourceUrl,
            commit: c.faults.commit,
            retrieved: c.faults.retrieved,
            crs: c.faults.crs,
            license: c.faults.license,
            licenseUrl: c.faults.licenseUrl,
            attribution: c.faults.attribution,
            citation: c.faults.citation,
            limitation: c.faults.limitation,
          }
        : null,
      hydrorecon_geology: c.geology
        ? {
            dmg: c.geology.dmg
              ? {
                  matches: c.geology.dmg.maps.length,
                  catalogMaps: c.geology.dmg.catalogMaps,
                  source: c.geology.dmg.source,
                  sourceUrl: c.geology.dmg.sourceUrl,
                  updated: c.geology.dmg.updated,
                  retrieved: c.geology.dmg.retrieved,
                  scale: c.geology.dmg.scale,
                  crs: c.geology.dmg.crs,
                  rights: c.geology.dmg.rights,
                  availability: c.geology.dmg.availability,
                  geometryMethod: c.geology.dmg.geometryMethod,
                  limitation: c.geology.dmg.limitation,
                }
              : null,
            regional: c.geology.regional
              ? {
                  samples: c.geology.regional.samples,
                  references: c.geology.regional.references,
                  source: c.geology.regional.source,
                  sourceUrl: c.geology.regional.sourceUrl,
                  license: c.geology.regional.license,
                  limitation: c.geology.regional.limitation,
                }
              : null,
            regionalError: c.geology.regionalError,
          }
        : null,
      features,
    },
    null,
    1
  );
}

/** Hand a string to the browser as a file. */
export function download(filename: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function fileStem(at: { lat: number; lon: number }): string {
  return `hydrorecon_${at.lat.toFixed(4)}_${at.lon.toFixed(4)}`;
}
