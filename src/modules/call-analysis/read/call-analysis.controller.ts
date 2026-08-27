import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CALL_ANALYSIS_VIEW_OWN, CALL_ANALYSIS_VIEW_TEAM } from "../permissions";
import { CallAnalysisReadService } from "./call-analysis-read.service";

const windowQuerySchema = z.object({
  /**
   * Bounded at a year, and not because of the query cost.
   *
   * A coaching window that reaches back further stops being coaching: nobody is
   * usefully told what their calls sounded like eighteen months ago, and a
   * window that long turns a trend into a performance history.
   */
  windowDays: z.coerce.number().int().min(7).max(365).optional(),
});
type WindowQuery = z.infer<typeof windowQuerySchema>;

/**
 * The two surfaces, and the two permissions that separate them.
 *
 * There is no route here that takes a call and analyses it, and there could not
 * be: this controller's module cannot reach anything that performs one. See
 * `CallAnalysisAnalyserModule`.
 */
@Controller("crm/call-analysis")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CallAnalysisController {
  constructor(private readonly svc: CallAnalysisReadService) {}

  /**
   * A rep's own calls, first.
   *
   * `u.userId` rather than a parameter, and that is the ticket rather than a
   * shortcut: an endpoint that took a user id would need a rule about whose ids
   * are acceptable, and the first exception written into that rule is the point
   * at which this becomes the surveillance report nobody puts calls into. Whose
   * calls these are is not addressable, so it cannot be widened.
   */
  @Get("me")
  @RequirePermission(CALL_ANALYSIS_VIEW_OWN)
  forRep(
    @Query(new ZodValidationPipe(windowQuerySchema)) query: WindowQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.forRep(u.orgId, u.userId, query.windowDays);
  }

  /** The team, pooled. Returns aggregates and prompts; carries no call and no person. */
  @Get("team")
  @RequirePermission(CALL_ANALYSIS_VIEW_TEAM)
  forManager(
    @Query(new ZodValidationPipe(windowQuerySchema)) query: WindowQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.forManager(u.orgId, query.windowDays);
  }
}
