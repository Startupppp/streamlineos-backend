import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte } from "drizzle-orm";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  callAnalyses,
  type CallObjection,
  type CompetitorMention,
} from "../../db/schema/crm/call-analysis";
import { CALL_ANALYSIS_ANALYZER_VERSION } from "./call-analysis.contract";
import {
  callAnalysisVisibility,
  type CallAnalysisVisibility,
} from "./call-analysis-visibility";
import { CallAnalysisVisibilityService } from "./call-analysis-visibility.service";
import { CallRecordingConsentService } from "./call-recording-consent.service";

/**
 * Every call in a window that this person is allowed to have counted, and
 * nothing else.
 *
 * This file exists because of a sentence in `call-analysis-visibility.ts`: a
 * visibility rule buried in a query builder is a rule that holds for exactly the
 * query it was written in. When that was written the module had one aggregate —
 * the coaching digest — and it applied the rule by hand. CRM-P2-05 and P2-06 add
 * two more, and three hand-written copies of "read the window, resolve the rep,
 * resolve the release, resolve consent, then decide" is the arrangement where
 * the fourth one forgets a clause and nothing raises, because a wrong aggregate
 * looks exactly like a right one.
 *
 * So the assembly is here, once, and every aggregate over `crm_call_analyses`
 * takes its rows from this service. The invariant it buys is worth stating
 * plainly, because it is the whole safety argument for the per-rep surface:
 *
 *   **An aggregate may only be computed from calls the viewer could have opened
 *   one at a time.**
 *
 * That is what makes a group-by safe. A rep who does not hold
 * `crm:call-analysis:view-team` gets back their own calls and the unattributed
 * ones and literally nothing else, so grouping by rep cannot produce a row for a
 * colleague — not because the grouping code is careful, but because the rows for
 * that colleague never arrived. A manager who does hold it gets other people's
 * calls only once released or once the private window has elapsed, which is the
 * same answer `GET /crm/calls/:activityId/analysis` would give them for each one
 * individually.
 *
 * Three exclusions, kept distinct rather than collapsed into one "dropped"
 * count, because a caller has to be able to say a different sentence about each:
 *
 *   - **Not a live call.** The analysis row outlives the timeline entry on
 *     purpose (`activity_id` is deliberately not a foreign key), so an analysis
 *     can survive a delete. Those are dropped and not counted anywhere: nothing
 *     is being withheld, the call is gone.
 *   - **Consent-refused.** Counted as `consentBlocked`. A call nobody may ever
 *     have processed. Reporting it as embargoed would promise a disclosure that
 *     is never going to arrive.
 *   - **Embargoed.** Present in `calls` with `visibility.visible === false`, so
 *     a caller can count them and say "and four more open later". The row's
 *     metrics are still on the object, which is safe only because no caller is
 *     permitted to read them — see the note on `CohortCall` below.
 *
 * The cost is stated rather than hidden, exactly as the coaching digest states
 * it: this reads rows and decides in process, so it is capped and reports its
 * own truncation. A SQL-side version would be faster and would be a fourth copy
 * of the rule.
 */

/**
 * The largest window any of these surfaces reads.
 *
 * Matched to the DTO caps rather than chosen here, and clamped in the service
 * as well as at the route, because a digest email or a workflow step will one
 * day call this with a number nobody validated. An unclamped `NaN` makes `since`
 * an Invalid Date, which silently matches nothing on some drivers — an empty
 * page that reads as a quiet quarter.
 */
export const COHORT_MAX_SINCE_DAYS = 90;

/**
 * One analysed call, with the decision about whether this viewer may see it.
 *
 * The metrics are on the object even for a row whose `visibility.visible` is
 * false, and that is a deliberate and slightly uncomfortable choice. Filtering
 * inside this service would make the type safe by construction, but it would
 * also destroy the embargoed count — a caller cannot report "and four more open
 * later" about rows it was never handed. The rule every consumer follows, and
 * which the specs beside them assert, is that nothing but `visible === true`
 * rows may reach an arithmetic operation or a response body.
 */
export interface CohortCall {
  readonly activityId: string;
  /** `activities.actor_user_id` when `actor_kind = 'human'`, else null. */
  readonly repUserId: string | null;
  /** When the analysis was produced. The private window runs from here. */
  readonly analysedAt: Date;
  /** When the call happened. Null only if the activity read returned nothing. */
  readonly occurredAt: Date | null;
  readonly talkRatioBps: number | null;
  readonly repTurnCount: number | null;
  readonly repQuestionCount: number | null;
  readonly objections: readonly CallObjection[];
  readonly competitorMentions: readonly CompetitorMention[];
  readonly nextStepCommitted: boolean;
  readonly visibility: CallAnalysisVisibility;
}

export interface CallAnalysisCohort {
  /** The clamped period actually read, which may not be the one asked for. */
  readonly sinceDays: number;
  /** The lower bound on `analysed_at`, not on when the calls happened. */
  readonly since: Date;
  /**
   * The instant `since` was measured back from, so `until - since` is exactly
   * `sinceDays` days. A caller that reads the clock again for the upper bound
   * gets a window a few milliseconds longer than the period it is labelling.
   */
  readonly until: Date;
  /** True when the window held more analyses than `maxRows`. */
  readonly truncated: boolean;
  /** Whether this viewer holds `crm:call-analysis:view-team`. */
  readonly canReadTeam: boolean;
  /** Live, consented calls in the window, each with its visibility decision. */
  readonly calls: readonly CohortCall[];
  /** Calls the consent rule refuses. Never in `calls`, and never countable. */
  readonly consentBlocked: number;
}

