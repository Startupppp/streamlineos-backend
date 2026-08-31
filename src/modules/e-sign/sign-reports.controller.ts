import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { SignReportsService } from "./sign-reports.service";

@RequireModule("sign")
@Controller("sign/reports")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignReportsController {
  constructor(private readonly reports: SignReportsService) {}

  @Get("dashboard")
  @RequirePermission("sign:envelope:view")
  getDashboard(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getDashboard(u.orgId, actingMembershipId(u.principal));
  }

  @Get("summary")
  @RequirePermission("sign:audit:view")
  getSummary(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSummary(u.orgId);
  }
}
