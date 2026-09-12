import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CrmConsentService } from "./crm-consent.service";
import { Public } from "../../../common/auth/public.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { verifyUnsubscribeToken } from "./unsubscribe-token.util";
import {
  consentEventsQuerySchema,
  contactParamSchema,
  missingConsentQuerySchema,
  recordConsentSchema,
  type ConsentEventsQuery,
  type ContactParam,
  type MissingConsentQuery,
  type RecordConsentInput,
  unsubscribeSchema,
  type UnsubscribeInput,
} from "./dto/consent.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  consentListSchema,
  consentEventListSchema,
  consentCountMissingSchema,
  successSchema,
} from "./dto/crm-consent-response.schemas";

@Controller("crm/consent")
@RequireModule("crm")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmConsentController {
  constructor(private readonly consent: CrmConsentService) {}

  @Get("contacts/:contactId")
  @RequirePermission("crm:contacts:view")
  @ResponseSchema(consentListSchema)
  @Validate({ params: contactParamSchema })
  listForContact(
    @Param() params: ContactParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.consent.listForContact(u.orgId, params.contactId);
  }

  /**
   * The evidence trail. `listForContact` above answers "what may we send them
   * now"; this answers "when did that become true, on what basis, at whose
   * hand" -- the question a DPDP or GDPR review actually asks, and the one the
   * product had no route for even though it wrote the rows on every change.
   *
   * Gated on `view` rather than `manage`: reading a history is a read. It is
   * the same key the current-position route carries, so anybody who can see
   * the consent card can see how it got that way.
   */
  @Get("contacts/:contactId/events")
  @RequirePermission("crm:contacts:view")
  @ResponseSchema(consentEventListSchema)
  listEvents(
    @Param(new ZodValidationPipe(contactParamSchema)) params: ContactParam,
    @Query(new ZodValidationPipe(consentEventsQuerySchema)) query: ConsentEventsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.consent.listConsentEvents(u.orgId, params.contactId, query.limit);
  }

  @Post("contacts/:contactId")
  @HttpCode(200)
  @RequirePermission("crm:contacts:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: contactParamSchema, body: recordConsentSchema })
  async record(
    @Param() params: ContactParam,
    @Body() body: RecordConsentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.consent.record(u.orgId, {
      contactId: params.contactId,
      channel: body.channel,
      status: body.status,
      source: body.source,
      legalBasis: body.legalBasis,
      sourceDetail: body.sourceDetail,
      expiresAt: body.expiresAt ?? null,
      // Never from the client (§6): the actor is the bearer token's subject.
      recordedByUserId: u.userId,
    });
    return { success: true };
  }

  @Get("missing")
  @RequirePermission("crm:contacts:view")
  @ResponseSchema(consentCountMissingSchema)
  @Validate({ query: missingConsentQuerySchema })
  async countMissing(
    @Query() query: MissingConsentQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return { channel: query.channel, count: await this.consent.countMissingConsent(u.orgId, query.channel) };
  }
}

/**
 * Separate controller because it is unauthenticated: keeping it out of the
 * guarded class means a future route added to `CrmConsentController` cannot
 * accidentally inherit `@Public()`.
 */
@Controller("crm/consent")
export class CrmPublicConsentController {
  constructor(private readonly consent: CrmConsentService) {}

  @Post("unsubscribe")
  @Public()
  @HttpCode(200)
  @ResponseSchema(successSchema)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("crm:public-unsubscribe")
  @Validate({ body: unsubscribeSchema })
  async unsubscribe(
    @Body() body: UnsubscribeInput,
  ) {
    return this.honour(body.token);
  }

  /**
   * The same withdrawal, addressed the way a MAIL CLIENT can reach it.
   *
   * The body form above cannot be the whole surface: RFC 8058 one-click sends
   * `List-Unsubscribe=One-Click` as the body and nothing else, and a human who
   * clicks the link issues a GET. Neither carries our JSON. So the token moves
   * into the path and both verbs answer, which is the same shape the platform's
   * own `notifications/unsubscribe/:token` settled on.
   *
   * The body form stays because it is a real public contract with its own
   * coverage; all three share one handler so the withdrawal itself has exactly
   * one implementation.
   */
  @Get("unsubscribe/:token")
  @Public()
  @ResponseSchema(successSchema)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("crm:public-unsubscribe")
  async unsubscribeByLink(@Param("token") token: string) {
    return this.honour(token);
  }

  @Post("unsubscribe/:token")
  @BodylessAction()
  @Public()
  @HttpCode(200)
  @ResponseSchema(successSchema)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("crm:public-unsubscribe")
  async unsubscribeOneClick(@Param("token") token: string) {
    return this.honour(token);
  }

  private async honour(token: string) {
    const payload = verifyUnsubscribeToken(token);

    // Always the same response, valid token or not. Distinguishing them would
    // turn this endpoint into an oracle for whether a contact exists. A token
    // naming a contact outside its own organisation writes nothing, and
    // `recordUnsubscribe` answers it the way it answers every other token.
    if (payload) await this.consent.recordUnsubscribe(payload);

    return { success: true };
  }
}
