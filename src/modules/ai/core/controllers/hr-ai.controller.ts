import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { LlmService } from "../providers/llm.service";
import { HrPerformanceAiService } from "../services/hr-performance-ai.service";
import { HrRecruitmentAiService } from "../services/hr-recruitment-ai.service";
import { HrPolicyAiService } from "../services/hr-policy-ai.service";
import { HrHelpdeskAiService } from "../services/hr-helpdesk-ai.service";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import {
  acceptCandidateScoreSchema,
  attritionRiskSchema,
  generateJdSchema,
  generateReviewSchema,
  helpdeskReplySchema,
  interviewKitSchema,
  interviewNotesSummarySchema,
  letterDraftSchema,
  policyQaSchema,
  scoreCandidateSchema,
  type AcceptCandidateScoreInput,
  type AttritionRiskInput,
  type GenerateJdInput,
  type GenerateReviewInput,
  type HelpdeskReplyInput,
  type InterviewKitInput,
  type InterviewNotesSummaryInput,
  type LetterDraftInput,
  type PolicyQaInput,
  type ScoreCandidateInput,
} from "../dto/request.schemas";
import type { HelpdeskReplyResult } from "../dto/output.schemas";

const ADVISORY_DISCLAIMER = "AI estimate only. Human decision required.";

@Controller("ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
@NoTenantTransaction()
export class HrAiController {
  constructor(
    private readonly llm: LlmService,
    private readonly hrPerformance: HrPerformanceAiService,
    private readonly hrRecruitment: HrRecruitmentAiService,
    private readonly hrPolicy: HrPolicyAiService,
    private readonly hrHelpdesk: HrHelpdeskAiService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  private ensureLlm(message: string): void {
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException(message);
  }

  @Post("attrition-risk")
  @RequirePermission("hr:employees:manage")
  @Validate({ body: attritionRiskSchema })
  async attritionRisk(
    @Body() body: AttritionRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    const result = await this.hrPerformance.analyzeAttritionRisk(u.orgId, body.userId);
    if (!result) throw new NotFoundException("Employee not found or analysis failed");
    return { ...result, advisory: true, disclaimer: ADVISORY_DISCLAIMER };
  }

  @Post("generate-review")
  @RequirePermission("hr:performance:manage")
  @Validate({ body: generateReviewSchema })
  async generateReview(
    @Body() body: GenerateReviewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    const result = await this.hrPerformance.generateReview(u.orgId, body.userId, body.periodStart, body.periodEnd);
    if (!result) throw new NotFoundException("Employee not found or review generation failed");
    return { ...result, advisory: true, disclaimer: "Draft only — requires human review before any official use." };
  }

  @Post("generate-jd")
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: generateJdSchema })
  generateJd(
    @Body() body: GenerateJdInput,
  ) {
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    return this.hrRecruitment.generateJd(body);
  }

  @Post("score-candidate")
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: scoreCandidateSchema })
  async scoreCandidate(
    @Body() body: ScoreCandidateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.candidate-scoring");
    this.ensureLlm("AI scoring is not configured. Set OPENAI_API_KEY.");
    const result = await this.hrRecruitment.scoreCandidate(u.orgId, body.candidateId, body.jobId);
    if (!result) throw new NotFoundException("Candidate not found or scoring failed");
    return {
      ...result,
      advisory: true,
      disclaimer: "AI estimate only. Human decision required. Score is not applied until explicitly accepted.",
    };
  }

  @Post("helpdesk-reply")
  @RequirePermission("hr:helpdesk:manage")
  @Validate({ body: helpdeskReplySchema })
  async helpdeskReply(
    @Body() body: HelpdeskReplyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.reply-suggestion");
    this.ensureLlm("AI reply suggestion is not available at this time. Please contact your administrator.");

    let result: HelpdeskReplyResult | null;
    try {
      result = await this.hrHelpdesk.suggestHelpdeskReply(u.orgId, body.ticketId);
    } catch {
      throw new ServiceUnavailableException("Failed to generate AI reply. Please try again later.");
    }
    if (!result) throw new NotFoundException("Ticket not found or reply generation failed");
    return result;
  }

  @Get("hr/policy-qa/capabilities")
  @RequirePermission("hr:policies:view")
  policyQaCapabilities() {
    return this.hrPolicy.policyQaCapabilities();
  }

  @Post("hr/policy-qa")
  @RequirePermission("hr:policies:view")
  @Validate({ body: policyQaSchema })
  async policyQa(
    @Body() body: PolicyQaInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm("AI policy Q&A is not configured.");
    return this.hrPolicy.policyQa(u.orgId, u.userId, body.question);
  }

  @Post("hr/interview-kit")
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: interviewKitSchema })
  async interviewKit(
    @Body() body: InterviewKitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.review-generation");
    this.ensureLlm("AI interview kit is not configured.");
    const result = await this.hrRecruitment.generateInterviewKit(u.orgId, body.jobPostingId);
    if (!result) throw new NotFoundException("Job posting not found");
    return { ...result, advisory: true, disclaimer: "Draft only. Review and customize before use." };
  }

  @Post("hr/letter-draft")
  @RequirePermission("hr:employees:manage")
  @Validate({ body: letterDraftSchema })
  async letterDraft(
    @Body() body: LetterDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.review-generation");
    this.ensureLlm("AI letter drafting is not configured.");
    const result = await this.hrHelpdesk.draftLetter(u.orgId, u.userId, body.userId, body.letterType, body.details ?? null);
    if (!result) throw new NotFoundException("Employee not found");
    return {
      ...result,
      advisory: true,
      disclaimer: "DRAFT — AI-generated. Requires human review, editing, and authorized signature before official use.",
    };
  }

  @Post("hr/interview-notes-summary")
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: interviewNotesSummarySchema })
  async interviewNotesSummary(
    @Body() body: InterviewNotesSummaryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm("AI interview summary is not configured.");
    const result = await this.hrRecruitment.summarizeInterviewNotes(u.orgId, body.candidateId, body.jobPostingId);
    if (!result) throw new NotFoundException("No interview notes found for this candidate");
    return {
      ...result,
      advisory: true,
      disclaimer: "AI-generated summary. Verify against original notes before making decisions.",
    };
  }

  @Post("hr/accept-candidate-score")
  @RequirePermission("hr:interviews:manage")
  @Validate({ body: acceptCandidateScoreSchema })
  async acceptCandidateScore(
    @Body() body: AcceptCandidateScoreInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.planLimits.assertFeature(u.orgId, "ai.candidate-scoring");
    this.ensureLlm("AI scoring is not configured.");
    return this.hrRecruitment.acceptCandidateScore(u.orgId, body.candidateId, body.aiScore);
  }
}
