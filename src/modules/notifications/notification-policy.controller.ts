import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { NotificationPolicyService } from "./notification-policy.service";
import { upsertPolicySchema, type UpsertPolicyInput } from "./dto/policy.schemas";
import { Validate } from "../../common/validation/validate.decorator";

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
  @Validate({ body: upsertPolicySchema })
  upsert(
    @Body() body: UpsertPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.policy.upsert(u.orgId, u.userId, body);
  }
}
