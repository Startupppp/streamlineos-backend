import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CALL_ANALYSIS_PRIVATE_WINDOW_HOURS } from "./call-analysis-visibility";
import { COACHING_MIN_COHORT } from "./call-coaching";
import { CallCoachingService } from "./call-coaching.service";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { coachingDigestQuerySchema, type CoachingDigestQuery } from "./dto/call-analysis.schemas";
import { coachingDigestResponseSchema } from "./dto/call-analysis-response.schemas";

/**
 * The manager surface: what a team's calls look like in aggregate.
 *
 * One route, and no per-rep route anywhere in this module, which is the design
 * rather than a first cut. The ticket's phrase is "coaching rather than a
 * leaderboard", and a leaderboard is not a rendering choice — it is an endpoint
 * that returns rows keyed by person, after which every client that consumes it
 * eventually sorts them. So the digest is org-wide, un-attributed, and reports
 * bands rather than averages. A manager who wants to talk to one person opens
 * that person's call and reads its analysis, under the rule the rep can see: it
 * is theirs first, and they know when it opened.
 *
 * Gated on `crm:call-analysis:view-team` rather than on `:view`. `:view` is
 * granted to every CRM member at seed time, so gating this on it would put the
 * whole team's numbers in front of the whole team — the leaderboard, arrived at
 * from the permission side.
 *
 * `GET crm/calls/coaching` and `GET crm/calls/:activityId/analysis` do not
 * collide: the second has two path segments after the prefix and the first has
 * one, so no ordering between the two controllers can shadow either.
 */
@RequireModule("crm")
@Controller("crm/calls")
@UseGuards(JwtAuthGuard)
export class CallCoachingController {
  constructor(private readonly coaching: CallCoachingService) {}

  @Get("coaching")
  @UseGuards(PermissionGuard)
  // The literal, not the constant `CALL_ANALYSIS_VIEW_TEAM` beside it:
  // `gated-keys-are-catalogued.spec.ts` reads these decorators with a regex and
  // counts the ones it cannot resolve. A gate expressed as an identifier is a
  // gate that scan stops covering.
  @RequirePermission("crm:call-analysis:view-team")
  @ResponseSchema(coachingDigestResponseSchema)
  @Validate({ query: coachingDigestQuerySchema })
  async digest(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: CoachingDigestQuery,
  ) {
    const result = await this.coaching.digest(user, query.sinceDays);

    return {
      data: result.digest,
      meta: {
        sinceDays: result.sinceDays,
        since: result.since,
        truncated: result.truncated,
        /**
         * Both thresholds are in the response, not only in the source. A
         * suppressed digest with no stated minimum reads as an error, and an
         * `embargoed` count with no stated window reads as calls that are simply
         * missing. Naming them is what makes a partial answer legible instead of
         * suspicious.
         */
        minimumCohort: COACHING_MIN_COHORT,
        privateWindowHours: CALL_ANALYSIS_PRIVATE_WINDOW_HOURS,
      },
    };
  }
}
