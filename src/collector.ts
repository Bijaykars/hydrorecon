/**
 * Collector intakes: when a second stream is worth piping into the headpond.
 *
 * Multi-intake run-of-river schemes are ordinary in Nepal — a main intake on
 * the principal stream plus supplementary intakes on tributaries, joined to
 * the headrace by link canals or short tunnels. The attraction is that the
 * extra water arrives at the SAME head, so it costs a channel rather than a
 * second powerhouse.
 *
 * The arithmetic is easy and the traps are not. This module holds the traps.
 *
 * WHY THE RATIO SCALING IS DEFENSIBLE. Each tributary is assumed to share the
 * main catchment's flow-duration SHAPE — reasonable for a neighbouring
 * catchment in the same rainfall regime, and the standard screening
 * assumption. If the tributary carries r times the main stream's flow at every
 * exceedance, then its design flow at the chosen exceedance is r times the
 * main's, and its residual-flow obligation is likewise r times — so the NET
 * usable addition is exactly r times the main's design flow. Residual flow is
 * therefore already handled by proportionality, not ignored.
 *
 * What the ratio does NOT handle: the headrace and penstock were sized for the
 * main flow alone. Adding 50% more water through the same pipe raises velocity
 * and head loss quadratically. Screening says "worth surveying"; it does not
 * size the civil works, and the app says so.
 */

/** A link canal needs fall to flow. Typical lined-canal gradients run about
 *  1:1000 to 1:2000 — call it 1 m per km as the floor. */
const MIN_GRADIENT_M_PER_KM = 1;

/**
 * Plus an absolute minimum for entry losses, freeboard and survey error.
 *
 * THE OLD 2 m WAS SMALLER THAN THE ERROR IT WAS MEANT TO SURVIVE. The comment
 * beside it said the terrain carries roughly ±15 m of vertical error and then
 * accepted a 2.1 m apparent fall as gravity-feasible — a margin whose SIGN can
 * flip on the DEM alone. A 5.1 m fall over 5 km passed the same way.
 *
 * The absolute error is correlated at short range, so what actually survives is
 * a DIFFERENCE over a short baseline (see engine/corridor.ts, which relies on
 * exactly that). Two independent terrain products agree on short-baseline
 * differences to about 2.9%, so over a channel of a few kilometres the residual
 * is metres rather than tens of metres. 15 m is the honest bar for calling a
 * gravity feed confirmed from terrain alone, and anything under it is reported
 * as needing survey rather than as feasible.
 */
const MIN_FALL_M = 15;

/**
 * A tributary sitting far ABOVE the headpond is a warning, not a prize.
 * Delivering it down to the main intake throws away the head between them —
 * head the scheme could have developed. Past this fraction of the plant's own
 * gross head, a separate scheme or a higher main intake usually beats a
 * collector.
 */
const WASTEFUL_DROP_FRAC = 0.3;

/** Beyond this, the link channel starts to dominate the civil cost. */
const LONG_CHANNEL_KM = 5;

/** Cost sanity: km of channel bought per m³/s of mean flow gained. */
const POOR_VALUE_KM_PER_CMS = 3;

export type CollectorInput = {
  lat: number;
  lon: number;
  /** Terrain elevation at the intake, m. Null when the DEM did not answer. */
  elevationM: number | null;
  /** Mapped network long-term mean at this point, m³/s. Null off-network. */
  meanCms: number | null;
  uplandKm2: number | null;
  /**
   * Length of the link canal: straight-line distance to the nearest point of
   * the main waterway, which is where the two flows become one.
   */
  channelKm: number;
  /** Index into the studied path where the link meets the main waterway. */
  linkPathIndex?: number | null;
  /** Indicative alignment for that link, [lon, lat], following its own valley. */
  linkRoute?: [number, number][];
  /**
   * True when water here ALREADY reaches the main intake by the river itself.
   * Determined by the caller from channel topology, not from geometry.
   */
  nestedUpstream: boolean;
  /**
   * Where this stream rejoins the diverted reach, as distance below the main
   * intake in km — null when it does not rejoin within the studied reach.
   *
   * This is the twin-intake case, and it is common: two branches meet, and the
   * engineer wants both. When the branch is BELOW the headpond it cannot be
   * piped up to it, but moving the main intake below the junction captures
   * both rivers with one structure, which is what a real layout would do.
   */
  joinsMainBelowIntakeKm?: number | null;
  /** Index into the studied path just below that junction, for the UI to act on. */
  junctionPathIndex?: number | null;
  /** The mapped network's mean flow just below that junction, m³/s. */
  junctionMeanCms?: number | null;
  /** The mapped network's mean flow at the main intake now, m³/s. */
  mainMeanCms?: number | null;
  /** How far the dropped pin was moved to reach the mapped channel, km. */
  snappedKm?: number;
};

