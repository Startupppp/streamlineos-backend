import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, ilike, inArray, lte } from "drizzle-orm";
import {
  clientAccountActivities,
  clientAccounts,
  leadActivities,
  leads,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AiGatewayService } from "../gateway/ai-gateway.service";

import { NlSearchFilterSchema } from "../dto/output.schemas";
import type { AccountSummaryInput, MeetingPrepInput, NlSearchInput } from "../dto/request.schemas";
import { throwOnAiFailure } from "./gateway-result.util";
import { OrgFeaturesService } from "./org-features.service";

interface MeetingFollowUpInput {
  meetingTitle: string;
  attendeeType: "lead" | "client";
  attendeeId: number;
  outcome: string;
  actionItems?: string[];
  scheduledAt: string;
  notes?: string;
}

interface CitationItem {
  id: string;
  title: string;
  snippet: string;
}

const MAX_NOTES = 2000;

function trunc(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > MAX_NOTES ? s.slice(0, MAX_NOTES) + "…" : s;
}

@Injectable()
export class CrmBriefService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  async accountSummary(orgId: string, input: AccountSummaryInput, userId?: string) {
    const ctx = await runInTenantTransaction(this.db, async (tx) => {
      const account = await tx.query.clientAccounts.findFirst({
        where: and(eq(clientAccounts.id, input.clientId), eq(clientAccounts.orgId, orgId)),
      });

      if (!account) return null;

      const [resolvedLead, activities] = await Promise.all([
        account.leadId
          ? tx.query.leads.findFirst({ where: eq(leads.id, account.leadId) })
          : Promise.resolve(null),
        tx
          .select({
            activityType: clientAccountActivities.activityType,
            description: clientAccountActivities.description,
            createdAt: clientAccountActivities.createdAt,
          })
          .from(clientAccountActivities)
          .where(eq(clientAccountActivities.clientAccountId, input.clientId))
          .orderBy(desc(clientAccountActivities.createdAt))
          .limit(20),
      ]);

      return { account, resolvedLead: resolvedLead ?? null, activities };
    }, { orgId });

    if (!ctx) throw new NotFoundException("Client account not found");
    const { account, resolvedLead, activities } = ctx;

    const investmentAmount = account.investmentAmount
      ? `₹${Number(account.investmentAmount).toLocaleString("en-IN")}`
      : "Not specified";
    const estimatedInvestment = account.estimatedInvestment
      ? `₹${Number(account.estimatedInvestment).toLocaleString("en-IN")}`
      : "Not specified";

    const activitiesText =
      activities.length === 0
        ? "No recent activities recorded."
        : activities
            .map((a) => {
              const date = a.createdAt ? new Date(a.createdAt).toLocaleDateString("en-IN") : "Unknown date";
              return `- [${date}] ${a.activityType}: ${trunc(a.description)}`;
            })
            .join("\n");

    const userPrompt = `Generate a professional 1-page account summary for an executive briefing.

CLIENT ACCOUNT DETAILS:
- Client Name: ${account.clientName}
- Email: ${account.clientEmail ?? "N/A"}
- Phone: ${account.clientPhone ?? "N/A"}
- Status: ${account.status}
- Plan: ${account.planName ?? "Not specified"}
- Investment Amount: ${investmentAmount}
- Estimated Investment: ${estimatedInvestment}
- Investment Date: ${account.investmentDate ? new Date(account.investmentDate).toLocaleDateString("en-IN") : "N/A"}
- Renewal Stage: ${account.renewalStage}
- Renewal Date: ${account.renewalDate ?? "Not set"}
- Conversion Notes: ${trunc(account.conversionNotes)}
- Renewal Notes: ${trunc(account.renewalNotes)}
- Account Created: ${new Date(account.createdAt).toLocaleDateString("en-IN")}

LEAD CONTEXT:
${resolvedLead ? `- Source: ${resolvedLead.source ?? "N/A"}, Priority: ${resolvedLead.priority ?? "N/A"}, City: ${resolvedLead.city ?? "N/A"}, Company: ${resolvedLead.company ?? "N/A"}` : "- No lead data available"}

RECENT ACTIVITIES (Last 20):
${activitiesText}

Please generate a comprehensive account summary with:
1. Executive Overview (2-3 sentences on account health and relationship status)
2. Investment Profile (current investment, plan details, financial standing)
3. Renewal Status (upcoming renewal details, stage, recommended actions)
4. Recent Engagement (summary of recent interactions and outcomes)
5. Key Risks & Opportunities (any flags or upsell potential)
6. Recommended Next Steps (2-3 specific actions for the account manager)`;

