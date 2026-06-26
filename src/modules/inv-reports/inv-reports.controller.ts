import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { InvReportsService } from "./inv-reports.service";

@Controller("inventory/reports")
@UseGuards(JwtAuthGuard)
export class InvReportsController {
  constructor(private readonly reports: InvReportsService) {}

  @Get("dashboard")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:reports")
  getDashboard(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getDashboard(u.orgId);
  }

  @Get("stock-summary")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:reports")
  getStockSummary(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getStockSummary(u.orgId);
  }

  @Get("reorder")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:reports")
  getReorderReport(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getReorderReport(u.orgId);
  }

  @Get("movements")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "inventory:reports")
  getMovements(
    @Query("fromDate") fromDate: string | undefined,
    @Query("toDate") toDate: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getMovementsReport(u.orgId, fromDate, toDate);
  }
}
