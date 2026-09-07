import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, dealActivities, deals } from "../../../../db/schema";
import { businessParties, leadPartyMap } from "../../../../db/schema/party";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  INCLUDE_DELETED,
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadIdIs,
  leadPartyScope,
} from "../../../leads/lead-party-reader";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { OrgFeaturesService } from "./org-features.service";
import { CrmContentService } from "./crm-content.service";
import { CrmPipelineService } from "./crm-pipeline.service";
import { CrmCopilotLeadService } from "./crm-copilot-lead.service";
import { ConversationSummarySchema, DealInsightsSchema, type DealInsights } from "../dto/output.schemas";
import { throwOnAiFailure } from "./gateway-result.util";

interface CitationItem {
  id: string;
  title: string;
  snippet: string;
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

@Injectable()
export class CrmCopilotService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly content: CrmContentService,
    private readonly pipeline: CrmPipelineService,
    private readonly leadCopilot: CrmCopilotLeadService,
  ) {}

  private async auditAiAction(
    orgId: string,
    userId: string,
    action: string,
    targetType: string,
    targetId: string,
  ): Promise<void> {
    await runInTenantTransaction(this.db, async (tx) => {
      await tx.insert(auditLogs).values({
        action,
        userId,
        orgId,
        targetId,
        targetType,
        metadata: { source: "crm-copilot" },
      });
    }, { orgId });
  }

  leadSummary(orgId: string, leadId: number, userId: string) {
    return this.leadCopilot.leadSummary(orgId, leadId, userId);
  }

  leadSummaryWithCitations(orgId: string, leadId: number, userId: string) {
    return this.leadCopilot.leadSummaryWithCitations(orgId, leadId, userId);
  }

  nextBestActionsAcrossPipeline(orgId: string, userId: string, limit: number) {
    return this.leadCopilot.nextBestActionsAcrossPipeline(orgId, userId, limit);
  }

  duplicateSuggestionsForLead(orgId: string, leadId: number, userId: string) {
    return this.leadCopilot.duplicateSuggestionsForLead(orgId, leadId, userId);
  }

  async dealSummary(orgId: string, dealId: number, userId: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const ctx = await runInTenantTransaction(this.db, async (tx) => {
      const [[deal], activities] = await Promise.all([
        tx
          .select({
            id: deals.id,
            name: deals.name,
            value: deals.value,
            stage: deals.stage,
            probability: deals.probability,
            contactPerson: deals.contactPerson,
            expectedCloseDate: deals.expectedCloseDate,
            notes: deals.notes,
          })
          .from(deals)
          .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt))),
        tx
          .select({
            type: dealActivities.type,
            subject: dealActivities.subject,
            notes: dealActivities.notes,
            createdAt: dealActivities.createdAt,
          })
          .from(dealActivities)
          .where(eq(dealActivities.dealId, dealId))
          .orderBy(desc(dealActivities.createdAt))
          .limit(10),
      ]);
      return { deal: deal ?? null, activities };
    }, { orgId });

    if (!ctx.deal) throw new NotFoundException("Deal not found");
    const { deal, activities } = ctx;

    const activitiesText = activities.length === 0
      ? "No activities recorded."
      : activities.map((a) => {
          const d = a.createdAt ? new Date(a.createdAt).toLocaleDateString("en-IN") : "?";
          return `[${d}] ${a.type}${a.subject ? `: ${a.subject}` : ""}${a.notes ? ` — ${truncate(a.notes, 200)}` : ""}`;
        }).join("\n");

    const userPrompt = `Analyze this CRM deal and provide structured insights.

Deal: ${deal.name}
Value: ${deal.value ?? "0"}
Stage: ${deal.stage}
Win Probability: ${deal.probability}%
Contact: ${deal.contactPerson ?? "N/A"}
Expected Close: ${deal.expectedCloseDate ?? "Not set"}
Notes: ${truncate(deal.notes, 500)}

Recent Activities:
${truncate(activitiesText, 1500)}`;

    const result = await this.gateway.invokeStructured<DealInsights>({
      actor: { orgId, userId },
      feature: "crm.copilot.summary",
      prompt: {
        system: "You are a B2B deal analyst. Provide structured deal health analysis. Return JSON matching the schema exactly.",
        user: userPrompt,
      },
      schema: DealInsightsSchema,
      tier: "standard",
      maxTokens: 512,
      charge: true,
      dedupe: true,
    });

    if (!result.ok) throwOnAiFailure(result);

    await this.auditAiAction(orgId, userId, "ai.crm.deal_summary", "deal", String(dealId));

    return { stage: deal.stage, ...result.data, generatedAt: new Date().toISOString() };
  }

  async emailDraftForEntity(
    orgId: string,
    userId: string,
    input: { entityType: "lead" | "deal"; entityId: number; intent: string; tone: "formal" | "friendly" | "urgent" },
  ) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiEmailDraft) throw new ForbiddenException("AI email draft is disabled for this organization");

    const entityCtx = await runInTenantTransaction(this.db, async (tx) => {
      if (input.entityType === "lead") {
        const [lead] = await tx
          .select({
            name: LEAD_PARTY_COLUMNS.name,
            company: LEAD_PARTY_COLUMNS.company,
            designation: LEAD_PARTY_COLUMNS.designation,
            potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
            status: LEAD_PARTY_COLUMNS.status,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIs(input.entityId)));
        if (!lead) throw new NotFoundException("Lead not found");
        return { entityName: lead.name, company: lead.company, contextLine: `Status: ${lead.status}, Value: ${lead.potentialValue ?? "N/A"}` };
      } else {
        const [deal] = await tx
          .select({ name: deals.name, contactPerson: deals.contactPerson, value: deals.value, stage: deals.stage })
          .from(deals)
          .where(and(eq(deals.id, input.entityId), eq(deals.orgId, orgId), isNull(deals.deletedAt)));
        if (!deal) throw new NotFoundException("Deal not found");
        const company: string | null = null;
        return { entityName: deal.contactPerson ?? deal.name, company, contextLine: `Deal: ${deal.name}, Stage: ${deal.stage}, Value: ${deal.value}` };
      }
    }, { orgId });

    const actor = { orgId, userId };
    const draft = await this.content.generateEmail(userId, {
      leadName: entityCtx.entityName,
      company: entityCtx.company ?? undefined,
      tone: input.tone,
      context: `Intent: ${input.intent}. ${entityCtx.contextLine}`,
    }, actor);

    await this.auditAiAction(orgId, userId, "ai.crm.email_draft", input.entityType, String(input.entityId));

    const email = "variations" in draft ? Object.values(draft.variations ?? {})[0] : draft;
    return { subject: email?.subject ?? "", body: email?.body ?? "", generatedAt: new Date().toISOString() };
  }

  async summarizeNotes(orgId: string, userId: string, text: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiChat) throw new ForbiddenException("AI features are disabled for this organization");

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "crm.copilot.notes",
      prompt: {
        system: `You are a sales assistant. Summarize meeting/call notes into structured insights.
Return JSON with summary, keyPoints, actionItems, objections, sentiment.`,
        user: truncate(text, 6000),
      },
      schema: ConversationSummarySchema.extend({ objections: z.array(z.string()).default([]) }),
      tier: "fast",
      maxTokens: 512,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    const data = result.data;

    return {
      summary: data.summary,
      actionItems: data.actionItems,
      objections: data.objections ?? [],
      sentiment: data.sentiment,
    };
  }

  async objectionHelp(orgId: string, userId: string, input: { objection: string; context?: string }) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiChat) throw new ForbiddenException("AI features are disabled for this organization");

    const actor = { orgId, userId };
    return this.content.handleObjection({
      objection: input.objection,
      dealStage: "Unknown",
      ...(input.context ? { productName: undefined } : {}),
    }, actor);
  }

  async dealSummaryWithCitations(orgId: string, dealId: number, userId: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const { deal, citations } = await runInTenantTransaction(this.db, async (tx) => {
      const [[deal], activities] = await Promise.all([
        tx
          .select({ id: deals.id, name: deals.name, stage: deals.stage, value: deals.value, probability: deals.probability, assignedToId: deals.assignedToId })
          .from(deals)
          .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt))),
        tx
          .select({ createdAt: dealActivities.createdAt })
          .from(dealActivities)
          .where(eq(dealActivities.dealId, dealId))
          .orderBy(desc(dealActivities.createdAt))
          .limit(10),
      ]);

      const emptyCitations: CitationItem[] = [];
      if (!deal) return { deal: null, citations: emptyCitations };

      const built: CitationItem[] = [
        { id: `deal-stage-${dealId}`, title: "Deal Stage & Value", snippet: `Stage: ${deal.stage}, Value: ₹${Number(deal.value ?? 0).toLocaleString("en-IN")}` },
        { id: `deal-probability-${dealId}`, title: "Win Probability", snippet: `Current probability: ${deal.probability}%` },
      ];
      if (activities.length > 0) {
        built.push({
          id: `deal-activity-${dealId}`,
          title: "Activity History",
          snippet: `${activities.length} activities. Latest: ${activities[0]?.createdAt ? new Date(activities[0].createdAt).toLocaleDateString("en-IN") : "N/A"}`,
        });
      }

      return { deal, citations: built };
    }, { orgId });

    if (!deal) throw new NotFoundException("Deal not found");

    const base = await this.dealSummary(orgId, dealId, userId);
    return { ...base, citations };
  }

  stalePipelineDigest(orgId: string, userId: string, inactiveDays?: number) {
    return runInTenantTransaction(this.db, () => this.pipeline.stalePipelineDigest(orgId, userId, inactiveDays), { orgId });
  }

  dataQualityCopilot(orgId: string, userId: string) {
    return runInTenantTransaction(this.db, () => this.pipeline.dataQualityCopilot(orgId, userId), { orgId });
  }
}
