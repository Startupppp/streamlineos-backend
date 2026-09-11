import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { InvReportsService } from "./inv-reports.service";
import { InvReportsExtendedService } from "./inv-reports-extended.service";
import {
  stockSummaryQuerySchema,
  reorderQuerySchema,
  movementsQuerySchema,
  valuationReportSchema,
  slowMovingQuerySchema,
  expiryReportSchema,
  type StockSummaryQueryInput,
  type ReorderQueryInput,
  type MovementsQueryInput,
  type ValuationReportInput,
  type SlowMovingQueryInput,
  type ExpiryReportInput,
} from "./dto/inv-reports.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { OperationsMetricsService } from "./operations-metrics.service";
import { WorkAgingService } from "./work-aging.service";
import {
  throughputQuerySchema,
  workAgingQuerySchema,
  type ThroughputQueryInput,
  type WorkAgingQueryInput,
} from "./dto/operations-metrics.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  dashboardResponseSchema,
  stockSummaryResponseSchema,
  reorderReportResponseSchema,
  movementsReportResponseSchema,
  valuationReportResponseSchema,
  slowMovingReportResponseSchema,
  expiryReportResponseSchema,
  throughputResponseSchema,
  workAgingResponseSchema,
} from "./dto/reports-response.schemas";

@RequireModule("inventory")
@Controller("inventory/reports")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvReportsController {
  constructor(
    private readonly reports: InvReportsService,
    private readonly extended: InvReportsExtendedService,
    private readonly operationsMetrics: OperationsMetricsService,
    private readonly workAging: WorkAgingService,
  ) {}

  /**
   * INV-210. Throughput and SLA over a bounded window, computed from the facts
   * the rest of the phase records rather than from a counter that would drift.
   */
  @Get("throughput")
  @ResponseSchema(throughputResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  @Validate({ query: throughputQuerySchema })
  throughput(
    @Query() query: ThroughputQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.operationsMetrics.throughput(u.orgId, u.userId, query);
  }

  /**
   * How long the open work in each stage has been standing there.
   *
   * The same permission as throughput: both are the same floor-supervisor view
   * over the same rows, and a second key nobody has been granted would put the
   * dashboard behind a permission that exists only in this file.
   */
  @Get("work-aging")
  @ResponseSchema(workAgingResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  @Validate({ query: workAgingQuerySchema })
  getWorkAging(
    @Query() query: WorkAgingQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workAging.workAging(u.orgId, u.userId, query);
  }

  @Get("dashboard")
  @ResponseSchema(dashboardResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getDashboard(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getDashboard(u.orgId, u.userId);
  }

  @Get("stock-summary")
  @ResponseSchema(stockSummaryResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  @Validate({ query: stockSummaryQuerySchema })
  getStockSummary(
    @Query() query: StockSummaryQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getStockSummary(u.orgId, u.userId, query);
  }

  @Get("reorder")
  @ResponseSchema(reorderReportResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  @Validate({ query: reorderQuerySchema })
  getReorderReport(
    @Query() query: ReorderQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getReorderReport(u.orgId, u.userId, query);
  }

  @Get("movements")
  @ResponseSchema(movementsReportResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  @Validate({ query: movementsQuerySchema })
  getMovements(
    @Query() query: MovementsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getMovementsReport(u.orgId, u.userId, query);
  }

  @Get("valuation")
  @ResponseSchema(valuationReportResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  @Validate({ query: valuationReportSchema })
  getValuationReport(
    @Query() query: ValuationReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.extended.getValuationReport(u.orgId, u.userId, query);
  }

  @Get("slow-moving")
  @ResponseSchema(slowMovingReportResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  @Validate({ query: slowMovingQuerySchema })
  getSlowMovingReport(
    @Query() query: SlowMovingQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.extended.getSlowMovingReport(u.orgId, u.userId, query);
  }

  @Get("expiry")
  @ResponseSchema(expiryReportResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  @Validate({ query: expiryReportSchema })
  getExpiryReport(
    @Query() query: ExpiryReportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.extended.getExpiryReport(u.orgId, u.userId, query);
  }
}
