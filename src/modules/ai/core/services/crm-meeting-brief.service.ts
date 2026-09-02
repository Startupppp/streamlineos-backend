import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { clientAccounts } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { OrgFeaturesService } from "./org-features.service";
import { throwOnAiFailure } from "./gateway-result.util";
import { loadLeadContext, trunc } from "./crm-brief-loaders";
import type { AiInvokePrompt } from "../gateway/ai-gateway.types";
import type { AiTextStream } from "../gateway/ai-gateway-stream.helper";

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
