import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvReplenishmentService } from "./inv-replenishment.service";
import { forecastingSchema, type ForecastingInput } from "./dto/replenishment.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("inventory")
@Controller("inventory/forecasting")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvForecastingController {
  constructor(private readonly replenishment: InvReplenishmentService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:reports:read")
  @Validate({ query: forecastingSchema })
  getForecasting(
    @Query() filters: ForecastingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.replenishment.getForecasting(u.orgId, filters);
  }
}
