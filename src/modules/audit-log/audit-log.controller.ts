import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AuditLogService } from "./audit-log.service";
import { listSchema, type ListInput } from "./dto/audit-log.schemas";

@Controller("audit-log")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @CheckAbility("read", "audit-log")
  list(
    @Query(new ZodValidationPipe(listSchema)) filters: ListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.auditLog.list(u.orgId, filters);
  }

  @Get("actions")
  @CheckAbility("read", "audit-log")
  listActions(@CurrentUser() u: CurrentUserContext) {
    return this.auditLog.listActions(u.orgId);
  }

  @Get("target-types")
  @CheckAbility("read", "audit-log")
  listTargetTypes(@CurrentUser() u: CurrentUserContext) {
    return this.auditLog.listTargetTypes(u.orgId);
  }
}
