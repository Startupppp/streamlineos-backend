import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TeamRewardsService } from "./team-rewards.service";

/**
 * Org-level pay distribution analytics (cash CTC only).
 * Not a legal pay-equity audit — no protected attributes.
 */
@RequireModule("payroll")
@Controller("payroll/analytics")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class PayAnalyticsController {
  constructor(private readonly teamRewards: TeamRewardsService) {}

  @Get("pay-compression")
  @RequirePermission("payroll:salaries:view")
  orgPayCompression(@CurrentUser() u: CurrentUserContext) {
    return this.teamRewards.getOrgPayCompression(u.orgId);
  }
}