export type CollectorMain = {
  /** Terrain elevation at the main intake — the headpond level, m. */
  elevationM: number | null;
  meanCms: number | null;
  uplandKm2: number | null;
  grossHeadM: number;
};

export type CollectorVerdict =
  | 'ok'
  | 'not-a-stream'
  | 'already-counted'
  | 'below-headpond'
  | 'too-flat';

export type AssessedCollector = CollectorInput & {
  /** Elevation above the headpond, m. Positive means gravity can deliver. */
  headroomM: number | null;
  /** Fall available per km of channel, m/km. */
  gradientMPerKm: number | null;
  verdict: CollectorVerdict;
  /**
   * This stream carries more water than the one being studied.
   *
   * When it also sits below the headpond, that combination is the signal that
   * the WRONG river is being studied: the bigger branch, taken at its own
   * elevation, usually beats both piping it uphill (impossible) and dropping
   * the intake to the confluence (which gives up the most head of any option).
   */
  biggerThanMain: boolean;
  /** Why it was excluded, or what to watch if it counts. Plain language. */
  reason: string;
  /** Non-fatal cautions that still let the intake count. */
  warnings: string[];
  /** Share of the main stream's flow this adds. Zero unless the verdict is ok. */
  ratio: number;
};

export type CollectorScreen = {
  items: AssessedCollector[];
  /** Total usable share added — the multiplier is 1 + gainFrac. */
  gainFrac: number;
  counted: number;
};

