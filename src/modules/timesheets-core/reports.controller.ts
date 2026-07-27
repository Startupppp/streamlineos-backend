import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ReportsService } from "./reports.service";
import { overviewQuerySchema, type OverviewQuery } from "./dto/reports.schemas";

@RequireModule("build")
@Controller("timesheets/reports")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("overview")
  @RequirePermission("timesheets:reports:view")
  overview(
    @Query(new ZodValidationPipe(overviewQuerySchema)) query: OverviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getOverview(u, query);
  }
}
