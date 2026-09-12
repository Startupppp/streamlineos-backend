import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, isNull, max } from "drizzle-orm";
import { dealActivities, deals } from "../../../../db/schema";
import { businessParties, clientPartyMap } from "../../../../db/schema/party";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../../common/tenant/tenant-context";
import { CacheService } from "../../../../common/cache/cache.service";
import {
  CLIENT_PARTY_COLUMNS,
  CLIENT_PARTY_JOIN,
  clientIdIs,
  clientPartyScope,
} from "../../../clients/client-party-reader";
import { AiGatewayService } from "../gateway/ai-gateway.service";

import { churnRiskPrompt, dealPredictionPrompt } from "../prompts/crm-scoring.prompts";
import {
  ChurnRiskSchema,
  DealPredictionSchema,
  type ChurnRiskResult,
  type DealPredictionResult,
  type LeadScoreResult,
  type NextActionResult,
  type NextActionWithEvidenceResult,
} from "../dto/output.schemas";
import { throwOnAiFailure } from "./gateway-result.util";
import { updateMirroredClients } from "../../../party/party-legacy-clients";
import {
  batchScoreLeads,
  scoreLead,
  trunc,
  type LeadScoringDeps,
} from "./lib/crm-lead-scoring";
import { nextBestAction, nextBestActionWithEvidence } from "./lib/crm-next-action";

interface ChurnContext {
  openTickets?: number;
  ticketsLast90Days?: number;
  daysSinceLastActivity?: number | null;
}

/**
 * The CRM's AI scoring, over three subjects that share nothing but a gateway.
 *
 * A lead, a deal and a client each arrive through a different reader and leave
 * through a different writer: the lead projection in `lead-party-reader.ts`
 * writing back through the lead mirror, `deals` read and updated in place, and
 * the client projection writing the client mirror and invalidating two health
 * caches. The lead half is out in `lib/`, split again by what it leaves behind —
 * `crm-lead-scoring.ts` persists a score, `crm-next-action.ts` returns advice and
 * writes nothing. Nothing left in this file mentions the lead projection.
 *
 * Every method keeps a delegate here because the DI graph is the public
 * surface: `crm-ai.controller.ts` and `crm-copilot-lead.service.ts` both inject
 * this class.
 */
@Injectable()
export class CrmScoringService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly cache: CacheService,
  ) {}

  private get leadDeps(): LeadScoringDeps {
    return { db: this.db, gateway: this.gateway };
  }

  scoreLead(orgId: string, leadId: number, userId?: string): Promise<LeadScoreResult | null> {
    return scoreLead(this.leadDeps, orgId, leadId, userId);
  }

  batchScoreLeads(orgId: string, leadIds: number[], userId?: string): Promise<Map<number, LeadScoreResult>> {
    return batchScoreLeads(this.leadDeps, orgId, leadIds, userId);
  }

  nextBestAction(orgId: string, leadId: number, userId?: string): Promise<NextActionResult | null> {
    return nextBestAction(this.leadDeps, orgId, leadId, userId);
  }

  nextBestActionWithEvidence(orgId: string, leadId: number, userId?: string): Promise<NextActionWithEvidenceResult | null> {
    return nextBestActionWithEvidence(this.leadDeps, orgId, leadId, userId);
  }

  async predictDeal(orgId: string, dealId: number, userId?: string): Promise<DealPredictionResult | null> {
    const ctx = await runInTenantTransaction(this.db, async (tx) => {
      const [[deal], [activityStats]] = await Promise.all([
        tx
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
          .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt))),
        tx
          .select({ count: count(), lastDate: max(dealActivities.createdAt) })
          .from(dealActivities)
          .where(eq(dealActivities.dealId, dealId)),
      ]);
      return { deal: deal ?? null, activityStats: activityStats ?? null };
    }, { orgId });

    if (!ctx.deal) return null;
    const { deal, activityStats } = ctx;

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
      // The same prompt budget the lead paths spend, imported from where its
      // other three call sites live rather than re-picked here.
      notes: trunc(deal.notes),
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.predict-deal",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.deal_prediction", promptVersion: 1 },
      schema: DealPredictionSchema,
      tier: "fast",
      maxTokens: 512,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    const data = result.data;
    data.winProbability = Math.max(0, Math.min(100, Math.round(data.winProbability)));

    await runInTenantTransaction(this.db, async (tx) => {
      await tx
        .update(deals)
        .set({ probability: data.winProbability, updatedAt: new Date() })
        .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)));
    }, { orgId });

    return data;
  }

  async analyzeChurnRisk(
    orgId: string,
    clientId: number,
    context?: ChurnContext,
    userId?: string,
  ): Promise<ChurnRiskResult | null> {
    const client = await runInTenantTransaction(this.db, async (tx) => {
      const [row] = await tx
        .select({
          id: CLIENT_PARTY_COLUMNS.id,
          name: CLIENT_PARTY_COLUMNS.name,
          company: CLIENT_PARTY_COLUMNS.company,
          healthScore: CLIENT_PARTY_COLUMNS.healthScore,
          investmentValue: CLIENT_PARTY_COLUMNS.investmentValue,
          convertedAt: CLIENT_PARTY_COLUMNS.convertedAt,
          createdAt: CLIENT_PARTY_COLUMNS.createdAt,
          status: CLIENT_PARTY_COLUMNS.status,
        })
        .from(clientPartyMap)
        .innerJoin(businessParties, CLIENT_PARTY_JOIN)
        .where(and(...clientPartyScope(orgId), clientIdIs(clientId)));
      return row ?? null;
    }, { orgId });

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
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    const data = result.data;
    data.churnRiskScore = Math.max(0, Math.min(100, Math.round(data.churnRiskScore)));

    const healthStatus =
      data.churnRiskScore >= 70 ? "critical" : data.churnRiskScore >= 40 ? "at_risk" : "healthy";
    const healthScore = Math.max(0, 100 - data.churnRiskScore);

    await runInTenantTransaction(this.db, async (tx) => {
      await updateMirroredClients(tx, orgId, [clientId], {
        healthScore,
        healthStatus,
        churnRiskScore: data.churnRiskScore,
        churnRiskReasoning: data.reasoning,
        lastHealthCheck: new Date(),
        updatedAt: new Date(),
      });
    }, { orgId });

    const invalidate = () => Promise.all([
      this.cache.invalidateNamespaceForOrg(orgId, "clients:health"),
      this.cache.invalidateNamespaceForOrg(orgId, "clients:churn"),
    ]);
    if (!registerAfterCommit(invalidate)) await invalidate();

    return data;
  }
}
