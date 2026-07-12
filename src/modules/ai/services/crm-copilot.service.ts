import { ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, dealActivities, deals, leadActivities, leads } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { LlmService } from "../providers/llm.service";
import { AiUsageService } from "./ai-usage.service";
import { OrgFeaturesService } from "./org-features.service";
import { CrmScoringService } from "./crm-scoring.service";
import { CrmContentService } from "./crm-content.service";
import { findDuplicateLeads } from "../../leads/duplicate-leads";
import { ConversationSummarySchema } from "../dto/output.schemas";

const DealInsightsSchema = z.object({
  summary: z.string(),
  risks: z.array(z.string()),
  recommendedPlays: z.array(z.string()),
  stakeholdersGap: z.string(),
});

type DealInsights = z.infer<typeof DealInsightsSchema>;

const URGENCY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

@Injectable()
export class CrmCopilotService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
    private readonly usage: AiUsageService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly scoring: CrmScoringService,
    private readonly content: CrmContentService,
  ) {}

  private ensureLlm(): void {
    if (!this.llm.isConfigured()) {
      throw new ServiceUnavailableException("AI provider is not configured. Set OPENAI_API_KEY.");
    }
  }

  private async auditAiAction(
    orgId: string,
    userId: string,
    action: string,
    targetType: string,
    targetId: string,
  ): Promise<void> {
    await this.db.insert(auditLogs).values({
      action,
      userId,
      orgId,
      targetId,
      targetType,
      metadata: { source: "crm-copilot" },
    });
  }

  async leadSummary(orgId: string, leadId: number, userId: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");
    this.ensureLlm();

    const [lead] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));
    if (!lead) throw new NotFoundException("Lead not found");

    const activities = await this.db
      .select({ type: leadActivities.type, date: leadActivities.date, subject: leadActivities.subject, notes: leadActivities.notes, outcome: leadActivities.outcome })
      .from(leadActivities)
      .where(eq(leadActivities.leadId, leadId))
      .orderBy(desc(leadActivities.date))
      .limit(10);

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
${truncate(activitiesText, 1500)}

