import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InvReportsService } from "./inv-reports.service";
import { movementsQuerySchema, type MovementsQueryInput } from "./dto/inv-reports.schemas";

@Controller("inventory/reports")
@UseGuards(JwtAuthGuard)
export class InvReportsController {
  constructor(private readonly reports: InvReportsService) {}

  @Get("dashboard")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getDashboard(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getDashboard(u.orgId);
  }

  @Get("stock-summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getStockSummary(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getStockSummary(u.orgId);
  }

  @Get("reorder")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getReorderReport(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getReorderReport(u.orgId);
  }

  @Get("movements")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getMovements(
    @Query(new ZodValidationPipe(movementsQuerySchema)) query: MovementsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getMovementsReport(u.orgId, query);
  }
}
