import { Controller, Get, Query, UseGuards } from "@nestjs/common";
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

@RequireModule("inventory")
@Controller("inventory/forecasting")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvForecastingController {
  constructor(private readonly replenishment: InvReplenishmentService) {}

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