Return a JSON object:
{
  "summary": "<2-3 sentence executive summary>",
  "nextBestActions": ["<action1>", "<action2>", "<action3>"]
}`;

    const result = await this.llm.invokeJson<{ summary: string; nextBestActions: string[] }>({
      model: "standard",
      system: "You are a CRM sales assistant. Return valid JSON only matching the requested schema.",
      user: userPrompt,
    });

    await Promise.all([
      this.usage.track({ orgId, userId, feature: "crm.lead-summary", model: "standard" }),
      this.auditAiAction(orgId, userId, "ai.crm.lead_summary", "lead", String(leadId)),
    ]);

    return { summary: result.summary ?? "", nextBestActions: result.nextBestActions ?? [], generatedAt: new Date().toISOString() };
  }

  async dealSummary(orgId: string, dealId: number, userId: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");
    this.ensureLlm();

    const [deal] = await this.db
      .select()
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)));
    if (!deal) throw new NotFoundException("Deal not found");

    const activities = await this.db
      .select({ type: dealActivities.type, subject: dealActivities.subject, notes: dealActivities.notes, createdAt: dealActivities.createdAt })
      .from(dealActivities)
      .where(eq(dealActivities.dealId, dealId))
      .orderBy(desc(dealActivities.createdAt))
      .limit(10);

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
${truncate(activitiesText, 1500)}

Return a JSON object:
{
  "summary": "<2-3 sentence deal health summary>",
  "risks": ["<risk1>", "<risk2>"],
  "recommendedPlays": ["<play1>", "<play2>"],
  "stakeholdersGap": "<one sentence on missing stakeholders or contacts>"
}`;

    const insights = await this.llm.invokeStructured<typeof DealInsightsSchema>({
      model: "standard",
      schema: DealInsightsSchema,
      schemaName: "deal_insights",
      system: "You are a B2B deal analyst. Provide structured deal health analysis. Return JSON matching the schema exactly.",
      user: userPrompt,
    });

    await Promise.all([
      this.usage.track({ orgId, userId, feature: "crm.deal-summary", model: "standard" }),
      this.auditAiAction(orgId, userId, "ai.crm.deal_summary", "deal", String(dealId)),
    ]);

    return { stage: deal.stage, ...insights, generatedAt: new Date().toISOString() };
  }

  async nextBestActionsAcrossPipeline(orgId: string, userId: string, limit: number) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");
    this.ensureLlm();

    const fetchLimit = Math.min(limit * 2, 40);
    const topLeads = await this.db
      .select({ id: leads.id, name: leads.name, score: leads.score })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt)))
      .orderBy(desc(leads.score))
      .limit(fetchLimit);

    const results: Array<{ leadId: number; leadName: string; action: string; urgency: string; reasoning: string }> = [];

    for (const lead of topLeads) {
      try {
        const nba = await this.scoring.nextBestAction(orgId, lead.id);
        if (nba) {
          results.push({ leadId: lead.id, leadName: lead.name, action: nba.action, urgency: nba.urgency, reasoning: nba.reasoning });
        }
      } catch {
        continue;
      }
    }

    results.sort((a, b) => {
      const ao = URGENCY_ORDER[a.urgency as keyof typeof URGENCY_ORDER] ?? 3;
      const bo = URGENCY_ORDER[b.urgency as keyof typeof URGENCY_ORDER] ?? 3;
      return ao - bo;
    });

    await this.usage.track({ orgId, userId, feature: "crm.next-best-actions", model: "fast" });

    return { actions: results.slice(0, limit) };
  }

  async emailDraftForEntity(
    orgId: string,
    userId: string,
    input: { entityType: "lead" | "deal"; entityId: number; intent: string; tone: "formal" | "friendly" | "urgent" },
  ) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiEmailDraft) throw new ForbiddenException("AI email draft is disabled for this organization");
    this.ensureLlm();

    let entityName = "";
    let company: string | null = null;
    let contextLine = "";

    if (input.entityType === "lead") {
      const [lead] = await this.db
        .select({ name: leads.name, company: leads.company, designation: leads.designation, potentialValue: leads.potentialValue, status: leads.status })
        .from(leads)
        .where(and(eq(leads.id, input.entityId), eq(leads.orgId, orgId)));
      if (!lead) throw new NotFoundException("Lead not found");
      entityName = lead.name;
      company = lead.company;
      contextLine = `Status: ${lead.status}, Value: ${lead.potentialValue ?? "N/A"}`;
    } else {
      const [deal] = await this.db
        .select({ name: deals.name, contactPerson: deals.contactPerson, value: deals.value, stage: deals.stage })
        .from(deals)
        .where(and(eq(deals.id, input.entityId), eq(deals.orgId, orgId)));
      if (!deal) throw new NotFoundException("Deal not found");
      entityName = deal.contactPerson ?? deal.name;
      contextLine = `Deal: ${deal.name}, Stage: ${deal.stage}, Value: ${deal.value}`;
    }

    const draft = await this.content.generateEmail(userId, {
      leadName: entityName,
      company: company ?? undefined,
      tone: input.tone,
      context: `Intent: ${input.intent}. ${contextLine}`,
    });

    await Promise.all([
      this.usage.track({ orgId, userId, feature: "crm.email-draft", model: "fast" }),
      this.auditAiAction(orgId, userId, "ai.crm.email_draft", input.entityType, String(input.entityId)),
    ]);

    const email = "variations" in draft ? Object.values(draft.variations ?? {})[0] : draft;
    return { subject: email?.subject ?? "", body: email?.body ?? "", generatedAt: new Date().toISOString() };
  }

  async summarizeNotes(orgId: string, userId: string, text: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiChat) throw new ForbiddenException("AI features are disabled for this organization");
    this.ensureLlm();

    const result = await this.llm.invokeStructured({
      model: "fast",
      schema: ConversationSummarySchema.extend({ objections: z.array(z.string()).default([]) }),
      schemaName: "notes_summary",
      system: `You are a sales assistant. Summarize meeting/call notes into structured insights.
Return JSON with summary, keyPoints, actionItems, objections, sentiment.`,
      user: truncate(text, 6000),
    });

    await this.usage.track({ orgId, userId, feature: "crm.notes-summary", model: "fast" });

    return {
      summary: result.summary,
      actionItems: result.actionItems,
      objections: result.objections ?? [],
      sentiment: result.sentiment,
    };
  }

  async objectionHelp(orgId: string, userId: string, input: { objection: string; context?: string }) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiChat) throw new ForbiddenException("AI features are disabled for this organization");
    this.ensureLlm();

    const result = await this.content.handleObjection({
      objection: input.objection,
      dealStage: "Unknown",
      ...(input.context ? { productName: undefined } : {}),
    });

    await this.usage.track({ orgId, userId, feature: "crm.objection-help", model: "fast" });

    return result;
  }

  async duplicateSuggestionsForLead(orgId: string, leadId: number, userId: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");
    this.ensureLlm();

    const [lead] = await this.db
      .select({ id: leads.id, name: leads.name })
      .from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.orgId, orgId)));
    if (!lead) throw new NotFoundException("Lead not found");

    const allGroups = await findDuplicateLeads(this.db, orgId);
    const relevant = allGroups.filter((g) => g.leads.some((l) => l.id === leadId));

    let aiExplanation = "No likely duplicates found for this lead.";
    if (relevant.length > 0) {
      const groupSummaries = relevant.map((g) =>
        `- Leads: ${g.leads.map((l) => `${l.name} (id:${l.id})`).join(" vs ")} | Match: ${g.matchReason.join(", ")} | Score: ${g.score}`
      ).join("\n");

      aiExplanation = await this.llm.invokeText({
        model: "fast",
        system: "You are a CRM data quality assistant. Explain duplicate lead matches in 2-3 sentences and recommend what to do.",
        user: `Lead "${lead.name}" (id: ${leadId}) has these potential duplicate groups:\n${groupSummaries}\n\nExplain the situation and recommend action.`,
      });
    }

    await Promise.all([
      this.usage.track({ orgId, userId, feature: "crm.duplicate-suggestions", model: "fast" }),
      this.auditAiAction(orgId, userId, "ai.crm.duplicate_suggestions", "lead", String(leadId)),
    ]);

    return { leadId, duplicates: relevant, aiExplanation, generatedAt: new Date().toISOString() };
  }
}
