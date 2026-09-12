import {
  OBJECTION_HANDLINGS,
  type ObjectionHandling,
} from "../../db/schema/crm/call-analysis";
import type { CallAnalysisVisibility } from "./call-analysis-visibility";

/**
 * What a manager sees across a team's calls, built so that it cannot be read
 * backwards into one rep's call.
 *
 * Two constraints shape every decision in this file, and both are the ticket
 * rather than taste.
 *
 * The first: an aggregate must not reconstruct an analysis the rep has not
 * released. The obvious half is that an embargoed row must not be counted, and
 * that is enforced below by taking the visibility decision as an input and
 * filtering on it here — not by trusting the caller to have filtered, because
 * the next caller will not. The less obvious half is that a mean over two calls
 * IS those two calls: "average talk ratio 7,900 bps across 2 calls" plus one
 * released analysis reproduces the other one exactly. So there is a minimum
 * cohort, and below it the digest reports nothing but its own size.
 *
 * The second: this is coaching, not a leaderboard. Nothing here is per rep and
 * nothing here is a ranking, which is why `CoachableAnalysis` has no name field
 * for a rep to be sorted by. A manager who wants to talk to one person opens
 * that person's call and reads the analysis, under the rule in
 * `call-analysis-visibility.ts` — where the rep has already seen it. Routing
 * that conversation through a sorted table of names is what turns the tool into
 * the thing people quietly stop feeding.
 *
 * Metrics are reported as bands rather than averages for the same reason and one
 * more: a mean talk ratio is a number to be beaten, while "four of eleven calls
 * had the rep speaking over 80% of the time" is a sentence you can act on. Bands
 * are also robust to the one bad transcript that a mean is not.
 *
 * Note what is structurally absent: `CoachableAnalysis` carries no quote, no
 * next-step text and no activity id. Verbatim customer speech cannot leak
 * through this function because it never enters it — that is a type, not a
 * promise, and it is why the caller maps objections down to their handling
 * before calling in.
 */

/**
 * The smallest number of visible analyses that can be summarised.
 *
 * Five, not two and not fifty. At two, any aggregate plus one released analysis
 * gives up the other; at three or four the same arithmetic still bites for a
 * manager who knows how many calls their team made. Fifty would mean a team of
 * four never sees a digest at all, which fails the feature closed and teaches
 * everyone to ignore it. Five is the point where a count in a band stops being a
 * pointer at a person.
 */
export const COACHING_MIN_COHORT = 5;

/**
 * One analysis, reduced to what a summary is allowed to know about it.
 *
 * Everything quoted has been dropped by the time a value of this type exists.
 * The rep id is present only so the caller's visibility decision can be checked
 * against it upstream; nothing in this file groups or reports by it.
 */
export interface CoachableAnalysis {
  readonly talkRatioBps: number | null;
  readonly repTurnCount: number | null;
  readonly repQuestionCount: number | null;
  /** Objections reduced to how each was handled. The quotes never arrive here. */
  readonly objectionHandlings: readonly ObjectionHandling[];
  /** Rival names only. The lines that named them stay in the analysis row. */
  readonly competitorsNamed: readonly string[];
  readonly nextStepCommitted: boolean;
}

export interface CoachingCandidate {
  readonly analysis: CoachableAnalysis;
  readonly visibility: CallAnalysisVisibility;
}

export interface CoachingBand {
  readonly label: string;
  readonly calls: number;
}

export interface CoachingDigest {
  /** Analyses this manager may read. Everything below is computed from these. */
  readonly cohort: number;
  /**
   * How many analyses in the period are still in their rep's private window.
   *
   * A bare count, deliberately: without it the digest silently understates the
   * period and a manager draws conclusions from a partial cohort without knowing
   * it is partial. With any breakdown — by rep, by band, by day — it would
   * become the leaderboard by another route. A number and nothing else is the
   * most that can be said without saying something about somebody.
   */
  readonly embargoed: number;
  /**
   * True when the cohort is too small to summarise. Every metric is null and
   * that is the answer, not a failure.
   */
  readonly suppressed: boolean;
  /** Visible analyses whose transcript carried no speaker attribution. */
  readonly withoutSpeakerMetrics: number;
  readonly talkRatio: readonly CoachingBand[] | null;
  readonly questionRate: readonly CoachingBand[] | null;
  readonly objectionHandling: Readonly<Record<ObjectionHandling, number>> | null;
  readonly competitors: readonly { readonly name: string; readonly calls: number }[] | null;
  /** Share of visible calls that ended with a named commitment, in basis points. */
  readonly nextStepCommittedBps: number | null;
}

/**
 * Band edges in basis points, and the sentence each band is meant to support.
 *
 * A rep talking under 35% of a discovery call is usually being interviewed
 * rather than interviewing; over 80% is a demo nobody asked for. The middle
 * three exist so the two ends are not the only thing anybody looks at.
 */
const TALK_RATIO_BANDS: readonly { readonly label: string; readonly upToBps: number }[] = [
  { label: "under-35pct", upToBps: 3500 },
  { label: "35-50pct", upToBps: 5000 },
  { label: "50-65pct", upToBps: 6500 },
  { label: "65-80pct", upToBps: 8000 },
  { label: "over-80pct", upToBps: 10001 },
];

