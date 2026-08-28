import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvReplenishmentService } from "./inv-replenishment.service";
import { forecastingSchema, type ForecastingInput } from "./dto/replenishment.schemas";
import { DemandBaselineService } from "./forecast/demand-baseline.service";
import { SafetyStockPolicyService } from "./forecast/safety-stock-policy.service";

@RequireModule("inventory")
@Controller("inventory/forecasting")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvForecastingController {
  constructor(
    private readonly replenishment: InvReplenishmentService,
    private readonly demandBaseline: DemandBaselineService,
    private readonly safetyStockPolicy: SafetyStockPolicyService,
  ) {}

  /**
   * INV-303. Safety stock and reorder point over measured demand and measured
   * lead times, or an explanation of why the model does not apply.
   */
  @Get("safety-stock/:productVariantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  safetyStockPolicyFor(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.safetyStockPolicy.policyFor(u.orgId, productVariantId);
  }

  /**
   * INV-301. The deterministic baseline for one SKU, and how every candidate
   * scored against it in a rolling-origin backtest. This is the number any
   * model has to beat before it is allowed to replace the arithmetic.
   */
  @Get("baseline/:productVariantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  baseline(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.demandBaseline.baseline(u.orgId, productVariantId);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  getForecasting(
    @Query(new ZodValidationPipe(forecastingSchema)) filters: ForecastingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.replenishment.getForecasting(u.orgId, filters);
  }
}
