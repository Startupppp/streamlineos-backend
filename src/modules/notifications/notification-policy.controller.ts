import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationPolicyService } from "./notification-policy.service";
import { upsertPolicySchema, type UpsertPolicyInput } from "./dto/policy.schemas";

@Controller("notifications/admin/policy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationPolicyController {
  constructor(private readonly policy: NotificationPolicyService) {}

  @Get()
  @RequirePermission("notifications:policy:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.policy.list(u.orgId);
  }

  @Put()
  @RequirePermission("notifications:policy:manage")
  upsert(
    @Body(new ZodValidationPipe(upsertPolicySchema)) body: UpsertPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.policy.upsert(u.orgId, u.userId, body);
  }
}
