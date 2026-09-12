import { Inject, Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { CallAnalysisCohortService } from "./call-analysis-cohort.service";
import {
  selectCallExemplars,
  type CallExemplar,
  type ExemplarMetric,
} from "./call-exemplars";
import { resolveRepNames } from "./call-rep-names";

/**
 * CRM-P2-06, assembled: "show me a good example of this" answered without ever
 * offering a call that should not be offered.
 *
 * Two gates decide what can appear, and neither of them is implemented here.
 * That is the design rather than an accident of layering.
 *
 * **Consent.** A recording made without the agreement a jurisdiction requires
 * may not be processed at all, and holding one up as a model call is about the
 * worst possible thing to do with it — it is the version of the failure that
 * gets forwarded, listened to by six people, and quoted in a QBR.
 * `CallAnalysisCohortService` drops consent-refused calls before ranking sees
 * them, so there is no ordering, no metric and no tie-break that can promote
 * one. `call-exemplars.service.spec.ts` asserts it with the refused call
 * deliberately scoring highest, because a test where the excluded row would have
 * lost anyway proves nothing.
 *
 * **Visibility.** The same cohort applies `callAnalysisVisibility`, so a
 * colleague's call in its private window is not an exemplar either. This matters
 * more here than in an aggregate: an exemplar is a *link*, and a list that
 * surfaced an embargoed call would not merely include it in a number, it would
 * invite the reader to click through to a rep's first read of their own call
 * before that rep has had it.
 *
 * What comes back is a pointer and a measurement — never a quote, a next-step
 * sentence or an objection. The reader follows the link to the analysis route,
 * which applies the visibility rule again on its own terms. Putting the content
 * in the list would make this a second bulk read of `crm_call_analyses` with a
 * different gate on it, which is exactly the shape of hole this module keeps
 * closing.
 */

/**
 * The most analyses one exemplar search reads.
 *
 * The same window cap as the two aggregates beside it, for the same reason: the
 * three surfaces read one window over one table, and a search that considered a
 * different number of calls from the summary above it would recommend calls the
 * summary says do not exist. Truncation is reported so a short list can be
 * explained rather than guessed at.
 */
export const EXEMPLAR_MAX_ROWS = 500;

export interface CallExemplarRow extends CallExemplar {
  /** Null for an unattributed call, and for a rep who has left. */
  readonly repName: string | null;
}

export interface CallExemplarsResult {
  readonly rows: readonly CallExemplarRow[];
  readonly total: number;
  readonly metric: ExemplarMetric;
  readonly sinceDays: number;
  readonly since: Date;
  readonly truncated: boolean;
  readonly scope: "own" | "team";
  /** Visible, consented calls this metric could not be measured on. */
  readonly ineligible: number;
  /** Calls in the window this reader may not read yet. */
  readonly embargoed: number;
  /** Calls the consent rule refuses. Never rankable, at any score. */
  readonly consentBlocked: number;
}

export interface CallExemplarsQuery {
  readonly metric: ExemplarMetric;
  readonly sinceDays: number;
  readonly page: number;
  readonly limit: number;
}

@Injectable()
export class CallExemplarsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cohort: CallAnalysisCohortService,
  ) {}

  async search(
    user: CurrentUserContext,
    query: CallExemplarsQuery,
  ): Promise<CallExemplarsResult> {
    const cohort = await this.cohort.read(user, {
      sinceDays: query.sinceDays,
      maxRows: EXEMPLAR_MAX_ROWS,
    });

    /**
     * Filtered to visible here rather than inside the ranker, so that
     * `ineligible` keeps meaning "measured nothing on this metric" instead of
     * quietly absorbing "you are not allowed to see it". Two very different
     * facts about a short list, and a reader acts differently on each.
     */
    const visible = cohort.calls.filter((call) => call.visibility.visible);
    /**
     * Only `rep-window` counts. A colleague's call seen by somebody who does not
     * hold `crm:call-analysis:view-team` is not in scope at all, and reporting
     * those would tell a rep how many calls the rest of the team made — a fact
     * about other people, delivered as a total.
     */
    const embargoed = cohort.calls.filter(
      (call) => !call.visibility.visible && call.visibility.reason === "rep-window",
    ).length;

    const selection = selectCallExemplars(
      visible.map((call) => ({
        activityId: call.activityId,
        repUserId: call.repUserId,
        occurredAt: call.occurredAt,
        analysedAt: call.analysedAt,
        talkRatioBps: call.talkRatioBps,
        repTurnCount: call.repTurnCount,
        repQuestionCount: call.repQuestionCount,
        nextStepCommitted: call.nextStepCommitted,
      })),
      query.metric,
    );

    const page = Math.max(1, Math.trunc(query.page));
    const limit = Math.max(1, Math.trunc(query.limit));
    const window = selection.exemplars.slice((page - 1) * limit, page * limit);

    const names = await resolveRepNames(
      this.db,
      user.orgId,
      window.map((row) => row.repUserId).filter((id): id is string => id !== null),
    );

    return {
      rows: window.map((row) => ({
        ...row,
        repName: row.repUserId === null ? null : (names.get(row.repUserId) ?? null),
      })),
      total: selection.exemplars.length,
      metric: query.metric,
      sinceDays: cohort.sinceDays,
      since: cohort.since,
      truncated: cohort.truncated,
      scope: cohort.canReadTeam ? "team" : "own",
      ineligible: selection.ineligible,
      embargoed,
      consentBlocked: cohort.consentBlocked,
    };
  }
}
