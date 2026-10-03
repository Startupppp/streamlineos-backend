import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  UseGuards,
  type RawBodyRequest,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { Public } from "../../../../common/auth/public.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { WhatsappService } from "./whatsapp.service";
import { WHATSAPP_TEMPLATE_KEYS } from "./whatsapp-consent";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";

const candidateIdParams = z.object({ candidateId: z.coerce.number().int().positive() }).strict();

const consentSchema = z.object({ optedIn: z.boolean() }).strict();
type ConsentInput = z.infer<typeof consentSchema>;

const sendSchema = z
  .object({
    template: z.enum(WHATSAPP_TEMPLATE_KEYS as [string, ...string[]]),
    /**
     * Values only, capped. The template body is fixed on the server, so this is
     * the substitution data and nothing else — a caller cannot extend an
     * approved message by passing more of them.
     */
    variables: z.record(z.string(), z.string().trim().min(1).max(300)),
  })
  .strict();
type SendInput = z.infer<typeof sendSchema>;

const stateSchema = z.object({
  candidateId: z.number().int(),
  optInAt: z.date().nullable(),
  optOutAt: z.date().nullable(),
  canSend: z.boolean(),
  refusal: z.string().nullable(),
  providerBlockedReason: z.string().nullable(),
});

@RequireModule("hr")
@Controller("hr/recruitment/candidates/:candidateId/whatsapp")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Get()
  @ResponseSchema(stateSchema)
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: candidateIdParams })
  state(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whatsapp.state(u.orgId, candidateId);
  }

  @Put("consent")
  @ResponseSchema(stateSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: candidateIdParams, body: consentSchema })
  recordConsent(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: ConsentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whatsapp.recordConsent(u.orgId, u.userId, candidateId, body.optedIn);
  }

  /** Idempotency-keyed: a double-submit would message the candidate twice. */
  @Post("send")
  @Idempotent("hr.recruitment.whatsapp.send")
  @ResponseSchema(z.object({ sent: z.literal(true), reference: z.string() }))
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: candidateIdParams, body: sendSchema })
  send(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: SendInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.whatsapp.sendTemplate(
      u.orgId,
      u.userId,
      candidateId,
      body.template as Parameters<WhatsappService["sendTemplate"]>[3],
      body.variables,
    );
  }
}

@Public()
@Controller("public/whatsapp-inbound")
export class WhatsappInboundController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Post(":orgSlug")
  @BodylessAction()
  @HttpCode(202)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:whatsapp-inbound")
  @ResponseSchema(z.object({ linked: z.boolean() }))
  receive(
    @Param("orgSlug", new ZodValidationPipe(z.string().min(1).max(128))) orgSlug: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-streamline-signature") signature: string | undefined,
  ) {
    return this.whatsapp.receiveInbound(orgSlug, request.rawBody ?? "", signature);
  }
}
