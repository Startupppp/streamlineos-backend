import {
  Controller,
  Get,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { ReportsService } from "./reports.service";

@Controller("reports")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermission("crm:reports:view")
  @Get("source-effectiveness")
  sourceEffectiveness(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSourceEffectiveness(u.orgId);
  }
}
