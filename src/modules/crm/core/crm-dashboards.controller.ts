import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CrmSalesDashboardService } from "./crm-sales-dashboard.service";
import { CrmSupportDashboardService } from "./crm-support-dashboard.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmDashboardsController {
  constructor(
    private readonly salesDashboard: CrmSalesDashboardService,
    private readonly supportDashboard: CrmSupportDashboardService,
  ) {}

  @Get("sales-dashboard")
  @RequirePermission("dashboard:sales:view")
  sales(@CurrentUser() u: CurrentUserContext) {
    return this.salesDashboard.getSalesDashboard(u.orgId);
  }

  @Get("support-dashboard")
  @RequirePermission("dashboard:support:view")
  support(@CurrentUser() u: CurrentUserContext) {
    return this.supportDashboard.getSupportDashboard(u.orgId);
  }

  @Get("customer-executive")
  @RequirePermission("dashboard:customer-executive:view")
  customerExecutive(@CurrentUser() u: CurrentUserContext) {
    return this.supportDashboard.getCustomerExecutiveDashboard(u.orgId);
  }
}