/** Questions per rep turn. Under one in ten turns is a monologue with pauses. */
const QUESTION_RATE_BANDS: readonly { readonly label: string; readonly upToBps: number }[] = [
  { label: "under-10pct", upToBps: 1000 },
  { label: "10-20pct", upToBps: 2000 },
  { label: "20-35pct", upToBps: 3500 },
  { label: "over-35pct", upToBps: 10001 },
];

function bandLabel(
  bands: readonly { readonly label: string; readonly upToBps: number }[],
  bps: number,
): string {
  for (const band of bands) if (bps < band.upToBps) return band.label;
  // Unreachable while the last edge is above 10000, which the constants above
  // hold. Returning the last label rather than throwing keeps a digest from
  // failing a manager's page over an out-of-range metric the CHECK constraint
  // on `crm_call_analyses` already refuses to store.
  return bands[bands.length - 1]!.label;
}

/**
 * Questions per rep turn in basis points, from the two counts.
 *
 * Duplicated deliberately rather than imported from `transcript-metrics.ts`:
 * that module's version takes the row's nullable columns and answers null, and
 * this one is reached only after both counts are known to be present. Keeping
 * the null handling at the call site is what lets `withoutSpeakerMetrics` be a
 * reported number instead of a silent zero in the first band.
 */
function rateBps(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10000);
}

export function coachingDigest(candidates: readonly CoachingCandidate[]): CoachingDigest {
  const visible = candidates
    .filter((candidate) => candidate.visibility.visible)
    .map((candidate) => candidate.analysis);
  const embargoed = candidates.filter((candidate) => !candidate.visibility.visible).length;

  const cohort = visible.length;

  /**
   * The suppression, and the reason it returns a shaped answer rather than
   * throwing or returning null: a manager with a small team must be able to tell
   * "not enough calls to summarise" from "the endpoint is broken", and a client
   * that has to distinguish those from an exception will guess wrong.
   */
  if (cohort < COACHING_MIN_COHORT) {
    return {
      cohort,
      embargoed,
      suppressed: true,
      withoutSpeakerMetrics: 0,
      talkRatio: null,
      questionRate: null,
      objectionHandling: null,
      competitors: null,
      nextStepCommittedBps: null,
    };
  }

  const talkRatio = new Map<string, number>();
  const questionRate = new Map<string, number>();
  const objectionHandling: Record<ObjectionHandling, number> = Object.fromEntries(
    OBJECTION_HANDLINGS.map((handling) => [handling, 0]),
  ) as Record<ObjectionHandling, number>;
  const competitors = new Map<string, { name: string; calls: number }>();

  let withoutSpeakerMetrics = 0;
  let committed = 0;

  for (const row of visible) {
    if (row.talkRatioBps === null || row.repTurnCount === null || row.repQuestionCount === null) {
      // The metric arc is all-or-nothing in the database (see the CHECK in
      // migration 0540), so one null means the transcript was not diarised.
      // Counted rather than dropped: a digest over eleven calls that quietly
      // banded four of them is a chart with a hole nobody can see.
      withoutSpeakerMetrics += 1;
    } else {
      const talk = bandLabel(TALK_RATIO_BANDS, row.talkRatioBps);
      talkRatio.set(talk, (talkRatio.get(talk) ?? 0) + 1);

      // A rep with no turns has no question rate; dividing would be a 0/0 that
      // lands in the lowest band and reads as "asked nothing".
      if (row.repTurnCount > 0) {
        const rate = bandLabel(
          QUESTION_RATE_BANDS,
          rateBps(row.repQuestionCount, row.repTurnCount),
        );
        questionRate.set(rate, (questionRate.get(rate) ?? 0) + 1);
      }
    }

    for (const handling of row.objectionHandlings) objectionHandling[handling] += 1;

    /**
     * Per call, not per mention. A rep who said "Acme" nine times has named one
     * competitor on one call, and counting mentions would rank rivals by how
     * talkative somebody was.
     */
    const named = new Set<string>();
    for (const raw of row.competitorsNamed) {
      const name = raw.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (named.has(key)) continue;
      named.add(key);
      const seen = competitors.get(key);
      if (seen) seen.calls += 1;
      else competitors.set(key, { name, calls: 1 });
    }

    if (row.nextStepCommitted) committed += 1;
  }

  return {
    cohort,
    embargoed,
    suppressed: false,
    withoutSpeakerMetrics,
    talkRatio: toBands(TALK_RATIO_BANDS, talkRatio),
    questionRate: toBands(QUESTION_RATE_BANDS, questionRate),
    objectionHandling,
    competitors: [...competitors.values()].sort(
      (a, b) => b.calls - a.calls || a.name.localeCompare(b.name),
    ),
    nextStepCommittedBps: rateBps(committed, cohort),
  };
}

/**
 * Every band, including the empty ones, in the order they were declared.
 *
 * Emitting only the non-empty bands would make an absence indistinguishable
 * from a zero, and a client that renders whatever it is given would silently
 * drop "nobody on this team is over 80%" — which is the good news the digest
 * exists to be able to deliver.
 */
function toBands(
  bands: readonly { readonly label: string; readonly upToBps: number }[],
  counts: Map<string, number>,
): CoachingBand[] {
  return bands.map((band) => ({ label: band.label, calls: counts.get(band.label) ?? 0 }));
}
