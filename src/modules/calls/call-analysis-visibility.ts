/**
 * Who may read one rep's call analysis, and when.
 *
 * This is the ticket, expressed as a function rather than as a condition inside
 * a service, and the separation is the point. A visibility rule buried in a
 * query builder is a rule that holds for exactly the query it was written in:
 * the next surface that reads `crm_call_analyses` — a deal health panel, an
 * export, a digest email — reimplements it from memory or forgets it, and the
 * failure is silent because the wrong answer looks like data. Here it is one
 * pure function with no database, no Nest and no clock of its own, so every
 * reader calls the same rule and the spec beside it can enumerate the cases.
 *
 * The rule:
 *
 *   1. The rep who was on the call can always read their own analysis. No
 *      window, no permission subtleties, no exception for a bad quarter.
 *   2. Anybody else needs `crm:call-analysis:view-team`.
 *   3. A holder of that key reads it once the rep has released it, or once the
 *      rep has had it to themselves for `CALL_ANALYSIS_PRIVATE_WINDOW_HOURS`.
 *
 * Why the window exists at all, since it always elapses: a coaching tool that
 * arrives in a manager's inbox before the rep has seen it is a surveillance
 * report, and people work around surveillance — they stop recording calls, or
 * they stop having the hard ones. The window buys the rep the first read, which
 * is the difference between "here is what the model heard, come talk to me" and
 * "your talk ratio was 82%". It is not confidentiality; a manager gets there in
 * a day either way, and nothing here pretends otherwise.
 *
 * The org owner is not exempt. `AccessService.scopeFor` hands an owner `"all"`
 * on every key, so an owner arrives here with `canReadTeam: true` and waits like
 * any other manager. An owner bypass would make the whole rule advisory — the
 * one person most likely to be asked to "just check" is the one person the rule
 * has to bind for a rep to believe in it.
 */

/**
 * How long the rep has the analysis to themselves.
 *
 * Twenty-four hours rather than an hour or a week. An hour does not survive a
 * call that ends at 5pm; a week makes the manager surface useless for coaching a
 * deal that is still moving. A day means a rep who runs their calls in the
 * morning reads yesterday's before their manager does, which is the behaviour
 * the rule is actually buying.
 *
 * Stated as a constant and reported to the caller in the response, because "you
 * cannot see this yet" without a time is indistinguishable from a bug.
 */
export const CALL_ANALYSIS_PRIVATE_WINDOW_HOURS = 24;
const WINDOW_MS = CALL_ANALYSIS_PRIVATE_WINDOW_HOURS * 60 * 60 * 1000;

/** The release recorded for this call, if the rep made one. */
export interface CallAnalysisRelease {
  /** The analyser whose output was released. Consent does not carry forward. */
  readonly analyzerVersion: number;
  readonly releasedAt: Date;
}

/**
 * The facts about the call and its analysis that the rule needs.
 *
 * `repUserId` is `activities.actor_user_id` when `actor_kind = 'human'`, and
 * null otherwise. Null is a real and common case, not a defect: the ingress
 * workflow writes every adapter-delivered call with `actor_kind: 'system'` and
 * no user, so a call that arrived from a carrier has nobody attributed to it.
 * See `noRepToProtect` below for what the rule does with that, and why.
 */
export interface CallAnalysisSubject {
  readonly repUserId: string | null;
  /** When the analysis first existed, i.e. when the rep could first read it. */
  readonly analysedAt: Date;
  /** The analyser version of the row being read. */
  readonly analyzerVersion: number;
  readonly release: CallAnalysisRelease | null;
}

export interface CallAnalysisViewer {
  readonly userId: string;
  /** Holds `crm:call-analysis:view-team`. Resolved by the caller, not here. */
  readonly canReadTeam: boolean;
}

