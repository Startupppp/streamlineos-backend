import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { auditQuerySchema, type AuditQuery } from "./dto/audit.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("timesheets")
@Controller("timesheets/audit")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimesheetAuditController {
  constructor(private readonly auditService: TimesheetsAuditService) {}

  @Get("verify")
  @RequirePermission("timesheets:audit:view")
  verify(@CurrentUser() u: CurrentUserContext) {
    return this.auditService.verifyChain(u.orgId);
  }

  @Get()
  @RequirePermission("timesheets:audit:view")
  @Validate({ query: auditQuerySchema })
  async list(
    @Query() query: AuditQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.auditService.listAuditEvents(u.orgId, query);
  }
}
