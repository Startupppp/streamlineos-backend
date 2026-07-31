import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvValuationService } from "./inv-valuation.service";
import {
  valuationSummarySchema,
  valuationLayersSchema,
  type ValuationSummaryInput,
  type ValuationLayersInput,
} from "./dto/valuation.schemas";

@RequireModule("inventory")
@Controller("inventory/valuation")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvValuationController {
  constructor(private readonly valuation: InvValuationService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  getValuationSummary(
    @Query(new ZodValidationPipe(valuationSummarySchema)) filters: ValuationSummaryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.valuation.getValuationSummary(u.orgId, filters);
  }

  @Get("layers")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  getValuationLayers(
    @Query(new ZodValidationPipe(valuationLayersSchema)) filters: ValuationLayersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.valuation.getValuationLayers(u.orgId, filters);
  }
}
