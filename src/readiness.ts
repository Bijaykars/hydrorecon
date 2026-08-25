/**
 * Evidence gates and the field campaign that follows a desktop screening.
 *
 * This intentionally has no overall percentage. A site with excellent head
 * and energy can still be stopped by a licence conflict, an impossible intake
 * bench, or a national park. Averaging those facts into "72% ready" would hide
 * the only facts that matter. Each discipline therefore keeps its own gate.
 */
import type { HeadAudit } from './audit.ts';
import type { Licence } from './context.ts';
import type { Scheme } from './engine/discover.ts';
import type { FlowChoice } from './engine/flowchoice.ts';
import type { HydestScreen } from './engine/hydest.ts';
import { NEPAL_EFLOW_POLICY, POWER_DURATION_GUIDANCE } from './engine/hydro.ts';
import type { BenchFit, SedimentSource } from './engine/sediment.ts';
import type { Gauge } from './gauges.ts';
import type { GridLink } from './grid.ts';
import type { HazardScreen } from './hazards.ts';
import type { FaultScreen } from './faults.ts';
import type { GeologyScreen } from './geology.ts';
import { BUILT_UP, TREE_COVER, type LandcoverScreen } from './landcover.ts';
import {
  LAKE_MAX_ROUTE_KM,
  LAKE_MAX_SNAP_KM,
  type UpstreamConnectivityScreen,
} from './connectivity.ts';
import { isAdvancedDoedStage, type CascadeScreen } from './cascade.ts';
import type { RegionMode } from './region.ts';

export type EvidenceLevel =
  | 'stop'
  | 'not-assessed'
  | 'weak'
  | 'screened'
  | 'corroborated'
  | 'measured';

export type GateId =
  | 'water'
  | 'head-layout'
  | 'sediment-headworks'
  | 'geology-hazards'
  | 'equipment-operations'
  | 'grid'
  | 'legal-environment'
  | 'economics';

/**
 * A distance a reader believes.
 *
 * These strings are quoted verbatim into the desk study, and `toFixed(1)` on a
 * short distance prints "0.0 km" — which reads as a broken field rather than as
 * a fact. One real site has a 132 kV line 2.8 m from the powerhouse, and the
 * grid gate reported "0.0 km straight-line to a mapped line". Below 100 m the
 * honest unit is metres.
 */
function km(value: number): string {
  if (!Number.isFinite(value)) return 'an unknown distance';
  return value < 0.1 ? `${Math.round(value * 1000)} m` : `${value.toFixed(1)} km`;
}

export type ReadinessGate = {
  id: GateId;
  title: string;
  level: EvidenceLevel;
  summary: string;
  evidence: string[];
  next: string;
};

export type FieldPriority = 'P1' | 'P2' | 'P3';

export type FieldTask = {
  priority: FieldPriority;
  discipline: string;
  title: string;
  reason: string;
  deliverable: string;
};

export type EngineeringReadiness = {
  region: RegionMode;
  decision: 'hold' | 'fieldwork' | 'screening';
  label: string;
  gates: ReadinessGate[];
  tasks: FieldTask[];
  stopReasons: string[];
};

export type ReadinessInput = {
  region: RegionMode;
  borderKm: number | null;
  scheme: Scheme | null;
  flowYears: number;
  measured: boolean;
  flowChoice: FlowChoice | null;
  hydest: HydestScreen | null;
  residualFraction: number;
  headAudit: HeadAudit | null;
  auditYears: number | null;
  licences: readonly Licence[] | null;
  gauges: readonly Gauge[] | null;
  grid: GridLink | null;
  hazards: HazardScreen | null;
  upstreamConnectivity: UpstreamConnectivityScreen | null;
  cascade: CascadeScreen | null;
  faults: FaultScreen | null;
  geology: GeologyScreen | null;
  conservation: {
    inside: readonly { name: string; nearEdge: boolean }[];
    near: readonly { name: string }[];
    hard: boolean;
  } | null;
  sediment: { source: SedimentSource | null } | null;
  bench: BenchFit | null;
  /** What the alignment crosses. Null is not screened, not "no forest". */
  landcover: LandcoverScreen | null;
};

const task = (
  priority: FieldPriority,
  discipline: string,
  title: string,
  reason: string,
  deliverable: string
): FieldTask => ({ priority, discipline, title, reason, deliverable });

const hardLicence = (l: Licence) =>
  l.stage === 'Operating' || l.stage === 'Construction licence';