    const result = await this.gateway.invokeText({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.account-summary",
      prompt: {
        system:
          "You are an executive assistant preparing client briefing documents for an Indian investment firm. Generate concise, professional account summaries that help account managers and executives quickly understand the full picture of a client relationship. Be data-driven and specific.",
        user: userPrompt,
      },
      tier: "standard",
      maxTokens: 1024,
      charge: true,
      dedupe: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    return { summary: result.data, clientName: account.clientName, generatedAt: new Date().toISOString() };
  }

  async meetingPrep(orgId: string, input: MeetingPrepInput, userId?: string) {
    const { meetingTitle, attendeeType, attendeeId, scheduledAt, notes } = input;

    const ctx = await runInTenantTransaction(this.db, async (tx) => {
      if (attendeeType === "lead") {
        const [lead, activities] = await Promise.all([
          tx.query.leads.findFirst({
            where: and(eq(leads.id, attendeeId), eq(leads.orgId, orgId)),
          }),
          tx
            .select({
              type: leadActivities.type,
              date: leadActivities.date,
              subject: leadActivities.subject,
              notes: leadActivities.notes,
              outcome: leadActivities.outcome,
            })
            .from(leadActivities)
            .where(eq(leadActivities.leadId, attendeeId))
            .orderBy(desc(leadActivities.date))
            .limit(5),
        ]);
        return { kind: "lead" as const, lead: lead ?? null, activities };
      } else {
        const [account, activities] = await Promise.all([
          tx.query.clientAccounts.findFirst({
            where: and(eq(clientAccounts.id, attendeeId), eq(clientAccounts.orgId, orgId)),
          }),
          tx
            .select({
              activityType: clientAccountActivities.activityType,
              description: clientAccountActivities.description,
              createdAt: clientAccountActivities.createdAt,
            })
            .from(clientAccountActivities)
            .where(eq(clientAccountActivities.clientAccountId, attendeeId))
            .orderBy(desc(clientAccountActivities.createdAt))
            .limit(5),
        ]);
        return { kind: "client" as const, account: account ?? null, activities };
      }
    }, { orgId });

    let attendeeName: string;
    let contextString: string;

    if (ctx.kind === "lead") {
      if (!ctx.lead) throw new NotFoundException("Lead not found");
      attendeeName = ctx.lead.name;

      const activitiesText =
        ctx.activities.length === 0
          ? "No previous interactions recorded."
          : ctx.activities
              .map((a) => {
                const date = a.date ? new Date(a.date).toLocaleDateString("en-IN") : "Unknown";
                return `- [${date}] ${a.type}${a.subject ? `: ${a.subject}` : ""} — ${trunc(a.notes)}${a.outcome ? ` | Outcome: ${a.outcome}` : ""}`;
              })
              .join("\n");

      const lead = ctx.lead;
      contextString = `ATTENDEE TYPE: Lead (Prospective Client)

LEAD PROFILE:
- Name: ${lead.name}
- Email: ${lead.email ?? "N/A"}
- Phone: ${lead.phone ?? "N/A"}
- Company: ${lead.company ?? "N/A"}
- Designation: ${lead.designation ?? "N/A"}
- City: ${lead.city ?? "N/A"}
- Source: ${lead.source ?? "N/A"}
- Status: ${lead.status}
- Priority: ${lead.priority ?? "N/A"}
- AI Score: ${lead.score ?? "Not scored"}
- Potential Value: ${lead.potentialValue ? `₹${Number(lead.potentialValue).toLocaleString("en-IN")}` : "Not specified"}
- Investment Interest: ${lead.investmentInterest ? `₹${Number(lead.investmentInterest).toLocaleString("en-IN")}` : "Not specified"}
- Tags: ${lead.tags?.join(", ") ?? "None"}
- Notes: ${trunc(lead.notes)}
- Follow-up Notes: ${trunc(lead.followUpNotes)}

PREVIOUS INTERACTIONS:
${activitiesText}`;
    } else {
      if (!ctx.account) throw new NotFoundException("Client account not found");
      attendeeName = ctx.account.clientName;

      const activitiesText =
        ctx.activities.length === 0
          ? "No recent activities recorded."
          : ctx.activities
              .map((a) => {
                const date = a.createdAt ? new Date(a.createdAt).toLocaleDateString("en-IN") : "Unknown";
                return `- [${date}] ${a.activityType}: ${trunc(a.description)}`;
              })
              .join("\n");

      const account = ctx.account;
      contextString = `ATTENDEE TYPE: Existing Client

CLIENT PROFILE:
- Name: ${account.clientName}
- Email: ${account.clientEmail ?? "N/A"}
- Phone: ${account.clientPhone ?? "N/A"}
- Account Status: ${account.status}
- Plan: ${account.planName ?? "Not specified"}
- Investment Amount: ${account.investmentAmount ? `₹${Number(account.investmentAmount).toLocaleString("en-IN")}` : "N/A"}
- Investment Date: ${account.investmentDate ? new Date(account.investmentDate).toLocaleDateString("en-IN") : "N/A"}
- Renewal Stage: ${account.renewalStage}
- Renewal Date: ${account.renewalDate ?? "Not set"}
- Renewal Notes: ${trunc(account.renewalNotes)}
- Conversion Notes: ${trunc(account.conversionNotes)}

RECENT INTERACTIONS:
${activitiesText}`;
    }

    const userPrompt = `Meeting Title: ${meetingTitle}
Scheduled: ${new Date(scheduledAt).toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" })}
${notes ? `Additional Notes from Organizer: ${trunc(notes)}` : ""}

${contextString}

Please generate a structured pre-meeting brief with:
1. Meeting Overview (purpose, what success looks like)
2. Attendee Background (key facts about this ${attendeeType} the team should know)
3. Relationship History (summary of past interactions and current standing)
4. Key Discussion Points (3-5 specific topics to address in this meeting)
5. Potential Pain Points & Opportunities (what to look out for or capitalize on)
6. Suggested Questions to Ask (3-4 open-ended questions to drive the conversation)
7. Preparation Checklist (materials or data to prepare before the meeting)`;

    const result = await this.gateway.invokeText({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.meeting-prep",
      prompt: {
        system:
          "You are an executive assistant preparing meeting briefs for an Indian investment firm sales team. Generate structured, concise pre-meeting briefs that help the team walk into every meeting fully prepared. Be specific, actionable, and tailor advice to the Indian B2B financial services context.",
        user: userPrompt,
      },
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    return { brief: result.data, attendeeName, generatedAt: new Date().toISOString() };
  }

  async nlSearch(orgId: string, input: NlSearchInput, userId?: string) {
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.nl-search",
      prompt: {
        system:
          "You are a CRM query parser. Convert natural language lead search queries into structured filter objects. " +
          "For Indian context: '1L' = 100000, '5L' = 500000, '10L' = 1000000, '1Cr' = 10000000, '2Cr' = 20000000. " +
          "Status values must be uppercase: NEW, CONTACTED, INTERESTED, QUALIFIED, CONVERTED, LOST. " +
          "Priority values must be uppercase: HOT, WARM, COLD. " +
          "Source values: referral, campaign, cold_call, website, social_media, walk_in, other. " +
          "Extract city, company, name, and assignedToName from the query when mentioned. " +
          "Only populate fields that are clearly mentioned in the query.",
        user: input.query,
      },
      schema: NlSearchFilterSchema,
      tier: "fast",
      maxTokens: 512,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    const parsedFilters = result.data;

    const leadsResult = await runInTenantTransaction(this.db, async (tx) => {
      const conditions = [eq(leads.orgId, orgId)];
      if (parsedFilters.status?.length) conditions.push(inArray(leads.status, parsedFilters.status));
      if (parsedFilters.priority?.length) conditions.push(inArray(leads.priority, parsedFilters.priority));
      if (parsedFilters.source) conditions.push(ilike(leads.source, `%${parsedFilters.source}%`));
      if (parsedFilters.city) conditions.push(ilike(leads.city, `%${parsedFilters.city}%`));
      if (parsedFilters.company) conditions.push(ilike(leads.company, `%${parsedFilters.company}%`));
      if (parsedFilters.nameSearch) conditions.push(ilike(leads.name, `%${parsedFilters.nameSearch}%`));
      if (parsedFilters.minValue !== undefined) {
        conditions.push(gte(leads.potentialValue, String(parsedFilters.minValue)));
      }
      if (parsedFilters.maxValue !== undefined) {
        conditions.push(lte(leads.potentialValue, String(parsedFilters.maxValue)));
      }

      const rows = await tx
        .select({
          id: leads.id,
          name: leads.name,
          email: leads.email,
          company: leads.company,
          status: leads.status,
          priority: leads.priority,
          source: leads.source,
          value: leads.potentialValue,
          city: leads.city,
          assignedToId: leads.assignedToId,
          assigneeName: users.name,
          assigneeFirstName: users.firstName,
          assigneeLastName: users.lastName,
        })
        .from(leads)
        .leftJoin(users, eq(leads.assignedToId, users.id))
        .where(and(...conditions))
        .limit(50);

      let filteredRows = rows;
      if (parsedFilters.assignedToName) {
        const search = parsedFilters.assignedToName.toLowerCase();
        filteredRows = rows.filter((r) => {
          const fullName =
            `${r.assigneeFirstName ?? ""} ${r.assigneeLastName ?? ""}`.trim() || r.assigneeName || "";
          return fullName.toLowerCase().includes(search);
        });
      }

      return filteredRows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        company: r.company,
        status: r.status,
        priority: r.priority,
        source: r.source,
        value: r.value !== null ? Number(r.value) : null,
        city: r.city,
        assignedTo:
          `${r.assigneeFirstName ?? ""} ${r.assigneeLastName ?? ""}`.trim() || r.assigneeName || null,
      }));
    }, { orgId });

    return { query: input.query, parsedFilters, leads: leadsResult, total: leadsResult.length };
  }

