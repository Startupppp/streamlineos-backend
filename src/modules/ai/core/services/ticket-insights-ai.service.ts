import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { tickets, ticketComments } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  TicketSummaryOutputSchema,
  TicketCommentsSummaryOutputSchema,
  TicketHandoffOutputSchema,
} from "../dto/ticket-ai.schemas";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { unwrapAiResult } from "./gateway-result.util";
import { assertTicket } from "./ticket-ai-assertions";

const TEXT_LIMIT = 2000;

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

@Injectable()
export class TicketInsightsAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  async summarizeTicket(orgId: string, userId: string, projectId: number, ticketId: number) {
    const { ticket, comments } = await runInTenantTransaction(this.db, async () => {
      const ticket = await assertTicket(this.db, orgId, projectId, ticketId);
      const comments = await this.db
        .select({ content: ticketComments.content })
        .from(ticketComments)
        .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.orgId, orgId), isNull(ticketComments.deletedAt)))
        .limit(10);
      return { ticket, comments };
    }, { orgId });

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
      charge: true,
      dedupe: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.ticket.summarize", userId, orgId, resourceType: "ticket", resourceId: String(ticketId) });
    return data;
  }

  async summarizeComments(orgId: string, userId: string, projectId: number, ticketId: number) {
    const comments = await runInTenantTransaction(this.db, async () => {
      await assertTicket(this.db, orgId, projectId, ticketId);
      const rows = await this.db
        .select({ content: ticketComments.content, createdAt: ticketComments.createdAt })
        .from(ticketComments)
        .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.orgId, orgId), isNull(ticketComments.deletedAt)))
        .orderBy(asc(ticketComments.createdAt))
        .limit(50);
      if (rows.length === 0) throw new BadRequestException("This ticket has no comments to summarize");
      return rows;
    }, { orgId });

    const commentBlock = comments
      .map((c, i) => `Comment ${i + 1}: ${c.content.slice(0, 800)}`)
      .join("\n\n");

    const system =
      "You are a project management assistant. Summarize a ticket comment thread for someone catching up. Be factual and concise.";
    const user = `Ticket comment thread (${comments.length} comments, oldest to newest):
${commentBlock}

Summarize the discussion, key themes, and any open questions still unresolved.`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "ticket.summarize-comments",
      prompt: { system, user },
      schema: TicketCommentsSummaryOutputSchema,
      tier: "fast",
      maxTokens: 768,
      charge: true,
      dedupe: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({
      action: "ai.ticket.summarize-comments",
      userId,
      orgId,
      resourceType: "ticket",
      resourceId: String(ticketId),
    });
    return data;
  }

  async improveDescription(orgId: string, userId: string, projectId: number, ticketId: number, draft?: string) {
    const ticket = await runInTenantTransaction(this.db, async () => {
      return assertTicket(this.db, orgId, projectId, ticketId);
    }, { orgId });

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
      charge: true,
    });

    const description = unwrapAiResult(result);
    this.audit.log({ action: "ai.ticket.improve-description", userId, orgId, resourceType: "ticket", resourceId: String(ticketId) });
    return { description: description.slice(0, 5000) };
  }

  async handoffSummary(orgId: string, userId: string, projectId: number, ticketId: number) {
    const { ticket, comments } = await runInTenantTransaction(this.db, async () => {
      const ticket = await assertTicket(this.db, orgId, projectId, ticketId);
      const comments = await this.db
        .select({ content: ticketComments.content, createdAt: ticketComments.createdAt })
        .from(ticketComments)
        .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.orgId, orgId), isNull(ticketComments.deletedAt)))
        .limit(10);
      return { ticket, comments };
    }, { orgId });

    const commentBlock =
      comments.length > 0
        ? comments.map((c, i) => `Comment ${i + 1}: ${c.content.slice(0, 500)}`).join("\n")
        : "No comments";

    const system =
      "You are a project handoff assistant. Create a factual handoff brief for this ticket. Cite specific text from the description or comments as evidence. Never fabricate decisions or blockers not visible in the provided data.";

    const user = `Ticket: "${ticket.title}"
Type: ${ticket.type} | Status: ${ticket.status} | Priority: ${ticket.priority}
Description: ${(ticket.description ?? "(none)").slice(0, TEXT_LIMIT)}
Comments (newest first):
${commentBlock}

Produce a handoff brief with current state, key decisions, next action, and blockers.`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "ticket.handoff",
      prompt: { system, user },
      schema: TicketHandoffOutputSchema,
      tier: "fast",
      maxTokens: 768,
      charge: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.ticket.handoff", userId, orgId, resourceType: "ticket", resourceId: String(ticketId) });
    return data;
  }
}
