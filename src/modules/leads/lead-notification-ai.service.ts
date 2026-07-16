import { Injectable } from "@nestjs/common";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";

export type SmartNotificationEvent =
  | "LEAD_ASSIGNED"
  | "LEAD_STATUS_CHANGED"
  | "DEAL_STAGE_CHANGED"
  | "TICKET_ASSIGNED"
  | "SLA_BREACH_WARNING";

export type SmartNotificationContext = Record<string, string | number | null | undefined>;

export interface SmartNotificationInput {
  event: SmartNotificationEvent;
  defaultTitle: string;
  defaultMessage: string;
  context: SmartNotificationContext;
  orgId: string;
}

export interface SmartNotificationResult {
  title: string;
  message: string;
  enriched: boolean;
}

const SYSTEM_PROMPT =
  "You generate concise, contextual in-app notifications for a CRM and HR platform. Output ONLY the requested format with no extra text.";

const SEPARATOR = "|||";

const EVENT_PROMPTS: Record<SmartNotificationEvent, (ctx: SmartNotificationContext) => string> = {
  LEAD_ASSIGNED: (ctx) => `
You are generating a smart in-app notification for a CRM sales team member.
Event: A lead has just been assigned to them.

Lead details:
- Name: ${ctx.leadName ?? "Unknown"}
- Priority: ${ctx.priority ?? "WARM"}
- Source: ${ctx.source ?? "Unknown"}
- Company: ${ctx.company ?? "N/A"}
- Potential Value: ${ctx.potentialValue ? `₹${ctx.potentialValue}` : "Not specified"}
- Notes: ${ctx.notes ?? "None"}

Write a short, action-oriented notification message (1-2 sentences, max 150 characters).
Include: the lead name, why they matter (priority/value), and a clear suggested action.
Do not use markdown. Do not use emojis. Plain text only.
Output format: TITLE|||MESSAGE
Example: New HOT Lead Assigned|||Rajesh Sharma (₹50L, Referral) requires immediate follow-up — call within 2 hours.
`,

  LEAD_STATUS_CHANGED: (ctx) => `
You are generating a smart in-app notification for a CRM sales manager.
Event: A lead's status has changed.

Lead details:
- Name: ${ctx.leadName ?? "Unknown"}
- Old status: ${ctx.fromStatus ?? "Unknown"}
- New status: ${ctx.toStatus ?? "Unknown"}
- Priority: ${ctx.priority ?? "WARM"}
- Changed by: ${ctx.changedBy ?? "a team member"}

Write a concise notification (1 sentence, max 120 characters).
Highlight the significance of this status change and suggest a next action if applicable.
Do not use markdown. Plain text only.
Output format: TITLE|||MESSAGE
`,

  DEAL_STAGE_CHANGED: (ctx) => `
You are generating a smart in-app notification for a sales manager.
Event: A deal has moved to a new pipeline stage.

Deal details:
- Deal name: ${ctx.dealName ?? "Unknown Deal"}
- From stage: ${ctx.fromStage ?? "Unknown"}
- To stage: ${ctx.toStage ?? "Unknown"}
- Deal value: ${ctx.dealValue ? `₹${ctx.dealValue}` : "Not specified"}
- Client: ${ctx.clientName ?? "Unknown"}

Write a short, professional notification (1-2 sentences, max 140 characters).
Celebrate progress or flag urgency based on the stage.
Do not use markdown. Plain text only.
Output format: TITLE|||MESSAGE
`,

  TICKET_ASSIGNED: (ctx) => `
You are generating a smart in-app notification for a project team member.
Event: A support/project ticket has been assigned to them.

Ticket details:
- Title: ${ctx.ticketTitle ?? "Unknown Ticket"}
- Priority: ${ctx.priority ?? "MEDIUM"}
- Project: ${ctx.projectName ?? "Unknown Project"}
- Due date: ${ctx.dueDate ?? "Not set"}

Write a brief, action-oriented notification (1-2 sentences, max 130 characters).
Do not use markdown. Plain text only.
Output format: TITLE|||MESSAGE
`,

  SLA_BREACH_WARNING: (ctx) => `
You are generating an urgent in-app notification for a CRM team member.
Event: A lead is about to breach the SLA response time.

Details:
- Lead name: ${ctx.leadName ?? "Unknown"}
- Hours since last contact: ${ctx.hoursSinceContact ?? "Unknown"}
- SLA limit: ${ctx.slaLimit ?? "Unknown"} hours
- Priority: ${ctx.priority ?? "WARM"}

Write an urgent, action-oriented notification (1-2 sentences, max 140 characters).
Convey urgency clearly. Do not use markdown. Plain text only.
Output format: TITLE|||MESSAGE
`,
};

@Injectable()
export class LeadNotificationAiService {
  constructor(private readonly gateway: AiGatewayService) {}

  async generateSmartNotification(input: SmartNotificationInput): Promise<SmartNotificationResult> {
    const fallback: SmartNotificationResult = {
      title: input.defaultTitle,
      message: input.defaultMessage,
      enriched: false,
    };

    try {
      const promptFn = EVENT_PROMPTS[input.event];
      if (!promptFn) return fallback;

      const result = await this.gateway.invokeText({
        actor: { orgId: input.orgId, userId: null },
        feature: "lead.smart-notification",
        tier: "fast",
        maxTokens: 256,
        prompt: { system: SYSTEM_PROMPT, user: promptFn(input.context) },
      });

      if (!result.ok) return fallback;

      const raw = result.data;
      const separatorIdx = raw.indexOf(SEPARATOR);
      if (separatorIdx === -1) return fallback;

      const title = raw.slice(0, separatorIdx).trim();
      const message = raw.slice(separatorIdx + SEPARATOR.length).trim();
      if (!title || !message) return fallback;

      return { title, message, enriched: true };
    } catch {
      return fallback;
    }
  }
}
