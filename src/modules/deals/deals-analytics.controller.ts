import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DealsAnalyticsService } from "./deals-analytics.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("deals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DealsAnalyticsController {
  constructor(private readonly analytics: DealsAnalyticsService) {}

  @Get("stats")
  @RequirePermission("crm:deals:read")
  getStats(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getStats(u.orgId);
  }

  @Get("aging")
  @RequirePermission("crm:deals:read")
  getAging(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getAging(u.orgId);
  }

  @Get("forecast")
  @RequirePermission("crm:deals:read")
  getForecast(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getForecast(u.orgId);
  }

  @Get("win-loss")
  @RequirePermission("crm:deals:read")
  getWinLoss(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getWinLoss(u.orgId);
  }
}
