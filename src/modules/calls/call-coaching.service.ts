import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte } from "drizzle-orm";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { callAnalyses } from "../../db/schema/crm/call-analysis";
import { CALL_ANALYSIS_ANALYZER_VERSION } from "./call-analysis.contract";
import { callAnalysisVisibility } from "./call-analysis-visibility";
import { CallAnalysisVisibilityService } from "./call-analysis-visibility.service";
import { CallRecordingConsentService } from "./call-recording-consent.service";
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
 * The cost of that is real and stated rather than hidden: the digest reads rows
 * and decides in process, which is why it is capped at `COACHING_MAX_ROWS` and
 * why the response says when it truncated. A SQL-side version of this rule would
 * be faster and would be a second copy of the rule.
 *
 * The consent rule is applied the same way and for the same reason. Phase 5
 * ticket 03 stops a call in a two-party jurisdiction from being analysed at all,
 * so in the ordinary case there is no row here to filter — but rows written
 * before that rule shipped are still in the table, and so is any call whose
 * counterparty has withdrawn consent since. An aggregate that counted those
 * would be the ticket's failure arriving through the back door: the numbers a
 * manager quotes would be built partly from conversations the organisation is
 * not allowed to have processed. `decideMany` is the batched form, so this costs
 * three queries for the whole page rather than three per call.
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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly visibility: CallAnalysisVisibilityService,
    private readonly consent: CallRecordingConsentService,
  ) {}

  async digest(user: CurrentUserContext, sinceDays: number): Promise<CoachingDigestResult> {
    /**
     * Clamped here as well as in the DTO, because this is a service method and
     * the route is not the only way in — a digest email or a workflow step will
     * call it with a number nobody validated. An unclamped `NaN` makes `since`
     * an Invalid Date, which Postgres rejects on some drivers and which silently
     * matches nothing on others: an empty digest that looks like a quiet week.
     */
    const days = Number.isFinite(sinceDays) ? Math.min(Math.max(Math.trunc(sinceDays), 1), 90) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    /**
     * Windowed on when the analysis was produced, not on when the call
     * happened, and the choice matters. The private window runs from
     * `analysed_at`, so a period defined by `occurred_at` would contain calls
     * whose window has not started — a back-filled import of last month's
     * recordings would land a hundred analyses in a period a manager considers
     * closed, every one of them embargoed, and the digest would read as broken.
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
      .limit(COACHING_MAX_ROWS + 1);

    const truncated = rows.length > COACHING_MAX_ROWS;
    const page = truncated ? rows.slice(0, COACHING_MAX_ROWS) : rows;

    const viewer = await this.visibility.viewer(user);
    const subjects = await this.visibility.subjectsFor(
      user.orgId,
      page.map((row) => row.activityId),
      CALL_ANALYSIS_ANALYZER_VERSION,
    );

    const consented = await this.consent.decideMany(
      user.orgId,
      page.map((row) => row.activityId),
    );

    const now = new Date();
    const candidates: CoachingCandidate[] = [];

    for (const row of page) {
      const subject = subjects.get(row.activityId);
      /**
       * No call behind the analysis — deleted from the timeline, or filed as
       * something other than a call. The per-call route already refuses to serve
       * these (`CallAnalysisService.find` requires a live activity), so counting
       * them here would put a call a manager cannot open into the numbers they
       * are being asked to act on. Dropped, not counted as embargoed: it is not
       * being withheld, it is gone.
       */
      if (!subject) continue;

      /**
       * Dropped, not counted as embargoed. An embargoed call is one a manager
       * will be able to read tomorrow; a consent-refused one is a call nobody
       * may ever read, and reporting it in the embargoed count would promise a
       * disclosure that is never going to arrive. Missing from the map means the
       * call is not a live `call` activity, which the branch above already
       * dropped, so a missing entry here is treated as a refusal rather than as
       * permission.
       */
      if (!consented.get(row.activityId)?.verdict.allowed) continue;

      candidates.push({
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
        analysis: {
          talkRatioBps: row.talkRatioBps,
          repTurnCount: row.repTurnCount,
          repQuestionCount: row.repQuestionCount,
          /**
           * Reduced here, at the boundary, rather than inside the digest. The
           * quotes are the most sensitive text in the CRM and the aggregate has
           * no use for them; dropping them before they cross into
           * `coachingDigest` makes "no verbatim customer speech reaches the
           * manager surface" a property of the types rather than a discipline
           * somebody has to keep remembering.
           */
          objectionHandlings: (row.objections ?? []).map((objection) => objection.handling),
          competitorsNamed: (row.competitorMentions ?? []).map((mention) => mention.name),
          nextStepCommitted: row.nextStepCommitted,
        },
      });
    }

    return {
      sinceDays: days,
      since,
      truncated,
      digest: coachingDigest(candidates),
    };
  }
}
