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
import type { Licence } from './context.ts';
import { transferAdvice, type Gauge } from './gauges.ts';

export type ExportContext = {
  at: { lat: number; lon: number };
  schemes: Scheme[];
  selected: Scheme | null;
  path: { km: number; lat: number; lon: number; elevationM: number; meanCms: number }[];
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
  assumptions: {
    exceedance: number;
    efficiency: number;
    headLossFrac: number;
    residualFrac: number;
  };
};

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** Every line a reader needs to judge how much to trust the rows below. */
function provenance(c: ExportContext): string[] {
  const lines = [
    'Ghatta — run-of-river screening',
    'https://github.com/Bijaykars  ·  MIT licence',
    `generated: ${stamp()}`,
    `study point: ${c.at.lat.toFixed(5)}, ${c.at.lon.toFixed(5)}`,
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
    `flow: GloFAS v4 reanalysis via Open-Meteo, ${c.flowYears.toFixed(0)} years, modelled not gauged`,
    `flow mean at the model cell: ${c.flowMeanCms.toFixed(2)} m3/s`,
  ];
  if (c.networkMeanCms !== null) {
    const ratio = Math.max(c.networkMeanCms / c.flowMeanCms, c.flowMeanCms / c.networkMeanCms);
    lines.push(
      `mapped network long-term mean here: ${c.networkMeanCms.toFixed(2)} m3/s`,
      `  the two disagree by ${ratio.toFixed(1)}x; magnitude below is taken from the network,`,
      '  day-to-day shape from the flood model'
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
  if (c.gauges.length > 0) {
    lines.push(
      '',
      'TO NARROW THE FLOW UNCERTAINTY, request these gauged records from Nepal DHM:',
      ...c.gauges
        .slice(0, 3)
        .map(
          (g) =>
            `  ${g.name} — ${g.relation}, ${g.distanceKm.toFixed(1)} km away` +
            `${g.uplandKm2 ? `, ${g.uplandKm2.toFixed(0)} km2 catchment` : ''}\n` +
            `    ${transferAdvice(g)}`
        ),
      '  station values are not public (the DHM API requires a key); locations are.'
    );
  }
  if (c.licences.length > 0) {
    lines.push(
      '',
      `WARNING: ${c.licences.length} licensed project(s) already within 6 km of this reach:`,
      ...c.licences
        .slice(0, 8)
        .map(
          (l) =>
            `  ${l.name} — ${l.stage}${l.capacityMW ? `, ${l.capacityMW} MW` : ''}, ${l.distanceKm.toFixed(1)} km away`
        ),
      '  source: Nepal DoED registry via Open Data Nepal; the public snapshot lags the live register'
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
    'gross_head_m',
    'net_head_m',
    'design_flow_m3s',
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
    'intake_lat',
    'intake_lon',
    'powerhouse_lat',
    'powerhouse_lon',
    'why_kept',
  ];
  const rows = c.schemes.map((s) =>
    [
      `S${c.schemes.indexOf(s) + 1}`,
      c.selected && s.i === c.selected.i && s.j === c.selected.j ? 'yes' : '',
      s.capacityMW.toFixed(3),
      s.energyGwh.toFixed(2),
      s.grossHeadM.toFixed(1),
      s.netHeadM.toFixed(1),
      s.designFlowCms.toFixed(3),
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
      s.intake.lat.toFixed(5),
      s.intake.lon.toFixed(5),
      s.power.lat.toFixed(5),
      s.power.lon.toFixed(5),
      s.reasons.join('; '),
    ]
      .map(cell)
      .join(',')
  );
  return [...head, '', cols.join(','), ...rows].join('\n') + '\n';
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
      gross_head_m: Number(s.grossHeadM.toFixed(1)),
      net_head_m: Number(s.netHeadM.toFixed(1)),
      design_flow_m3s: Number(s.designFlowCms.toFixed(3)),
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

  for (const l of c.licences) {
    features.push({
      type: 'Feature',
      properties: {
        part: 'existing licence',
        name: l.name,
        stage: l.stage,
        capacity_MW: l.capacityMW,
        promoter: l.promoter,
        river: l.river,
        distance_km: Number(l.distanceKm.toFixed(2)),
        source: 'Nepal DoED registry via Open Data Nepal',
      },
      geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
    });
  }

  // GeoJSON has no comment syntax, so provenance rides as a member of the
  // FeatureCollection. QGIS ignores it; a human reading the file does not.
  return JSON.stringify(
    { type: 'FeatureCollection', ghatta: provenance(c), features },
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
  return `ghatta_${at.lat.toFixed(4)}_${at.lon.toFixed(4)}`;
}