/** Build gates and a site-specific investigation brief from the current evidence. */
export function assessReadiness(input: ReadinessInput): EngineeringReadiness {
  const {
    region,
    scheme,
    measured,
    flowChoice,
    hydest,
    residualFraction,
    headAudit,
    licences,
    gauges,
    grid,
    hazards,
    upstreamConnectivity,
    cascade,
    faults,
    geology,
    conservation,
    sediment,
    bench,
    landcover,
  } = input;
  if (!scheme) {
    return {
      region,
      decision: 'screening',
      label: 'Choose a viable layout before opening engineering gates',
      gates: [],
      tasks: [],
      stopReasons: [],
    };
  }

  const gates: ReadinessGate[] = [];
  const tasks: FieldTask[] = [];
  const upstreamAdvancedProjects = cascade?.upstream.filter((project) =>
    isAdvancedDoedStage(project.stage)
  ) ?? [];
  const downstreamAdvancedProjects = cascade?.downstream.filter((project) =>
    isAdvancedDoedStage(project.stage)
  ) ?? [];
  const cascadeAdvancedProjects = [...upstreamAdvancedProjects, ...downstreamAdvancedProjects];
  const years = input.auditYears ?? input.flowYears;
  const hydestAgreement = hydest?.agreement ?? null;
  const regionalQ100 = hydest?.floods.find((flood) => flood.t === 100)?.cms ?? null;
  const independentAgreement =
    Boolean(hydestAgreement?.agree) ||
    Boolean(flowChoice && Number.isFinite(flowChoice.disagreement) && flowChoice.disagreement <= 2);

  // Water and energy yield.
  const waterLevel: EvidenceLevel = measured
    ? 'measured'
    : upstreamAdvancedProjects.length > 0
      ? 'weak'
    : years < 10
      ? 'weak'
      : independentAgreement
        ? 'corroborated'
        : 'screened';
  const waterEvidence = measured
    ? [`Imported discharge record is driving the dispatch (${years || 'unknown'} years).`]
    : [
        `${years} complete model years drive the flow-duration curve and interannual energy.`,
        hydestAgreement
          ? `WECS/DHM regional dry-season check is ${hydestAgreement.agree ? 'consistent' : `${hydestAgreement.ratio.toFixed(1)}x apart`}; this is screening corroboration, not gauge validation.`
          : region === 'nepal'
            ? 'WECS/DHM regional regression could not independently check this catchment.'
            : 'No country-specific regression is applied outside Nepal.',
        ...(regionalQ100 !== null
          ? [`WECS/DHM regional Q100 estimate is ${regionalQ100.toFixed(0)} m³/s; it is not a selected design, diversion or spillway check flood.`]
          : []),
        ...(region === 'nepal'
          ? [
              `Policy-floor screening release is ${scheme.residualCms.toFixed(3)} m³/s (${(residualFraction * 100).toFixed(0)}% of the lowest modelled monthly mean at the intake); the approved EIA requirement may be higher.`,
            ]
          : []),
        ...(scheme.powerDuration
          ? [
              `Daily hydrological output screen: P90 ${scheme.powerDuration.p90MW.toFixed(2)} MW and P95 ${scheme.powerDuration.p95MW.toFixed(2)} MW across ${scheme.powerDuration.days} usable record days; ${POWER_DURATION_GUIDANCE.interpretation}`,
            ]
          : []),
      ];
  if (upstreamAdvancedProjects.length > 0) {
    waterEvidence.push(
      `${upstreamAdvancedProjects.length} upstream operating/construction DoED project candidate(s) may alter inflow timing, abstraction, spill or flushing; the registry contains no operating release series.`
    );
  }
  gates.push({
    id: 'water',
    title: 'Water & energy yield',
    level: waterLevel,
    summary:
      waterLevel === 'measured'
        ? upstreamAdvancedProjects.length
          ? 'A supplied record replaced modelled discharge, but upstream project operations and future commissioning still require an explicit release-series case.'
          : 'A supplied record replaced modelled discharge; rating-curve and transfer error remain.'
        : upstreamAdvancedProjects.length
          ? 'Upstream operating/construction project candidates make an unregulated desktop flow series inadequate for scheme energy and flood decisions.'
        : independentAgreement
          ? 'Open models are independently consistent enough for screening, not design.'
          : 'The energy case still rests on uncalibrated open models.',
    evidence: waterEvidence,
    next: upstreamAdvancedProjects.length
      ? 'Obtain upstream abstraction, generation, spill and flushing rules/records; build coordinated and independent-operation flow scenarios alongside the gauge, environmental flow, flood and drought cases.'
      : 'Build a site or transferred-gauge flow series, environmental flow, design flood and drought case.',
  });
  if (!measured) {
    const best = gauges?.find((g) => g.trustworthy && g.measuresDischarge);
    tasks.push(
      task(
        'P1',
        'Hydrology',
        best ? `Obtain and transfer DHM record: ${best.name}` : 'Establish the discharge record',
        upstreamAdvancedProjects.length
          ? `${upstreamAdvancedProjects.map((project) => project.name).slice(0, 3).join(', ')} ${upstreamAdvancedProjects.length > 3 ? 'and others ' : ''}are upstream network candidates; naturalized desktop models cannot represent their operating releases.`
          : best
          ? `${best.name} is the strongest mapped discharge station for this reach; desktop models do not calibrate the river.`
          : 'No trustworthy open gauge series is available in the app for this reach.',
        upstreamAdvancedProjects.length
          ? 'Quality-controlled daily flows plus upstream plant abstraction/generation/spill/flushing time series; naturalized and coordinated/independent-operation FDC, energy, flood, drought and climate-sensitivity cases.'
            + ' Include daily power-duration and the project definition of dependable/firm capacity.'
          : 'Quality-controlled daily flows; rating curve; catchment-transfer method; FDC; monthly, flood, drought and climate-sensitivity series; daily power-duration screen and project definition of dependable/firm capacity.'
      )
    );
  }
  if (region === 'nepal') {
    tasks.push(
      task(
        hydestAgreement?.agree && measured ? 'P2' : 'P1',
        'Hydrology & flood risk',
        'Establish the flood-frequency and extreme-event basis',
        regionalQ100 !== null
          ? `The app can only supply a WECS/DHM regional Q100 comparator (${regionalQ100.toFixed(0)} m³/s); regional regression alone cannot select a project design flood.`
          : 'No regional flood comparator is available here, and a project flood basis cannot be inferred from the energy-flow series.',
        'Quality-controlled instantaneous-peak gauge frequency analysis (20+ years where available, 30+ preferred); applicable regional/empirical method comparison; historical flood marks, interviews and slope-area reconstruction; at least one direct flood-discharge measurement where records are absent; GLOF/CLOF assessment; documented diversion, design/check-flood and PMF/PMP decisions.'
      )
    );
  }

  /**
   * Topography and layout.
   *
   * ABSOLUTE AND RELATIVE, both. A flat 10 m tolerance is right on a 400 m
   * drop and meaningless on the 15 m minimum the engine will accept: two
   * sources reporting 15 m and 6 m differ by 9 m, passed as "corroborated",
   * and the summary said they agree — about a head one of them puts at 60%
   * of the other's. A difference that large relative to the head being
   * measured is not corroboration whatever its absolute size.
   */
  const headAgrees =
    !!headAudit &&
    headAudit.deltaM <= 10 &&
    (!(scheme.grossHeadM > 0) || headAudit.deltaM / scheme.grossHeadM <= 0.15);
  const headLevel: EvidenceLevel = headAudit ? (headAgrees ? 'corroborated' : 'weak') : 'screened';
  gates.push({
    id: 'head-layout',
    title: 'Head & layout',
    level: headLevel,
    summary: headAudit
      ? headAgrees
        ? 'Two terrain products agree on the gross head, but neither is a ground survey.'
        : 'The two terrain products disagree materially at this layout.'
      : 'One global DEM and an unrouted waterway define the layout.',
    evidence: [
      `${scheme.grossHeadM.toFixed(0)} m gross head over ${scheme.waterwayKm.toFixed(2)} km.`,
      headAudit
        ? `Independent terrain heads differ by ${headAudit.deltaM.toFixed(1)} m` +
          (scheme.grossHeadM > 0
            ? ` — ${((headAudit.deltaM / scheme.grossHeadM) * 100).toFixed(0)}% of the gross head.`
            : '.')
        : 'No second-terrain site audit has been run.',
      'The displayed waterway follows the river reach; tunnel, canal and penstock alignments are not routed.',
    ],
    next: 'Survey intake, waterways, surge arrangement, powerhouse and river cross-sections on a project datum.',
  });
  tasks.push(
    task(
      'P1',
      'Survey & layout',
      'Survey the control levels and route alternatives',
      headAudit && headAudit.deltaM > 10
        ? `Terrain products differ by ${headAudit.deltaM.toFixed(1)} m, large enough to change capacity and waterways.`
        : 'A DEM cannot settle intake sill, headpond, surge, penstock, tailwater or construction access levels.',
      'Benchmarks and DTM; river cross-sections; intake/powerhouse levels; canal/tunnel/penstock alternatives; access and spoil areas.'
    )
  );

  // Sediment and headworks.
  const sedimentLevel: EvidenceLevel =
    bench?.verdict === 'no-room'
      ? 'stop'
      : bench?.verdict === 'fits' && sediment?.source
        ? 'screened'
        : 'weak';
  gates.push({
    id: 'sediment-headworks',
    title: 'Sediment & headworks',
    level: sedimentLevel,
    summary:
      bench?.verdict === 'no-room'
        ? 'The selected intake has no DEM-visible bench for its screening desander; move or redesign it.'
        : bench?.verdict === 'fits'
          ? 'A screening desander footprint fits, but sediment load and flood behaviour are unmeasured.'
          : 'Desander fit, sediment regime or both remain uncertain.',
    evidence: [
      sediment?.source?.label ?? 'No catchment sediment-source proxy is available.',
      ...(regionalQ100 !== null
        ? [`WECS/DHM regional Q100 comparator: ${regionalQ100.toFixed(0)} m³/s; not a headworks design flood.`]
        : []),
      bench
        ? `${bench.widestM.toFixed(0)} m workable bench found; terrain resolution about ${bench.resolutionM.toFixed(0)} m.`
        : 'No usable intake cross-section result is available.',
    ],
    next: 'Measure suspended load and bed material, establish the project flood basis, then design intake, flushing and exclusion works.',
  });
  tasks.push(
    task(
      bench?.verdict === 'no-room' ? 'P1' : 'P2',
      'Hydraulics & sediment',
      bench?.verdict === 'no-room' ? 'Relocate the intake and desander' : 'Run the sediment and headworks campaign',
      bench?.verdict === 'no-room'
        ? 'The current layout fails the minimum terrain bench screen.'
        : 'Himalayan turbine wear and intake reliability cannot be designed from catchment altitude.',
      'Monsoon suspended-sediment and grading series; bed-load observations; adopted flood-frequency/extreme-event basis, flood levels and debris; intake, gravel trap, desander and flushing concept.'
    )
  );

  // Published map availability, small-scale regional geology, historical
  // incidents and regional fault traces can focus fieldwork, but none can
  // upgrade engineering geology or become a probability/design model.
  const hazardCategories = hazards?.categories.filter((category) => category.count > 0) ?? [];
  const nearestHazard = hazards?.records[0] ?? null;
  const nearestFault = faults?.nearest ?? null;
  const crossedFaults = faults?.nearby.filter((fault) => fault.intersectsReach) ?? [];
  const dmgMaps = geology?.dmg?.maps ?? [];
  const regionalSamples = geology?.regional?.samples ?? [];
  const regionalUnits = regionalSamples.flatMap((sample) => sample.units);
  const hasGeologySource = Boolean(geology?.dmg || geology?.regional);
  const geologyLevel: EvidenceLevel = hasGeologySource || (region === 'nepal' && Boolean(hazards || faults || upstreamConnectivity))
    ? 'weak'
    : 'not-assessed';
  const geologySummary = crossedFaults.length
    ? `${crossedFaults.length} GEM regional active-fault trace(s) intersect the selected mapped river reach; this is an investigation trigger, not a surveyed crossing or seismic design action.`
    : region === 'nepal' && hazards && hazards.total > 0
      ? `BIPAD maps ${hazards.total} approved, verified incident record(s) within ${hazards.radiusKm} km; this is historical evidence, not a hazard probability.`
      : region === 'nepal' && upstreamConnectivity && upstreamConnectivity.lakes.length > 0
        ? `${upstreamConnectivity.lakes.length} open glacial-lake centroid(s) have a candidate directed HydroRIVERS path to the intake; this is neither a dangerous-lake classification nor a GLOF model.`
        : region === 'nepal' && upstreamConnectivity && upstreamConnectivity.incidents.length > 0
          ? `${upstreamConnectivity.incidents.length} BIPAD report point(s) have a candidate directed HydroRIVERS path to the intake; this does not prove a source, runout or flood wave.`
      : dmgMaps.length
        ? `${dmgMaps.length} official DMG 1:50,000 map publication(s) cover the reach; obtain the usable maps, because catalog coverage is not a ground model.`
        : regionalUnits.length
          ? 'Open small-scale regional units were sampled at the layout, but they cannot establish a contact, foundation or tunnel condition.'
          : nearestFault
            ? `The nearest GEM regional active-fault trace is ${km(nearestFault.distanceKm)} from the reach; distance and non-intersection do not clear the site.`
            : region === 'nepal' && hazards
              ? `No approved, verified BIPAD incident record is mapped within ${hazards.radiusKm} km; absence of reports does not clear the site.`
              : 'No engineering geology, subsurface, seismic, landslide or GLOF investigation is in the desktop result.';
  gates.push({
    id: 'geology-hazards',
    title: 'Geology & natural hazards',
    level: geologyLevel,
    summary: geologySummary,
    evidence: [
      'Open terrain can show slope shape, not rock mass, faults, permeability or foundation conditions.',
      ...(geology?.dmg
        ? dmgMaps.length
          ? [
              `Official DMG ${geology.dmg.scale} publications touching the reach: ${dmgMaps.map((map) => `${map.title} [${map.sheets.map((sheet) => sheet.code).join(', ')}]`).join('; ')}.`,
              geology.dmg.availability,
            ]
          : [geology.dmg.limitation]
        : []),
      ...(geology?.regional
        ? [
            regionalUnits.length
              ? `Macrostrat small-scale samples: ${regionalSamples.map((sample) => `${sample.role}—${sample.units[0]?.name ?? 'no mapped unit returned'}`).join('; ')}.`
              : 'Macrostrat returned no mapped regional unit at the three layout samples; this is not clearance.',
            geology.regional.limitation,
          ]
        : geology?.regionalError
          ? [`Open regional geology was unavailable: ${geology.regionalError}`]
          : []),
      ...(region === 'nepal' && hazards
        ? [
            hazardCategories.length
              ? `Nearby report breakdown: ${hazardCategories.map((category) => `${category.title} ${category.count}`).join(', ')}.`
              : 'No nearby reports were found in the screened categories; reporting and geocoding coverage vary by place, year and hazard.',
            nearestHazard
              ? `Nearest mapped report: ${nearestHazard.title}, ${nearestHazard.date}, ${km(nearestHazard.distanceKm)} from the selected reach.`
              : `BIPAD inventory screened from ${hazards.period.from} to ${hazards.period.to}; bundled ${hazards.retrieved}.`,
            'Point proximity does not test an upstream GLOF/flood path, slope connectivity, recurrence, magnitude or seismic design action.',
          ]
        : [
            region === 'nepal'
              ? 'Himalayan seismicity, landslides, debris flow, cascade interaction and possible GLOF exposure require explicit checks.'
              : 'Country-specific seismic and catchment-hazard layers are not applied in global mode.',
          ]),
      ...(region === 'nepal' && upstreamConnectivity
        ? [
            `${upstreamConnectivity.lakes.length} of ${upstreamConnectivity.lakeInventory.total.toLocaleString('en-US')} GLO Sentinel-2 lake centroids have a candidate directed channel path to this intake (maximum ${LAKE_MAX_ROUTE_KM} km; centroid snap at most ${LAKE_MAX_SNAP_KM} km).`,
            upstreamConnectivity.lakes.some((lake) =>
              lake.expansionSignificant === true &&
              (lake.expansionRateKm2Yr ?? 0) > 0 &&
              lake.timeSeriesOutlier !== true
            )
              ? `${upstreamConnectivity.lakes.filter((lake) => lake.expansionSignificant === true && (lake.expansionRateKm2Yr ?? 0) > 0 && lake.timeSeriesOutlier !== true).length} connected lake(s) carry a published significant positive 2017-2024 expansion signal; expansion is not breach likelihood.`
              : 'No connected lake carries an unflagged, significant positive expansion signal in this screen; that is not GLOF clearance.',
            `${upstreamConnectivity.incidents.length} approved, verified BIPAD report point(s) have a candidate directed channel path within 150 km.`,
            upstreamConnectivity.method,
            upstreamConnectivity.limitation,
          ]
        : region === 'nepal'
          ? ['Upstream lake/report channel topology has not produced a usable result; explicit GLOF, landslide-dam and debris-flow checks remain open.']
          : []),
      ...(region === 'nepal' && faults
        ? [
            crossedFaults.length
              ? `GEM trace intersection(s): ${crossedFaults.map((fault) => `${fault.name ?? fault.sourceId} near reach chainage ${km(fault.chainageKm)}`).join('; ')}.`
              : nearestFault
                ? `Nearest GEM regional active-fault trace: ${nearestFault.name ?? nearestFault.sourceId} (${nearestFault.type}), ${km(nearestFault.distanceKm)} from the selected reach.`
                : 'No regional GEM trace result is available for this reach.',
            'Regional HimaTibetMap-derived traces are not surveyed locations; distance or non-intersection is not clearance, and the river reach is not a routed project waterway.',
          ]
        : []),
    ],
    next: 'Obtain the best published geology, then map hazards and engineering geology before fixing any underground or foundation layout.',
  });
  const geologyAcquisition = dmgMaps.length
    ? `Obtain the named DMG 1:50,000 publication${dmgMaps.length === 1 ? '' : 's'} (${dmgMaps.map((map) => map.sheets.map((sheet) => sheet.code).join('/')).join(', ')}) before field mapping.`
    : region === 'nepal'
      ? 'No 1:50,000 publication matched the current official online DMG catalog; confirm available maps directly with DMG.'
      : 'Only generalized open regional geology is available in global mode; obtain the competent national geological survey mapping.';
  const geologyHazardReasons = [
    crossedFaults.length
      ? `${crossedFaults.length} regional mapped trace(s) intersect the river reach; locate structures in the field before routing underground or foundation works.`
      : null,
    region === 'nepal' && hazards && hazards.total > 0
      ? `${hazards.total} nearby BIPAD report(s) identify evidence to inspect, but not the source area, runout, recurrence or design action.`
      : null,
    region === 'nepal' && upstreamConnectivity && upstreamConnectivity.lakes.length > 0
      ? `${upstreamConnectivity.lakes.length} mapped glacial-lake centroid(s) require outlet/catchment verification and a defensible outburst-routing decision.`
      : null,
    region === 'nepal' && upstreamConnectivity && upstreamConnectivity.incidents.length > 0
      ? `${upstreamConnectivity.incidents.length} upstream-connected report candidate(s) require source-location and channel-entry verification.`
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  const geologyHazardReason = geologyHazardReasons.length
    ? geologyHazardReasons.join(' ')
    : 'Open-data absence cannot exclude unmapped faults, slope, seismic, debris-flow or upstream GLOF hazards.';
  tasks.push(
    task(
      'P1',
      'Engineering geology & hazards',
      dmgMaps.length ? 'Obtain the mapped geology and walk the full layout' : 'Walk the full layout and hazard catchment',
      `${geologyAcquisition} ${geologyHazardReason}`,
      'Referenced desk-study map register; engineering-geology and structural map with surveyed fault/lineament crossings; discontinuity and rock-mass logs; verified landslide scars, channel entry and temporary-dam evidence; lake outlets and dangerous-lake ranking; scenario GLOF/debris hydrographs and routing; seismic basis; investigation and laboratory-testing plan.'
    )
  );

  // Machines, hydraulic transients and maintainability.
  gates.push({
    id: 'equipment-operations',
    title: 'Equipment, transients & operations',
    level: scheme.turbine && cascadeAdvancedProjects.length === 0 ? 'screened' : 'weak',
    summary: cascadeAdvancedProjects.length
      ? `${cascadeAdvancedProjects.length} upstream/downstream operating or construction project candidate(s) require cascade operating, transient and communication interfaces.`
      : scheme.turbine
        ? `${scheme.turbine} fits the screening head-flow envelope and its part-load curve is dispatched; equipment design is open.`
      : 'No standard turbine envelope fits this duty point; the energy estimate uses a placeholder efficiency.',
    evidence: [
      scheme.turbine
        ? `Screening selection ${scheme.turbine}; best-point turbine efficiency ${(scheme.turbinePeak * 100).toFixed(1)}%.`
        : 'No screening machine selection is available.',
      ...(scheme.powerDuration
        ? [`The P90/P95 daily output screen assumes one unit and excludes forced outages, station service, curtailment, multi-unit commitment and contractual availability.`]
        : []),
      ...(scheme.unitSensitivity && scheme.unitSensitivity.length > 1
        ? [
            `Equal-rated 1–${scheme.unitSensitivity.at(-1)!.units}-unit sensitivity spans daily P90 ${Math.min(...scheme.unitSensitivity.map((item) => item.dailyP90MW)).toFixed(2)}–${Math.max(...scheme.unitSensitivity.map((item) => item.dailyP90MW)).toFixed(2)} MW and annual energy ${Math.min(...scheme.unitSensitivity.map((item) => item.energyGwh)).toFixed(1)}–${Math.max(...scheme.unitSensitivity.map((item) => item.energyGwh)).toFixed(1)} GWh; it includes no equipment cost or outage credit and is not a recommendation.`,
          ]
        : []),
      'Unit number, runner setting, cavitation, surge/water hammer, speed rise, generator, transformer, controls, auxiliaries and maintainability are not designed.',
      ...(cascade
        ? [
            `${cascade.upstream.length} upstream and ${cascade.downstream.length} downstream DoED midpoint(s) passed the directed-network candidate screen; ${cascadeAdvancedProjects.length} are operating or construction-stage records.`,
            'The registry contains no tailrace hydrograph, plant operating rule, outage schedule, warning protocol, sediment-flushing rule or hydraulic boundary condition.',
            cascade.limitation,
          ]
        : region === 'nepal'
          ? ['No usable directed DoED cascade result is available; project-operation interfaces remain unassessed.']
          : []),
    ],
    next: cascadeAdvancedProjects.length
      ? 'Confirm actual project components and obtain operating rules, then develop coordinated/independent cascade operation, emergency communication and transient boundary cases with the electro-mechanical design.'
      : 'Develop the electro-mechanical arrangement together with transient, grid-code and O&M studies.',
  });
  tasks.push(
    task(
      scheme.turbine && cascadeAdvancedProjects.length === 0 ? 'P2' : 'P1',
      'Electro-mechanical & operations',
      'Develop the unit, transient and maintainability concept',
      cascadeAdvancedProjects.length
        ? `${cascadeAdvancedProjects.map((project) => `${project.name} (${project.direction})`).slice(0, 4).join(', ')} require verified hydraulic and operating interfaces; midpoint topology is only a discovery lead.`
        : scheme.turbine
        ? 'A turbine family and part-load curve are screening inputs, not a supplier selection or hydraulic guarantee.'
        : 'The duty point falls outside the standard turbine envelopes and needs specialist review.',
      cascadeAdvancedProjects.length
        ? 'Verified cascade schematic and component chainages; upstream/downstream release, spill, flushing, outage and emergency-warning protocols; synchronized and independent-operation hydrographs; transient boundary cases; then unit/transient/control/O&M concept.'
        : 'Unit number and rating; turbine setting/NPSH and cavitation check; waterways transient/surge study; generator-transformer and controls concept; grid-code duties; lifting, access, spares and O&M plan.'
    )
  );

  // Grid: Nepal has a bundled open map; global mode does not pretend it is worldwide.
  if (region === 'nepal') {
    const adequate = grid?.adequateKm ?? null;
    const gridLevel: EvidenceLevel = adequate === null ? 'weak' : adequate <= 10 ? 'screened' : 'weak';
    gates.push({
      id: 'grid',
      title: 'Grid evacuation',
      level: gridLevel,
      summary:
        adequate === null
          ? `No mapped line at the screening ${grid?.requiredKv ?? 'required'} kV class was found.`
          : `${km(adequate)} straight-line to a mapped line at the required voltage class.`,
      evidence: [
        grid
          ? `Screening requirement ${grid.requiredKv} kV; nearest line of any voltage ${km(grid.nearestKm)}.`
          : 'Nepal grid mapping was unavailable.',
        'OpenStreetMap coverage and straight-line distance do not establish capacity, right-of-way or connection cost.',
      ],
      next: 'Obtain the NEA system/connection study and survey a constructible evacuation route.',
    });
    tasks.push(
      task(
        adequate !== null && adequate <= 10 ? 'P2' : 'P1',
        'Power system',
        'Confirm the grid connection and evacuation route',
        adequate === null
          ? 'No adequate-voltage line is mapped within the screening search.'
          : `The ${km(adequate)} figure is a straight-line floor and says nothing about available capacity.`,
        'NEA connection point and available capacity; load-flow, short-circuit and stability scope; surveyed line route, voltage, losses, land and cost.'
      )
    );
  } else {
    gates.push({
      id: 'grid',
      title: 'Grid evacuation',
      level: 'not-assessed',
      summary: 'The Nepal grid bundle is disabled outside Nepal; no global connection claim is made.',
      evidence: ['No trustworthy, consistently attributed worldwide voltage-and-capacity dataset is bundled.'],
      next: 'Use the national utility or system operator network model and connection process.',
    });
    tasks.push(
      task(
        'P1',
        'Power system',
        'Establish the national grid connection case',
        'Global mode has no country-specific grid capacity or connection rules.',
        'Utility-confirmed point of connection, voltage, available capacity, study requirements, route and budget cost.'
      )
    );
  }

  // Legal, environmental and social screening.
  if (region === 'nepal') {
    const hard = licences?.filter(hardLicence) ?? [];
    const pending = licences?.filter((l) => !hardLicence(l)) ?? [];
    const edge = conservation?.inside.some((h) => h.nearEdge) || Boolean(conservation?.near.length);
    const nearCountryBorder = input.borderKm !== null && input.borderKm <= 10;
    const legalLevel: EvidenceLevel =
      conservation?.hard || hard.length > 0
        ? 'stop'
        : licences === null
          ? 'not-assessed'
          : pending.length > 0 || edge || nearCountryBorder || Boolean(cascade && (cascade.upstream.length || cascade.downstream.length))
            ? 'weak'
            : 'screened';
    gates.push({
      id: 'legal-environment',
      title: 'Legal, environmental & social',
      level: legalLevel,
      summary: conservation?.hard
        ? 'The selected works intersect a hard protected-area screen.'
        : hard.length
          ? `${hard.length} operating/construction DoED record(s) overlap the 6 km reach screen.`
          : pending.length
            ? `${pending.length} DoED application/survey record(s) require a live status and geometry check.`
            : cascade && (cascade.upstream.length || cascade.downstream.length)
              ? `${cascade.upstream.length} upstream and ${cascade.downstream.length} downstream DoED project candidate(s) require current files and cumulative/cascade scoping.`
            : licences === null
              ? 'Nepal registry context is not yet available.'
              : 'No bundled DoED or protected-area conflict was found; this is not a permit clearance.',
      evidence: [
        `${licences?.length ?? 0} DoED record(s) in the conservative reach screen.`,
        conservation
          ? `${conservation.inside.length} protected-area intersection(s), ${conservation.near.length} near-boundary result(s).`
          : 'No protected-area intersection at the selected intake or powerhouse.',
        ...(landcover
          ? (() => {
              // Forests moved from "not screened" to "screened, not cleared" when
              // the land-cover store landed, and the evidence has to say which.
              const of = (code: number) => landcover.along.find((a) => a.code === code);
              const tree = of(TREE_COVER);
              const built = of(BUILT_UP);
              return [
                tree
                  ? `${km(tree.km)} of the ${km(landcover.waterwayKm)} alignment centreline runs on mapped tree cover (${(tree.share * 100).toFixed(0)}%); forest clearance and compensatory plantation are in play. Cover is not tenure, so national, community and private forest are not separated here.`
                  : `No mapped tree cover on the alignment centreline over ${km(landcover.waterwayKm)}.`,
                ...(built ? [`${km(built.km)} crosses mapped built-up ground; treat as a resettlement question, not an easement.`] : []),
              ];
            })()
          : ['Land cover along the alignment has not been screened.']),
        'Land tenure, environmental flow, aquatic ecology, cultural heritage, communities and cumulative impacts are not cleared by this screen.',
        `Nepal policy requires the higher of at least ${(NEPAL_EFLOW_POLICY.minimumFractionOfLowestMonthlyMean * 100).toFixed(0)}% of minimum monthly average discharge or the EIA-required minimum; the desktop release is not an approved EFlow.`,
        ...(cascade
          ? [
              `Directed midpoint screen: ${cascade.upstream.length} upstream, ${cascade.downstream.length} downstream; registry updated ${cascade.registry.updated}, bundled ${cascade.registry.retrieved}.`,
              cascade.limitation,
            ]
          : ['Upstream/downstream licensed-project topology and cascade interfaces are not established.']),
        ...(nearCountryBorder
          ? [`The site is ${km(input.borderKm!)} from the generalized country outline; verify jurisdiction from authoritative survey/control points.`]
          : []),
      ],
      next: 'Confirm legal status, actual components and exact footprints; then run alternatives, E&S baseline, e-flow, cascade-interface and cumulative-impact scoping.',
    });
    tasks.push(
      task(
        legalLevel === 'stop' || cascadeAdvancedProjects.length > 0 ? 'P1' : 'P2',
        'Permitting, environment & social',
        legalLevel === 'stop' ? 'Resolve the legal/environmental stop before more design' : 'Ground-truth permits, land and E&S receptors',
        legalLevel === 'stop'
          ? 'The current open-data screen contains a potential fatal conflict.'
          : cascadeAdvancedProjects.length
            ? `${cascadeAdvancedProjects.length} upstream/downstream operating or construction candidate(s) make project interfaces and cumulative effects priority evidence.`
          : 'A clear desktop screen is only absence of a mapped conflict, not approval.',
        'DoED/DNPWC/forest and local-government confirmations; current licence maps and component chainages; cadastral footprint; stakeholder map; aquatic/terrestrial baseline; approved EIA EFlow with seasonal ecological/hydraulic basis, downstream uses, drought/ramping rules, release works and monitoring/compliance plan; cascade-interface and cumulative-impact terms of reference.'
      )
    );
  } else {
    gates.push({
      id: 'legal-environment',
      title: 'Legal, environmental & social',
      level: 'not-assessed',
      summary: 'Nepal registers and protected-area rules are disabled; jurisdiction-specific screening is required.',
      evidence: [
        'Global mode supplies physical screening only where open inputs are available.',
        ...(input.borderKm !== null && input.borderKm <= 10
          ? [`The site is ${km(input.borderKm)} from the generalized Nepal outline; authoritative jurisdiction must be checked.`]
          : []),
      ],
      next: 'Run the host-country land, water right, protected-area, indigenous/community and environmental process.',
    });
    tasks.push(
      task(
        'P1',
        'Permitting, environment & social',
        'Build the host-country approvals and safeguards register',
        'No jurisdiction-specific permits or legal constraints are asserted in global mode.',
        'Permit and water-right register; land/tenure and protected-area overlay; stakeholder and safeguards plan; e-flow and cumulative-impact scope.'
      )
    );
  }

  // Economics and delivery remain open until quantities and field layouts exist.
  const ppaReference = region === 'nepal' ? scheme.reliability?.ppaEightFour ?? null : null;
  gates.push({
    id: 'economics',
    title: 'Cost, schedule & bankability',
    level: 'not-assessed',
    summary: 'No quantities, construction method, price date, financing, tariff case or schedule are claimed.',
    evidence: [
      'Capacity and energy alone cannot rank bankability.',
      ...(ppaReference
        ? [
            `Published NEA base-rate energy comparator: NPR ${ppaReference.grossReferenceValueMillionNpr.toFixed(0)} million/year under the 8+4 season split at a blended ${ppaReference.blendedBaseRateNprPerKwh.toFixed(2)} NPR/kWh; gross reference only, not a PPA entitlement or contracted revenue.`,
            ...(scheme.capacityMW > 100
              ? [`At ${scheme.capacityMW.toFixed(1)} MW the scheme exceeds the posted-rate 100 MW boundary; negotiated/base-rate review is required.`]
              : []),
          ]
        : []),
      'Access, underground works, geology, grid, sediment, land and environmental obligations usually dominate scheme cost and risk.',
    ],
    next: 'Build alternatives on surveyed quantities, local unit rates, risk allowances and an explicit price/currency basis.',
  });
  tasks.push(
    task(
      'P1',
      'Cost & delivery',
      'Prepare comparable alternatives and a pre-feasibility cost model',
      'Economics is deliberately unassessed; an energy-only optimum can be the most expensive project.',
      'Basis of estimate and price date; quantities and local rates; access/construction method; grid and E&S cost; schedule; contingencies; signed/expected PPA option, capacity eligibility, COD/escalation year, contracted energy/losses/curtailment/penalties; LCOE/NPV sensitivities and risk register.'
    )
  );

  const order: Record<FieldPriority, number> = { P1: 0, P2: 1, P3: 2 };
  tasks.sort((a, b) => order[a.priority] - order[b.priority] || a.discipline.localeCompare(b.discipline));
  const stopReasons = gates.filter((g) => g.level === 'stop').map((g) => `${g.title}: ${g.summary}`);
  const notAssessed = gates.filter((g) => g.level === 'not-assessed').length;
  return {
    region,
    decision: stopReasons.length ? 'hold' : notAssessed ? 'fieldwork' : 'screening',
    label: stopReasons.length
      ? 'Hold this layout and resolve stop conditions first'
      : 'Promising enough to investigate, not ready to design or finance',
    gates,
    tasks,
    stopReasons,
  };
}
