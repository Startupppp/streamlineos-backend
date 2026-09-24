import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
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
import { actingMembershipId } from "../../../../common/auth/principal";
import { Validate } from "../../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { VoiceScreenService } from "./voice-screen.service";

const candidateIdParams = z.object({ candidateId: z.coerce.number().int().positive() }).strict();

const requestScreenSchema = z
  .object({
    /**
     * A script is required and cannot be empty. An automated caller with no
     * questions is a machine ringing somebody for no stated purpose, which is
     * not a thing this product will ask a vendor to do.
     */
    script: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
    /**
     * No default, for the same reason the transcript's consent has none: the
     * server inventing the moment a candidate agreed to an automated call would
     * be a record of agreement nobody witnessed.
     */
    consentAt: z.coerce.date(),
  })
  .strict();
type RequestScreenInput = z.infer<typeof requestScreenSchema>;

const voiceScreenViewSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  reference: z.string().nullable(),
  result: z.enum(["PENDING", "PASSED", "FAILED", "NO_SHOW"]),
  rating: z.number().int().nullable(),
  script: z.array(z.string()),
  answers: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
      confidence: z.number().nullable(),
    }),
  ),
  requestedAt: z.date(),
  completedBy: z.enum(["PROVIDER", "RECRUITER"]).nullable(),
  providerBlockedReason: z.string().nullable(),
});

@RequireModule("hr")
@Controller("hr/recruitment/candidates/:candidateId/voice-screens")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class VoiceScreenController {
  constructor(private readonly screens: VoiceScreenService) {}

  @Get()
  @ResponseSchema(z.array(voiceScreenViewSchema))
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: candidateIdParams })
  list(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.screens.listForCandidate(u.orgId, candidateId);
  }

  /** Idempotency-keyed: a double-submit would ring the candidate twice. */
  @Post()
  @Idempotent("hr.recruitment.voice-screen.request")
  @HttpCode(201)
  @ResponseSchema(voiceScreenViewSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: candidateIdParams, body: requestScreenSchema })
  request(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: RequestScreenInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.screens.request(
      u.orgId,
      u.userId,
      actingMembershipId(u.principal),
      candidateId,
      body.script,
      body.consentAt,
    );
  }
}

const voiceScreenResultResponseSchema = z.object({
  replay: z.boolean(),
  answers: z.number().int(),
});

@Public()
@Controller("public/voice-screen-result")
export class VoiceScreenResultController {
  constructor(private readonly screens: VoiceScreenService) {}

  @Post(":orgSlug")
  @BodylessAction()
  @HttpCode(202)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:voice-screen-result")
  @ResponseSchema(voiceScreenResultResponseSchema)
  receive(
    @Param("orgSlug") orgSlug: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-streamline-signature") signature: string | undefined,
  ) {
    return this.screens.recordResult(orgSlug, request.rawBody ?? "", signature);
  }
}
