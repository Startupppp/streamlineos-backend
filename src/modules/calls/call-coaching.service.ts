import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CallAnalysisCohortService } from "./call-analysis-cohort.service";
import { coachingDigest, type CoachingCandidate, type CoachingDigest } from "./call-coaching";

/**
 * The manager's view of a team's calls, assembled under the same rule as the
 * per-call view.
 *
 * The temptation this file exists to refuse: a manager holds
 * `crm:call-analysis:view-team`, so an aggregate query over
 * `crm_call_analyses` would be one statement and would answer instantly. It
 * would also count every analysis still sitting in its rep's private window,
 * which is the ticket's failure mode arriving through the back door — the
 * numbers a manager quotes at somebody would include the call that person has
 * not read yet. So every row goes through `callAnalysisVisibility`, the same
 * function the per-call route uses, before anything is counted.
 *
 * That assembly used to live in this file. It now lives in
 * `CallAnalysisCohortService`, because CRM-P2-05 and P2-06 added two more
 * aggregates over the same table and three hand-written copies of "read the
 * window, resolve the rep, resolve the release, resolve consent, then decide" is
 * how the fourth one ends up missing a clause. Nothing about the digest's
 * semantics moved with it: the cohort is still consented live calls in the
 * window with their visibility decisions attached, `embargoed` is still the ones
 * this viewer may not read, and consent-refused calls are still dropped rather
 * than counted as embargoed — an embargoed call is one a manager will be able to
 * read tomorrow, and a consent-refused one is a call nobody may ever read.
 *
 * The cost of deciding in process is real and stated rather than hidden: the
 * digest reads rows and applies the rule per row, which is why it is capped at
 * `COACHING_MAX_ROWS` and why the response says when it truncated. A SQL-side
 * version of this rule would be faster and would be a second copy of the rule.
 */

/**
 * The most analyses one digest reads.
 *
 * Five hundred is roughly a ten-person team's quarter, and it bounds the memory
 * a single request can take. Truncation is reported rather than silently
 * changing what the percentages mean — a digest that quietly summarised the most
 * recent five hundred of nine hundred calls while labelling itself "last 90
 * days" would be wrong in a way nobody could see.
 */
export const COACHING_MAX_ROWS = 500;

export interface CoachingDigestResult {
  readonly sinceDays: number;
  /** The lower bound on `analysed_at`, not on when the calls happened. */
  readonly since: Date;
  readonly truncated: boolean;
  readonly digest: CoachingDigest;
}

@Injectable()
export class CallCoachingService {
  constructor(private readonly cohort: CallAnalysisCohortService) {}

  async digest(user: CurrentUserContext, sinceDays: number): Promise<CoachingDigestResult> {
    const cohort = await this.cohort.read(user, { sinceDays, maxRows: COACHING_MAX_ROWS });

    const candidates: CoachingCandidate[] = cohort.calls.map((call) => ({
      visibility: call.visibility,
      analysis: {
        talkRatioBps: call.talkRatioBps,
        repTurnCount: call.repTurnCount,
        repQuestionCount: call.repQuestionCount,
        /**
         * Reduced here, at the boundary, rather than inside the digest. The
         * quotes are the most sensitive text in the CRM and the aggregate has no
         * use for them; dropping them before they cross into `coachingDigest`
         * makes "no verbatim customer speech reaches the manager surface" a
         * property of the types rather than a discipline somebody has to keep
         * remembering.
         */
        objectionHandlings: call.objections.map((objection) => objection.handling),
        competitorsNamed: call.competitorMentions.map((mention) => mention.name),
        nextStepCommitted: call.nextStepCommitted,
      },
    }));

    return {
      sinceDays: cohort.sinceDays,
      since: cohort.since,
      truncated: cohort.truncated,
      digest: coachingDigest(candidates),
    };
  }
}
