import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationPreferencesService } from "./notification-preferences.service";
import {
  updatePreferenceSchema,
  eventPreferenceSchema,
  type UpdatePreferenceInput,
  type EventPreferenceInput,
} from "./dto/preference.schemas";

@Controller("notification-preferences")
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  get(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.getEffective(u.orgId, u.userId);
  }

  @Patch()
  update(
    @Body(new ZodValidationPipe(updatePreferenceSchema)) body: UpdatePreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.update(u.orgId, u.userId, body);
  }

  @Get("events")
  eventCatalog(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.getEventCatalog(u.orgId, u.userId);
  }

  @Patch("events/:eventKey")
  updateEvent(
    @Param("eventKey") eventKey: string,
    @Body(new ZodValidationPipe(eventPreferenceSchema)) body: EventPreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.updateEventPreference(u.orgId, u.userId, eventKey, body);
  }

  @Post("reset")
  reset(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.reset(u.orgId, u.userId);
  }
}
