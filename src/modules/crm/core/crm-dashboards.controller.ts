import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CrmSalesDashboardService } from "./crm-sales-dashboard.service";
import { CrmSupportDashboardService } from "./crm-support-dashboard.service";
import { CrmCeDashboardService } from "./crm-ce-dashboard.service";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  salesDashboardSchema,
  supportDashboardSchema,
  ceDashboardSchema,
} from "./dto/crm-dashboards-response.schemas";

@RequireModule("crm")
@Controller("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmDashboardsController {
  constructor(
    private readonly salesDashboard: CrmSalesDashboardService,
    private readonly supportDashboard: CrmSupportDashboardService,
    private readonly ceDashboard: CrmCeDashboardService,
  ) {}

  @Get("sales-dashboard")
  @RequirePermission("dashboard:sales:view")
  @ResponseSchema(salesDashboardSchema)
  sales(@CurrentUser() u: CurrentUserContext) {
    return this.salesDashboard.getSalesDashboard(u.orgId);
  }

  @Get("support-dashboard")
  @RequirePermission("dashboard:support:view")
  @ResponseSchema(supportDashboardSchema)
  support(@CurrentUser() u: CurrentUserContext) {
    return this.supportDashboard.getSupportDashboard(u.orgId);
  }

  @Get("customer-executive")
  @RequirePermission("dashboard:customer-executive:view")
  @ResponseSchema(ceDashboardSchema)
  customerExecutive(@CurrentUser() u: CurrentUserContext) {
    return this.ceDashboard.getCustomerExecutiveDashboard(u.orgId);
  }
}
