import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { DealsAnalyticsService } from "./deals-analytics.service";
import { resolveDealsReadScope } from "./deals-scope";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import {
  forecastSnapshotsQuerySchema,
  type ForecastSnapshotsQueryInput,
  createForecastSnapshotSchema,
  type CreateForecastSnapshotInput,
  compareForecastSnapshotsSchema,
  type CompareForecastSnapshotsInput,
  overrideForecastSnapshotSchema,
  type OverrideForecastSnapshotInput,
} from "./dto/deals.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  dealStatsSchema,
  dealAgingSchema,
  dealForecastSchema,
  dealForecastSnapshotsSchema,
  dealForecastSnapshotSchema,
  dealForecastCompareSchema,
  dealWinLossSchema,
  dealHealthSchema,
} from "./dto/deals-response.schemas";

const dealIdParams = z.object({ dealId: z.coerce.number().int().positive() }).strict();
const snapshotIdParams = z.object({ snapshotId: z.string().min(1) }).strict();

@RequireModule("crm")
@Controller("deals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DealsAnalyticsController {
  constructor(
    private readonly analytics: DealsAnalyticsService,
    private readonly access: AccessService,
  ) {}

  @Get("stats")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(dealStatsSchema)
  async getStats(@CurrentUser() u: CurrentUserContext) {
    const read = await resolveDealsReadScope(this.access, u);
    return this.analytics.getStats(read);
  }

  @Get("aging")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(dealAgingSchema)
  async getAging(@CurrentUser() u: CurrentUserContext) {
    const read = await resolveDealsReadScope(this.access, u);
    return this.analytics.getAging(read);
  }

  @Get("forecast")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(dealForecastSchema)
  getForecast(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getForecast(u.orgId);
  }

  @Get("forecast/snapshots")
  @RequirePermission("crm:deals:forecast")
  @ResponseSchema(dealForecastSnapshotsSchema)
  @Validate({ query: forecastSnapshotsQuerySchema })
  getForecastSnapshots(
    @Query() query: ForecastSnapshotsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getForecastSnapshots(u.orgId, query);
  }

  @Post("forecast/snapshot")
  @HttpCode(201)
  @RequirePermission("crm:deals:forecast")
  @ResponseSchema(dealForecastSnapshotSchema)
  @Validate({ body: createForecastSnapshotSchema })
  captureForecastSnapshot(
    @Body() body: CreateForecastSnapshotInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.createForecastSnapshot(u.orgId, u.userId, body);
  }

  @Get("forecast/compare")
  @RequirePermission("crm:deals:forecast")
  @ResponseSchema(dealForecastCompareSchema)
  @Validate({ query: compareForecastSnapshotsSchema })
  compareForecastSnapshots(
    @Query() query: CompareForecastSnapshotsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.compareForecastSnapshots(u.orgId, query);
  }

  @Get("win-loss")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(dealWinLossSchema)
  getWinLoss(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getWinLoss(u.orgId);
  }

  @Get(":dealId/health")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(dealHealthSchema)
  @Validate({ params: dealIdParams })
  async getDealHealth(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveDealsReadScope(this.access, u);
    return this.analytics.getDealHealth(read, dealId);
  }

  @Patch("forecast/:snapshotId/override")
  @RequirePermission("crm:deals:manage")
  @ResponseSchema(dealForecastSnapshotSchema)
  @Validate({ params: snapshotIdParams, body: overrideForecastSnapshotSchema })
  overrideForecast(
    @Param("snapshotId") snapshotId: string,
    @Body() body: OverrideForecastSnapshotInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.overrideForecastSnapshot(u.orgId, u.userId, snapshotId, body);
  }
}
