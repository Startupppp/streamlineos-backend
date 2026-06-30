import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationPreferencesService } from "./notification-preferences.service";
import { updatePreferenceSchema, type UpdatePreferenceInput } from "./dto/preference.schemas";

@Controller("notification-preferences")
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  get(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.get(u.orgId, u.userId);
  }

  @Patch()
  update(
    @Body(new ZodValidationPipe(updatePreferenceSchema)) body: UpdatePreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.update(u.orgId, u.userId, body);
  }
}
