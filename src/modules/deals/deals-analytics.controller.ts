import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DealsAnalyticsService } from "./deals-analytics.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  forecastSnapshotsQuerySchema,
  type ForecastSnapshotsQueryInput,
  createForecastSnapshotSchema,
  type CreateForecastSnapshotInput,
  compareForecastSnapshotsSchema,
  type CompareForecastSnapshotsInput,
} from "./dto/deals.schemas";

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

  @Get("forecast/snapshots")
  @RequirePermission("crm:deals:forecast")
  getForecastSnapshots(
    @Query(new ZodValidationPipe(forecastSnapshotsQuerySchema)) query: ForecastSnapshotsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getForecastSnapshots(u.orgId, query);
  }

  @Post("forecast/snapshot")
  @RequirePermission("crm:deals:forecast")
  captureForecastSnapshot(
    @Body(new ZodValidationPipe(createForecastSnapshotSchema)) body: CreateForecastSnapshotInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.createForecastSnapshot(u.orgId, u.userId, body);
  }

  @Get("forecast/compare")
  @RequirePermission("crm:deals:forecast")
  compareForecastSnapshots(
    @Query(new ZodValidationPipe(compareForecastSnapshotsSchema)) query: CompareForecastSnapshotsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.compareForecastSnapshots(u.orgId, query);
  }

  @Get("win-loss")
  @RequirePermission("crm:deals:read")
  getWinLoss(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getWinLoss(u.orgId);
  }

  @Get(":dealId/health")
  @RequirePermission("crm:deals:read")
  getDealHealth(
    @Param("dealId") dealId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getDealHealth(u.orgId, Number(dealId));
  }

  @Patch("forecast/:snapshotId/override")
  @RequirePermission("crm:deals:manage")
  overrideForecast(
    @Param("snapshotId") snapshotId: string,
    @Body() body: { overrideAmount?: number; overrideNote?: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.overrideForecastSnapshot(u.orgId, u.userId, snapshotId, body);
  }
}
