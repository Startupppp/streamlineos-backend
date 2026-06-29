import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DealsAnalyticsService } from "./deals-analytics.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("deals")
@UseGuards(JwtAuthGuard)
export class DealsAnalyticsController {
  constructor(private readonly analytics: DealsAnalyticsService) {}

  @Get("stats")
  getStats(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getStats(u.orgId);
  }

  @Get("aging")
  getAging(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getAging(u.orgId);
  }

  @Get("forecast")
  getForecast(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getForecast(u.orgId);
  }

  @Get("win-loss")
  getWinLoss(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getWinLoss(u.orgId);
  }
}