export function assessCollectors(
  main: CollectorMain,
  inputs: CollectorInput[]
): CollectorScreen {
  /**
   * Collectors are checked against the MAIN river and against EACH OTHER.
   *
   * Every rule below asks whether this intake's water already reaches the main
   * intake, and none asked whether it already reaches another collector. Two
   * pins on the same tributary — or one on a branch and one below its junction
   * — were both counted in full, so the same water was added twice and the
   * headline gain doubled with nothing on screen to say so. Two identical pins
   * at a 0.2 ratio each produced a 0.4 gain.
   *
   * The test is the same one used against the main stem: a later pin whose
   * mapped reach is the one an earlier pin already sits on, or which shares its
   * snapped channel, is water already spoken for.
   */
  const claimedReaches = new Set<number>();
  const claimedPoints = new Set<string>();
  const items = inputs.map((c): AssessedCollector => {
    const headroomM =
      c.elevationM != null && main.elevationM != null ? c.elevationM - main.elevationM : null;
    const gradientMPerKm = headroomM != null && c.channelKm > 0 ? headroomM / c.channelKm : null;
    const biggerThanMain = Boolean(
      c.meanCms != null && main.meanCms != null && c.meanCms > main.meanCms
    );
    const base = {
      ...c,
      headroomM,
      gradientMPerKm,
      biggerThanMain,
      warnings: [] as string[],
      ratio: 0,
    };

    // 1. It has to be a stream. A point on a hillside has no flow to divert,
    //    however good the elevation looks.
    if (c.meanCms == null || !(c.meanCms > 0)) {
      return {
        ...base,
        verdict: 'not-a-stream',
        reason:
          'no mapped watercourse here — an intake needs a stream, not a hillside. Drag it onto a blue channel.',
      };
    }

    // 2. The one that would silently inflate the answer: water already flowing
    //    through the main intake cannot be diverted to it a second time.
    if (c.nestedUpstream) {
      return {
        ...base,
        verdict: 'already-counted',
        reason:
          'this water already flows through the main intake — diverting it again would count the same river twice. Use a tributary that joins BELOW the intake, or a separate catchment.',
      };
    }

    // 2b. The same trap between two collectors: a second pin on a channel an
    //     earlier pin already claims adds the same water a second time.
    const reachKey = c.linkPathIndex ?? null;
    const pointKey = `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
    if (claimedPoints.has(pointKey) || (reachKey != null && claimedReaches.has(reachKey))) {
      return {
        ...base,
        verdict: 'already-counted',
        reason:
          'another collector intake already takes this water — two pins on the same channel would add it twice. Move this one to a separate tributary.',
      };
    }

    // 3. Gravity. A collector below the headpond would need pumping, which no
    //    run-of-river scheme does.
    if (headroomM == null) {
      return {
        ...base,
        verdict: 'below-headpond',
        reason: 'terrain unavailable here, so gravity delivery cannot be confirmed.',
      };
    }
    if (headroomM < MIN_FALL_M) {
      const short =
        headroomM >= 0
          ? `only ${headroomM.toFixed(0)} m above the headpond, which is inside the terrain's own error`
          : `${Math.abs(headroomM).toFixed(0)} m below the headpond`;
      /**
       * Three different situations wear the same "below the headpond" verdict,
       * and the useful answer differs in each.
       *
       * The one worth catching is the bigger branch sitting below the intake.
       * Dropping the intake to the confluence works but surrenders every metre
       * between here and there; taking the big river at ITS OWN elevation
       * keeps that head AND the flow, and turns the stream being studied into
       * a collector rather than the main stem. That is usually the real layout.
       */
      const reason = biggerThanMain
        ? `${short} — its water cannot climb to your intake. But it carries ${c.meanCms.toFixed(1)} m³/s against ${(main.meanCms ?? 0).toFixed(1)} m³/s on the stream you are studying: this is the bigger river, and taking it at its own level keeps the head between here and the confluence instead of giving it away.`
        : c.joinsMainBelowIntakeKm != null
          ? `${short} — its water cannot climb to your intake. But it joins your river ${c.joinsMainBelowIntakeKm.toFixed(1)} km below the intake, so moving the MAIN intake below that junction takes both rivers through one structure.`
          : `${short} — water will not run uphill. Move it upstream on its own stream, where it sits above the headpond.`;
      return { ...base, verdict: 'below-headpond', reason };
    }

    // 4. Enough fall to actually flow the distance.
    if (gradientMPerKm != null && gradientMPerKm < MIN_GRADIENT_M_PER_KM) {
      return {
        ...base,
        verdict: 'too-flat',
        reason: `${headroomM.toFixed(0)} m of fall over ${c.channelKm.toFixed(1)} km is ${gradientMPerKm.toFixed(2)} m/km — flatter than a canal will flow. A tunnel or a higher intake is the alternative.`,
      };
    }

    // Counted. Now the cautions that do not disqualify it.
    const warnings: string[] = [];
    if (main.grossHeadM > 0 && headroomM > main.grossHeadM * WASTEFUL_DROP_FRAC) {
      warnings.push(
        `sits ${headroomM.toFixed(0)} m above the headpond, ${Math.round((headroomM / main.grossHeadM) * 100)}% of this scheme's own gross head — delivering it down here throws that away. A higher main intake, or its own scheme, may beat a collector.`
      );
    }
    if (c.channelKm > LONG_CHANNEL_KM) {
      warnings.push(
        `${c.channelKm.toFixed(1)} km of link channel — at this length the channel, not the turbine, decides the economics.`
      );
    }
    const kmPerCms = c.channelKm / c.meanCms;
    if (kmPerCms > POOR_VALUE_KM_PER_CMS) {
      warnings.push(
        `${kmPerCms.toFixed(1)} km of channel per m³/s gained — poor value beside most link canals.`
      );
    }
    if (main.uplandKm2 != null && c.uplandKm2 != null && c.uplandKm2 > main.uplandKm2) {
      warnings.push(
        'this stream drains a larger catchment than the one you selected — it is the main stem here, and is probably the river to build on.'
      );
    }

    // Claim this water so a later pin on the same channel cannot add it again.
    claimedPoints.add(pointKey);
    if (reachKey != null) claimedReaches.add(reachKey);

    return {
      ...base,
      verdict: 'ok',
      reason: 'gravity-fed from its own catchment, and its water does not pass the main intake.',
      warnings,
      ratio: main.meanCms && main.meanCms > 0 ? c.meanCms / main.meanCms : 0,
    };
  });

  const gainFrac = items.reduce((sum, item) => sum + item.ratio, 0);
  return { items, gainFrac, counted: items.filter((i) => i.verdict === 'ok').length };
}
