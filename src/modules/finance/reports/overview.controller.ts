import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { OverviewService } from "./overview.service";
import { overviewQuerySchema, type OverviewQuery } from "./dto/finance-reports.schemas";

@RequireModule("accounting")
@Controller("accounting")
@UseGuards(JwtAuthGuard)
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  @Get("overview")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getOverview(
    @Query(new ZodValidationPipe(overviewQuerySchema)) query: OverviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.overviewService.getOverview(u.orgId, query);
  }
}
