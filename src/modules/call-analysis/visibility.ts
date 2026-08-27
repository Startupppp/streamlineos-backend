import { COACHING_PROMPT_KINDS, type CoachingPromptKind, type TeamCoachingView } from "./coaching";

/**
 * What a manager can see, said to the rep in plain words.
 *
 * Ticket 02's third criterion. It is a `Record` over the manager view's own keys
 * rather than a list of sentences, and that is the whole mechanism: adding a
 * field to `TeamCoachingView` stops this file compiling until somebody has
 * written the sentence that tells a rep the field exists. A disclosure kept in
 * step by a reviewer's memory is a disclosure that is true on the day it is
 * written and slowly stops being true afterwards — which is worse than none,
 * because the rep has been told it is complete.
 *
 * The sentences are addressed to the rep and written in the second person on
 * purpose. A person reading "aggregate metrics are exposed to users holding
 * crm:call-analysis:view-team" has not been told anything.
 */
export const MANAGER_VISIBILITY: Record<keyof TeamCoachingView, string> = {
  callsAnalysed: "How many calls across the team were analysed in the period. Not which.",
  repsWithCalls: "How many people on the team made calls in the period. Not who.",
  medianTalkRatioBps:
    "The team's middle value for how much of a call the seller spoke for. Yours is part of it; it is not shown as yours.",
  medianQuestionShareBps:
    "The team's middle value for how often the seller asked something rather than told. Same again — pooled, never attributed.",
  nextStepRateBps:
    "What share of the team's calls ended with somebody committing to a next step.",
  objectionsByTheme:
    "What customers pushed back on across the team, counted by theme, and how often nobody answered. Your calls are in the counts; your name and the calls themselves are not.",
  competitorMentions:
    "Which competitors came up, and on how many calls across the team. Not on whose.",
  prompts:
    "The same coaching prompts you see below, stated for the team — each one says how many calls and how many people it applies to, and never which.",
};

/**
 * And what a manager cannot see, which is the half a rep actually worries about.
 *
 * Stated as its own list rather than left implicit in the absence of the fields
 * above, because "we did not mention it" is not a promise. Each line here is
 * checked against the manager view's type by `visibility.spec.ts` — a field that
 * appeared on that view would make one of these sentences a lie, and the test is
 * what stops it becoming one quietly.
 */
export const MANAGER_CANNOT_SEE: readonly string[] = [
  "Any individual call of yours — not its transcript, not its analysis, not that it happened.",
  "Your own talk ratio, question rate, objection count or next-step rate, as yours.",
  "Which of the coaching prompts above are about you.",
  "Any ranking of you against anyone else. There is no leaderboard, because there is no per-person number to build one from.",
] as const;

/** The prompts a rep may be shown about themselves — the same list the team view uses. */
export const DISCLOSED_PROMPT_KINDS: readonly CoachingPromptKind[] = COACHING_PROMPT_KINDS;

export interface VisibilityDisclosure {
  readonly managerCanSee: readonly string[];
  readonly managerCannotSee: readonly string[];
  /**
   * Said once, at the top, because the ordering is the reassurance: the rep's
   * own screen exists before the manager's does, and a tool that arrives the
   * other way round is one people stop putting calls into.
   */
  readonly summary: string;
}

export function visibilityDisclosure(): VisibilityDisclosure {
  return {
    summary:
      "You see your own calls here first. Your manager sees the team pooled together — totals, middle values and the same coaching prompts — and never an individual call or an individual person.",
    managerCanSee: Object.values(MANAGER_VISIBILITY),
    managerCannotSee: [...MANAGER_CANNOT_SEE],
  };
}
