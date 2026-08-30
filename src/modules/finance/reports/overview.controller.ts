import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { OverviewService } from "./overview.service";
import { overviewQuerySchema, type OverviewQuery } from "./dto/finance-reports.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("accounting")
@Controller("accounting")
@UseGuards(JwtAuthGuard)
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  @Get("overview")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: overviewQuerySchema })
  getOverview(
    @Query() query: OverviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.overviewService.getOverview(u.orgId, query);
  }
}
