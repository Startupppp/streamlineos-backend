import { BadRequestException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { ticketLabels } from "../../../../../db/schema";
import { type Db } from "../../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../../common/tenant/run-in-tenant-transaction";
import { AuditService } from "../../../../../common/audit/audit.service";
import {
  TicketSuggestTitleOutputSchema,
  TicketSuggestFieldsOutputSchema,
} from "../../dto/ticket-ai.schemas";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { unwrapAiResult } from "../gateway-result.util";
import { assertProject } from "../ticket-ai-assertions";

const TEXT_LIMIT = 2000;

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Helping somebody WRITE a ticket, before there is one.
 *
 * Split from the two helpers that work on a ticket that already exists
 * (`suggestSubtasks`, `generateChecklist`), because the difference decides what
 * each can assume: these three take a DRAFT off the request and gate on the
 * project, so they call `assertProject` and never `assertTicket`, and they have
 * no row to attribute the suggestion to.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged.
 */
export interface TicketDraftAiDeps {
  readonly db: Db;
  readonly gateway: AiGatewayService;
  readonly audit: AuditService;
}

export async function suggestTitleFromDraft(
  deps: TicketDraftAiDeps,
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

  await runInTenantTransaction(deps.db, async () => {
    await assertProject(deps.db, orgId, projectId);
  }, { orgId });

  const system =
    "You are a project management assistant. Suggest one concise, actionable issue title (max 120 characters). Output only the title — no quotes, no preamble.";
  const user = `Project context: issue draft
Current title: ${currentTitle || "(none)"}
Description:
${plainDescription || "(none)"}

Suggest a clear issue title.`;

  const result = await deps.gateway.invokeStructured({
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
  deps.audit.log({
    action: "ai.ticket.suggest-title",
    userId,
    orgId,
    resourceType: "project",
    resourceId: String(projectId),
  });
  return { title };
}

export async function improveDescriptionDraft(
  deps: TicketDraftAiDeps,
  orgId: string,
  userId: string,
  projectId: number,
  draft: { title?: string; description?: string },
) {
  const sourceText = (draft.description?.trim() || draft.title?.trim() || "").slice(0, TEXT_LIMIT);
  if (!sourceText) {
    throw new BadRequestException("Provide a title or description to improve");
  }

  await runInTenantTransaction(deps.db, async () => {
    await assertProject(deps.db, orgId, projectId);
  }, { orgId });

  const system = `You are a technical writer specializing in software tickets.
Rewrite the provided text into a well-structured ticket description using HTML tags compatible with TipTap/ProseMirror (<p>, <ul>, <li>, <strong>, <em>).
Output ONLY the HTML string, no markdown, no code blocks, no preamble. Keep it under 5000 characters.
Structure: overview paragraph, acceptance criteria as <ul>, optional notes.`;

  const user = `Ticket title: "${(draft.title ?? "").trim() || "(untitled)"}"
Draft description:
${sourceText}

Produce an improved HTML description.`;

  const result = await deps.gateway.invokeText({
    actor: { orgId, userId },
    feature: "ticket.improve-description",
    prompt: { system, user },
    tier: "fast",
    maxTokens: 768,
    charge: true,
  });

  const description = unwrapAiResult(result);
  deps.audit.log({
    action: "ai.ticket.improve-description-draft",
    userId,
    orgId,
    resourceType: "project",
    resourceId: String(projectId),
  });
  return { description: description.slice(0, 5000) };
}

export async function suggestFieldsFromDraft(
  deps: TicketDraftAiDeps,
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

  const labels = await runInTenantTransaction(deps.db, async () => {
    await assertProject(deps.db, orgId, projectId);
    return deps.db
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

  const result = await deps.gateway.invokeStructured({
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

  deps.audit.log({
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
