import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { readRequestScopedRead } from "../organization/core/read-request-scope";
import { SignReportsService } from "./sign-reports.service";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { signDashboardResponseSchema, signSummaryResponseSchema } from "./dto/e-sign-response.schemas";

@RequireModule("sign")
@Controller("sign/reports")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignReportsController {
  constructor(private readonly reports: SignReportsService) {}

  @Get("dashboard")
  @RequirePermission("sign:envelope:view")
  @ResponseSchema(signDashboardResponseSchema)
  getDashboard(@CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    const read = readRequestScopedRead(req, u);
    return this.reports.getDashboard(read, actingMembershipId(u.principal));
  }

  @Get("summary")
  @RequirePermission("sign:audit:view")
  @ResponseSchema(signSummaryResponseSchema)
  getSummary(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSummary(u.orgId);
  }
}
