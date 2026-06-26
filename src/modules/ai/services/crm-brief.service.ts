import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, ilike, inArray, lte } from "drizzle-orm";
import {
  clientAccountActivities,
  clientAccounts,
  leadActivities,
  leads,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { LlmService } from "../providers/llm.service";
import { NlSearchFilterSchema } from "../dto/output.schemas";
import type { AccountSummaryInput, MeetingPrepInput, NlSearchInput } from "../dto/request.schemas";

@Injectable()
export class CrmBriefService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
  ) {}

  async accountSummary(orgId: string, input: AccountSummaryInput) {
    const account = await this.db.query.clientAccounts.findFirst({
      where: and(eq(clientAccounts.id, input.clientId), eq(clientAccounts.orgId, orgId)),
    });
    if (!account) throw new NotFoundException("Client account not found");

    const lead = account.leadId
      ? await this.db.query.leads.findFirst({ where: eq(leads.id, account.leadId) })
      : null;

    const activities = await this.db
      .select({
        activityType: clientAccountActivities.activityType,
        description: clientAccountActivities.description,
        createdAt: clientAccountActivities.createdAt,
      })
      .from(clientAccountActivities)
      .where(eq(clientAccountActivities.clientAccountId, input.clientId))
      .orderBy(desc(clientAccountActivities.createdAt))
      .limit(5);

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
              return `- [${date}] ${a.activityType}: ${a.description ?? "No description"}`;
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
- Conversion Notes: ${account.conversionNotes ?? "None"}
- Renewal Notes: ${account.renewalNotes ?? "None"}
- Account Created: ${new Date(account.createdAt).toLocaleDateString("en-IN")}

LEAD CONTEXT:
${lead ? `- Source: ${lead.source ?? "N/A"}, Priority: ${lead.priority ?? "N/A"}, City: ${lead.city ?? "N/A"}, Company: ${lead.company ?? "N/A"}` : "- No lead data available"}

RECENT ACTIVITIES (Last 5):
${activitiesText}

Please generate a comprehensive account summary with:
1. Executive Overview (2-3 sentences on account health and relationship status)
2. Investment Profile (current investment, plan details, financial standing)
3. Renewal Status (upcoming renewal details, stage, recommended actions)
4. Recent Engagement (summary of recent interactions and outcomes)
5. Key Risks & Opportunities (any flags or upsell potential)
6. Recommended Next Steps (2-3 specific actions for the account manager)`;

    const summary = await this.llm.invokeText({
      model: "standard",
      system:
        "You are an executive assistant preparing client briefing documents for an Indian investment firm. Generate concise, professional account summaries that help account managers and executives quickly understand the full picture of a client relationship. Be data-driven and specific.",
      user: userPrompt,
    });

    return { summary, clientName: account.clientName, generatedAt: new Date().toISOString() };
  }

  async meetingPrep(orgId: string, input: MeetingPrepInput) {
    const { meetingTitle, attendeeType, attendeeId, scheduledAt, notes } = input;
    let attendeeName = "Unknown";
    let contextString = "";

    if (attendeeType === "lead") {
      const lead = await this.db.query.leads.findFirst({
        where: and(eq(leads.id, attendeeId), eq(leads.orgId, orgId)),
      });
      if (!lead) throw new NotFoundException("Lead not found");
      attendeeName = lead.name;

      const activities = await this.db
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
        .limit(5);

      const activitiesText =
        activities.length === 0
          ? "No previous interactions recorded."
          : activities
              .map((a) => {
                const date = a.date ? new Date(a.date).toLocaleDateString("en-IN") : "Unknown";
                return `- [${date}] ${a.type}${a.subject ? `: ${a.subject}` : ""} — ${a.notes ?? "No notes"}${a.outcome ? ` | Outcome: ${a.outcome}` : ""}`;
              })
              .join("\n");

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
- Notes: ${lead.notes ?? "None"}
- Follow-up Notes: ${lead.followUpNotes ?? "None"}

PREVIOUS INTERACTIONS:
${activitiesText}`;
    } else {
      const account = await this.db.query.clientAccounts.findFirst({
        where: and(eq(clientAccounts.id, attendeeId), eq(clientAccounts.orgId, orgId)),
      });
      if (!account) throw new NotFoundException("Client account not found");
      attendeeName = account.clientName;

      const activities = await this.db
        .select({
          activityType: clientAccountActivities.activityType,
          description: clientAccountActivities.description,
          createdAt: clientAccountActivities.createdAt,
        })
        .from(clientAccountActivities)
        .where(eq(clientAccountActivities.clientAccountId, attendeeId))
        .orderBy(desc(clientAccountActivities.createdAt))
        .limit(5);

      const activitiesText =
        activities.length === 0
          ? "No recent activities recorded."
          : activities
              .map((a) => {
                const date = a.createdAt ? new Date(a.createdAt).toLocaleDateString("en-IN") : "Unknown";
                return `- [${date}] ${a.activityType}: ${a.description ?? "No description"}`;
              })
              .join("\n");

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
- Renewal Notes: ${account.renewalNotes ?? "None"}
- Conversion Notes: ${account.conversionNotes ?? "None"}

RECENT INTERACTIONS:
${activitiesText}`;
    }

    const userPrompt = `Meeting Title: ${meetingTitle}
Scheduled: ${new Date(scheduledAt).toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" })}
${notes ? `Additional Notes from Organizer: ${notes}` : ""}

${contextString}

Please generate a structured pre-meeting brief with:
1. Meeting Overview (purpose, what success looks like)
2. Attendee Background (key facts about this ${attendeeType} the team should know)
3. Relationship History (summary of past interactions and current standing)
4. Key Discussion Points (3-5 specific topics to address in this meeting)
5. Potential Pain Points & Opportunities (what to look out for or capitalize on)
6. Suggested Questions to Ask (3-4 open-ended questions to drive the conversation)
7. Preparation Checklist (materials or data to prepare before the meeting)`;

    const brief = await this.llm.invokeText({
      model: "standard",
      system:
        "You are an executive assistant preparing meeting briefs for an Indian investment firm sales team. Generate structured, concise pre-meeting briefs that help the team walk into every meeting fully prepared. Be specific, actionable, and tailor advice to the Indian B2B financial services context.",
      user: userPrompt,
    });

    return { brief, attendeeName, generatedAt: new Date().toISOString() };
  }

  async nlSearch(orgId: string, input: NlSearchInput) {
    const parsedFilters = await this.llm.invokeStructured({
      model: "fast",
      schema: NlSearchFilterSchema,
      schemaName: "lead_filters",
      system:
        "You are a CRM query parser. Convert natural language lead search queries into structured filter objects. " +
        "For Indian context: '1L' = 100000, '5L' = 500000, '10L' = 1000000, '1Cr' = 10000000, '2Cr' = 20000000. " +
        "Status values must be uppercase: NEW, CONTACTED, INTERESTED, QUALIFIED, CONVERTED, LOST. " +
        "Priority values must be uppercase: HOT, WARM, COLD. " +
        "Source values: referral, campaign, cold_call, website, social_media, walk_in, other. " +
        "Extract city, company, name, and assignedToName from the query when mentioned. " +
        "Only populate fields that are clearly mentioned in the query.",
      user: input.query,
    });

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

    const rows = await this.db
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

    const result = filteredRows.map((r) => ({
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

    return { query: input.query, parsedFilters, leads: result, total: result.length };
  }
}
