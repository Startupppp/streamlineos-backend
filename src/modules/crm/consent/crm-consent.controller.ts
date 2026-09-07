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
import { CrmConsentService } from "./crm-consent.service";
import { Public } from "../../../common/auth/public.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { verifyUnsubscribeToken } from "./unsubscribe-token.util";
import {
  contactParamSchema,
  missingConsentQuerySchema,
  recordConsentSchema,
  type ContactParam,
  type MissingConsentQuery,
  type RecordConsentInput,
  unsubscribeSchema,
  type UnsubscribeInput,
} from "./dto/consent.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  consentListSchema,
  consentCountMissingSchema,
  successSchema,
} from "./dto/crm-consent-response.schemas";

const contactIdParams = z.object({ contactId: z.string().min(1) }).strict();

@Controller("crm/consent")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmConsentController {
  constructor(private readonly consent: CrmConsentService) {}

  @Get("contacts/:contactId")
  @RequirePermission("crm:contacts:view")
  @ResponseSchema(consentListSchema)
  @Validate({ params: contactIdParams })
  listForContact(
    @Param() params: ContactParam,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.consent.listForContact(u.orgId, params.contactId);
  }

  @Post("contacts/:contactId")
  @HttpCode(200)
  @RequirePermission("crm:contacts:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: contactIdParams, body: recordConsentSchema })
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
    const payload = verifyUnsubscribeToken(body.token);

    // Always the same response, valid token or not. Distinguishing them would
    // turn this endpoint into an oracle for whether a contact exists.
    if (payload) {
      await this.consent.record(payload.orgId, {
        contactId: payload.contactId,
        channel: payload.channel,
        status: "OPTED_OUT",
        source: "UNSUBSCRIBE_LINK",
        legalBasis: "CONSENT",
        recordedByUserId: null,
      });
    }

    return { success: true };
  }
}