export type CallAnalysisVisibility =
  | {
      readonly visible: true;
      /**
       * `own-call` — the viewer was on it.
       * `released` — the rep shared it early.
       * `window-elapsed` — the rep's day has passed.
       * `unattributed` — no rep is recorded, so there is nobody to protect.
       */
      readonly reason: "own-call" | "released" | "window-elapsed" | "unattributed";
      readonly opensAt: null;
    }
  | {
      readonly visible: false;
      /**
       * `rep-window` — it exists, it is not yours yet, and `opensAt` says when.
       * `not-your-call` — the viewer has no claim on another person's call.
       */
      readonly reason: "rep-window";
      readonly opensAt: Date;
    }
  | {
      readonly visible: false;
      readonly reason: "not-your-call";
      readonly opensAt: null;
    };

/** When the rep's private window ends. Pure, so a UI and a spec agree on it. */
export function callAnalysisOpensAt(analysedAt: Date): Date {
  return new Date(analysedAt.getTime() + WINDOW_MS);
}

/**
 * Whether this viewer may read this analysis right now.
 *
 * `now` is a parameter rather than a `Date.now()` inside, so the boundary can be
 * asserted at the millisecond instead of tested with a sleep.
 */
export function callAnalysisVisibility(
  viewer: CallAnalysisViewer,
  subject: CallAnalysisSubject,
  now: Date,
): CallAnalysisVisibility {
  /**
   * The rep first, before the permission check, and the order is load-bearing.
   *
   * A rep who is also somebody's manager holds `view-team`; a rep who was moved
   * off the CRM admin rung this morning does not. If the team key were consulted
   * first, the answer to "may I read my own call" would change when somebody
   * edited a role, which is exactly the property the rule promises it does not
   * have.
   */
  if (subject.repUserId !== null && subject.repUserId === viewer.userId) {
    return { visible: true, reason: "own-call", opensAt: null };
  }

  /**
   * A call nobody is attributed to is not protected, and saying so plainly is
   * better than a rule that looks stricter than it is.
   *
   * The embargo protects a named person's first read. With no name there is no
   * beneficiary — and worse, the person who was actually on that call holds
   * `crm:call-analysis:view` and not `view-team`, so an embargo would lock the
   * rep out of their own call permanently while the rest of the branch above
   * never fires for them. An outage is not a privacy control. The honest
   * consequence, stated in the ticket report rather than hidden here: calls
   * delivered by an adapter carry no rep and get no window.
   */
  if (subject.repUserId === null) {
    return { visible: true, reason: "unattributed", opensAt: null };
  }

  if (!viewer.canReadTeam) {
    /**
     * No `opensAt`. Somebody with no claim on this call must not learn when it
     * opens for people who do have one — that is a fact about a colleague's
     * work, and handing it out would turn a 403 into a timing oracle over who
     * analysed what.
     */
    return { visible: false, reason: "not-your-call", opensAt: null };
  }

  /**
   * A release covers the analyser it was made against and no other. Consent to
   * one judgement of a call is not consent to the next one; see the schema.
   */
  if (
    subject.release !== null &&
    subject.release.analyzerVersion === subject.analyzerVersion &&
    subject.release.releasedAt.getTime() <= now.getTime()
  ) {
    return { visible: true, reason: "released", opensAt: null };
  }

  const opensAt = callAnalysisOpensAt(subject.analysedAt);
  // `>=` rather than `>`: the window is closed for exactly its stated length and
  // opens on the tick. A strict comparison would leave a one-millisecond state
  // that no clock in the system can distinguish from either neighbour.
  if (now.getTime() >= opensAt.getTime()) {
    return { visible: true, reason: "window-elapsed", opensAt: null };
  }

  return { visible: false, reason: "rep-window", opensAt };
}

/**
 * Whether this viewer may release this call — a question with one answer.
 *
 * Only the rep who was on the call. Not a manager "on their behalf", not an org
 * owner: a release is the one thing in this design that is the rep's alone, and
 * an admin override would mean the window is a delay a manager can skip, which
 * is the same as not having one. An unattributed call has no rep, so nobody can
 * release it; it opens on its own terms under the rule above.
 */
export function canReleaseCallAnalysis(
  viewer: CallAnalysisViewer,
  subject: Pick<CallAnalysisSubject, "repUserId">,
): boolean {
  return subject.repUserId !== null && subject.repUserId === viewer.userId;
}
