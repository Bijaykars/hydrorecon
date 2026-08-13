/**
 * Run Ghatta against plants that exist.
 *
 * This module is the credibility test: click where they actually built it, with
 * the app's shipped defaults, and compare what the screen would have said
 * against what stands in the river. It runs in the browser via
 * pipeline/build-validation.mjs precisely so that it CANNOT drift from the app —
 * every import below is the same module the panel uses, not a copy.
 *
 * What is deliberately NOT done here: no per-plant tuning, no choosing the
 * exceedance that makes a plant look right, no snapping helped along by hand.
 * The intake and powerhouse coordinates come from public records
 * (pipeline/plants.json, sources named per field), the path between them is
 * traced by the app, and the numbers are whatever the engine says.
 */
import { downstreamPath, nearestReach } from './rivers.ts';
import { fetchDischarge, fetchPathProfile, meanOf } from './api.ts';
import { evaluate, type SchemeInput } from './engine/discover.ts';
import { chooseFlowMagnitude, type FlowChoice } from './engine/flowchoice.ts';
import { haversineKm, minMonthlyMean } from './engine/hydro.ts';

/** The app's shipped defaults — what a user gets before touching any slider. */
const DEFAULTS = { exceedance: 0.4, efficiency: 0.96, headLossFrac: 0.05, residualFrac: 0.1 };
const MIN_FLOW_FRAC = 0.2;

/**
 * A dam coordinate can sit a kilometre from the mapped centreline — two
 * datasets, two geometries — but a dam is BY CONSTRUCTION on its river, so a
 * slightly wider snap than the app's click radius is honest here. The distance
 * actually moved is recorded per plant and shown on the page.
 */
const INTAKE_SNAP_KM = 1.6;

/**
 * The Kali Gandaki loops ~30 km around the ridge its project tunnels through —
 * that bend is the entire reason the plant exists. The trace must go around it
 * to find the powerhouse, so the path is generous.
 */
const TRACE_KM = 40;

/**
 * A powerhouse further than this from the traced river is a wrong coordinate or
 * a wrong stream, and the run must say so rather than snap to somewhere else.
 */
const MAX_POWERHOUSE_SNAP_KM = 1.5;

export type Plant = {
  name: string;
  river: string;
  intake: [number, number];
  powerhouse: [number, number];
  actual: {
    capacityMW: number;
    designQ: number | null;
    head: number | null;
    headBasis: 'gross' | 'net' | null;
    energyGwh: number;
  };
};

export type PlantResult = {
  name: string;
  ok: boolean;
  error?: string;
  predicted?: {
    capacityMW: number;
    energyGwh: number;
    grossHeadM: number;
    netHeadM: number;
    designFlowCms: number;
    meanFlowCms: number;
    waterwayKm: number;
    turbine: string | null;
    plantFactor: number;
  };
  /** How far each given coordinate had to move to sit on the traced river. */
  snapKm?: { intake: number; powerhouse: number };
  /** Catchment of the reach the intake snapped to — the wrong-stream detector. */
  reachKm2?: number;
  /** Which flow source set the magnitude, and why (engine/flowchoice.ts). */
  flow?: FlowChoice;
  /**
   * Where the intake actually landed on the network. Deep links use this, not
   * the raw coordinate: the app's click policy snaps to the NEAREST reach — the
   * right behaviour for a person, who may mean the tributary they clicked — and
   * a raw coordinate can sit nearer a rivulet thread than the named river's own
   * line. Linking to the snapped point reproduces this run exactly.
   */
  snappedIntake?: [number, number];
  demSource?: string;
};

