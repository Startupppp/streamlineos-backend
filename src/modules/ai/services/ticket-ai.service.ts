import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { tickets, ticketComments } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import {
  TicketSummaryOutputSchema,
  TicketSubtasksOutputSchema,
} from "../dto/ticket-ai.schemas";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { getFeatureCost } from "../billing/ai-cost-catalog";
import { unwrapAiResult } from "./gateway-result.util";

const TEXT_LIMIT = 2000;

@Injectable()
export class TicketAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  private async assertTicket(orgId: string, projectId: number, ticketId: number) {
    const [ticket] = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        description: tickets.description,
        type: tickets.type,
        status: tickets.status,
        priority: tickets.priority,
        projectId: tickets.projectId,
      })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
      .limit(1);

    if (!ticket || ticket.projectId !== projectId) throw new NotFoundException("Ticket not found");
    return ticket;
  }

  async summarizeTicket(orgId: string, userId: string, projectId: number, ticketId: number) {
    const ticket = await this.assertTicket(orgId, projectId, ticketId);

    const comments = await this.db
      .select({ content: ticketComments.content })
      .from(ticketComments)
      .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.orgId, orgId)))
      .limit(10);

    const commentBlock = comments.length > 0
      ? comments.map((c, i) => `Comment ${i + 1}: ${c.content.slice(0, 500)}`).join("\n")
      : "No comments.";

    const system = "You are a project management assistant. Summarize the given ticket concisely.";
    const user = `Ticket: "${ticket.title}"
Type: ${ticket.type} | Status: ${ticket.status} | Priority: ${ticket.priority}
Description: ${(ticket.description ?? "(none)").slice(0, TEXT_LIMIT)}
Comments:
${commentBlock}

Provide a summary, key points, and any blockers visible in the discussion.`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "ticket.summarize",
      prompt: { system, user },
      schema: TicketSummaryOutputSchema,
      tier: "fast",
      maxTokens: 768,
      charge: { credits: getFeatureCost("ticket.summarize") },
      dedupe: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.ticket.summarize", userId, orgId, resourceType: "ticket", resourceId: String(ticketId) });
    return data;
  }

  async improveDescription(orgId: string, userId: string, projectId: number, ticketId: number, draft?: string) {
    const ticket = await this.assertTicket(orgId, projectId, ticketId);

    const sourceText = (draft ?? ticket.description ?? ticket.title).slice(0, TEXT_LIMIT);

    const system = `You are a technical writer specializing in software tickets.
Rewrite the provided text into a well-structured ticket description using HTML tags compatible with TipTap/ProseMirror (<p>, <ul>, <li>, <strong>, <em>).
Output ONLY the HTML string, no markdown, no code blocks, no preamble. Keep it under 5000 characters.
Structure: overview paragraph, acceptance criteria as <ul>, optional notes.`;

    const user = `Ticket title: "${ticket.title}"
${draft ? "Draft description:" : "Current description:"}
${sourceText}

Produce an improved HTML description.`;

    const result = await this.gateway.invokeText({
      actor: { orgId, userId },
      feature: "ticket.improve-description",
      prompt: { system, user },
      tier: "fast",
      maxTokens: 768,
      charge: { credits: getFeatureCost("ticket.improve-description") },
    });

    const description = unwrapAiResult(result);
    this.audit.log({ action: "ai.ticket.improve-description", userId, orgId, resourceType: "ticket", resourceId: String(ticketId) });
    return { description: description.slice(0, 5000) };
  }

  async suggestSubtasks(orgId: string, userId: string, projectId: number, ticketId: number) {
    const ticket = await this.assertTicket(orgId, projectId, ticketId);

    const existingSubtasks = await this.db
      .select({ title: tickets.title })
      .from(tickets)
      .where(and(eq(tickets.parentTicketId, ticketId), eq(tickets.orgId, orgId)))
      .limit(50);

    const existingTitles = existingSubtasks.map((s) => s.title);

    const system = "You are a project management assistant. Suggest 3-7 concrete, actionable subtasks to complete the given ticket. Avoid duplicating existing subtasks.";
    const user = `Ticket: "${ticket.title}"
Description: ${(ticket.description ?? "(none)").slice(0, TEXT_LIMIT)}
Type: ${ticket.type} | Priority: ${ticket.priority}
${existingTitles.length > 0 ? `Existing subtasks (DO NOT duplicate):\n${existingTitles.map((t) => `- ${t}`).join("\n")}` : "No existing subtasks."}

Suggest 3-7 subtask titles.`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "ticket.suggest-subtasks",
      prompt: { system, user },
      schema: TicketSubtasksOutputSchema,
      tier: "fast",
      maxTokens: 512,
      charge: { credits: getFeatureCost("ticket.suggest-subtasks") },
    });

    const data = unwrapAiResult(result);
    const deduped = data.subtasks.filter(
      (s) => !existingTitles.some((t) => t.toLowerCase() === s.title.toLowerCase()),
    ).slice(0, 7);

    this.audit.log({ action: "ai.ticket.suggest-subtasks", userId, orgId, resourceType: "ticket", resourceId: String(ticketId) });
    return { subtasks: deduped };
  }
}
