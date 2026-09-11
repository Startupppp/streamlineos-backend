import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { InvValuationService } from "./inv-valuation.service";
import {
  valuationSummarySchema,
  valuationLayersSchema,
  valuationConsumptionsSchema,
  type ValuationSummaryInput,
  type ValuationLayersInput,
  type ValuationConsumptionsInput,
} from "./dto/valuation.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  valuationSummaryResponseSchema,
  valuationLayersResponseSchema,
  valuationConsumptionsResponseSchema,
  listValuationPeriodsResponseSchema,
} from "./dto/valuation-response.schemas";

@RequireModule("inventory")
@Controller("inventory/valuation")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvValuationController {
  constructor(private readonly valuation: InvValuationService) {}

  @Get()
  @ResponseSchema(valuationSummaryResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  @Validate({ query: valuationSummarySchema })
  getValuationSummary(
    @Query() filters: ValuationSummaryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.valuation.getValuationSummary(u.orgId, u.userId, filters);
  }

  /** The accounting periods a valuation may be quoted at, where any exist. */
  @Get("periods")
  @ResponseSchema(listValuationPeriodsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  listPeriods(@CurrentUser() u: CurrentUserContext) {
    return this.valuation.listPeriods(u.orgId);
  }

  @Get("layers")
  @ResponseSchema(valuationLayersResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  @Validate({ query: valuationLayersSchema })
  getValuationLayers(
    @Query() filters: ValuationLayersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.valuation.getValuationLayers(u.orgId, u.userId, filters);
  }

  /** Which layers each issue drew from, and what the draw cost. */
  @Get("consumptions")
  @ResponseSchema(valuationConsumptionsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  getValuationConsumptions(
    @Query(new ZodValidationPipe(valuationConsumptionsSchema)) filters: ValuationConsumptionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.valuation.getValuationConsumptions(u.orgId, u.userId, filters);
  }
}
