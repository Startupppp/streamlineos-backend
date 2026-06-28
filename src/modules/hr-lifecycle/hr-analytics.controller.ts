import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrAnalyticsService } from "./hr-analytics.service";
import { attendanceAnalyticsQuerySchema, type AttendanceAnalyticsQuery } from "./dto/hr-lifecycle.schemas";

@Controller("hr/analytics")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("hr:analytics:read")
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
