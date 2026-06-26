import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrAnalyticsService } from "./hr-analytics.service";
import { attendanceAnalyticsQuerySchema, type AttendanceAnalyticsQuery } from "./dto/hr-lifecycle.schemas";

@Controller("hr/analytics")
@UseGuards(JwtAuthGuard, AbilityGuard)
@CheckAbility("read", "hr:analytics")
export class HrAnalyticsController {
  constructor(private readonly analytics: HrAnalyticsService) {}

  @Get()
  overview(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.overview(u.orgId);
  }

  @Get("attendance")
  attendance(
    @Query(new ZodValidationPipe(attendanceAnalyticsQuerySchema)) query: AttendanceAnalyticsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.attendance(u.orgId, query.year, query.month);
  }

  @Get("attrition")
  attrition(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.attrition(u.orgId);
  }
}
