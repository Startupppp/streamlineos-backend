import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrNotificationPreferencesService } from "./hr-notification-preferences.service";
import {
  updateNotificationPreferencesSchema,
  type UpdateNotificationPreferencesInput,
} from "./dto/notification-preferences.schemas";

@Controller("hr/notification-preferences")
@UseGuards(JwtAuthGuard)
export class HrNotificationPreferencesController {
  constructor(private readonly preferences: HrNotificationPreferencesService) {}

  @Get()
  get(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.get(u.userId);
  }

  @Patch()
  update(
    @Body(new ZodValidationPipe(updateNotificationPreferencesSchema)) body: UpdateNotificationPreferencesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.update(u.userId, u.orgId, body);
  }
}
