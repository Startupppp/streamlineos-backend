import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CrmSalesDashboardService } from "./crm-sales-dashboard.service";
import { CrmSupportDashboardService } from "./crm-support-dashboard.service";

@Controller("crm")
@UseGuards(JwtAuthGuard)
export class CrmDashboardsController {
  constructor(
    private readonly salesDashboard: CrmSalesDashboardService,
    private readonly supportDashboard: CrmSupportDashboardService,
  ) {}

  @Get("sales-dashboard")
  sales(@CurrentUser() u: CurrentUserContext) {
    return this.salesDashboard.getSalesDashboard(u.orgId);
  }

  @Get("support-dashboard")
  support(@CurrentUser() u: CurrentUserContext) {
    return this.supportDashboard.getSupportDashboard(u.orgId);
  }

  @Get("customer-executive")
  customerExecutive(@CurrentUser() u: CurrentUserContext) {
    return this.supportDashboard.getCustomerExecutiveDashboard(u.orgId);
  }
}
