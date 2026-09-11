import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { tickets, ticketChecklists } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  TicketSubtasksOutputSchema,
  TicketChecklistOutputSchema,
} from "../dto/ticket-ai.schemas";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { unwrapAiResult } from "./gateway-result.util";
import { assertTicket } from "./ticket-ai-assertions";
import {
  improveDescriptionDraft,
  suggestFieldsFromDraft,
  suggestTitleFromDraft,
  type TicketDraftAiDeps,
} from "./lib/ticket-draft-ai";

const TEXT_LIMIT = 2000;

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

@Injectable()
export class TicketTriageAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  async suggestSubtasks(orgId: string, userId: string, projectId: number, ticketId: number) {
    const { ticket, existingTitles } = await runInTenantTransaction(this.db, async () => {
      const ticket = await assertTicket(this.db, orgId, projectId, ticketId);
      const existingSubtasks = await this.db
        .select({ title: tickets.title })
        .from(tickets)
        .where(and(eq(tickets.parentTicketId, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
        .limit(50);
      return { ticket, existingTitles: existingSubtasks.map((s) => s.title) };
    }, { orgId });

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
      charge: true,
    });

    const data = unwrapAiResult(result);
    const deduped = data.subtasks.filter(
      (s) => !existingTitles.some((t) => t.toLowerCase() === s.title.toLowerCase()),
    ).slice(0, 7);

    this.audit.log({ action: "ai.ticket.suggest-subtasks", userId, orgId, resourceType: "ticket", resourceId: String(ticketId) });
    return { subtasks: deduped };
  }

  async generateChecklist(orgId: string, userId: string, projectId: number, ticketId: number) {
    const { ticket, existingChecklists } = await runInTenantTransaction(this.db, async () => {
      const ticket = await assertTicket(this.db, orgId, projectId, ticketId);
      const titlePlain = ticket.title.trim();
      const descriptionPlain = stripHtml(ticket.description ?? "");
      if (!titlePlain && !descriptionPlain) {
        throw new BadRequestException("Add a title or description before generating a checklist");
      }
      const existingChecklists = await this.db.query.ticketChecklists.findMany({
        where: and(eq(ticketChecklists.ticketId, ticketId), eq(ticketChecklists.orgId, orgId)),
        columns: { title: true },
        with: {
          items: {
            columns: { text: true },
            limit: 50,
          },
        },
        limit: 20,
      });
      return { ticket, existingChecklists };
    }, { orgId });

    const existingItemTexts = existingChecklists.flatMap((checklist) =>
      checklist.items.map((item) => item.text),
    );
    const existingTitles = existingChecklists.map((checklist) => checklist.title);

    const existingBlock =
      existingItemTexts.length > 0
        ? existingItemTexts.map((text) => `- ${text}`).join("\n")
        : "None";

    const system =
      "You are a project management assistant. Generate a practical checklist to complete the given ticket. Items must be concrete, verifiable steps. Avoid duplicating existing checklist items.";
    const user = `Ticket: "${ticket.title}"
Description: ${(ticket.description ?? "(none)").slice(0, TEXT_LIMIT)}
Type: ${ticket.type} | Priority: ${ticket.priority}
${existingTitles.length > 0 ? `Existing checklist titles (avoid near-duplicates):\n${existingTitles.map((t) => `- ${t}`).join("\n")}` : "No existing checklists."}
Existing checklist items (DO NOT duplicate):
${existingBlock}

Suggest a checklist title and 4-10 items.`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "ticket.generate-checklist",
      prompt: { system, user },
      schema: TicketChecklistOutputSchema,
      tier: "fast",
      maxTokens: 768,
      charge: true,
    });

    const data = unwrapAiResult(result);
    const normalizedExisting = new Set(existingItemTexts.map((text) => text.trim().toLowerCase()));
    const dedupedItems = data.items
      .map((item) => ({ text: item.text.trim() }))
      .filter((item) => item.text.length > 0)
      .filter((item) => !normalizedExisting.has(item.text.toLowerCase()))
      .slice(0, 10);

    const title = data.title.trim().slice(0, 80) || "Checklist";

    this.audit.log({
      action: "ai.ticket.generate-checklist",
      userId,
      orgId,
      resourceType: "ticket",
      resourceId: String(ticketId),
    });

    return {
      title,
      items: dedupedItems,
    };
  }

  /** @see lib/ticket-draft-ai.ts */
  async suggestTitleFromDraft(
    orgId: string,
    userId: string,
    projectId: number,
    draft: { title?: string; description?: string },
  ) {
    return suggestTitleFromDraft(this.draftDeps, orgId, userId, projectId, draft);
  }

  /** @see lib/ticket-draft-ai.ts */
  async improveDescriptionDraft(
    orgId: string,
    userId: string,
    projectId: number,
    draft: { title?: string; description?: string },
  ) {
    return improveDescriptionDraft(this.draftDeps, orgId, userId, projectId, draft);
  }

  /** @see lib/ticket-draft-ai.ts */
  async suggestFieldsFromDraft(
    orgId: string,
    userId: string,
    projectId: number,
    draft: { title?: string; description?: string },
  ) {
    return suggestFieldsFromDraft(this.draftDeps, orgId, userId, projectId, draft);
  }

  private get draftDeps(): TicketDraftAiDeps {
    return { db: this.db, gateway: this.gateway, audit: this.audit };
  }
}
