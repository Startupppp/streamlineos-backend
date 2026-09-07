import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { NotificationPreferencesService } from "./notification-preferences.service";
import { NotificationPreferenceRulesService } from "./notification-preference-rules.service";
import { NotificationConsentService } from "./notification-consent.service";
import { preferenceRuleSchema, type PreferenceRuleBody } from "./dto/preference-rule.schemas";
import {
  updatePreferenceSchema,
  eventPreferenceSchema,
  createSuppressionSchema,
  recordConsentSchema,
  type UpdatePreferenceInput,
  type EventPreferenceInput,
  type CreateSuppressionInput,
  type RecordConsentInputDto,
} from "./dto/preference.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { z } from "zod";
import {
  consentRowSchema,
  notificationConsentsListSchema,
  notificationEventCatalogSchema,
  notificationPreferenceRulesListSchema,
  notificationPreferenceSchema,
  notificationSuccessSchema,
  notificationSuppressionsListSchema,
  preferenceRuleOkSchema,
  suppressionRowSchema,
} from "./dto/notification-admin-response.schemas";

const eventKeyParams = z.object({ eventKey: z.string().min(1) }).strict();
const suppressionIdParams = z.object({ suppressionId: z.coerce.number().int().positive() }).strict();

@Controller("notification-preferences")
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly rules: NotificationPreferenceRulesService,
    private readonly consents: NotificationConsentService,
  ) {}

  @Get()
  @ResponseSchema(notificationPreferenceSchema)
  @Universal()
  get(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.getEffective(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Patch()
  @ResponseSchema(notificationPreferenceSchema)
  @Universal()
  @Validate({ body: updatePreferenceSchema })
  update(
    @Body() body: UpdatePreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.update(u.orgId, u.userId, body, actingMembershipId(u.principal));
  }

  /** SCH-003. The normalised rules behind the preference centre. */
  @Get("rules")
  @ResponseSchema(notificationPreferenceRulesListSchema)
  @Universal()
  listRules(@CurrentUser() u: CurrentUserContext) {
    return this.rules.list(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Put("rules")
  @ResponseSchema(preferenceRuleOkSchema)
  @Universal()
  @HttpCode(200)
  @Validate({ body: preferenceRuleSchema })
  setRule(
    @Body() body: PreferenceRuleBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rules.set(u.orgId, u.userId, body, actingMembershipId(u.principal));
  }

  @Get("events")
  @ResponseSchema(notificationEventCatalogSchema)
  @Universal()
  eventCatalog(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.getEventCatalog(u.orgId, u.userId);
  }

  @Patch("events/:eventKey")
  @ResponseSchema(notificationPreferenceSchema)
  @Universal()
  @Validate({ params: eventKeyParams, body: eventPreferenceSchema })
  updateEvent(
    @Param("eventKey") eventKey: string,
    @Body() body: EventPreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.updateEventPreference(u.orgId, u.userId, eventKey, body, actingMembershipId(u.principal));
  }

  @Post("reset")
  @ResponseSchema(notificationPreferenceSchema)
  @BodylessAction()
  @Universal()
  @HttpCode(200)
  reset(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.reset(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Get("suppressions")
  @ResponseSchema(notificationSuppressionsListSchema)
  @Universal()
  listSuppressions(@CurrentUser() u: CurrentUserContext) {
    return this.preferences.listSuppressions(u.orgId, u.userId);
  }

  @Post("suppressions")
  @ResponseSchema(suppressionRowSchema)
  @Universal()
  @Validate({ body: createSuppressionSchema })
  createSuppression(
    @Body() body: CreateSuppressionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.preferences.createSuppression(u.orgId, u.userId, body);
  }

  @Delete("suppressions/:suppressionId")
  @ResponseSchema(notificationSuccessSchema)
  @Universal()
  @Validate({ params: suppressionIdParams })
  removeSuppression(@Param("suppressionId", ParseIntPipe) suppressionId: number, @CurrentUser() u: CurrentUserContext) {
    return this.preferences.removeSuppression(u.orgId, u.userId, suppressionId);
  }

  /**
   * COMP-003. The consent surface. SMS and WhatsApp do not route without a GRANTED
   * row here — a preference toggle is a setting, and this is the record of
   * agreement that a setting cannot stand in for.
   */
  @Get("consents")
  @ResponseSchema(notificationConsentsListSchema)
  @Universal()
  listConsents(@CurrentUser() u: CurrentUserContext) {
    return this.consents.list(u.orgId, actingMembershipId(u.principal));
  }

  @Put("consents")
  @ResponseSchema(consentRowSchema)
  @Universal()
  @HttpCode(200)
  @Validate({ body: recordConsentSchema })
  recordConsent(
    @Body() body: RecordConsentInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.consents.record(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }
}
