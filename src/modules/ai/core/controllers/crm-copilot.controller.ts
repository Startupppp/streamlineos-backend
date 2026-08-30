import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { LlmService } from "../providers/llm.service";
import { CrmCopilotService } from "../services/crm-copilot.service";
import { CrmBriefService } from "../services/crm-brief.service";
import { Validate } from "../../../../common/validation/validate.decorator";

const leadIdParams = z.object({ leadId: z.coerce.number().int().positive() }).strict();
const dealIdParams = z.object({ dealId: z.coerce.number().int().positive() }).strict();

const nextBestActionsSchema = z.object({
  limit: z.number().int().min(1).max(20).default(10),
  withEvidence: z.boolean().optional().default(true),
});

const emailDraftSchema = z.object({
  entityType: z.enum(["lead", "deal"]),
  entityId: z.number().int().positive(),
  intent: z.string().min(1).max(1000),
  tone: z.enum(["formal", "friendly", "urgent"]).default("friendly"),
});

const summarizeNotesSchema = z.object({
  text: z.string().min(10).max(8000),
});

const objectionHelpSchema = z.object({
  objection: z.string().min(1).max(2000),
  context: z.string().max(1000).optional(),
});

const meetingFollowUpSchema = z.object({
  meetingTitle: z.string().min(1).max(200),
  attendeeType: z.enum(["lead", "client"]),
  attendeeId: z.number().int().positive(),
  outcome: z.string().min(1).max(3000),
  actionItems: z.array(z.string().max(500)).max(20).optional(),
  scheduledAt: z.string(),
  notes: z.string().max(2000).optional(),
});
type MeetingFollowUpBodyInput = z.infer<typeof meetingFollowUpSchema>;

const accountSummaryWithCitationsSchema = z.object({
  clientId: z.number().int().positive(),
});
type AccountSummaryWithCitationsInput = z.infer<typeof accountSummaryWithCitationsSchema>;

const stalePipelineQuerySchema = z.object({
  inactiveDays: z.coerce.number().int().min(1).max(90).default(14),
});
type StalePipelineQuery = z.infer<typeof stalePipelineQuerySchema>;

@Controller("ai/crm")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@RequirePermission("crm:ai:use")
@UseRateLimit("ai:invoke")
@NoTenantTransaction()
export class CrmCopilotController {
  constructor(
    private readonly llm: LlmService,
    private readonly copilot: CrmCopilotService,
    private readonly brief: CrmBriefService,
  ) {}

  private ensureLlm(): void {
    if (!this.llm.isConfigured()) {
      throw new ServiceUnavailableException("AI provider is not configured. Set OPENAI_API_KEY.");
    }
  }

  @Post("leads/:leadId/summary")
  @Validate({ params: leadIdParams })
  async leadSummary(
    @Param("leadId", ParseIntPipe) leadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    const result = await this.copilot.leadSummary(u.orgId, leadId, u.userId);
    if (!result) throw new NotFoundException("Lead not found");
    return result;
  }

  @Post("deals/:dealId/summary")
  @Validate({ params: dealIdParams })
  async dealSummary(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.dealSummary(u.orgId, dealId, u.userId);
  }

  @Post("next-best-actions")
  nextBestActions(
    @Body(new ZodValidationPipe(nextBestActionsSchema)) body: z.infer<typeof nextBestActionsSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.nextBestActionsAcrossPipeline(u.orgId, u.userId, body.limit);
  }

  @Post("email-draft")
  emailDraft(
    @Body(new ZodValidationPipe(emailDraftSchema)) body: z.infer<typeof emailDraftSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.emailDraftForEntity(u.orgId, u.userId, body);
  }

  @Post("summarize-notes")
  summarizeNotes(
    @Body(new ZodValidationPipe(summarizeNotesSchema)) body: z.infer<typeof summarizeNotesSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.summarizeNotes(u.orgId, u.userId, body.text);
  }

  @Post("objection-help")
  objectionHelp(
    @Body(new ZodValidationPipe(objectionHelpSchema)) body: z.infer<typeof objectionHelpSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.objectionHelp(u.orgId, u.userId, { objection: body.objection, context: body.context });
  }

  @Post("duplicate-suggestions/:leadId")
  @Validate({ params: leadIdParams })
  duplicateSuggestions(
    @Param("leadId", ParseIntPipe) leadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.duplicateSuggestionsForLead(u.orgId, leadId, u.userId);
  }

  @Post("meeting-follow-up")
  async meetingFollowUp(
    @Body(new ZodValidationPipe(meetingFollowUpSchema)) body: MeetingFollowUpBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.brief.meetingFollowUpDraft(u.orgId, body, u.userId);
  }

  @Get("stale-pipeline")
  async stalePipeline(
    @Query(new ZodValidationPipe(stalePipelineQuerySchema)) query: StalePipelineQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.stalePipelineDigest(u.orgId, u.userId, query.inactiveDays);
  }

  @Get("data-quality")
  async dataQuality(@CurrentUser() u: CurrentUserContext) {
    this.ensureLlm();
    return this.copilot.dataQualityCopilot(u.orgId, u.userId);
  }

  @Post("leads/:leadId/summary-with-citations")
  @Validate({ params: leadIdParams })
  async leadSummaryWithCitations(
    @Param("leadId", ParseIntPipe) leadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    const result = await this.copilot.leadSummaryWithCitations(u.orgId, leadId, u.userId);
    if (!result) throw new NotFoundException("Lead not found");
    return result;
  }

  @Post("deals/:dealId/summary-with-citations")
  @Validate({ params: dealIdParams })
  async dealSummaryWithCitations(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.copilot.dealSummaryWithCitations(u.orgId, dealId, u.userId);
  }

  @Post("account-summary-with-citations")
  async accountSummaryWithCitations(
    @Body(new ZodValidationPipe(accountSummaryWithCitationsSchema)) body: AccountSummaryWithCitationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.brief.accountSummaryWithCitations(u.orgId, body, u.userId);
  }
}
