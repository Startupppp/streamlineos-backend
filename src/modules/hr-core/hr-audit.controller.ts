import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrAuditService } from "./hr-audit.service";
import { listAuditLogsSchema, type ListAuditLogsInput } from "./dto/hr-core.schemas";

@RequireModule("hr")
@Controller("hr/audit-logs")
@UseGuards(JwtAuthGuard)
export class HrAuditController {
  constructor(private readonly audit: HrAuditService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:audit:view")
  list(
    @Query(new ZodValidationPipe(listAuditLogsSchema)) query: ListAuditLogsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audit.list(u.orgId, query);
  }
}
