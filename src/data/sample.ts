/**
 * Sample-data factory. The discovery/hydrology engines land in M1–M3 (plan.md);
 * until then the UI runs on synthetic inputs pushed through the REAL physics
 * kernel (src/engine/hydro.ts, 36 passing checks). Everything produced here is
 * quality-labelled 'sample' or 'assumed' so the UI can never pass demo numbers
 * off as analysis.
 */
import {
  annualEnergy,
  buildFdc,
  flowAtExceedance,
  residualForBasis,
  seasonalRatio,
  wetDryEnergy,
  type FdcPoint,
  type PlantParams,
} from '../engine/hydro.ts';
import { traced, type ProfilePoint, type Scheme } from '../types.ts';

/** Deterministic 0..1 noise — no Math.random so renders and screenshots repeat. */
const noise = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Nepali monsoon shape, normalized to mean 1.0. Jul–Sep carry the flood; the
 * Feb–Mar trough is what firm power lives on. Shape only — scaled by the reach's
 * HydroRIVERS long-term mean at the clicked site.
 */
const MONSOON = [0.32, 0.28, 0.26, 0.3, 0.45, 1.1, 2.6, 3.1, 2.2, 1.05, 0.55, 0.38];
const MONSOON_NORM = 12 / MONSOON.reduce((a, b) => a + b, 0);

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Three years of plausible daily flow, scaled to a mean. */
export function sampleSeries(meanCms: number): { dates: string[]; valuesCms: number[] } {
  const dates: string[] = [];
  const valuesCms: number[] = [];
  let i = 0;
  for (let year = 2023; year <= 2025; year++) {
    for (let m = 0; m < 12; m++) {
      for (let day = 1; day <= DAYS_IN_MONTH[m]; day++) {
        const base = meanCms * MONSOON[m] * MONSOON_NORM;
        // Mild day-to-day variability, wetter noise in monsoon months.
        const jitter = 0.72 + 0.56 * noise(i) + (m >= 5 && m <= 8 ? 0.35 * noise(i * 7) : 0);
        dates.push(`${year}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        valuesCms.push(base * jitter);
        i++;
      }
    }
  }
  return { dates, valuesCms };
}

const NPR_PER_USD = 134; // assumed FX for the specific-cost readout
const CAPEX_MN_NPR_PER_MW = 205; // mid of the verified 170–240 band (research doc §9)

type FamilySpec = {
  family: Scheme['family'];
  familyLabel: string;
  headM: number;
  exceedance: number;
  headLossFrac: number;
  efficiency: number;
  minFlowFrac: number;
  why: string;
};

/** Head menu scales with river size — a 380 m scheme on the Sapta Koshi is nonsense. */
function familySpecs(meanCms: number): FamilySpec[] {
  const heads: [number, number, number] =
    meanCms > 100 ? [25, 60, 95] : meanCms > 20 ? [60, 150, 240] : [90, 240, 380];
  return [
    {
      family: 'canal',
      familyLabel: 'Canal-dominant',
      headM: heads[0],
      exceedance: 0.45,
      headLossFrac: 0.035,
      efficiency: 0.85,
      minFlowFrac: 0.2,
      why: 'Lowest civil risk: no tunnel, all works accessible from the surface. Wins on cost and constructability; loses on head.',
    },
    {
      family: 'tunnel',
      familyLabel: 'Tunnel-dominant',
      headM: heads[1],
      exceedance: 0.4,
      headLossFrac: 0.055,
      efficiency: 0.86,
      minFlowFrac: 0.15,
      why: 'The balanced option: more head for moderate tunnel length. Survives because it captures most of the energy upside at a defensible cost.',
    },
    {
      family: 'high-head',
      familyLabel: 'High-head',
      headM: heads[2],
      exceedance: 0.3,
      headLossFrac: 0.075,
      efficiency: 0.88,
      minFlowFrac: 0.1,
      why: 'Maximum energy per drop of water. Survives on energy and dry-season value; carries the longest waterway and the most geological exposure.',
    },
  ];
}

/** Schematic long profile for a family. Sample geometry — real routing lands in M2. */
function sampleProfile(spec: FamilySpec, waterwayM: number, penstockM: number): ProfilePoint[] {
  const phZ = 600; // arbitrary sample datum
  const intakeZ = phZ + spec.headM;
  const pts: ProfilePoint[] = [];
  const n = 90;
  const totalM = waterwayM + penstockM;
  const conveySlope = 0.001; // canal / low-pressure tunnel
  const conveyDrop = waterwayM * conveySlope;
  const frictionM = spec.headM * spec.headLossFrac;
  for (let i = 0; i <= n; i++) {
    const ch = (totalM * i) / n;
    const inConvey = ch <= waterwayM;
    const invert = inConvey
      ? intakeZ - ch * conveySlope
      : intakeZ - conveyDrop - (spec.headM - conveyDrop) * ((ch - waterwayM) / penstockM);
    // Valley side: rises away from the river then falls to the powerhouse bench.
    const t = ch / totalM;
    const ridge =
      spec.family === 'canal'
        ? 14 + 10 * Math.sin(t * 9) * noise(i + 3)
        : 30 + (spec.family === 'tunnel' ? 190 : 260) * Math.sin(Math.PI * Math.min(1, t * 1.15));
    const ground = inConvey ? invert + ridge : Math.max(invert + 4, phZ + (1 - t) * 90);
    // HGL: friction spread along conveyance, the rest lost through the penstock.
    const hgl = intakeZ - frictionM * (inConvey ? (ch / waterwayM) * 0.45 : 0.45 + 0.55 * ((ch - waterwayM) / penstockM));
    pts.push({
      ch,
      ground,
      invert,
      hgl,
      seg: inConvey ? (spec.family === 'canal' ? 'canal' : 'tunnel') : 'penstock',
    });
  }
  return pts;
}

export type SiteAnalysis = {
  fdc: FdcPoint[];
  monthlyMeans: number[];
  residualCms: number;
  schemes: Scheme[];
};

/** Build the sample scheme set for a clicked reach. Real engine, sample inputs. */
export function analyseSite(dates: string[], valuesCms: number[]): SiteAnalysis {
  const fdc = buildFdc(valuesCms);
  const { monthlyMeans } = seasonalRatio(dates, valuesCms);
  const residualCms = residualForBasis('minMonth', dates, valuesCms);

  const meanCms = valuesCms.reduce((a, b) => a + b, 0) / valuesCms.length;
  const schemes = familySpecs(meanCms).map((spec, idx): Scheme => {
    const designFlowCms = Math.max(
      0.1,
      flowAtExceedance(fdc, spec.exceedance) - residualCms
    );
    const p: PlantParams = {
      grossHeadM: spec.headM,
      headLossFrac: spec.headLossFrac,
      efficiency: spec.efficiency,
      designFlowCms,
      residualFlowCms: residualCms,
      minFlowFrac: spec.minFlowFrac,
    };
    const energy = annualEnergy(valuesCms, p);
    const seasons = wetDryEnergy(dates, valuesCms, p);
    const capacityMW = energy.ratedPowerW / 1e6;
    const capexMnNpr = capacityMW * CAPEX_MN_NPR_PER_MW;
    const revenueMnNpr = seasons.wetGwh * 4.8 + seasons.dryGwh * 8.4;
    const riverSlope = meanCms > 100 ? 0.005 : meanCms > 20 ? 0.014 : 0.03;
    const waterwayM = (spec.headM / riverSlope) * 0.85;
    const penstockM = spec.headM * 2.1;

    const sample = (v: number, unit: string, method: string) =>
      traced(v, 'sample' as const, method, { unit, source: 'sample flow series' });

    return {
      id: `S-${idx + 1}`,
      name: `${spec.familyLabel} · Q${Math.round(spec.exceedance * 100)}`,
      family: spec.family,
      familyLabel: spec.familyLabel,
      grossHeadM: traced(spec.headM, 'assumed', 'family head menu — DEM-derived head lands in M2', {
        unit: 'm',
      }),
      designFlowCms: sample(
        designFlowCms,
        'm³/s',
        `Q${Math.round(spec.exceedance * 100)} from the sample FDC minus residual flow`
      ),
      residualFlowCms: traced(residualCms, 'estimated', '10% of minimum monthly mean — Nepal licensing basis', {
        unit: 'm³/s',
        source: 'engine: residualForBasis(minMonth)',
      }),
      waterwayM: traced(waterwayM, 'assumed', 'head ÷ assumed river slope — real routing lands in M2', {
        unit: 'm',
      }),
      penstockM: traced(penstockM, 'assumed', '≈2.1 × head at ~28° descent', { unit: 'm' }),
      capacityMW: sample(capacityMW, 'MW', 'ρ·g·Q·H·η at design flow (validated kernel)'),
      energyGwh: sample(energy.gwhPerYear, 'GWh/yr', 'daily dispatch over the sample series (validated kernel)'),
      wetGwh: sample(seasons.wetGwh, 'GWh', 'mid-Apr → mid-Dec split (NEA PPA seasons)'),
      dryGwh: sample(seasons.dryGwh, 'GWh', 'mid-Dec → mid-Apr split (NEA PPA seasons)'),
      plantFactor: sample(energy.grossPlantFactor, '', 'gross hydrologic plant factor — excludes outages'),
      capexMnNpr: traced(capexMnNpr, 'assumed', `${CAPEX_MN_NPR_PER_MW} Mn NPR/MW — mid of the verified 2025–26 band (170–240)`, {
        unit: 'Mn NPR',
        source: 'CARE/ICRA rating reports, research doc §9',
      }),
      specificUsdPerKw: traced((capexMnNpr * 1e6) / NPR_PER_USD / (capacityMW * 1000), 'assumed', 'CAPEX ÷ capacity at assumed FX 134 NPR/USD', {
        unit: 'USD/kW',
      }),
      paybackYears: traced(capexMnNpr / Math.max(0.001, revenueMnNpr), 'sample', 'CAPEX ÷ first-year PPA revenue (wet 4.8 / dry 8.4 NPR)', {
        unit: 'yr',
      }),
      flags:
        spec.family === 'high-head'
          ? ['Longest dewatered reach', 'Tunnel cover unverified']
          : spec.family === 'tunnel'
            ? ['Tunnel cover unverified']
            : ['Flood exposure of canal alignment'],
      whySurvives: spec.why,
      profile: sampleProfile(spec, waterwayM, penstockM),
    };
  });

  return { fdc, monthlyMeans, residualCms, schemes };
}
