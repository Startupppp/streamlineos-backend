import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { auditQuerySchema, type AuditQuery } from "./dto/audit.schemas";

@RequireModule("projects")
@Controller("timesheets/audit")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class AuditController {
  constructor(private readonly auditService: TimesheetsAuditService) {}

  @Get()
  @RequirePermission("timesheets:audit:view")
  async list(
    @Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.auditService.listAuditEvents(u.orgId, query);
  }
}
