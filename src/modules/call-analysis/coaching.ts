import type { CallObjection, ObjectionTheme } from "./call-judgement.schemas";
import { OBJECTION_THEMES } from "./call-judgement.schemas";

/**
 * What a rep sees about themselves, and what a manager sees about a team.
 *
 * Ticket 02. The two are different shapes rather than the same shape with a
 * filter on it, and that is the ticket: a coaching tool that arrives as a
 * surveillance report is a tool people route around, and the way it arrives as
 * one is that the manager's screen is the rep's screen with more rows.
 *
 * So `TeamCoachingView` has no call identifier and no person on it anywhere.
 * Not hidden, not filtered — absent from the type, so there is nowhere for a
 * later query to put one and no field a serialiser could leak. It carries
 * aggregates and coaching prompts, and a prompt says how many calls and how many
 * people it touches without saying which. The conversation about who needs help
 * is one a manager has with a rep, and it starts from the rep's own screen,
 * which shows the same prompts about themselves before anybody else sees a
 * thing.
 *
 * The cost is real and is the trade being made: a manager cannot open this and
 * find the person to talk to. That is the point rather than an omission —
 * `visibility.ts` states the whole of it to the rep in the same words.
 */

/** One analysis, as both surfaces read it. */
export interface AnalysedCall {
  readonly crmCallAnalysisId: string;
  readonly activityId: string;
  readonly repUserId: string | null;
  readonly occurredAt: Date;
  readonly talkRatioBps: number | null;
  readonly questionShareBps: number | null;
  readonly objections: readonly CallObjection[];
  readonly competitorKeys: readonly string[];
  readonly nextStepCommitted: boolean;
}

const BPS = 10_000;

/**
 * The bands a prompt fires outside, as constants in this file.
 *
 * Not tenant settings, and not for the legal reason `jurisdiction.ts` has — for
 * a plainer one. A band an organisation can widen is a band that gets widened
 * the first quarter somebody is uncomfortable, and a coaching signal that moves
 * when the team's results move is a signal that says nothing at all. They are
 * bands rather than targets: the upper edge of the talk-ratio band is the one
 * that fires, because a rep who listens more than the band is not a problem to
 * be corrected.
 */
export const COACHING_BANDS = {
  /** Above this share of the words, the rep is presenting rather than selling. */
  talkRatioCeilingBps: 5_500,
  /** Below this share of their own turns asking something, they are pitching. */
  questionShareFloorBps: 2_000,
  /** Below this share of calls ending in a commitment, the pipeline is soft. */
  nextStepRateFloorBps: 5_000,
} as const;

export const COACHING_PROMPT_KINDS = [
  "talking-more-than-listening",
  "asking-too-few-questions",
  "objections-left-unanswered",
  "calls-ending-without-a-next-step",
] as const;
export type CoachingPromptKind = (typeof COACHING_PROMPT_KINDS)[number];

export interface CoachingPrompt {
  readonly kind: CoachingPromptKind;
  readonly prompt: string;
  readonly callsAffected: number;
  /** How many people, never which. Zero when every affected call is unattributed. */
  readonly repsAffected: number;
}

export interface ObjectionThemeCount {
  readonly theme: ObjectionTheme;
  readonly raised: number;
  /** Raised and not answered. The number worth a conversation. */
  readonly unanswered: number;
}

export interface CompetitorMentionCount {
  readonly competitorKey: string;
  readonly calls: number;
}

/**
 * The manager surface, in full.
 *
 * Every field is a count or a median over the window. If you are adding one,
 * `MANAGER_VISIBILITY` will stop compiling until you have written the sentence
 * that tells a rep it exists — which is ticket 02's third criterion enforced by
 * the type checker rather than by a reviewer noticing.
 */
export interface TeamCoachingView {
  readonly callsAnalysed: number;
  readonly repsWithCalls: number;
  readonly medianTalkRatioBps: number | null;
  readonly medianQuestionShareBps: number | null;
  readonly nextStepRateBps: number;
  readonly objectionsByTheme: readonly ObjectionThemeCount[];
  readonly competitorMentions: readonly CompetitorMentionCount[];
  readonly prompts: readonly CoachingPrompt[];
}

export interface RepTrendPoint {
  /** The Monday of the week these calls fall in, at UTC midnight. */
  readonly weekStart: Date;
  readonly calls: number;
  readonly medianTalkRatioBps: number | null;
  readonly medianQuestionShareBps: number | null;
  readonly nextStepRateBps: number;
  readonly unansweredObjections: number;
}

export function teamCoachingView(calls: readonly AnalysedCall[]): TeamCoachingView {
  return {
    callsAnalysed: calls.length,
    repsWithCalls: new Set(calls.flatMap((call) => (call.repUserId ? [call.repUserId] : [])))
      .size,
    medianTalkRatioBps: median(calls.map((call) => call.talkRatioBps)),
    medianQuestionShareBps: median(calls.map((call) => call.questionShareBps)),
    nextStepRateBps: shareBps(calls.filter((call) => call.nextStepCommitted).length, calls.length),
    objectionsByTheme: objectionsByTheme(calls),
    competitorMentions: competitorMentions(calls),
    prompts: coachingPrompts(calls),
  };
}

/**
 * A rep's own trend, by week.
 *
 * Weeks rather than days because a rep does not make enough calls in a day for a
 * median to mean anything, and a chart that jumps between 20% and 80% because
 * Tuesday had two calls teaches nobody anything. Empty weeks are omitted rather
 * than zero-filled: a week with no calls is not a week where the rep talked 0%.
 */
