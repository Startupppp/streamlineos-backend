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
import { AssessmentService } from "./assessment.service";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";

const candidateIdParams = z.object({ candidateId: z.coerce.number().int().positive() }).strict();

const inviteSchema = z.object({ testId: z.string().trim().min(1).max(200) }).strict();
type InviteInput = z.infer<typeof inviteSchema>;

const assessmentViewSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  testId: z.string().nullable(),
  reference: z.string().nullable(),
  candidateUrl: z.string().nullable(),
  result: z.enum(["PENDING", "PASSED", "FAILED", "NO_SHOW"]),
  score: z.number().int().nullable(),
  scoredAt: z.date().nullable(),
  invitedAt: z.date(),
  providerBlockedReason: z.string().nullable(),
});

@RequireModule("hr")
@Controller("hr/recruitment/candidates/:candidateId/assessments")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AssessmentController {
  constructor(private readonly assessments: AssessmentService) {}

  @Get()
  @ResponseSchema(z.array(assessmentViewSchema))
  @RequirePermission("hr:requisitions:view")
  @Validate({ params: candidateIdParams })
  list(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assessments.listForCandidate(u.orgId, candidateId);
  }

  /**
   * Idempotency-keyed: an assessment invitation is a seat the organisation pays
   * for, and a double-submit would buy two and send the candidate two links.
   */
  @Post()
  @Idempotent("hr.recruitment.assessment.invite")
  @HttpCode(201)
  @ResponseSchema(assessmentViewSchema)
  @RequirePermission("hr:requisitions:manage")
  @Validate({ params: candidateIdParams, body: inviteSchema })
  invite(
    @Param("candidateId", ParseIntPipe) candidateId: number,
    @Body() body: InviteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assessments.invite(
      u.orgId,
      u.userId,
      actingMembershipId(u.principal),
      candidateId,
      body.testId,
    );
  }
}

const assessmentScoreResponseSchema = z.object({
  replay: z.boolean(),
  result: z.string(),
  percent: z.number(),
});

/**
 * Where an assessment vendor pushes a score.
 *
 * Its own controller rather than a route on the one above, because the two have
 * nothing in common beyond the word "assessment": this one is public,
 * rate-limited, HMAC-verified over raw bytes and belongs to no candidate path.
 */
@Public()
@Controller("public/assessment-score")
export class AssessmentScoreController {
  constructor(private readonly assessments: AssessmentService) {}

  @Post(":orgSlug")
  @BodylessAction()
  @HttpCode(202)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:assessment-score")
  @ResponseSchema(assessmentScoreResponseSchema)
  receive(
    @Param("orgSlug", new ZodValidationPipe(z.string().min(1).max(128))) orgSlug: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-streamline-signature") signature: string | undefined,
  ) {
    return this.assessments.recordScore(orgSlug, request.rawBody ?? "", signature);
  }
}
