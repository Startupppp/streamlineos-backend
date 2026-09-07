import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { LlmService } from "../providers/llm.service";
import { CrmScoringService } from "../services/crm-scoring.service";
import { CrmContentService } from "../services/crm-content.service";
import { CrmBriefService } from "../services/crm-brief.service";
import { CrmTasksService } from "../services/crm-tasks.service";
import { OrgFeaturesService } from "../services/org-features.service";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { auditLogs } from "../../../../db/schema";
import {
  accountSummarySchema,
  churnRiskSchema,
  enrichLeadSchema,
  generateEmailSchema,
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
  type NextActionInput,
  type NlSearchInput,
  type ObjectionHandlerInput,
  type PredictDealInput,
  type ReportNarratorInput,
  type SentimentAnalysisInput,
  type SuggestionsQueryInput,
  type SummarizeInput,
} from "../dto/request.schemas";
import { AiRequestAbortInterceptor, respondWithAiTextStream } from "../streaming";
import { ApiOkResponse } from "@nestjs/swagger";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import {
  scoreLeadResponseSchema,
  predictDealResponseSchema,
  churnRiskResponseSchema,
  nextActionResponseSchema,
  accountSummaryResponseSchema,
  nlSearchResponseSchema,
  enrichLeadResponseSchema,
  generateEmailResponseSchema,
  objectionHandlerResponseSchema,
  sentimentAnalysisResponseSchema,
  summarizeResponseSchema,
  reportNarratorResponseSchema,
  prioritizeTasksResponseSchema,
  suggestionsResponseSchema,
} from "../dto/ai-response.schemas";

const scoreLeadBodySchema = z.union([scoreLeadBatchSchema, scoreLeadSingleSchema]);

function hasLeadIds(body: unknown): body is { leadIds: unknown } {
  return typeof body === "object" && body !== null && "leadIds" in body;
}

