import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, max } from "drizzle-orm";
import { dealActivities, deals, leadActivities, leads, clients } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { getFeatureCost } from "../billing/ai-cost-catalog";
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
  NextActionWithEvidenceSchema,
  type ChurnRiskResult,
  type DealPredictionResult,
  type LeadScoreResult,
  type NextActionResult,
  type NextActionWithEvidenceResult,
  type EvidenceItem,
} from "../dto/output.schemas";
import { throwOnAiFailure } from "./gateway-result.util";

interface ChurnContext {
  openTickets?: number;
  ticketsLast90Days?: number;
  daysSinceLastActivity?: number | null;
}

const MAX_NOTES = 2000;

function trunc(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > MAX_NOTES ? s.slice(0, MAX_NOTES) + "…" : s;
}

@Injectable()
export class CrmScoringService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async scoreLead(orgId: string, leadId: number, userId?: string): Promise<LeadScoreResult | null> {
    const [[lead], [activityResult]] = await Promise.all([
      this.db
        .select({
          id: leads.id,
          name: leads.name,
          email: leads.email,
          phone: leads.phone,
          company: leads.company,
          designation: leads.designation,
          city: leads.city,
          source: leads.source,
          priority: leads.priority,
          potentialValue: leads.potentialValue,
          investmentInterest: leads.investmentInterest,
          notes: leads.notes,
          tags: leads.tags,
          createdAt: leads.createdAt,
          assignedToId: leads.assignedToId,
        })
        .from(leads)
        .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId))),
      this.db
        .select({ count: count() })
        .from(leadActivities)
        .where(eq(leadActivities.leadId, leadId)),
    ]);

    if (!lead) return null;

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
      notes: trunc(lead.notes),
      tags: lead.tags,
      daysSinceCreated,
      activityCount: activityResult?.count ?? 0,
      hasAssignee: Boolean(lead.assignedToId),
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.score-lead",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.lead_scoring", promptVersion: 1 },
      schema: LeadScoreSchema,
      tier: "fast",
      maxTokens: 512,
      charge: { credits: getFeatureCost("crm.score-lead") },
    });

    if (!result.ok) throwOnAiFailure(result);
    const data = result.data;
    data.score = Math.max(0, Math.min(100, Math.round(data.score)));

    await this.db
      .update(leads)
      .set({ score: data.score, updatedAt: new Date() })
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));

    return data;
  }

  async batchScoreLeads(orgId: string, leadIds: number[], userId?: string): Promise<Map<number, LeadScoreResult>> {
    const capped = leadIds.slice(0, 50);
    const results = new Map<number, LeadScoreResult>();
    for (const leadId of capped) {
      try {
        const result = await this.scoreLead(orgId, leadId, userId);
        if (result) results.set(leadId, result);
      } catch (error) {
        logger.error(`[ai-score] Failed to score lead ${leadId}`, { error });
      }
    }
    return results;
  }

  async predictDeal(orgId: string, dealId: number, userId?: string): Promise<DealPredictionResult | null> {
    const [[deal], [activityStats]] = await Promise.all([
      this.db
        .select({
          id: deals.id,
          name: deals.name,
          value: deals.value,
          stage: deals.stage,
          probability: deals.probability,
          createdAt: deals.createdAt,
          updatedAt: deals.updatedAt,
          expectedCloseDate: deals.expectedCloseDate,
          contactPerson: deals.contactPerson,
          assignedToId: deals.assignedToId,
          notes: deals.notes,
        })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId))),
      this.db
        .select({ count: count(), lastDate: max(dealActivities.createdAt) })
        .from(dealActivities)
        .where(eq(dealActivities.dealId, dealId)),
    ]);

    if (!deal) return null;

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
      notes: trunc(deal.notes),
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.predict-deal",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.deal_prediction", promptVersion: 1 },
      schema: DealPredictionSchema,
      tier: "fast",
      maxTokens: 512,
      charge: { credits: getFeatureCost("crm.predict-deal") },
    });

    if (!result.ok) throwOnAiFailure(result);
    const data = result.data;
    data.winProbability = Math.max(0, Math.min(100, Math.round(data.winProbability)));

    await this.db
      .update(deals)
      .set({ probability: data.winProbability, updatedAt: new Date() })
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)));

    return data;
  }

  async analyzeChurnRisk(
    orgId: string,
    clientId: number,
    context?: ChurnContext,
    userId?: string,
  ): Promise<ChurnRiskResult | null> {
    const [client] = await this.db
      .select({
        id: clients.id,
        name: clients.name,
        company: clients.company,
        healthScore: clients.healthScore,
        investmentValue: clients.investmentValue,
        convertedAt: clients.convertedAt,
        createdAt: clients.createdAt,
        status: clients.status,
      })
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

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.churn-risk",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.churn_risk", promptVersion: 1 },
      schema: ChurnRiskSchema,
      tier: "fast",
      maxTokens: 512,
      charge: { credits: getFeatureCost("crm.churn-risk") },
    });

    if (!result.ok) throwOnAiFailure(result);
    const data = result.data;
    data.churnRiskScore = Math.max(0, Math.min(100, Math.round(data.churnRiskScore)));

    const healthStatus =
      data.churnRiskScore >= 70 ? "critical" : data.churnRiskScore >= 40 ? "at_risk" : "healthy";
    const healthScore = Math.max(0, 100 - data.churnRiskScore);

    await this.db
      .update(clients)
      .set({
        healthScore,
        healthStatus,
        churnRiskScore: data.churnRiskScore,
        churnRiskReasoning: data.reasoning,
        lastHealthCheck: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(clients.id, clientId), eq(clients.orgId, orgId)));

    return data;
  }

  async nextBestAction(orgId: string, leadId: number, userId?: string): Promise<NextActionResult | null> {
    const [[lead], [lastActivity]] = await Promise.all([
      this.db
        .select({
          id: leads.id,
          name: leads.name,
          status: leads.status,
          priority: leads.priority,
          potentialValue: leads.potentialValue,
          assignedToId: leads.assignedToId,
          followUpDate: leads.followUpDate,
          notes: leads.notes,
        })
        .from(leads)
        .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId))),
      this.db
        .select({ type: leadActivities.type, date: leadActivities.date })
        .from(leadActivities)
        .where(eq(leadActivities.leadId, leadId))
        .orderBy(desc(leadActivities.date))
        .limit(1),
    ]);

    if (!lead) return null;

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
      notes: trunc(lead.notes),
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.next-action",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.next_action", promptVersion: 1 },
      schema: NextActionSchema,
      tier: "fast",
      maxTokens: 512,
      charge: { credits: getFeatureCost("crm.next-action") },
    });

    if (!result.ok) throwOnAiFailure(result);
    return result.data;
  }

  async nextBestActionWithEvidence(orgId: string, leadId: number, userId?: string): Promise<NextActionWithEvidenceResult | null> {
    const [[lead], [lastActivity], recentActivities] = await Promise.all([
      this.db
        .select({
          id: leads.id,
          name: leads.name,
          status: leads.status,
          priority: leads.priority,
          potentialValue: leads.potentialValue,
          assignedToId: leads.assignedToId,
          followUpDate: leads.followUpDate,
          notes: leads.notes,
          source: leads.source,
          company: leads.company,
          email: leads.email,
          score: leads.score,
        })
        .from(leads)
        .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId))),
      this.db
        .select({ type: leadActivities.type, date: leadActivities.date, outcome: leadActivities.outcome })
        .from(leadActivities)
        .where(eq(leadActivities.leadId, leadId))
        .orderBy(desc(leadActivities.date))
        .limit(1),
      this.db
        .select({ type: leadActivities.type, date: leadActivities.date, outcome: leadActivities.outcome })
        .from(leadActivities)
        .where(eq(leadActivities.leadId, leadId))
        .orderBy(desc(leadActivities.date))
        .limit(3),
    ]);

    if (!lead) return null;

    const now = new Date();
    const lastActivityDate = lastActivity?.date ? new Date(lastActivity.date) : null;
    const daysSinceLastActivity = lastActivityDate
      ? Math.floor((now.getTime() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const followUpDate = lead.followUpDate ? new Date(lead.followUpDate) : null;
    const isOverdueFollowUp = followUpDate ? followUpDate < now : false;

    const evidence: EvidenceItem[] = [];
    if (daysSinceLastActivity !== null) {
      evidence.push({ kind: "activity", label: "Days since last contact", value: String(daysSinceLastActivity) });
    }
    if (lead.score !== null && lead.score !== undefined) {
      evidence.push({ kind: "signal", label: "AI lead score", value: String(lead.score) });
    }
    if (isOverdueFollowUp) {
      evidence.push({ kind: "signal", label: "Follow-up overdue", value: "Yes" });
    }
    if (lead.status) {
      evidence.push({ kind: "field", label: "Status", value: lead.status });
    }

    const recentActivityText = recentActivities.length === 0
      ? "No recent activities."
      : recentActivities.map((a) => {
          const d = a.date ? new Date(a.date).toLocaleDateString("en-IN") : "?";
          return `[${d}] ${a.type}${a.outcome ? ` | ${a.outcome}` : ""}`;
        }).join("\n");

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
      isOverdueFollowUp,
      notes: trunc(lead.notes),
    });

    const evidenceSummary = evidence.map((e) => `${e.label}: ${e.value}`).join("; ");
    const enhancedUser = `${prompt.user}\n\nDetected signals: ${evidenceSummary}\nRecent activities:\n${recentActivityText}\nSource: ${lead.source ?? "N/A"}, Company: ${lead.company ?? "N/A"}`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.next-action",
      prompt: { system: prompt.system, user: enhancedUser, promptKey: "crm.next_action_evidence", promptVersion: 1 },
      schema: NextActionWithEvidenceSchema,
      tier: "fast",
      maxTokens: 600,
      charge: { credits: getFeatureCost("crm.next-action") },
    });

    if (!result.ok) throwOnAiFailure(result);
    return result.data;
  }
}
