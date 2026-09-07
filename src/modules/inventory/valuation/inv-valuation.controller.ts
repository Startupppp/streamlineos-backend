import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvValuationService } from "./inv-valuation.service";
import {
  valuationSummarySchema,
  valuationLayersSchema,
  type ValuationSummaryInput,
  type ValuationLayersInput,
} from "./dto/valuation.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  valuationSummaryResponseSchema,
  valuationLayersResponseSchema,
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
}