@Controller("ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@RequirePermission("crm:ai:use")
@UseRateLimit("ai:invoke")
@NoTenantTransaction()
@UseInterceptors(AiRequestAbortInterceptor)
export class CrmAiController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
    private readonly scoring: CrmScoringService,
    private readonly content: CrmContentService,
    private readonly brief: CrmBriefService,
    private readonly aiTasks: CrmTasksService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  private ensureLlm(message: string): void {
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException(message);
  }

  private async requireAiFlag(orgId: string, flag: "aiLeadScoring" | "aiEmailDraft" | "aiChat"): Promise<void> {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags[flag]) {
      throw new ForbiddenException("AI features are disabled for this organization");
    }
  }

  private auditAiAction(orgId: string, userId: string, action: string, targetType: string, targetId: string): Promise<void> {
    return runInTenantTransaction(this.db, async (tx) => {
      await tx.insert(auditLogs).values({
        action,
        userId,
        orgId,
        targetId,
        targetType,
        metadata: { source: "crm-ai" },
      });
    }, { orgId });
  }

  @Post("score-lead")
  @ResponseSchema(scoreLeadResponseSchema)
  @Validate({ body: scoreLeadBodySchema })
  async scoreLead(@Body() body: z.infer<typeof scoreLeadBodySchema>, @CurrentUser() u: CurrentUserContext) {
    await this.requireAiFlag(u.orgId, "aiLeadScoring");
    await this.planLimits.assertFeature(u.orgId, "ai.lead-scoring");
    this.ensureLlm("AI scoring is not configured. Set OPENAI_API_KEY.");

    if (hasLeadIds(body) && Array.isArray(body.leadIds)) {
      const { leadIds } = scoreLeadBatchSchema.parse(body);
      const results = await this.scoring.batchScoreLeads(u.orgId, leadIds);
      return { results: Object.fromEntries(results.entries()), scored: results.size };
    }

    const { leadId } = scoreLeadSingleSchema.parse(body);
    const result = await this.scoring.scoreLead(u.orgId, leadId);
    if (!result) throw new NotFoundException("Lead not found or scoring failed");
    void this.auditAiAction(u.orgId, u.userId, "crm.ai.score_generated", "lead", String(leadId));
    return result;
  }

  @Post("predict-deal")
  @ResponseSchema(predictDealResponseSchema)
  @Validate({ body: predictDealSchema })
  async predictDeal(
    @Body() body: PredictDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiLeadScoring");
    await this.planLimits.assertFeature(u.orgId, "ai.deal-prediction");
    this.ensureLlm("AI prediction is not configured. Set OPENAI_API_KEY.");
    const result = await this.scoring.predictDeal(u.orgId, body.dealId);
    if (!result) throw new NotFoundException("Deal not found or prediction failed");
    void this.auditAiAction(u.orgId, u.userId, "crm.ai.deal_prediction", "deal", String(body.dealId));
    return result;
  }

  @Post("churn-risk")
  @ResponseSchema(churnRiskResponseSchema)
  @Validate({ body: churnRiskSchema })
  async churnRisk(
    @Body() body: ChurnRiskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiLeadScoring");
    await this.planLimits.assertFeature(u.orgId, "ai.churn-risk");
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
  @ResponseSchema(nextActionResponseSchema)
  @Validate({ body: nextActionSchema })
  async nextAction(
    @Body() body: NextActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiLeadScoring");
    await this.planLimits.assertFeature(u.orgId, "ai.next-action");
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    const result = await this.scoring.nextBestAction(u.orgId, body.leadId);
    if (!result) throw new NotFoundException("Lead not found or suggestion failed");
    return result;
  }

  @Post("account-summary")
  @ResponseSchema(accountSummaryResponseSchema)
  @Validate({ body: accountSummarySchema })
  async accountSummary(
    @Body() body: AccountSummaryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiLeadScoring");
    await this.planLimits.assertFeature(u.orgId, "ai.deal-summary");
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return this.brief.accountSummary(u.orgId, body);
  }

  @Post("account-summary/stream")
  @ApiOkResponse({ description: "AI text stream", content: { "text/plain": { schema: { type: "string" } } } })
  @Validate({ body: accountSummarySchema })
  async accountSummaryStream(
    @Req() req: Request,
    @Body() body: AccountSummaryInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    await this.requireAiFlag(u.orgId, "aiLeadScoring");
    await this.planLimits.assertFeature(u.orgId, "ai.deal-summary");
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: "crm.account-summary",
        orgId: u.orgId,
        route: "POST /ai/account-summary/stream",
      },
      async (signal) => this.brief.streamAccountSummary(u.orgId, body, u.userId, signal),
    );
  }

  @Post("nl-search")
  @ResponseSchema(nlSearchResponseSchema)
  @Validate({ body: nlSearchSchema })
  async nlSearch(
    @Body() body: NlSearchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiLeadScoring");
    await this.planLimits.assertFeature(u.orgId, "ai.next-action");
    this.ensureLlm("AI search is not configured. Set OPENAI_API_KEY.");
    return this.brief.nlSearch(u.orgId, body);
  }

  @Post("enrich-lead")
  @ResponseSchema(enrichLeadResponseSchema)
  @Validate({ body: enrichLeadSchema })
  async enrichLead(
    @Body() body: EnrichLeadInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiLeadScoring");
    this.ensureLlm("AI not configured");
    return this.content.enrichLead(body);
  }

  @Post("generate-email")
  @ResponseSchema(generateEmailResponseSchema)
  @Validate({ body: generateEmailSchema })
  async generateEmail(
    @Body() body: GenerateEmailInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiEmailDraft");
    await this.planLimits.assertFeature(u.orgId, "ai.email-drafting");
    this.ensureLlm("AI email generation is not configured. Set OPENAI_API_KEY.");
    return this.content.generateEmail(u.userId, body, { orgId: u.orgId, userId: u.userId });
  }

  @Post("objection-handler")
  @ResponseSchema(objectionHandlerResponseSchema)
  @Validate({ body: objectionHandlerSchema })
  async objectionHandler(
    @Body() body: ObjectionHandlerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiEmailDraft");
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return this.content.handleObjection(body);
  }

  @Post("sentiment-analysis")
  @ResponseSchema(sentimentAnalysisResponseSchema)
  @Validate({ body: sentimentAnalysisSchema })
  async sentimentAnalysis(
    @Body() body: SentimentAnalysisInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiChat");
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return this.content.analyzeSentiment(body);
  }

  @Post("summarize")
  @ResponseSchema(summarizeResponseSchema)
  @Validate({ body: summarizeSchema })
  async summarize(
    @Body() body: SummarizeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiChat");
    this.ensureLlm("AI not configured");
    return this.content.summarize(body);
  }

  @Post("report-narrator")
  @ResponseSchema(reportNarratorResponseSchema)
  @Validate({ body: reportNarratorSchema })
  async reportNarrator(
    @Body() body: ReportNarratorInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiChat");
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return this.content.narrateReport(body);
  }

  @Post("report-narrator/stream")
  @ApiOkResponse({ description: "AI text stream", content: { "text/plain": { schema: { type: "string" } } } })
  @Validate({ body: reportNarratorSchema })
  async reportNarratorStream(
    @Req() req: Request,
    @Body() body: ReportNarratorInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    await this.requireAiFlag(u.orgId, "aiChat");
    this.ensureLlm("AI features are not configured. Set OPENAI_API_KEY.");
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: "crm.report-narrator",
        orgId: u.orgId,
        route: "POST /ai/report-narrator/stream",
      },
      async (signal) =>
        this.content.streamNarrateReport(body, { orgId: u.orgId, userId: u.userId }, signal),
    );
  }

  @Get("prioritize-tasks")
  @ResponseSchema(prioritizeTasksResponseSchema)
  async prioritizeTasks(@CurrentUser() u: CurrentUserContext) {
    await this.requireAiFlag(u.orgId, "aiChat");
    this.ensureLlm("AI is not configured. Set OPENAI_API_KEY.");
    return this.aiTasks.prioritizeTasks(u.orgId, u.userId);
  }

  @Get("suggestions")
  @ResponseSchema(suggestionsResponseSchema)
  @Validate({ query: suggestionsQuerySchema })
  async suggestions(
    @Query() query: SuggestionsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.requireAiFlag(u.orgId, "aiChat");
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
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException("Internal Server Error");
    }
  }
}
