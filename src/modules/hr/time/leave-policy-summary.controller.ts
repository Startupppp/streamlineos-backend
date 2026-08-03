import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { LeavePoliciesService } from "./leave-policies.service";

@Controller("hr/leave-policy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LeavePolicySummaryController {
  constructor(private readonly service: LeavePoliciesService) {}

  @Get()
  @RequirePermission("hr:leaves:view")
  getSummary(@CurrentUser() u: CurrentUserContext) {
    return this.service.getOrgSummary(u.orgId);
  }
}
