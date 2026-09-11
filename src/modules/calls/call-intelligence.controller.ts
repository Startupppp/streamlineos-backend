import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CALL_ANALYSIS_PRIVATE_WINDOW_HOURS } from "./call-analysis-visibility";
import {
  EXEMPLAR_MIN_REP_TURNS,
  EXEMPLAR_TALK_RATIO_TARGET_BPS,
} from "./call-exemplars";
import { CallExemplarsService } from "./call-exemplars.service";
import { CallRepAggregatesService } from "./call-rep-aggregates.service";
import {
  callExemplarsQuerySchema,
  repCallAggregatesQuerySchema,
  type CallExemplarsQueryDto,
  type RepCallAggregatesQueryDto,
} from "./dto/call-intelligence.schemas";

/**
 * The two rep-facing reads over a window of analysed calls: my numbers, and a
 * call worth listening to.
 *
 * One controller for two routes, against the module's usual habit of one per
 * resource, because they are one resource seen twice. Both answer "over the last
 * N days, what do the calls I am allowed to read say" — the first summarises
 * them per person and the second points at individual ones — and both take their
 * rows from `CallAnalysisCohortService`, so their windows, their caps, their
 * truncation semantics and their scope are the same thing and have to stay the
 * same thing. Splitting them would put the identical `sinceDays` contract and
 * the identical `scope` derivation in two files that nobody would think to keep
 * in step.
 *
 * **Both are gated on `crm:call-analysis:view`, not on `:view-team`, and that is
 * the load-bearing decision.** `:view` is seeded to every CRM member, so a rep
 * can open their own trend and find their own best call — which is the coaching
 * direction this module exists to support. What a rep does *not* get is anybody
 * else's numbers, and the thing stopping that is not this gate: it is
 * `callAnalysisVisibility`, applied per call inside the cohort service against
 * `crm:call-analysis:view-team` — the exact key `CallCoachingController` uses
 * for the org-wide digest. A reader without it receives their own calls and the
 * unattributed ones and nothing more, so the per-rep group-by yields one row and
 * the exemplar search ranks one person's calls.
 *
 * Gating the routes themselves on `:view-team` was the obvious alternative and
 * is wrong: it would make "how am I doing on calls" a manager-only question,
 * which turns a coaching tool into a monitoring one — the failure
 * `call-analysis-visibility.ts` spends four paragraphs explaining.
 *
 * Route shapes do not collide with anything already mounted on this prefix.
 * `crm/calls/reps` and `crm/calls/exemplars` are single literal segments, like
 * `crm/calls/coaching`; `crm/calls/:activityId/analysis` has two. No ordering
 * between the three controllers can shadow any of them.
 */
@RequireModule("crm")
@Controller("crm/calls")
@UseGuards(JwtAuthGuard)
export class CallIntelligenceController {
  constructor(
    private readonly aggregates: CallRepAggregatesService,
    private readonly exemplars: CallExemplarsService,
  ) {}

  /**
   * CRM-P2-05. Per-rep aggregates and the trend behind them.
   *
   * Paginated over reps rather than over calls, and `total` counts reps. The
   * aggregate is computed before the page is cut, which is why `total` is
   * trustworthy and why the cost of page two is the same as page one — the
   * window is read either way.
   */
  @Get("reps")
  @UseGuards(PermissionGuard)
  // The literal rather than a constant: `gated-keys-are-catalogued.spec.ts`
  // reads these decorators with a regex and counts the ones it cannot resolve.
  // A gate expressed as an identifier is a gate that scan stops covering.
  @RequirePermission("crm:call-analysis:view")
  @Validate({ query: repCallAggregatesQuerySchema })
  async reps(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: RepCallAggregatesQueryDto,
  ) {
    const result = await this.aggregates.aggregate(user, query);

    return {
      data: result.rows,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / query.limit)),
      },
      meta: {
        sinceDays: result.sinceDays,
        since: result.since,
        /** Derived, not requested — see `trendBucketFor`. Named so a chart can label its axis. */
        bucket: result.bucket,
        truncated: result.truncated,
        scope: result.scope,
        unattributed: result.unattributed,
        /**
         * Every threshold the numbers depend on is in the response rather than
         * only in the source. An `embargoed` count with no stated window reads
         * as calls that are simply missing, and a partial period nobody can
         * account for is worse than a smaller one that explains itself.
         */
        embargoed: result.embargoed,
        consentBlocked: result.consentBlocked,
        privateWindowHours: CALL_ANALYSIS_PRIVATE_WINDOW_HOURS,
      },
    };
  }

  /**
   * CRM-P2-06. Calls that exemplify one metric, best first.
   *
   * `metric` has no default on purpose: a "best calls" list with an unnamed
   * definition of best is a ranking the caller never asked for.
   */
  @Get("exemplars")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:call-analysis:view")
  @Validate({ query: callExemplarsQuerySchema })
  async exemplarsFor(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: CallExemplarsQueryDto,
  ) {
    const result = await this.exemplars.search(user, query);

    return {
      data: result.rows,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / query.limit)),
      },
      meta: {
        metric: result.metric,
        sinceDays: result.sinceDays,
        since: result.since,
        truncated: result.truncated,
        scope: result.scope,
        /**
         * The three reasons a call did not make the list, kept apart. "Not
         * measurable", "not yours to read yet" and "may never be processed" lead
         * a reader to three different actions, and a single `excluded` total
         * would lead them to none.
         */
        ineligible: result.ineligible,
        embargoed: result.embargoed,
        consentBlocked: result.consentBlocked,
        /**
         * The definitions the ranking used, so a list of five calls can be
         * defended rather than merely presented. Without them "best talk ratio"
         * is a claim the client has to invent an explanation for.
         */
        talkRatioTargetBps: EXEMPLAR_TALK_RATIO_TARGET_BPS,
        minimumRepTurns: EXEMPLAR_MIN_REP_TURNS,
        privateWindowHours: CALL_ANALYSIS_PRIVATE_WINDOW_HOURS,
      },
    };
  }
}
