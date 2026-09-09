import { Inject, Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { CallAnalysisCohortService } from "./call-analysis-cohort.service";
import {
  repCallAggregates,
  trendBucketFor,
  type RepCallAggregate,
  type TrendBucket,
} from "./call-rep-aggregates";
import { resolveRepNames } from "./call-rep-names";

/**
 * CRM-P2-05, assembled: one rep's calls summarised, for every rep this reader is
 * allowed to have summarised.
 *
 * The whole safety argument is one line of this file — `this.cohort.read(user,
 * …)` — and it is worth saying why that is enough rather than leaving it to be
 * inferred. `CallAnalysisCohortService` returns only calls that survive the same
 * two rules the per-call route applies: the consent gate, and
 * `callAnalysisVisibility` decided for *this* viewer. So the group-by below
 * operates on a set that already contains nothing the reader could not have
 * opened individually. A rep who holds `crm:call-analysis:view` and not
 * `crm:call-analysis:view-team` receives their own calls and the unattributed
 * ones; grouping those by rep produces exactly one named row, theirs, and there
 * is no filter in this file responsible for that. The alternative design — read
 * everything, group in SQL, then subtract what the viewer may not see — is the
 * one that leaks, because the subtraction is a step somebody has to remember and
 * the aggregate is already computed by the time they would.
 *
 * `scope` is in the response so a client can say which surface this is. A rep
 * looking at one row should be told it is their own numbers rather than left to
 * wonder where their team went; a manager should know the rows are the people
 * whose calls have opened, not the whole team. Deriving it from
 * `cohort.canReadTeam` rather than from the row count is what keeps that honest
 * when a manager's team has one person in it.
 *
 * Pagination is over reps, not over calls, and the aggregate is computed before
 * the page is cut. That is the correct order and the expensive one: a page of
 * ten reps still reads the window's calls. It is bounded by `AGGREGATE_MAX_ROWS`
 * and the truncation is reported, for the same reason the coaching digest
 * reports its own — a page labelled "last 90 days" that silently summarised the
 * most recent five hundred analyses would be wrong in a way nobody could see.
 */

/**
 * The most analyses one aggregate reads.
 *
 * The same five hundred the coaching digest uses, and the same bound on the
 * memory a single request can take, deliberately not tuned separately: the two
 * surfaces read the same rows over the same window, and a per-rep page that
 * truncated at a different point from the digest beside it would show two
 * different totals for one period with nothing to explain the gap.
 */
export const AGGREGATE_MAX_ROWS = 500;

export interface RepCallAggregateRow extends RepCallAggregate {
  /** Null when the rep has left the organisation. The client decides the label. */
  readonly repName: string | null;
}

export interface RepCallAggregatesResult {
  readonly rows: readonly RepCallAggregateRow[];
  readonly total: number;
  readonly sinceDays: number;
  readonly since: Date;
  readonly bucket: TrendBucket;
  readonly truncated: boolean;
  /** `team` when the reader holds `crm:call-analysis:view-team`, else `own`. */
  readonly scope: "own" | "team";
  readonly unattributed: number;
  readonly embargoed: number;
  /** Calls the consent rule refuses, and which therefore count towards nothing. */
  readonly consentBlocked: number;
}

export interface RepCallAggregatesQuery {
  readonly sinceDays: number;
  readonly page: number;
  readonly limit: number;
}

@Injectable()
export class CallRepAggregatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cohort: CallAnalysisCohortService,
  ) {}

  async aggregate(
    user: CurrentUserContext,
    query: RepCallAggregatesQuery,
  ): Promise<RepCallAggregatesResult> {
    const cohort = await this.cohort.read(user, {
      sinceDays: query.sinceDays,
      maxRows: AGGREGATE_MAX_ROWS,
    });

    const bucket = trendBucketFor(cohort.sinceDays);
    const aggregates = repCallAggregates(
      cohort.calls.map((call) => ({
        repUserId: call.repUserId,
        visibility: call.visibility,
        analysedAt: call.analysedAt,
        talkRatioBps: call.talkRatioBps,
        repTurnCount: call.repTurnCount,
        repQuestionCount: call.repQuestionCount,
        nextStepCommitted: call.nextStepCommitted,
      })),
      /**
       * `until` is the request's own instant and not the newest analysis in the
       * cohort. Anchoring on the data would make the last bucket end whenever
       * the team last made a call, so a quiet week would silently shift every
       * boundary and two requests a day apart would chart different periods.
       *
       * The cohort's instant rather than a fresh `new Date()`, because both
       * ends of the window have to come from one clock read: a second read is
       * milliseconds later, which makes the span `sinceDays` days plus a
       * fraction, and `trendBuckets` closes that fraction with a whole extra
       * bucket. A seven-day trend charted eight points, the first a few
       * milliseconds wide and permanently empty.
       */
      { since: cohort.since, until: cohort.until, bucket },
    );

    const page = Math.max(1, Math.trunc(query.page));
    const limit = Math.max(1, Math.trunc(query.limit));
    const window = aggregates.reps.slice((page - 1) * limit, page * limit);

    /**
     * Names resolved for the page only. Resolving them for every rep in the
     * window would read rows nobody is going to render, and on a large team that
     * is the difference between a two-column lookup and a directory dump.
     */
    const names = await resolveRepNames(
      this.db,
      user.orgId,
      window.map((rep) => rep.repUserId),
    );

    return {
      rows: window.map((rep) => ({ ...rep, repName: names.get(rep.repUserId) ?? null })),
      total: aggregates.reps.length,
      sinceDays: cohort.sinceDays,
      since: cohort.since,
      bucket,
      truncated: cohort.truncated,
      scope: cohort.canReadTeam ? "team" : "own",
      unattributed: aggregates.unattributed,
      embargoed: aggregates.embargoed,
      consentBlocked: cohort.consentBlocked,
    };
  }
}
