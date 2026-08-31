import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { HrNotificationPreferencesService } from "./hr-notification-preferences.service";
import {
  updateNotificationPreferencesSchema,
  type UpdateNotificationPreferencesInput,
} from "./dto/notification-preferences.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/notification-preferences")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrNotificationPreferencesController {
  constructor(private readonly preferences: HrNotificationPreferencesService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  get(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.get(u.userId);
  }

  @Patch()
  @RequirePermission("hr:employees:view")
  @Validate({ body: updateNotificationPreferencesSchema })
  update(
    @Body() body: UpdateNotificationPreferencesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.update(u.userId, u.orgId, body);
  }
}
