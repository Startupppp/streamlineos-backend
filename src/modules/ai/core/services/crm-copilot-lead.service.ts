import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { leadActivities } from "../../../../db/schema";
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
import { CrmScoringService } from "./crm-scoring.service";
import { findDuplicateLeads } from "../../../leads/duplicate-leads";
import { throwOnAiFailure } from "./gateway-result.util";
import { auditAiAction } from "./crm-copilot-audit";
import { z } from "zod";

interface CitationItem {
  id: string;
  title: string;
  snippet: string;
}

const LeadSummarySchema = z.object({
  summary: z.string(),
  nextBestActions: z.array(z.string()),
});

function urgencyRank(urgency: string): number {
  switch (urgency) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 3;
  }
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

@Injectable()
export class CrmCopilotLeadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly scoring: CrmScoringService,
  ) {}

  async leadSummary(orgId: string, leadId: number, userId: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const ctx = await runInTenantTransaction(this.db, async (tx) => {
      const [[lead], activities] = await Promise.all([
        tx
          .select({
            id: LEAD_PARTY_COLUMNS.id,
            name: LEAD_PARTY_COLUMNS.name,
            email: LEAD_PARTY_COLUMNS.email,
            company: LEAD_PARTY_COLUMNS.company,
            status: LEAD_PARTY_COLUMNS.status,
            priority: LEAD_PARTY_COLUMNS.priority,
            score: LEAD_PARTY_COLUMNS.score,
            potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
            notes: LEAD_PARTY_COLUMNS.notes,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIs(leadId))),
        tx
          .select({
            type: leadActivities.type,
            date: leadActivities.date,
            subject: leadActivities.subject,
            notes: leadActivities.notes,
            outcome: leadActivities.outcome,
          })
          .from(leadActivities)
          .where(eq(leadActivities.leadId, leadId))
          .orderBy(desc(leadActivities.date))
          .limit(10),
      ]);
      return { lead: lead ?? null, activities };
    }, { orgId });

    if (!ctx.lead) throw new NotFoundException("Lead not found");
    const { lead, activities } = ctx;

    const activitiesText = activities.length === 0
      ? "No activities recorded."
      : activities.map((a) => {
          const d = a.date ? new Date(a.date).toLocaleDateString("en-IN") : "?";
          return `[${d}] ${a.type}${a.subject ? `: ${a.subject}` : ""}${a.notes ? ` — ${truncate(a.notes, 200)}` : ""}${a.outcome ? ` | ${a.outcome}` : ""}`;
        }).join("\n");

    const userPrompt = `Summarize this CRM lead and suggest 3 next best actions.

Lead: ${lead.name}
Email: ${lead.email ?? "N/A"}
Company: ${lead.company ?? "N/A"}
Status: ${lead.status}
Priority: ${lead.priority ?? "N/A"}
AI Score: ${lead.score ?? "Not scored"}
Potential Value: ${lead.potentialValue ?? "Not set"}
Notes: ${truncate(lead.notes, 500)}

Recent Activities (newest first):
${truncate(activitiesText, 1500)}`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "crm.copilot.summary",
      prompt: {
        system: "You are a CRM sales assistant. Return valid JSON only matching the requested schema.",
        user: userPrompt,
      },
      schema: LeadSummarySchema,
      tier: "standard",
      maxTokens: 512,
      charge: true,
      dedupe: true,
    });

    if (!result.ok) throwOnAiFailure(result);

    await auditAiAction(this.db, orgId, userId, "ai.crm.lead_summary", "lead", String(leadId));

    return {
      summary: result.data.summary ?? "",
      nextBestActions: result.data.nextBestActions ?? [],
      generatedAt: new Date().toISOString(),
    };
  }

  async nextBestActionsAcrossPipeline(orgId: string, userId: string, limit: number) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const fetchLimit = Math.min(limit * 2, 40);
    const topLeads = await runInTenantTransaction(this.db, (tx) =>
      tx
        .select({
          id: LEAD_PARTY_COLUMNS.id,
          name: LEAD_PARTY_COLUMNS.name,
          score: LEAD_PARTY_COLUMNS.score,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...leadPartyScope(orgId)))
        .orderBy(desc(LEAD_PARTY_COLUMNS.score), desc(LEAD_PARTY_COLUMNS.id))
        .limit(fetchLimit),
      { orgId },
    );

    const results: Array<{ leadId: number; leadName: string; action: string; urgency: string; reasoning: string; evidence: unknown[]; rationale: string }> = [];

    for (const lead of topLeads) {
      try {
        const nba = await this.scoring.nextBestActionWithEvidence(orgId, lead.id, userId);
        if (nba) {
          results.push({ leadId: lead.id, leadName: lead.name, action: nba.action, urgency: nba.urgency, reasoning: nba.reasoning, evidence: nba.evidence, rationale: nba.rationale });
        }
      } catch {
        continue;
      }
    }

    results.sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency));

    return { actions: results.slice(0, limit) };
  }

  async duplicateSuggestionsForLead(orgId: string, leadId: number, userId: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const { lead, allGroups } = await runInTenantTransaction(this.db, async (tx) => {
      const [lead] = await tx
        .select({ id: LEAD_PARTY_COLUMNS.id, name: LEAD_PARTY_COLUMNS.name })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIs(leadId)));

      const emptyGroups: Awaited<ReturnType<typeof findDuplicateLeads>> = [];
      if (!lead) return { lead: null, allGroups: emptyGroups };

      const allGroups = await findDuplicateLeads(this.db, orgId);
      return { lead, allGroups };
    }, { orgId });

    if (!lead) throw new NotFoundException("Lead not found");

    const relevant = allGroups.filter((g) => g.leads.some((l) => l.id === leadId));

    let aiExplanation = "No likely duplicates found for this lead.";
    if (relevant.length > 0) {
      const groupSummaries = relevant.map((g) =>
        `- Leads: ${g.leads.map((l) => `${l.name} (id:${l.id})`).join(" vs ")} | Match: ${g.matchReason.join(", ")} | Score: ${g.score}`
      ).join("\n");

      const result = await this.gateway.invokeText({
        actor: { orgId, userId },
        feature: "crm.copilot.duplicates",
        prompt: {
          system: "You are a CRM data quality assistant. Explain duplicate lead matches in 2-3 sentences and recommend what to do.",
          user: `Lead "${lead.name}" (id: ${leadId}) has these potential duplicate groups:\n${groupSummaries}\n\nExplain the situation and recommend action.`,
        },
        tier: "fast",
        maxTokens: 512,
        charge: true,
      });

      if (!result.ok) throwOnAiFailure(result);
      aiExplanation = result.data;
    }

    await auditAiAction(this.db, orgId, userId, "ai.crm.duplicate_suggestions", "lead", String(leadId));

    return { leadId, duplicates: relevant, aiExplanation, generatedAt: new Date().toISOString() };
  }

  async leadSummaryWithCitations(orgId: string, leadId: number, userId: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const { lead, citations } = await runInTenantTransaction(this.db, async (tx) => {
      const [[lead], activityCount] = await Promise.all([
        tx
          .select({
            id: LEAD_PARTY_COLUMNS.id,
            name: LEAD_PARTY_COLUMNS.name,
            score: LEAD_PARTY_COLUMNS.score,
            priority: LEAD_PARTY_COLUMNS.priority,
            status: LEAD_PARTY_COLUMNS.status,
            source: LEAD_PARTY_COLUMNS.source,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(and(...leadPartyScope(orgId, INCLUDE_DELETED), leadIdIs(leadId))),
        tx
          .select({ date: leadActivities.date })
          .from(leadActivities)
          .where(eq(leadActivities.leadId, leadId))
          .orderBy(desc(leadActivities.date))
          .limit(10),
      ]);

      const emptyCitations: CitationItem[] = [];
      if (!lead) return { lead: null, citations: emptyCitations };

      const built: CitationItem[] = [
        { id: `lead-score-${leadId}`, title: "AI Lead Score", snippet: `Score: ${lead.score ?? "Not scored"}, Priority: ${lead.priority ?? "N/A"}` },
        { id: `lead-status-${leadId}`, title: "Lead Status", snippet: `Status: ${lead.status}, Source: ${lead.source ?? "N/A"}` },
      ];
      if (activityCount.length > 0) {
        built.push({
          id: `lead-activity-${leadId}`,
          title: "Activity History",
          snippet: `${activityCount.length} activities. Latest: ${activityCount[0]?.date ? new Date(activityCount[0].date).toLocaleDateString("en-IN") : "N/A"}`,
        });
      }

      return { lead, citations: built };
    }, { orgId });

    if (!lead) throw new NotFoundException("Lead not found");

    const base = await this.leadSummary(orgId, leadId, userId);
    return { ...base, citations };
  }
}
