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

  /**
   * Every `crm:deals:read` route here resolves the same scope the deals list
   * resolves, through the same helper. `crm:deals:forecast` and
   * `crm:deals:manage` below do not, and are not scopable in the catalog: a
   * snapshot is the organisation's forecast whoever captured it.
   */
  private viewScope(u: CurrentUserContext) {
    return resolveDealsReadScope(this.access, u);
  }

  @Get("stats")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(dealStatsSchema)
  async getStats(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getStats(u.orgId, await this.viewScope(u));
  }

  @Get("aging")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(dealAgingSchema)
  async getAging(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getAging(u.orgId, await this.viewScope(u));
  }

  @Get("forecast")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(dealForecastSchema)
  async getForecast(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getForecast(u.orgId, await this.viewScope(u));
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
  async getWinLoss(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getWinLoss(u.orgId, await this.viewScope(u));
  }

  @Get(":dealId/health")
  @RequirePermission("crm:deals:read")
  @ResponseSchema(dealHealthSchema)
  @Validate({ params: dealIdParams })
  async getDealHealth(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getDealHealth(u.orgId, dealId, await this.viewScope(u));
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
