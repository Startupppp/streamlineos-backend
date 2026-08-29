import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
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
import {
  forecastPolicyScopeSchema,
  forecastScopeSchema,
  forecastVersionsQuerySchema,
  generateForecastSchema,
  type ForecastPolicyScopeInput,
  type ForecastScopeInput,
  type ForecastVersionsQuery,
  type GenerateForecastBody,
} from "./dto/forecast-scope.schemas";
import { DemandBaselineService } from "./forecast/demand-baseline.service";
import { SafetyStockPolicyService } from "./forecast/safety-stock-policy.service";
import { LeadTimeService } from "./forecast/lead-time.service";
import { ReorderProposalService } from "./forecast/reorder-proposal.service";
import { ReplenishmentSimulatorService } from "./forecast/replenishment-simulator.service";
import { ForecastPersistenceService } from "./forecast/forecast-persistence.service";
import { simulateSchema, type SimulateInput } from "./dto/simulate.schemas";

/**
 * C1 note on permissions. Every route here is gated on
 * `inventory:replenishment:manage`, which is the only replenishment key in the
 * catalog — there is no `:read`. The two new read surfaces below would sit
 * better behind a narrower key, and that is said here rather than solved
 * silently: adding one needs a catalog entry in both repos plus a backfill
 * migration (backend §5), which is a change of its own rather than a side
 * effect of persisting forecasts.
 */
@RequireModule("inventory")
@Controller("inventory/forecasting")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvForecastingController {
  constructor(
    private readonly replenishment: InvReplenishmentService,
    private readonly demandBaseline: DemandBaselineService,
    private readonly safetyStockPolicy: SafetyStockPolicyService,
    private readonly leadTime: LeadTimeService,
    private readonly reorderProposal: ReorderProposalService,
    private readonly simulator: ReplenishmentSimulatorService,
    private readonly forecastVersions: ForecastPersistenceService,
  ) {}

  /**
   * C1. Store the forecast this variant and site currently justify.
   *
   * A POST because it writes, and idempotent without an `Idempotency-Key`
   * because the stored version is keyed on a fingerprint of its own inputs: a
   * double-clicked "regenerate" lands on the row the first click wrote. The
   * response says which happened, so a caller can tell "already recorded" from
   * "recorded now" rather than guessing.
   */
  @Post("versions/:productVariantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  async generateVersion(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Body(new ZodValidationPipe(generateForecastSchema)) body: GenerateForecastBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const warehouseId = await this.demandBaseline.scopeFor(u.orgId, u.userId, body.warehouseId);
    return this.forecastVersions.generate(u.orgId, u.userId, {
      productVariantId,
      warehouseId,
      historyWeeks: body.historyWeeks,
      horizonWeeks: body.horizonWeeks,
      serviceLevel: body.serviceLevel,
    });
  }

  /** C1. Every forecast this SKU has had at this site, newest first. */
  @Get("versions/:productVariantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  async listVersions(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Query(new ZodValidationPipe(forecastVersionsQuerySchema)) query: ForecastVersionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const warehouseId = await this.demandBaseline.scopeFor(u.orgId, u.userId, query.warehouseId);
    return this.forecastVersions.versions(u.orgId, productVariantId, warehouseId, {
      page: query.page,
      limit: query.limit,
    });
  }

  /** C1. The forecast currently on record, without recomputing one. */
  @Get("versions/:productVariantId/latest")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  async latestVersion(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Query(new ZodValidationPipe(forecastScopeSchema)) query: ForecastScopeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const warehouseId = await this.demandBaseline.scopeFor(u.orgId, u.userId, query.warehouseId);
    return this.forecastVersions.latest(u.orgId, productVariantId, warehouseId);
  }

  /**
   * INV-306. What-if. Reads and computes; writes nothing, by construction --
   * there is no path from this service to the stock engine.
   */
  @Post("simulate/:productVariantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  async simulate(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Body(new ZodValidationPipe(simulateSchema)) body: SimulateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const warehouseId = await this.demandBaseline.scopeFor(u.orgId, u.userId, body.warehouseId);
    return this.simulator.simulate(u.orgId, productVariantId, body.scenarios, {
      serviceLevel: body.serviceLevel,
      weeks: body.weeks,
      warehouseId,
    });
  }

  /**
   * INV-305. A proposal with its working shown: every figure carries where it
   * came from, so a planner who disagrees can find the number they disagree
   * with.
   */
  @Get("reorder-proposal/:productVariantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  async reorderProposalFor(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Query(new ZodValidationPipe(forecastPolicyScopeSchema)) query: ForecastPolicyScopeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const warehouseId = await this.demandBaseline.scopeFor(u.orgId, u.userId, query.warehouseId);
    return this.reorderProposal.propose(u.orgId, productVariantId, {
      warehouseId,
      weeks: query.weeks,
      serviceLevel: query.serviceLevel,
    });
  }

  /** INV-304. What this vendor actually takes, from receipts rather than a promise. */
  @Get("lead-time/vendor/:vendorId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  vendorLeadTime(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.leadTime.vendorLeadTime(u.orgId, vendorId);
  }

  /**
   * INV-303. Safety stock and reorder point over measured demand and measured
   * lead times, or an explanation of why the model does not apply.
   */
  @Get("safety-stock/:productVariantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  async safetyStockPolicyFor(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Query(new ZodValidationPipe(forecastPolicyScopeSchema)) query: ForecastPolicyScopeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const warehouseId = await this.demandBaseline.scopeFor(u.orgId, u.userId, query.warehouseId);
    return this.safetyStockPolicy.policyFor(u.orgId, productVariantId, {
      warehouseId,
      weeks: query.weeks,
      serviceLevel: query.serviceLevel,
    });
  }

  /**
   * INV-301. The deterministic baseline for one SKU, and how every candidate
   * scored against it in a rolling-origin backtest. This is the number any
   * model has to beat before it is allowed to replace the arithmetic.
   */
  @Get("baseline/:productVariantId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:manage")
  async baseline(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Query(new ZodValidationPipe(forecastScopeSchema)) query: ForecastScopeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const warehouseId = await this.demandBaseline.scopeFor(u.orgId, u.userId, query.warehouseId);
    return this.demandBaseline.baseline(u.orgId, productVariantId, {
      warehouseId,
      weeks: query.weeks,
    });
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
