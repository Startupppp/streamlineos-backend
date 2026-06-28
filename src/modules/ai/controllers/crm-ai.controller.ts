import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { LlmService } from "../providers/llm.service";
import { CrmScoringService } from "../services/crm-scoring.service";
import { CrmContentService } from "../services/crm-content.service";
import { CrmBriefService } from "../services/crm-brief.service";
import { CrmTasksService } from "../services/crm-tasks.service";
import { requireFeature } from "../billing/feature-gates";
import {
  accountSummarySchema,
  churnRiskSchema,
  enrichLeadSchema,
  generateEmailSchema,
  meetingPrepSchema,
  nextActionSchema,
  nlSearchSchema,
  objectionHandlerSchema,
  predictDealSchema,
  reportNarratorSchema,
  scoreLeadBatchSchema,
  scoreLeadSingleSchema,
  sentimentAnalysisSchema,
  suggestionsQuerySchema,
  summarizeSchema,
  type AccountSummaryInput,
  type ChurnRiskInput,
  type EnrichLeadInput,
  type GenerateEmailInput,
  type MeetingPrepInput,
  type NextActionInput,
  type NlSearchInput,
  type ObjectionHandlerInput,
  type PredictDealInput,
  type ReportNarratorInput,
  type SentimentAnalysisInput,
  type SuggestionsQueryInput,
  type SummarizeInput,
} from "../dto/request.schemas";

function hasLeadIds(body: unknown): body is { leadIds: unknown } {
  return typeof body === "object" && body !== null && "leadIds" in body;
}

@Controller("ai")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("crm:ai:use")
export class CrmAiController {
  constructor(
    private readonly llm: LlmService,
    private readonly scoring: CrmScoringService,
    private readonly content: CrmContentService,
    private readonly brief: CrmBriefService,
    private readonly aiTasks: CrmTasksService,
  ) {}

  private ensureLlm(message: string): void {
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException(message);
  }

  @Post("score-lead")
  async scoreLead(@Body() body: unknown, @CurrentUser() u: CurrentUserContext) {
    requireFeature(u.plan, "ai.lead-scoring");
    this.ensureLlm("AI scoring is not configured. Set OPENAI_API_KEY.");

    if (hasLeadIds(body) && Array.isArray(body.leadIds)) {
      const { leadIds } = scoreLeadBatchSchema.parse(body);
      const results = await this.scoring.batchScoreLeads(u.orgId, leadIds);
      return { results: Object.fromEntries(results.entries()), scored: results.size };
    }

    const { leadId } = scoreLeadSingleSchema.parse(body);
    const result = await this.scoring.scoreLead(u.orgId, leadId);
    if (!result) throw new NotFoundException("Lead not found or scoring failed");
    return result;
  }

  @Post("predict-deal")
  async predictDeal(
    @Body(new ZodValidationPipe(predictDealSchema)) body: PredictDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.deal-prediction");
    this.ensureLlm("AI prediction is not configured. Set OPENAI_API_KEY.");
    const result = await this.scoring.predictDeal(u.orgId, body.dealId);
    if (!result) throw new NotFoundException("Deal not found or prediction failed");
    return result;
  }

  @Post("churn-risk")
  async churnRisk(
    @Body(new ZodValidationPipe(churnRiskSchema)) body: ChurnRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.churn-risk");
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    const result = await this.scoring.analyzeChurnRisk(u.orgId, body.clientId, {
      openTickets: body.openTickets,
      ticketsLast90Days: body.ticketsLast90Days,
      daysSinceLastActivity: body.daysSinceLastActivity,
    });
    if (!result) throw new NotFoundException("Client not found or analysis failed");
    return result;
  }

  @Post("next-action")
  async nextAction(
    @Body(new ZodValidationPipe(nextActionSchema)) body: NextActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.next-action");
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    const result = await this.scoring.nextBestAction(u.orgId, body.leadId);
    if (!result) throw new NotFoundException("Lead not found or suggestion failed");
    return result;
  }

  @Post("account-summary")
  accountSummary(
    @Body(new ZodValidationPipe(accountSummarySchema)) body: AccountSummaryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.deal-summary");
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return this.brief.accountSummary(u.orgId, body);
  }

  @Post("meeting-prep")
  meetingPrep(
    @Body(new ZodValidationPipe(meetingPrepSchema)) body: MeetingPrepInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.next-action");
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return this.brief.meetingPrep(u.orgId, body);
  }

  @Post("nl-search")
  nlSearch(
    @Body(new ZodValidationPipe(nlSearchSchema)) body: NlSearchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.next-action");
    this.ensureLlm("AI search is not configured. Set OPENAI_API_KEY.");
    return this.brief.nlSearch(u.orgId, body);
  }

  @Post("enrich-lead")
  enrichLead(@Body(new ZodValidationPipe(enrichLeadSchema)) body: EnrichLeadInput) {
    this.ensureLlm("AI not configured");
    return this.content.enrichLead(body);
  }

  @Post("generate-email")
  async generateEmail(
    @Body(new ZodValidationPipe(generateEmailSchema)) body: GenerateEmailInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireFeature(u.plan, "ai.email-drafting");
    this.ensureLlm("AI email generation is not configured. Set OPENAI_API_KEY.");
    return this.content.generateEmail(u.userId, body);
  }

  @Post("objection-handler")
  objectionHandler(@Body(new ZodValidationPipe(objectionHandlerSchema)) body: ObjectionHandlerInput) {
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return this.content.handleObjection(body);
  }

  @Post("sentiment-analysis")
  sentimentAnalysis(@Body(new ZodValidationPipe(sentimentAnalysisSchema)) body: SentimentAnalysisInput) {
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return this.content.analyzeSentiment(body);
  }

  @Post("summarize")
  summarize(@Body(new ZodValidationPipe(summarizeSchema)) body: SummarizeInput) {
    this.ensureLlm("AI not configured");
    return this.content.summarize(body);
  }

  @Post("report-narrator")
  reportNarrator(@Body(new ZodValidationPipe(reportNarratorSchema)) body: ReportNarratorInput) {
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return this.content.narrateReport(body);
  }

  @Get("prioritize-tasks")
  prioritizeTasks(@CurrentUser() u: CurrentUserContext) {
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    return this.aiTasks.prioritizeTasks(u.orgId, u.userId);
  }

  @Get("suggestions")
  async suggestions(
    @Query(new ZodValidationPipe(suggestionsQuerySchema)) query: SuggestionsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    try {
      if (query.type === "tasks" && query.projectId) {
        const projectId = parseInt(query.projectId, 10);
        if (Number.isNaN(projectId) || projectId <= 0) {
          throw new BadRequestException("Invalid projectId");
        }
        const suggestions = await this.aiTasks.suggestTaskAssignments(u.orgId, projectId);
        return { suggestions };
      }
      if (query.type === "workload") {
        const workload = await this.aiTasks.analyzeWorkload(u.orgId);
        return { workload };
      }
      throw new BadRequestException("Invalid type");
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Internal Server Error");
    }
  }
}
