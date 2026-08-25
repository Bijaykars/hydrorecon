/**
 * Run HydroRecon against plants that exist.
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
import { arbitrateByModelFlow, downstreamPath, nearestReach, reachToRead } from './rivers.ts';
import { osmLengthFactor, stretchPath } from './osm-rivers.ts';
import { fetchDischarge, fetchPathProfile, meanOf } from './api.ts';
import { evaluate, SEARCH_KM, type SchemeInput } from './engine/discover.ts';
import { chooseFlowMagnitude, type FlowChoice } from './engine/flowchoice.ts';
import { measuredSeriesFor } from './dhm.ts';
import { judgeShape, correctShape } from './engine/fdcshape.ts';
import { NEPAL_EFLOW_POLICY, haversineKm, minMonthlyMean } from './engine/hydro.ts';

/** The app's shipped defaults — what a user gets before touching any slider. */
const DEFAULTS = {
  exceedance: 0.4,
  efficiency: 0.96,
  headLossFrac: 0.05,
  residualFrac: NEPAL_EFLOW_POLICY.minimumFractionOfLowestMonthlyMean,
};
const MIN_FLOW_FRAC = 0.2;

/**
 * A dam coordinate can sit a kilometre from the mapped centreline — two
 * datasets, two geometries — but a dam is BY CONSTRUCTION on its river, so a
 * slightly wider snap than the app's click radius is honest here. The distance
 * actually moved is recorded per plant and shown on the page.
 */
const INTAKE_SNAP_KM = 1.6;

