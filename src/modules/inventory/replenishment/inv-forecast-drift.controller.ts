import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { DriftMonitorService } from "./forecast/drift-monitor.service";
import {
  driftDetailQuerySchema,
  driftWatchlistQuerySchema,
  type DriftDetailQuery,
  type DriftWatchlistQuery,
} from "./dto/forecast-drift.schemas";

/**
 * C7 — the drift watchlist.
 *
 * Both routes are GETs and both are read-only all the way down: watching a
 * forecast degrade must not regenerate it, or the evidence for the degradation
 * is destroyed by the act of looking at it.
 */
@RequireModule("inventory")
@Controller("inventory/replenishment/drift")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvForecastDriftController {
  constructor(private readonly monitor: DriftMonitorService) {}

  /** Every tracked SKU, worst error first, with coverage and the two rates. */
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:read")
  watchlist(
    @Query(new ZodValidationPipe(driftWatchlistQuerySchema)) query: DriftWatchlistQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.monitor.watchlist(u.orgId, u.userId, query);
  }

  /** The split-half drift report for one SKU, beside the stored versions behind it. */
  @Get(":productVariantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:read")
  detail(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Query(new ZodValidationPipe(driftDetailQuerySchema)) query: DriftDetailQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.monitor.detail(u.orgId, u.userId, productVariantId, query);
  }
}
