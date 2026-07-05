import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { InvReportsService } from "./inv-reports.service";
import { InvReportsExtendedService } from "./inv-reports-extended.service";
import {
  movementsQuerySchema,
  valuationReportSchema,
  slowMovingQuerySchema,
  expiryReportSchema,
  type MovementsQueryInput,
  type ValuationReportInput,
  type SlowMovingQueryInput,
  type ExpiryReportInput,
} from "./dto/inv-reports.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("inventory")
@Controller("inventory/reports")
@UseGuards(JwtAuthGuard)
export class InvReportsController {
  constructor(
    private readonly reports: InvReportsService,
    private readonly extended: InvReportsExtendedService,
  ) {}

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

  @Get("valuation")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  getValuationReport(
    @Query(new ZodValidationPipe(valuationReportSchema)) query: ValuationReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.extended.getValuationReport(u.orgId, query);
  }

  @Get("slow-moving")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getSlowMovingReport(
    @Query(new ZodValidationPipe(slowMovingQuerySchema)) query: SlowMovingQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.extended.getSlowMovingReport(u.orgId, query);
  }

  @Get("expiry")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getExpiryReport(
    @Query(new ZodValidationPipe(expiryReportSchema)) query: ExpiryReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.extended.getExpiryReport(u.orgId, query);
  }
}
