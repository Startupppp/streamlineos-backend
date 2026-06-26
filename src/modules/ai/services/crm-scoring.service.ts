import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, max } from "drizzle-orm";
import {
  clients,
  dealActivities,
  deals,
  leadActivities,
  leads,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { LlmService } from "../providers/llm.service";
import {
  churnRiskPrompt,
  dealPredictionPrompt,
  leadScoringPrompt,
  nextActionPrompt,
} from "../prompts/crm.prompts";
import {
  ChurnRiskSchema,
  DealPredictionSchema,
  LeadScoreSchema,
  NextActionSchema,
  type ChurnRiskResult,
  type DealPredictionResult,
  type LeadScoreResult,
  type NextActionResult,
} from "../dto/output.schemas";

interface ChurnContext {
  openTickets?: number;
  ticketsLast90Days?: number;
  daysSinceLastActivity?: number | null;
}

@Injectable()
export class CrmScoringService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
  ) {}

  async scoreLead(orgId: string, leadId: number): Promise<LeadScoreResult | null> {
    const [lead] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));
    if (!lead) return null;

    const [activityResult] = await this.db
      .select({ count: count() })
      .from(leadActivities)
      .where(eq(leadActivities.leadId, leadId));

    const daysSinceCreated = lead.createdAt
      ? Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    const prompt = leadScoringPrompt({
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      company: lead.company,
      designation: lead.designation,
      city: lead.city,
      source: lead.source,
      priority: lead.priority,
      potentialValue: lead.potentialValue,
      investmentInterest: lead.investmentInterest,
      notes: lead.notes,
      tags: lead.tags,
      daysSinceCreated,
      activityCount: activityResult?.count ?? 0,
      hasAssignee: Boolean(lead.assignedToId),
    });

    const result = await this.llm.invokeStructured({
      model: "fast",
      schema: LeadScoreSchema,
      schemaName: "lead_score",
      system: prompt.system,
      user: prompt.user,
    });

    result.score = Math.max(0, Math.min(100, Math.round(result.score)));

    await this.db
      .update(leads)
      .set({ score: result.score, updatedAt: new Date() })
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

    return result;
  }

  async batchScoreLeads(orgId: string, leadIds: number[]): Promise<Map<number, LeadScoreResult>> {
    const results = new Map<number, LeadScoreResult>();
    for (const leadId of leadIds) {
      try {
        const result = await this.scoreLead(orgId, leadId);
        if (result) results.set(leadId, result);
      } catch (error) {
        logger.error(`[ai-score] Failed to score lead ${leadId}`, { error });
      }
    }
    return results;
  }

  async predictDeal(orgId: string, dealId: number): Promise<DealPredictionResult | null> {
    const [deal] = await this.db
      .select()
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)));
    if (!deal) return null;

    const [activityStats] = await this.db
      .select({ count: count(), lastDate: max(dealActivities.createdAt) })
      .from(dealActivities)
      .where(eq(dealActivities.dealId, dealId));

    const now = new Date();
    const createdAt = deal.createdAt ? new Date(deal.createdAt) : now;
    const daysInPipeline = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    const updatedAt = deal.updatedAt ? new Date(deal.updatedAt) : createdAt;
    const daysInCurrentStage = Math.floor((now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));

    const lastActivityDate = activityStats?.lastDate ? new Date(activityStats.lastDate) : null;
    const lastActivityDaysAgo = lastActivityDate
      ? Math.floor((now.getTime() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const expectedClose = deal.expectedCloseDate ? new Date(deal.expectedCloseDate) : null;
    const daysUntilExpectedClose = expectedClose
      ? Math.floor((expectedClose.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const prompt = dealPredictionPrompt({
      dealName: deal.name,
      value: Number(deal.value ?? 0),
      stage: deal.stage,
      probability: deal.probability ?? 0,
      daysInPipeline,
      daysInCurrentStage,
      activityCount: activityStats?.count ?? 0,
      lastActivityDaysAgo,
      contactPerson: deal.contactPerson,
      assignedTo: deal.assignedToId,
      hasExpectedCloseDate: Boolean(expectedClose),
      daysUntilExpectedClose,
      notes: deal.notes,
    });

    const result = await this.llm.invokeStructured({
      model: "fast",
      schema: DealPredictionSchema,
      schemaName: "deal_prediction",
      system: prompt.system,
      user: prompt.user,
    });

    result.winProbability = Math.max(0, Math.min(100, Math.round(result.winProbability)));

    await this.db
      .update(deals)
      .set({ probability: result.winProbability, updatedAt: new Date() })
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)));

    return result;
  }

  async analyzeChurnRisk(
    orgId: string,
    clientId: number,
    context?: ChurnContext,
  ): Promise<ChurnRiskResult | null> {
    const [client] = await this.db
      .select()
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.orgId, orgId)));
    if (!client) return null;

    const now = new Date();
    const convertedAt = client.convertedAt
      ? new Date(client.convertedAt)
      : client.createdAt
        ? new Date(client.createdAt)
        : now;
    const daysSinceConversion = Math.floor((now.getTime() - convertedAt.getTime()) / (1000 * 60 * 60 * 24));

    const prompt = churnRiskPrompt({
      clientName: client.name,
      company: client.company,
      healthScore: client.healthScore ?? 50,
      investmentValue: client.investmentValue ? Number(client.investmentValue) : null,
      daysSinceLastActivity: context?.daysSinceLastActivity ?? null,
      openTickets: context?.openTickets ?? 0,
      totalTicketsLast90Days: context?.ticketsLast90Days ?? 0,
      accountManagerName: null,
      status: client.status,
      daysSinceConversion,
    });

    const result = await this.llm.invokeStructured({
      model: "fast",
      schema: ChurnRiskSchema,
      schemaName: "churn_risk",
      system: prompt.system,
      user: prompt.user,
    });

    result.churnRiskScore = Math.max(0, Math.min(100, Math.round(result.churnRiskScore)));

    const healthStatus =
      result.churnRiskScore >= 70 ? "critical" : result.churnRiskScore >= 40 ? "at_risk" : "healthy";
    const healthScore = Math.max(0, 100 - result.churnRiskScore);

    await this.db
      .update(clients)
      .set({
        healthScore,
        healthStatus,
        churnRiskScore: result.churnRiskScore,
        churnRiskReasoning: result.reasoning,
        lastHealthCheck: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(clients.id, clientId), eq(clients.orgId, orgId)));

    return result;
  }

  async nextBestAction(orgId: string, leadId: number): Promise<NextActionResult | null> {
    const [lead] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));
    if (!lead) return null;

    const [lastActivity] = await this.db
      .select()
      .from(leadActivities)
      .where(eq(leadActivities.leadId, leadId))
      .orderBy(desc(leadActivities.date))
      .limit(1);

    const now = new Date();
    const lastActivityDate = lastActivity?.date ? new Date(lastActivity.date) : null;
    const daysSinceLastActivity = lastActivityDate
      ? Math.floor((now.getTime() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const followUpDate = lead.followUpDate ? new Date(lead.followUpDate) : null;
    const isOverdue = followUpDate ? followUpDate < now : false;

    const prompt = nextActionPrompt({
      entityType: "lead",
      name: lead.name,
      status: lead.status,
      priority: lead.priority,
      lastActivityType: lastActivity?.type ?? null,
      lastActivityDate: lastActivity?.date ? new Date(lastActivity.date).toISOString().split("T")[0] : null,
      daysSinceLastActivity,
      value: lead.potentialValue ? Number(lead.potentialValue) : null,
      assignedTo: lead.assignedToId,
      followUpDate: followUpDate?.toISOString().split("T")[0] ?? null,
      isOverdueFollowUp: isOverdue,
      notes: lead.notes,
    });

    return this.llm.invokeStructured({
      model: "fast",
      schema: NextActionSchema,
      schemaName: "next_action",
      system: prompt.system,
      user: prompt.user,
    });
  }
}
