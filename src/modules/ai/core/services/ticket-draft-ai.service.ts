import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { ticketLabels } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  TicketSuggestTitleOutputSchema,
  TicketSuggestFieldsOutputSchema,
} from "../dto/ticket-ai.schemas";
import { AiGatewayService, type AiTextStream } from "../gateway/ai-gateway.service";
import { unwrapAiResult } from "./gateway-result.util";
import { assertProject } from "./ticket-ai-assertions";
import { DESCRIPTION_MAX, TEXT_LIMIT, stripHtml } from "./ticket-ai-text";

/**
 * AI assistance while a ticket is still being COMPOSED — there is no ticket row
 * yet, only the form's draft title and description.
 *
 * That is the whole reason it is not `TicketTriageAiService`: triage reads a
 * persisted ticket and writes subtasks and checklists back to it, while these
 * three take an unsaved draft, authorize against the project alone and persist
 * nothing. The two have different authorization seams (`assertTicket` vs
 * `assertProject`) and different failure modes.
 */
@Injectable()
export class TicketDraftAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  async suggestTitleFromDraft(
    orgId: string,
    userId: string,
    projectId: number,
    draft: { title?: string; description?: string },
  ) {
    const plainDescription = stripHtml(draft.description ?? "").slice(0, TEXT_LIMIT);
    const currentTitle = (draft.title ?? "").trim();
    if (!plainDescription && !currentTitle) {
      throw new BadRequestException("Provide a title or description to suggest a title");
    }

    await runInTenantTransaction(this.db, async () => {
      await assertProject(this.db, orgId, projectId);
    }, { orgId });

    const system =
      "You are a project management assistant. Suggest one concise, actionable issue title (max 120 characters). Output only the title — no quotes, no preamble.";
    const user = `Project context: issue draft
Current title: ${currentTitle || "(none)"}
Description:
${plainDescription || "(none)"}

Suggest a clear issue title.`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "ticket.suggest-title",
      prompt: { system, user },
      schema: TicketSuggestTitleOutputSchema,
      tier: "fast",
      maxTokens: 128,
      charge: true,
    });

    const data = unwrapAiResult(result);
    const title = data.title.trim().replace(/^["']|["']$/g, "").slice(0, 120);
    this.audit.log({
      action: "ai.ticket.suggest-title",
      userId,
      orgId,
      resourceType: "project",
      resourceId: String(projectId),
    });
    return { title };
  }

  async improveDescriptionDraft(
    orgId: string,
    userId: string,
    projectId: number,
    draft: { title?: string; description?: string },
  ) {
    const sourceText = (draft.description?.trim() || draft.title?.trim() || "").slice(0, TEXT_LIMIT);
    if (!sourceText) {
      throw new BadRequestException("Provide a title or description to improve");
    }

    await runInTenantTransaction(this.db, async () => {
      await assertProject(this.db, orgId, projectId);
    }, { orgId });

    const system = `You are a technical writer specializing in software tickets.
Rewrite the provided text into a well-structured ticket description using HTML tags compatible with TipTap/ProseMirror (<p>, <ul>, <li>, <strong>, <em>).
Output ONLY the HTML string, no markdown, no code blocks, no preamble. Preserve the full substance of long source text.
Structure: overview paragraph, acceptance criteria as <ul>, optional notes.`;

    const user = `Ticket title: "${(draft.title ?? "").trim() || "(untitled)"}"
Draft description:
${sourceText}

Produce an improved HTML description.`;

    const result = await this.gateway.invokeText({
      actor: { orgId, userId },
      feature: "ticket.improve-description",
      prompt: { system, user },
      tier: "fast",
      maxTokens: 4096,
      charge: true,
    });

    const description = unwrapAiResult(result);
    this.audit.log({
      action: "ai.ticket.improve-description-draft",
      userId,
      orgId,
      resourceType: "project",
      resourceId: String(projectId),
    });
    return { description: description.slice(0, DESCRIPTION_MAX) };
  }

  async streamImproveDescriptionDraft(
    orgId: string,
    userId: string,
    projectId: number,
    draft: { title?: string; description?: string },
    signal: AbortSignal,
  ): Promise<AiTextStream> {
    const sourceText = (draft.description?.trim() || draft.title?.trim() || "").slice(0, TEXT_LIMIT);
    if (!sourceText) throw new BadRequestException("Provide a title or description to improve");
    await runInTenantTransaction(this.db, async () => {
      await assertProject(this.db, orgId, projectId);
    }, { orgId });
    const system = `You are a technical writer specializing in software tickets.
Rewrite the provided text into a well-structured ticket description using HTML tags compatible with TipTap/ProseMirror (<p>, <ul>, <li>, <strong>, <em>).
Output ONLY the HTML string, no markdown, no code blocks, no preamble. Preserve the full substance of long source text.
Structure: overview paragraph, acceptance criteria as <ul>, optional notes.`;
    const user = `Ticket title: "${(draft.title ?? "").trim() || "(untitled)"}"
Draft description:
${sourceText}

Produce an improved HTML description.`;
    return this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "ticket.improve-description",
      prompt: { system, user },
      maxTokens: 4096,
      charge: true,
      signal,
    });
  }

  async suggestFieldsFromDraft(
    orgId: string,
    userId: string,
    projectId: number,
    draft: { title?: string; description?: string },
  ) {
    const plainDescription = stripHtml(draft.description ?? "").slice(0, TEXT_LIMIT);
    const currentTitle = (draft.title ?? "").trim();
    if (!plainDescription && !currentTitle) {
      throw new BadRequestException("Provide a title or description to suggest fields");
    }

    const labels = await runInTenantTransaction(this.db, async () => {
      await assertProject(this.db, orgId, projectId);
      return this.db
        .select({ id: ticketLabels.id, name: ticketLabels.name })
        .from(ticketLabels)
        .where(eq(ticketLabels.orgId, orgId))
        .orderBy(asc(ticketLabels.name))
        .limit(100);
    }, { orgId });

    const labelCatalog =
      labels.length > 0
        ? labels.map((l) => l.name).join(", ")
        : "(no labels configured — return an empty labelNames array)";

    const system = `You are a project management assistant helping triage a new issue draft.
Suggest priority (LOW|MEDIUM|HIGH|URGENT), story-point estimate (0-100 or null), and up to 5 labels.
CRITICAL: labelNames must be chosen ONLY from the available labels list (exact name match). If none fit, return [].`;

    const user = `Title: ${currentTitle || "(untitled)"}
Description:
${plainDescription || "(none)"}
Available labels: ${labelCatalog}

Suggest priority, points, and matching labels with a short rationale.`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "ticket.suggest-fields",
      prompt: { system, user },
      schema: TicketSuggestFieldsOutputSchema,
      tier: "fast",
      maxTokens: 512,
      charge: true,
    });

    const data = unwrapAiResult(result);
    const nameToId = new Map(labels.map((l) => [l.name.toLowerCase(), l] as const));
    const matchedLabels = data.labelNames
      .map((name) => nameToId.get(name.trim().toLowerCase()))
      .filter((l): l is { id: number; name: string } => l != null)
      .slice(0, 5);

    this.audit.log({
      action: "ai.ticket.suggest-fields",
      userId,
      orgId,
      resourceType: "project",
      resourceId: String(projectId),
    });

    return {
      priority: data.priority,
      points: data.points,
      labelIds: matchedLabels.map((l) => l.id),
      labelNames: matchedLabels.map((l) => l.name),
      rationale: data.rationale,
    };
  }
}
