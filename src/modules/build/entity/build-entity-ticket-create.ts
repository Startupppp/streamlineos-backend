import { and, eq, isNull, type SQL } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { projects, ticketRelatedLinks } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  EntityActionResult,
  EntityActor,
} from "../../entity-reference/entity-reference.types";
import { entityProjectWriteRefusal, text } from "./build-entity-action-helpers";
import { BuildTicketCreationService } from "../core/tickets";
import { appUrl } from "../../email/app-url";

const TICKET_TYPES = ["TASK", "BUG"] as const;
type TicketType = (typeof TICKET_TYPES)[number];

function isTicketType(value: string): value is TicketType {
  return TICKET_TYPES.some((ticketType) => ticketType === value);
}

function positiveInt(input: Record<string, unknown>, name: string): number | null {
  const value = input[name];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Built here from two ids, never taken from input, so a caller cannot plant an arbitrary URL. */
function chatMessageUrl(channelId: number, messageId: number): string {
  const path = `/chat?channel=${channelId}&message=${messageId}`;
  try {
    return `${appUrl()}${path}`;
  } catch {
    return path;
  }
}

export async function createTicketFromAction(
  db: Db,
  audit: AuditService,
  ticketCreation: BuildTicketCreationService,
  actor: EntityActor,
  projectId: number,
  input: Record<string, unknown>,
  reach: SQL,
): Promise<EntityActionResult> {
  const refusal = await entityProjectWriteRefusal(db, actor, reach, projectId);
  if (refusal !== null) return { ok: false, reason: refusal };

  const type = text(input, "type");
  if (!type || !isTicketType(type)) return { ok: false, reason: "invalid" };

  const project = await db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.orgId, actor.orgId),
      isNull(projects.deletedAt),
    ),
    columns: { key: true },
  });
  if (!project) return { ok: false, reason: "forbidden" };

  const description = text(input, "description") ?? "";
  const title = (text(input, "title") ?? description.slice(0, 80)).trim() || "Untitled";
  const sourceChannelId = positiveInt(input, "sourceChannelId");
  const sourceMessageId = positiveInt(input, "sourceMessageId");

  const { row: created, createdResult } = await db.transaction(async (tx) => {
    const createdResult = await ticketCreation.createInTransaction(tx, {
      orgId: actor.orgId,
      projectId,
      actor: { userId: actor.userId, membershipId: actor.membershipId ?? null },
      drafts: [{
        title,
        description: description || null,
        type,
        status: "TODO",
        priority: "MEDIUM",
        reporterId: actor.userId,
        activityToValue:
          sourceChannelId !== null && sourceMessageId !== null ? "From a chat message" : null,
      }],
    });
    const row = createdResult.tickets[0];

    // The backlink to the chat message this ticket was converted from.
    if (row && sourceChannelId !== null && sourceMessageId !== null) {
      await tx.insert(ticketRelatedLinks).values({
        orgId: actor.orgId,
        ticketId: row.id,
        url: chatMessageUrl(sourceChannelId, sourceMessageId),
        label: "Chat message",
        createdBy: actor.userId,
        createdByMembershipId: actor.membershipId ?? null,
      });
    }

    return { row, createdResult };
  });
  ticketCreation.publish(createdResult);

  if (!created) return { ok: false, reason: "invalid" };

  audit.log({
    action: "ticket.created_from_message",
    userId: actor.userId,
    orgId: actor.orgId,
    targetId: String(created.id),
    targetType: "ticket",
    metadata: { projectId, type },
  });

  return {
    ok: true,
    message: `Created ${type} ${project.key}-${created.ticketNumber}: ${created.title}`,
    data: {
      ticketId: created.id,
      ticketNumber: created.ticketNumber,
      projectKey: project.key,
      title: created.title,
      status: created.status,
    },
  };
}
