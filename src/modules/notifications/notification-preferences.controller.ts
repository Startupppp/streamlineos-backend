import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
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
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const eventKeyParams = z.object({ eventKey: z.string().min(1) }).strict();
const suppressionIdParams = z.object({ suppressionId: z.coerce.number().int().positive() }).strict();

@Controller("notification-preferences")
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly rules: NotificationPreferenceRulesService,
  ) {}

  @Get()
  @Universal()
  get(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.getEffective(u.orgId, u.userId);
  }

  @Patch()
  @Universal()
  @Validate({ body: updatePreferenceSchema })
  update(
    @Body() body: UpdatePreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.update(u.orgId, u.userId, body);
  }

  /** SCH-003. The normalised rules behind the preference centre. */
  @Get("rules")
  @Universal()
  listRules(@CurrentUser() u: CurrentUserContext) {
    return this.rules.list(u.orgId, u.userId);
  }

  @Put("rules")
  @Universal()
  @HttpCode(200)
  @Validate({ body: preferenceRuleSchema })
  setRule(
    @Body() body: PreferenceRuleBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.set(u.orgId, u.userId, body);
  }

  @Get("events")
  @Universal()
  eventCatalog(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.getEventCatalog(u.orgId, u.userId);
  }

  @Patch("events/:eventKey")
  @Universal()
  @Validate({ params: eventKeyParams, body: eventPreferenceSchema })
  updateEvent(
    @Param("eventKey") eventKey: string,
    @Body() body: EventPreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.updateEventPreference(u.orgId, u.userId, eventKey, body);
  }

  @Post("reset")
  @Universal()
  @HttpCode(200)
  reset(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.reset(u.orgId, u.userId);
  }

  @Get("suppressions")
  @Universal()
  listSuppressions(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.listSuppressions(u.orgId, u.userId);
  }

  @Post("suppressions")
  @Universal()
  @Validate({ body: createSuppressionSchema })
  createSuppression(
    @Body() body: CreateSuppressionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.createSuppression(u.orgId, u.userId, body);
  }

  @Delete("suppressions/:suppressionId")
  @Universal()
  @Validate({ params: suppressionIdParams })
  removeSuppression(@Param("suppressionId", ParseIntPipe) suppressionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.preferences.removeSuppression(u.orgId, u.userId, suppressionId);
  }
}