  async meetingFollowUpDraft(orgId: string, input: MeetingFollowUpInput, userId?: string) {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const attendeeName = await runInTenantTransaction(this.db, async (tx) => {
      if (input.attendeeType === "lead") {
        const lead = await tx.query.leads.findFirst({
          where: and(eq(leads.id, input.attendeeId), eq(leads.orgId, orgId)),
        });
        if (!lead) throw new NotFoundException("Lead not found");
        return lead.name;
      } else {
        const account = await tx.query.clientAccounts.findFirst({
          where: and(eq(clientAccounts.id, input.attendeeId), eq(clientAccounts.orgId, orgId)),
        });
        if (!account) throw new NotFoundException("Client account not found");
        return account.clientName;
      }
    }, { orgId });

    const actionItemsText = (input.actionItems ?? []).length > 0
      ? input.actionItems!.map((item, i) => `${i + 1}. ${item}`).join("\n")
      : "No specific action items recorded.";

    const userPrompt = `Draft a professional follow-up email for this meeting.

Meeting: ${input.meetingTitle}
Attendee: ${attendeeName}
Scheduled: ${new Date(input.scheduledAt).toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" })}
Outcome: ${input.outcome}
${input.notes ? `Additional Notes: ${trunc(input.notes)}` : ""}

Agreed Action Items:
${actionItemsText}

Write a concise, professional follow-up email (subject + body) that:
1. Thanks the attendee for their time
2. Summarizes the key outcomes from the meeting
3. Lists the agreed action items clearly
4. Sets expectations for next steps
Keep the tone professional but warm. Max 200 words for the body.`;

    const result = await this.gateway.invokeText({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.meeting-follow-up",
      prompt: {
        system: "You are an executive assistant drafting professional follow-up emails for an Indian investment firm. Write clear, concise, and actionable follow-up emails. Never auto-send; return draft text only.",
        user: userPrompt,
      },
      tier: "standard",
      maxTokens: 512,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    return { draft: result.data, attendeeName, generatedAt: new Date().toISOString() };
  }

  async accountSummaryWithCitations(orgId: string, input: AccountSummaryInput, userId?: string) {
    const citations = await runInTenantTransaction(this.db, async (tx) => {
      const account = await tx.query.clientAccounts.findFirst({
        where: and(eq(clientAccounts.id, input.clientId), eq(clientAccounts.orgId, orgId)),
      });

      if (!account) return null;

      const [resolvedLead, activities] = await Promise.all([
        account.leadId
          ? tx.query.leads.findFirst({ where: eq(leads.id, account.leadId) })
          : Promise.resolve(null),
        tx
          .select({
            activityType: clientAccountActivities.activityType,
            description: clientAccountActivities.description,
            createdAt: clientAccountActivities.createdAt,
          })
          .from(clientAccountActivities)
          .where(eq(clientAccountActivities.clientAccountId, input.clientId))
          .orderBy(desc(clientAccountActivities.createdAt))
          .limit(20),
      ]);

      const built: CitationItem[] = [
        {
          id: `account-${account.id}`,
          title: "Account Profile",
          snippet: `${account.clientName} — Plan: ${account.planName ?? "N/A"}, Status: ${account.status}, Renewal Stage: ${account.renewalStage}`,
        },
      ];
      if (account.investmentAmount) {
        built.push({
          id: `account-investment-${account.id}`,
          title: "Investment Details",
          snippet: `Investment: ₹${Number(account.investmentAmount).toLocaleString("en-IN")}, Date: ${account.investmentDate ? new Date(account.investmentDate).toLocaleDateString("en-IN") : "N/A"}`,
        });
      }
      if (activities.length > 0) {
        built.push({
          id: `account-activities-${account.id}`,
          title: "Recent Activity Summary",
          snippet: `${activities.length} activities recorded. Latest: ${activities[0]?.activityType ?? "N/A"} on ${activities[0]?.createdAt ? new Date(activities[0].createdAt).toLocaleDateString("en-IN") : "N/A"}`,
        });
      }
      if (resolvedLead) {
        built.push({
          id: `lead-${resolvedLead.id}`,
          title: "Lead Context",
          snippet: `Source: ${resolvedLead.source ?? "N/A"}, Priority: ${resolvedLead.priority ?? "N/A"}, City: ${resolvedLead.city ?? "N/A"}`,
        });
      }
      return built;
    }, { orgId });

    if (!citations) throw new NotFoundException("Client account not found");

    const base = await this.accountSummary(orgId, input, userId);
    return { ...base, citations };
  }
}
