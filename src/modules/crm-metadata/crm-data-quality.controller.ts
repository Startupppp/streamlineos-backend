import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CrmDataQualityService } from "./crm-data-quality.service";

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmDataQualityController {
  constructor(private readonly svc: CrmDataQualityService) {}

  @Get("data-quality")
  @RequirePermission("crm:data-quality:view")
  getReport(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getReport(u.orgId);
  }
}
