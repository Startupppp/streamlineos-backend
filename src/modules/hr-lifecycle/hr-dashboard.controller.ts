import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { HrDashboardService } from "./hr-dashboard.service";
import { HrDashboardReportsService } from "./hr-dashboard-reports.service";

@Controller("hr/dashboard")
@UseGuards(JwtAuthGuard)
export class HrDashboardController {
  constructor(
    private readonly dashboard: HrDashboardService,
    private readonly reports: HrDashboardReportsService,
  ) {}

  @Get("metrics")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  metrics(@CurrentUser() u: CurrentUserContext) {
    return this.dashboard.metrics(u.orgId);
  }

  @Get("diversity")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  diversity(@CurrentUser() u: CurrentUserContext) {
    return this.dashboard.diversity(u.orgId);
  }

  @Get("onboarding-status")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  onboardingStatus(@CurrentUser() u: CurrentUserContext) {
    return this.dashboard.onboardingStatus(u.orgId);
  }

  @Get("headcount-trends")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  headcountTrends(@CurrentUser() u: CurrentUserContext) {
    return this.reports.headcountTrends(u.orgId);
  }

  @Get("time-to-fill")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  timeToFill(@CurrentUser() u: CurrentUserContext) {
    return this.reports.timeToFill(u.orgId);
  }

}
