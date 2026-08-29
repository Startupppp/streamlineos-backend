import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { InvAuditEventsService } from "./inv-audit-events.service";
import { listAuditEventsSchema, type ListAuditEventsInput } from "./dto/inv-audit-events.schemas";

@RequireModule("inventory")
@Controller("inventory/audit-events")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvAuditEventsController {
  constructor(private readonly auditEvents: InvAuditEventsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:audit:read")
  list(
    @Query(new ZodValidationPipe(listAuditEventsSchema)) query: ListAuditEventsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.auditEvents.list(u.orgId, query);
  }
}
