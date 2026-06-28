import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AuditLogService } from "./audit-log.service";
import { listSchema, type ListInput } from "./dto/audit-log.schemas";

@Controller("audit-log")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @RequirePermission("audit-log:read")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.auditLog.list(u.orgId, filters);
  }

  @Get("actions")
  @RequirePermission("audit-log:read")
  listActions(@CurrentUser() u: CurrentUserContext) {
    return this.auditLog.listActions(u.orgId);
  }

  @Get("target-types")
  @RequirePermission("audit-log:read")
  listTargetTypes(@CurrentUser() u: CurrentUserContext) {
    return this.auditLog.listTargetTypes(u.orgId);
  }
}