export function repTrend(calls: readonly AnalysedCall[]): RepTrendPoint[] {
  const byWeek = new Map<number, AnalysedCall[]>();
  for (const call of calls) {
    const key = startOfIsoWeek(call.occurredAt).getTime();
    byWeek.set(key, [...(byWeek.get(key) ?? []), call]);
  }

  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekStart, week]) => ({
      weekStart: new Date(weekStart),
      calls: week.length,
      medianTalkRatioBps: median(week.map((call) => call.talkRatioBps)),
      medianQuestionShareBps: median(week.map((call) => call.questionShareBps)),
      nextStepRateBps: shareBps(week.filter((call) => call.nextStepCommitted).length, week.length),
      unansweredObjections: week.reduce(
        (total, call) => total + call.objections.filter(isUnanswered).length,
        0,
      ),
    }));
}

/**
 * The prompts, for a team or for one person.
 *
 * The same function serves both surfaces on purpose. A rep who is told one thing
 * about their calls and a manager who is told another about the same calls will
 * find out, and the tool loses the only thing it had.
 */
export function coachingPrompts(calls: readonly AnalysedCall[]): CoachingPrompt[] {
  const prompts: CoachingPrompt[] = [];

  const talking = calls.filter(
    (call) => call.talkRatioBps !== null && call.talkRatioBps > COACHING_BANDS.talkRatioCeilingBps,
  );
  if (talking.length > 0)
    prompts.push(
      promptFor(
        "talking-more-than-listening",
        `${describe(talking.length, calls.length)} the seller did more than ${pct(COACHING_BANDS.talkRatioCeilingBps)} of the talking. The next one is worth trying with a question where the explanation would have gone.`,
        talking,
      ),
    );

  const quiet = calls.filter(
    (call) =>
      call.questionShareBps !== null &&
      call.questionShareBps < COACHING_BANDS.questionShareFloorBps,
  );
  if (quiet.length > 0)
    prompts.push(
      promptFor(
        "asking-too-few-questions",
        `${describe(quiet.length, calls.length)} fewer than ${pct(COACHING_BANDS.questionShareFloorBps)} of the seller's turns asked anything. Calls that discover a problem tend to ask about it.`,
        quiet,
      ),
    );

  const unanswered = calls.filter((call) => call.objections.some(isUnanswered));
  if (unanswered.length > 0)
    prompts.push(
      promptFor(
        "objections-left-unanswered",
        `${describe(unanswered.length, calls.length)} the customer raised something nobody answered. An objection that goes unanswered on the call is usually the reason given for the loss.`,
        unanswered,
      ),
    );

  const noNextStep = calls.filter((call) => !call.nextStepCommitted);
  if (
    calls.length > 0 &&
    shareBps(calls.length - noNextStep.length, calls.length) <
      COACHING_BANDS.nextStepRateFloorBps
  )
    prompts.push(
      promptFor(
        "calls-ending-without-a-next-step",
        `${describe(noNextStep.length, calls.length)} the call ended without anybody committing to a next step. "Let's stay in touch" is where a pipeline goes to look healthy.`,
        noNextStep,
      ),
    );

  return prompts;
}

function promptFor(
  kind: CoachingPromptKind,
  prompt: string,
  affected: readonly AnalysedCall[],
): CoachingPrompt {
  return {
    kind,
    prompt,
    callsAffected: affected.length,
    repsAffected: new Set(affected.flatMap((call) => (call.repUserId ? [call.repUserId] : [])))
      .size,
  };
}

function isUnanswered(objection: CallObjection): boolean {
  return objection.handling === "unanswered";
}

function objectionsByTheme(calls: readonly AnalysedCall[]): ObjectionThemeCount[] {
  const all = calls.flatMap((call) => call.objections);
  return OBJECTION_THEMES.map((theme) => ({
    theme,
    raised: all.filter((objection) => objection.theme === theme).length,
    unanswered: all.filter((objection) => objection.theme === theme && isUnanswered(objection))
      .length,
  })).filter((row) => row.raised > 0);
}

/**
 * How many calls each competitor came up on, commonest first.
 *
 * Calls rather than mentions: a customer who says a competitor's name eleven
 * times in one call is one competitive situation, and counting the utterances
 * would make a single angry call look like a market shift.
 */
function competitorMentions(calls: readonly AnalysedCall[]): CompetitorMentionCount[] {
  const counts = new Map<string, number>();
  for (const call of calls)
    for (const key of new Set(call.competitorKeys))
      counts.set(key, (counts.get(key) ?? 0) + 1);

  return [...counts.entries()]
    .map(([competitorKey, count]) => ({ competitorKey, calls: count }))
    .sort((a, b) => b.calls - a.calls || a.competitorKey.localeCompare(b.competitorKey));
}

/**
 * The median, over the values that exist.
 *
 * Nulls are dropped rather than treated as zero, because null here means "the
 * transcript did not say who was speaking" and a zero would report every
 * undiarised call as a rep who said nothing. All-null returns null, which is the
 * honest answer and the one the surfaces render as "not available".
 *
 * A median rather than a mean because one forty-minute demo where the rep
 * presented throughout moves a mean across a whole team and moves a median not
 * at all — and the team did not change.
 */
export function median(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (present.length === 0) return null;

  const middle = Math.floor(present.length / 2);
  return present.length % 2 === 1
    ? present[middle]!
    : Math.round((present[middle - 1]! + present[middle]!) / 2);
}

function shareBps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * BPS);
}

function pct(bps: number): string {
  return `${Math.round(bps / 100)}%`;
}

function describe(affected: number, total: number): string {
  return `On ${affected} of ${total} analysed calls,`;
}

/** The Monday at UTC midnight of the week a moment falls in. */
export function startOfIsoWeek(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // `getUTCDay` is Sunday-zero; ISO weeks start on Monday.
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return day;
}
