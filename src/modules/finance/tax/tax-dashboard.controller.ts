import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TaxDashboardService } from "./tax-dashboard.service";
import { taxDashboardQuerySchema, type TaxDashboardQuery } from "./dto/tax-reports.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { taxDashboardResponseSchema } from "./dto/tax-response.schemas";

@RequireModule("accounting")
@Controller("accounting/taxes")
@UseGuards(JwtAuthGuard)
export class TaxDashboardController {
  constructor(private readonly dashboard: TaxDashboardService) {}

  @Get("dashboard")
  @ResponseSchema(taxDashboardResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  @Validate({ query: taxDashboardQuerySchema })
  getDashboard(
    @Query() query: TaxDashboardQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.dashboard.getDashboard(u.orgId, query);
  }
}