export interface CohortRequest {
  readonly sinceDays: number;
  readonly maxRows: number;
}

@Injectable()
export class CallAnalysisCohortService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly visibility: CallAnalysisVisibilityService,
    private readonly consent: CallRecordingConsentService,
  ) {}

  async read(user: CurrentUserContext, request: CohortRequest): Promise<CallAnalysisCohort> {
    const sinceDays = clampDays(request.sinceDays);
    /**
     * One clock read, reported alongside `since`.
     *
     * The window is `[since, until]` and callers need both ends of it. The
     * aggregate route used to take `since` from here and read the clock again
     * for the other end, so the two were a few milliseconds apart and the span
     * was `sinceDays` days *plus that gap* — which `trendBuckets`, counting
     * backwards in whole buckets, closed with an extra bucket a few
     * milliseconds wide. A seven-day trend came back with eight points, the
     * first of them always empty, under a `bucket: "day"` label.
     */
    const asOf = Date.now();
    const until = new Date(asOf);
    const since = new Date(asOf - sinceDays * 24 * 60 * 60 * 1000);
    const maxRows = Math.max(1, Math.trunc(request.maxRows));

    /**
     * Windowed on when the analysis was produced, not on when the call
     * happened, and the choice matters enough to repeat here. The private window
     * runs from `analysed_at`, so a period defined by `occurred_at` would contain
     * calls whose window has not started — a back-filled import of last month's
     * recordings would land a hundred embargoed analyses in a period a manager
     * considers closed, and every surface built on this would read as broken.
     *
     * Pinned to the current analyser version so a bump does not double-count a
     * transcript that has been judged twice.
     */
    const rows = await this.db
      .select({
        activityId: callAnalyses.activityId,
        analysedAt: callAnalyses.createdAt,
        talkRatioBps: callAnalyses.talkRatioBps,
        repTurnCount: callAnalyses.repTurnCount,
        repQuestionCount: callAnalyses.repQuestionCount,
        objections: callAnalyses.objections,
        competitorMentions: callAnalyses.competitorMentions,
        nextStepCommitted: callAnalyses.nextStepCommitted,
      })
      .from(callAnalyses)
      .where(
        and(
          eq(callAnalyses.organizationId, user.orgId),
          eq(callAnalyses.analyzerVersion, CALL_ANALYSIS_ANALYZER_VERSION),
          gte(callAnalyses.createdAt, since),
        ),
      )
      .orderBy(desc(callAnalyses.createdAt))
      .limit(maxRows + 1);

    const truncated = rows.length > maxRows;
    const page = truncated ? rows.slice(0, maxRows) : rows;
    const activityIds = page.map((row) => row.activityId);

    const viewer = await this.visibility.viewer(user);
    const [subjects, consented] = await Promise.all([
      this.visibility.subjectsFor(user.orgId, activityIds, CALL_ANALYSIS_ANALYZER_VERSION),
      this.consent.decideMany(user.orgId, activityIds),
    ]);

    const now = new Date();
    const calls: CohortCall[] = [];
    let consentBlocked = 0;

    for (const row of page) {
      const subject = subjects.get(row.activityId);
      // No live call behind the analysis. The per-call route refuses these too,
      // so counting them would put a call nobody can open into numbers somebody
      // is being asked to act on.
      if (!subject) continue;

      /**
       * A missing entry is treated as a refusal rather than as permission.
       * `decideMany` only returns live `call` activities, so an absence here
       * means the same thing the branch above caught — but reading it as a quiet
       * yes is the failure mode this rule exists to make impossible.
       */
      if (!consented.get(row.activityId)?.verdict.allowed) {
        consentBlocked += 1;
        continue;
      }

      calls.push({
        activityId: row.activityId,
        repUserId: subject.repUserId,
        analysedAt: row.analysedAt,
        occurredAt: subject.occurredAt,
        talkRatioBps: row.talkRatioBps,
        repTurnCount: row.repTurnCount,
        repQuestionCount: row.repQuestionCount,
        objections: row.objections ?? [],
        competitorMentions: row.competitorMentions ?? [],
        nextStepCommitted: row.nextStepCommitted,
        visibility: callAnalysisVisibility(
          viewer,
          {
            repUserId: subject.repUserId,
            analysedAt: row.analysedAt,
            analyzerVersion: CALL_ANALYSIS_ANALYZER_VERSION,
            release: subject.release,
          },
          now,
        ),
      });
    }

    return {
      sinceDays,
      since,
      until,
      truncated,
      canReadTeam: viewer.canReadTeam,
      calls,
      consentBlocked,
    };
  }
}

/**
 * The period, clamped rather than rejected.
 *
 * A service method is not a route and has no 400 to return; the alternative to
 * clamping is a thrown error on a background path nobody is watching, or an
 * Invalid Date that quietly reads nothing.
 */
function clampDays(sinceDays: number): number {
  if (!Number.isFinite(sinceDays)) return 30;
  return Math.min(Math.max(Math.trunc(sinceDays), 1), COHORT_MAX_SINCE_DAYS);
}