/**
 * The trace must be longer than a scheme may be: the Kali Gandaki loops ~30 km
 * around the ridge its project tunnels through, and a published powerhouse can
 * sit that far along the water even though no scheme would run its waterway
 * that far. So the PATH stays generous and the SCHEME is bounded by the app's
 * own SEARCH_KM, which is what a user would have been shown.
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
  /**
   * Where the tailrace actually is, when it is known.
   *
   * NULL means "let the engine choose", which is the harder and more honest
   * test: it is exactly what a user standing at the intake gets. The ten
   * hand-researched plants pin both ends so head can be scored; the two hundred
   * licensed plants in doed-projects.json publish one coordinate and a capacity,
   * and scoring the engine's OWN scheme against what was built is the only
   * comparison available there — and the one a real user cares about.
   */
  powerhouse: [number, number] | null;
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
  /**
   * Set when a far larger river sat beside the one chosen. The app shows the
   * user the same warning; here it marks a score that may be measuring the
   * wrong watercourse rather than the engine.
   */
  ambiguous?: { nearestKm2: number; mainKm2: number; km: number } | null;
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
  /**
   * The magnitude the scheme was actually built on, and the series mean it was
   * measured against. Recorded because a flow-choice decision that never
   * reaches the scheme looks exactly like a decision that did, and four plants
   * in the blend A/B moved their stated factor without moving their capacity.
   */
  intakeMeanCms?: number;
  seriesMeanCms?: number;
  /**
   * True when a transferred DHM gauge record replaced the modelled series.
   *
   * It must be reported, because on these sites the flow-choice machinery is
   * bypassed ENTIRELY and correctly — a measurement beats both models, so there
   * is nothing to arbitrate. An A/B over flow-choice changes that does not
   * exclude them is silently diluted: half the blend comparison turned out to
   * be plants where the blend could not possibly have done anything, and the
   * result read as "no effect" rather than "not applicable".
   */
  usedMeasured?: boolean;
  /**
   * Capacity against waterway length, for every outlet the free search tried.
   *
   * The headline ratio compares a licensed plant with the BIGGEST scheme the
   * search can reach, and the biggest scheme always sits at the far edge of the
   * search window — so that ratio partly measures the window. This curve asks a
   * question the window cannot answer for us: how much waterway does the engine
   * need before it reaches the capacity that was actually built? A few
   * kilometres means the engine agrees with the developer and the ratio is an
   * artefact of being asked for the maximum. Twenty means it does not.
   */
  curve?: { km: number; capacityMW: number }[];
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
    /**
     * The app resolves a click to `nearest`, so this must too.
     *
     * It used to take `mainStem ?? nearest`, quietly preferring a much larger
     * neighbouring river that the app itself would never have chosen. That made
     * the harness kinder than the product: a plant whose published coordinate
     * lands on stray geometry scored against the real river while a user
     * clicking the same spot got the rivulet. A validation of behaviour nobody
     * ships is not a validation. Where the choice was ambiguous it is now
     * recorded rather than silently improved, which is the same signal the app
     * shows the user.
     */
    /**
     * Read the river, not the rivulet beside it (see reachToRead in rivers.ts).
     * Upper Tamakoshi's headworks snap to an 8 km2 tributary 0.95 km from the
     * 1,754 km2 Tamakoshi; without this the harness scores 0.8 MW against 456.
     */
    const read = hit ? reachToRead(hit) : null;
    let reach = read?.reach ?? null;
    const ambiguous = hit?.mainStem
      ? { nearestKm2: hit.nearest.uplandKm2, mainKm2: hit.mainStem.uplandKm2, km: hit.mainStem.distanceKm }
      : null;
    if (!hit || !reach || reach.distanceKm > INTAKE_SNAP_KM) {
      return {
        name: p.name,
        ok: false,
        error: `intake is ${reach ? reach.distanceKm.toFixed(1) : '?'} km from any mapped reach`,
      };
    }
    let at = reach.point;

    /**
     * Let the model's own flow settle which channel this is, before anything
     * else reads a catchment (arbitrateByModelFlow in rivers.ts).
     *
     * The discharge is fetched once either way, so this costs no extra request
     * — only a re-trace of the path, which is local. It has to happen here
     * because everything downstream inherits the choice: the traced path, the
     * hypsometry, and the regional regression that flowchoice.ts uses as its
     * judge. That judge is computed FROM the catchment, so a wrong reach makes
     * it confirm the wrong source rather than catch it.
     */
    const flow = await fetchDischarge(at.lat, at.lon);
    // arbitrateByModelFlow is DISABLED — see its header. It promoted Seti Khola
    // from a 37 km2 channel MERIT independently confirms, turning a 0.34x
    // under-prediction into a 3.28x over-prediction.
    void arbitrateByModelFlow;

    const modelled = await downstreamPath(at.lat, at.lon, TRACE_KM);
    if (!modelled || modelled.length < 8) {
      return { name: p.name, ok: false, error: 'could not trace the river downstream' };
    }
    /**
     * Keep the modelled course — it is what the terrain sampling is validated
     * on — but restate its LENGTH at the traced value. See osmLengthFactor.
     */
    const { factor } = await osmLengthFactor(modelled);
    const river = stretchPath(modelled, factor);
    const dem = await fetchPathProfile(river);
    const path = river.map((pt, k) => ({ ...pt, elevationM: dem.points[k]?.elevationM ?? NaN }));

    // The powerhouse pinned to the traced path — or refused, loudly. With no
    // published powerhouse, j is decided later by the engine's own search.
    let j = -1;
    let jKm = Number.NaN;
    if (p.powerhouse) {
      jKm = Infinity;
      path.forEach((pt, k) => {
        const d = haversineKm([pt.lat, pt.lon], p.powerhouse!);
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
    }

    // Exactly the input App.tsx builds, with the shipped defaults — including
    // the same flow-authority decision the panel would make and report.
    /**
     * Measured water outranks modelled water.
     *
     * Where DHM holds a record on a comparable catchment nearby, the series and
     * its magnitude come from that record rather than from a global model. The
     * path keeps the network's downstream growth but is anchored to the gauge,
     * so flow still rises past confluences while the magnitude is the measured
     * one. Same call the app makes — see src/dhm.ts.
     */
    const measured = await measuredSeriesFor(at.lat, at.lon, reach.uplandKm2).catch(() => null);
    const networkAtIntake = path[0]?.meanCms ?? 0;
    const anchor =
      measured && networkAtIntake > 0 ? measured.meanCms / networkAtIntake : 1;
    /**
     * The same flow-duration shape guard the app applies (engine/fdcshape.ts).
     *
     * It has to be here as well as in App.tsx, or this harness stops measuring
     * the app — the last time these two drifted apart, validate was scoring a
     * scheme the app would never have built. A measured record is exempt: it is
     * the evidence the correction is trying to approximate.
     */
    const modelledSeries = measured ? measured.values : flow.values;
    const shape = measured ? null : judgeShape(modelledSeries, DEFAULTS.exceedance);
    const series = shape?.implausible ? correctShape(modelledSeries, DEFAULTS.exceedance) : modelledSeries;
    const seriesDates = measured ? measured.dates : flow.dates;
    const minMonth = minMonthlyMean(seriesDates, series);
    const flowChoice = chooseFlowMagnitude({
      dates: seriesDates,
      series,
      networkMeanCms: path[0]?.meanCms ?? 0,
      hydest:
        Number.isFinite(reach.below5000Frac) && reach.uplandKm2 > 0
          ? {
              totalKm2: reach.uplandKm2,
              below5000Km2: reach.below5000Frac * reach.uplandKm2,
              below3000Km2: reach.below3000Frac * reach.uplandKm2,
              ...(Number.isFinite(reach.monsoonMm) ? { monsoonMm: reach.monsoonMm } : {}),
            }
          : null,
      modified:
        reach && Number.isFinite(reach.averageAltitudeM) && Number.isFinite(reach.annualPrecipMm)
          ? {
              below3000Km2: reach.below3000Frac * reach.uplandKm2,
              below5000Km2: reach.below5000Frac * reach.uplandKm2,
              averageAltitudeM: reach.averageAltitudeM,
              annualWetnessMm: reach.annualPrecipMm,
            }
          : null,
    });
    const usedPath = measured
      ? path.map((pt) => ({ ...pt, meanCms: pt.meanCms * anchor }))
      : flowChoice.authority === 'model'
        ? path.map((pt) => ({ ...pt, meanCms: 0 }))
        : flowChoice.authority === 'hydest' && flowChoice.targetMeanCms
          ? path.map((pt) => ({ ...pt, meanCms: flowChoice.targetMeanCms! }))
          : flowChoice.magnitudeFactor && flowChoice.magnitudeFactor !== 1
            ? path.map((pt) => ({ ...pt, meanCms: pt.meanCms * flowChoice.magnitudeFactor! }))
            : path;
    const input: SchemeInput = {
      path: usedPath,
      series,
      seriesMeanCms: meanOf(series),
      residualCms: Number.isFinite(minMonth) ? minMonth * DEFAULTS.residualFrac : 0,
      exceedance: DEFAULTS.exceedance,
      efficiency: DEFAULTS.efficiency,
      headLossFrac: DEFAULTS.headLossFrac,
      minFlowFrac: MIN_FLOW_FRAC,
      /**
       * Unbounded is right ONLY when the intake is already pinned.
       *
       * With a published powerhouse the intake is fixed at index 0 and this
       * never bites. With the engine choosing its own scheme it does, badly:
       * an unbounded search walks the whole traced path and builds the biggest
       * thing it can find, which is the trunk river at the bottom. It sized a
       * 3 MW khola at 1,018 MW on 690 m3/s — the Piluwa Khola does not carry
       * 690 m3/s, the river thirty kilometres below it does. So the free-search
       * mode uses the same 2 km window the app gives a user, which keeps the
       * intake at the coordinate being asked about.
       */
      intakeWindowKm: p.powerhouse ? Number.POSITIVE_INFINITY : 2,
    };
    /**
     * With no published powerhouse, search the OUTLET only and pin the intake.
     *
     * discover() is free to move the intake too, up to its window, and against a
     * named plant that is the wrong question: it walks a couple of kilometres
     * downstream onto a bigger river and reports a scheme that belongs to a
     * different project. It sized Chhandi Khola at 14x its licence that way.
     * The plant is AT this coordinate, so the fair comparison is the best
     * scheme reachable FROM it.
     */
    let s: ReturnType<typeof evaluate> = null;
    const curve: { km: number; capacityMW: number }[] = [];
    if (j >= 0) {
      s = evaluate(input, 0, j);
    } else {
      for (let k = 2; k < path.length; k++) {
        if (path[k].km - path[0].km > SEARCH_KM) break;
        const cand = evaluate(input, 0, k, undefined, false);
        if (!cand) continue;
        curve.push({ km: cand.waterwayKm, capacityMW: cand.capacityMW });
        if (!s || cand.capacityMW > s.capacityMW) s = cand;
      }
    }
    if (!s) return { name: p.name, ok: false, error: 'the engine returned no scheme here' };

    /**
     * Rescale at the intake the scheme CHOSE, not at the start of the path.
     *
     * engine/discover.ts scales design flow by path[i].meanCms for its chosen
     * intake i. Reporting the mean against path[0] instead made the two
     * inconsistent the moment the intake moved, and produced flatly impossible
     * numbers: Lower Modi Khola came out with a Q40 8.5x its own mean flow,
     * when Q40 is by definition below the mean on a monsoon river.
     */
    const intakePt = usedPath[s.i] ?? usedPath[0];
    const ratio =
      intakePt.meanCms > 0 && input.seriesMeanCms > 0
        ? intakePt.meanCms / input.seriesMeanCms
        : 1;
    return {
      name: p.name,
      ok: true,
      usedMeasured: !!measured,
      intakeMeanCms: usedPath[s.i]?.meanCms,
      seriesMeanCms: input.seriesMeanCms,
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
      ...(curve.length ? { curve } : {}),
      snapKm: { intake: reach.distanceKm, powerhouse: jKm },
      reachKm2: reach.uplandKm2,
      ambiguous,
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
