import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { clientAccounts, clientAccountActivities, leadActivities } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { OrgFeaturesService } from "./org-features.service";
import { throwOnAiFailure } from "./gateway-result.util";
import { loadLeadContext, loadLeadProfile, trunc } from "./crm-brief-loaders";
import type { AiInvokePrompt } from "../gateway/ai-gateway.types";
import type { AiTextStream } from "../gateway/ai-gateway-stream.helper";
import type { MeetingPrepInput } from "../dto/request.schemas";

const MEETING_PREP_SYSTEM =
  "You are an executive assistant preparing meeting briefs for an Indian investment firm sales team. Generate structured, concise pre-meeting briefs that help the team walk into every meeting fully prepared. Be specific, actionable, and tailor advice to the Indian B2B financial services context.";
const MEETING_FOLLOW_UP_SYSTEM =
  "You are an executive assistant drafting professional follow-up emails for an Indian investment firm. Write clear, concise, and actionable follow-up emails. Never auto-send; return draft text only.";

interface MeetingFollowUpInput {
  meetingTitle: string;
  attendeeType: "lead" | "client";
  attendeeId: number;
  outcome: string;
  actionItems?: string[];
  scheduledAt: string;
  notes?: string;
}

@Injectable()
export class CrmMeetingBriefService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  /**
   * Shared by the buffered route and its streaming sibling. A second copy of the
   * context assembly would drift the moment either is tuned, and the streamed
   * brief would stop matching the one the buffered route returns.
   */
  private async resolveMeetingPrepPrompt(
    orgId: string,
    input: MeetingPrepInput,
  ): Promise<{ attendeeName: string; prompt: AiInvokePrompt }> {
    const { meetingTitle, attendeeType, attendeeId, scheduledAt, notes } = input;

    const ctx = await runInTenantTransaction(this.db, async (tx) => {
      if (attendeeType === "lead") {
        const [lead, activities] = await Promise.all([
          loadLeadProfile(tx, orgId, attendeeId),
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

    return { attendeeName, prompt: { system: MEETING_PREP_SYSTEM, user: userPrompt } };
  }

  async meetingPrep(orgId: string, input: MeetingPrepInput, userId?: string) {
    const { attendeeName, prompt } = await this.resolveMeetingPrepPrompt(orgId, input);

    const result = await this.gateway.invokeText({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.meeting-prep",
      prompt,
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    return { brief: result.data, attendeeName, generatedAt: new Date().toISOString() };
  }

  async streamMeetingPrep(
    orgId: string,
    input: MeetingPrepInput,
    userId: string,
    signal?: AbortSignal,
  ): Promise<AiTextStream> {
    const { prompt } = await this.resolveMeetingPrepPrompt(orgId, input);
    return this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "crm.meeting-prep",
      prompt,
      maxTokens: 1024,
      charge: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  private async resolveMeetingFollowUpPrompt(
    orgId: string,
    input: MeetingFollowUpInput,
  ): Promise<{ attendeeName: string; prompt: AiInvokePrompt }> {
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.aiLeadScoring) throw new ForbiddenException("AI features are disabled for this organization");

    const attendeeName = await runInTenantTransaction(this.db, async (tx) => {
      if (input.attendeeType === "lead") {
        const lead = await loadLeadContext(tx, orgId, input.attendeeId);
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

    return { attendeeName, prompt: { system: MEETING_FOLLOW_UP_SYSTEM, user: userPrompt } };
  }

  async meetingFollowUpDraft(orgId: string, input: MeetingFollowUpInput, userId?: string) {
    const { attendeeName, prompt } = await this.resolveMeetingFollowUpPrompt(orgId, input);

    const result = await this.gateway.invokeText({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.meeting-follow-up",
      prompt,
      tier: "standard",
      maxTokens: 512,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    return { draft: result.data, attendeeName, generatedAt: new Date().toISOString() };
  }

  async streamMeetingFollowUpDraft(
    orgId: string,
    input: MeetingFollowUpInput,
    userId: string,
    signal?: AbortSignal,
  ): Promise<AiTextStream> {
    const { prompt } = await this.resolveMeetingFollowUpPrompt(orgId, input);
    return this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "crm.meeting-follow-up",
      prompt,
      maxTokens: 512,
      charge: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}