export async function validatePlant(p: Plant): Promise<PlantResult> {
  try {
    /**
     * Snap to the MAIN STEM where one is present, not the nearest thread.
     *
     * A dam coordinate in a steep valley can sit nearer to a hillside rivulet
     * than to the centreline of the river it actually spans — the first run of
     * this harness put Khimti's intake on a 0.1 m³/s creek that way, and the
     * "60 MW plant" came out at 0.2 MW. `nearestReach` already knows how to
     * prefer a much bigger channel close by; this uses the app's own logic.
     */
    const hit = await nearestReach(p.intake[0], p.intake[1]).catch(() => null);
    const reach = hit ? (hit.mainStem ?? hit.nearest) : null;
    if (!hit || !reach || reach.distanceKm > INTAKE_SNAP_KM) {
      return {
        name: p.name,
        ok: false,
        error: `intake is ${reach ? reach.distanceKm.toFixed(1) : '?'} km from any mapped reach`,
      };
    }
    const at = reach.point;

    const flowP = fetchDischarge(at.lat, at.lon);
    const river = await downstreamPath(at.lat, at.lon, TRACE_KM);
    if (!river || river.length < 8) {
      return { name: p.name, ok: false, error: 'could not trace the river downstream' };
    }
    const dem = await fetchPathProfile(river);
    const path = river.map((pt, k) => ({ ...pt, elevationM: dem.points[k]?.elevationM ?? NaN }));
    const flow = await flowP;

    // The powerhouse pinned to the traced path — or refused, loudly.
    let j = -1;
    let jKm = Infinity;
    path.forEach((pt, k) => {
      const d = haversineKm([pt.lat, pt.lon], p.powerhouse);
      if (d < jKm) {
        jKm = d;
        j = k;
      }
    });
    if (jKm > MAX_POWERHOUSE_SNAP_KM) {
      return {
        name: p.name,
        ok: false,
        error: `powerhouse is ${jKm.toFixed(1)} km off the traced river — wrong coordinate or wrong stream`,
      };
    }
    if (j < 2) {
      return { name: p.name, ok: false, error: 'powerhouse snapped to the intake itself' };
    }

    // Exactly the input App.tsx builds, with the shipped defaults — including
    // the same flow-authority decision the panel would make and report.
    const series = flow.values;
    const minMonth = minMonthlyMean(flow.dates, series);
    const flowChoice = chooseFlowMagnitude({
      dates: flow.dates,
      series,
      networkMeanCms: path[0]?.meanCms ?? 0,
      hydest:
        Number.isFinite(reach.below5000Frac) && reach.uplandKm2 > 0
          ? {
              totalKm2: reach.uplandKm2,
              below5000Km2: reach.below5000Frac * reach.uplandKm2,
              below3000Km2: reach.below3000Frac * reach.uplandKm2,
            }
          : null,
    });
    const usedPath =
      flowChoice.authority === 'model' ? path.map((pt) => ({ ...pt, meanCms: 0 })) : path;
    const input: SchemeInput = {
      path: usedPath,
      series,
      seriesMeanCms: meanOf(series),
      residualCms: Number.isFinite(minMonth) ? minMonth * DEFAULTS.residualFrac : 0,
      exceedance: DEFAULTS.exceedance,
      efficiency: DEFAULTS.efficiency,
      headLossFrac: DEFAULTS.headLossFrac,
      minFlowFrac: MIN_FLOW_FRAC,
      intakeWindowKm: Number.POSITIVE_INFINITY,
    };
    const s = evaluate(input, 0, j);
    if (!s) return { name: p.name, ok: false, error: 'the engine returned no scheme here' };

    const ratio =
      usedPath[0].meanCms > 0 && input.seriesMeanCms > 0
        ? usedPath[0].meanCms / input.seriesMeanCms
        : 1;
    return {
      name: p.name,
      ok: true,
      predicted: {
        capacityMW: s.capacityMW,
        energyGwh: s.energyGwh,
        grossHeadM: s.grossHeadM,
        netHeadM: s.netHeadM,
        designFlowCms: s.designFlowCms,
        meanFlowCms: meanOf(series) * ratio,
        waterwayKm: s.waterwayKm,
        turbine: s.turbine,
        plantFactor: s.plantFactor,
      },
      snapKm: { intake: reach.distanceKm, powerhouse: jKm },
      reachKm2: reach.uplandKm2,
      flow: flowChoice,
      snappedIntake: [at.lat, at.lon],
      demSource: dem.source,
    };
  } catch (e) {
    return { name: p.name, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Sequential on purpose: ten plants, shared tile and flow endpoints. */
export async function validateAll(
  plants: Plant[],
  onProgress?: (name: string, done: number, total: number) => void
): Promise<PlantResult[]> {
  const out: PlantResult[] = [];
  for (const p of plants) {
    onProgress?.(p.name, out.length, plants.length);
    out.push(await validatePlant(p));
  }
  return out;
}
