import {
  Body,
  Controller,
  ForbiddenException,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { LlmService } from "../providers/llm.service";
import { HrAiService } from "../services/hr-ai.service";
import { abilityFor } from "../services/ai-ability.helper";
import { requireFeature } from "../billing/feature-gates";
import {
  attritionRiskSchema,
  generateJdSchema,
  generateReviewSchema,
  helpdeskReplySchema,
  scoreCandidateSchema,
  type AttritionRiskInput,
  type GenerateJdInput,
  type GenerateReviewInput,
  type HelpdeskReplyInput,
  type ScoreCandidateInput,
} from "../dto/request.schemas";
import type { HelpdeskReplyResult } from "../dto/output.schemas";

@Controller("ai")
@UseGuards(JwtAuthGuard)
export class HrAiController {
  constructor(
    private readonly llm: LlmService,
    private readonly hr: HrAiService,
  ) {}

  private ensureLlm(message: string): void {
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException(message);
  }

  @Post("attrition-risk")
  async attritionRisk(
    @Body(new ZodValidationPipe(attritionRiskSchema)) body: AttritionRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    if (!abilityFor(u).can("manage", "hr:employees")) {
      throw new ForbiddenException("Only admins can analyze attrition risk");
    }
    const result = await this.hr.analyzeAttritionRisk(u.orgId, body.userId);
    if (!result) throw new NotFoundException("Employee not found or analysis failed");
    return result;
  }

  @Post("generate-review")
  async generateReview(
    @Body(new ZodValidationPipe(generateReviewSchema)) body: GenerateReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    if (!abilityFor(u).can("manage", "hr:performance")) {
      throw new ForbiddenException("Only admins/managers can generate reviews");
    }
    const result = await this.hr.generateReview(u.orgId, body.userId, body.periodStart, body.periodEnd);
    if (!result) throw new NotFoundException("Employee not found or review generation failed");
    return result;
  }

  @Post("generate-jd")
  generateJd(@Body(new ZodValidationPipe(generateJdSchema)) body: GenerateJdInput) {
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    return this.hr.generateJd(body);
  }

  @Post("score-candidate")
  async scoreCandidate(
    @Body(new ZodValidationPipe(scoreCandidateSchema)) body: ScoreCandidateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.candidate-scoring");
    this.ensureLlm("AI scoring is not configured. Set OPENAI_API_KEY.");
    const result = await this.hr.scoreCandidate(u.orgId, body.candidateId, body.jobId);
    if (!result) throw new NotFoundException("Candidate not found or scoring failed");
    return result;
  }

  @Post("helpdesk-reply")
  async helpdeskReply(
    @Body(new ZodValidationPipe(helpdeskReplySchema)) body: HelpdeskReplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.reply-suggestion");
    this.ensureLlm("AI reply suggestion is not available at this time. Please contact your administrator.");

    let result: HelpdeskReplyResult | null;
    try {
      result = await this.hr.suggestHelpdeskReply(u.orgId, body.ticketId);
    } catch {
      throw new ServiceUnavailableException("Failed to generate AI reply. Please try again later.");
    }
    if (!result) throw new NotFoundException("Ticket not found or reply generation failed");
    return result;
  }
}
