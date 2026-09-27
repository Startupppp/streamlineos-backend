import { and, eq, isNull } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { projects, tickets } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  EntityActionResult,
  EntityActor,
} from "../../entity-reference/entity-reference.types";
import { isProjectMember, text } from "./build-entity-action-helpers";
import { reserveTicketCapacity } from "../core/tickets";
import { allocateTicketNumbers } from "../core/lib/allocate-ticket-number";

const TICKET_TYPES = ["TASK", "BUG"] as const;
type TicketType = (typeof TICKET_TYPES)[number];

function isTicketType(value: string): value is TicketType {
  return TICKET_TYPES.some((ticketType) => ticketType === value);
}

export async function createTicketFromAction(
  db: Db,
  audit: AuditService,
  actor: EntityActor,
  projectId: number,
  input: Record<string, unknown>,
): Promise<EntityActionResult> {
  const allowed = await isProjectMember(db, actor, projectId);
  if (!allowed) return { ok: false, reason: "forbidden" };

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

  const created = await db.transaction(async (tx) => {
    await reserveTicketCapacity(tx, actor.orgId, projectId, [{ status: "TODO", count: 1 }]);
    const ticketNumber = await allocateTicketNumbers(tx, actor.orgId, projectId);

    const [row] = await tx
      .insert(tickets)
      .values({
        orgId: actor.orgId,
        projectId,
        ticketNumber,
        title,
        description: description || null,
        type,
        status: "TODO",
        priority: "MEDIUM",
        reporterId: actor.userId,
      })
      .returning();

    return row;
  });

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
