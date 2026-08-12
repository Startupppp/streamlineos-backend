import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationPreferencesService } from "./notification-preferences.service";
import { NotificationPreferenceRulesService } from "./notification-preference-rules.service";
import { preferenceRuleSchema, type PreferenceRuleBody } from "./dto/preference-rule.schemas";
import {
  updatePreferenceSchema,
  eventPreferenceSchema,
  createSuppressionSchema,
  type UpdatePreferenceInput,
  type EventPreferenceInput,
  type CreateSuppressionInput,
} from "./dto/preference.schemas";

@Controller("notification-preferences")
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly rules: NotificationPreferenceRulesService,
  ) {}

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

  /** SCH-003. The normalised rules behind the preference centre. */
  @Get("rules")
  listRules(@CurrentUser() u: CurrentUserContext) {
    return this.rules.list(u.orgId, u.userId);
  }

  @Put("rules")
  @HttpCode(200)
  setRule(
    @Body(new ZodValidationPipe(preferenceRuleSchema)) body: PreferenceRuleBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.set(u.orgId, u.userId, body);
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
  @HttpCode(200)
  reset(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.reset(u.orgId, u.userId);
  }

  @Get("suppressions")
  listSuppressions(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.listSuppressions(u.orgId, u.userId);
  }

  @Post("suppressions")
  createSuppression(
    @Body(new ZodValidationPipe(createSuppressionSchema)) body: CreateSuppressionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.createSuppression(u.orgId, u.userId, body);
  }

  @Delete("suppressions/:suppressionId")
  removeSuppression(@Param("suppressionId", ParseIntPipe) suppressionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.preferences.removeSuppression(u.orgId, u.userId, suppressionId);
  }
}
