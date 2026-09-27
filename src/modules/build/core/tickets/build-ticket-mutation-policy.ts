import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.types";
import { tickets } from "../../../../db/schema";
import type { AccessService } from "../../../access/access.service";
import { resolveProjectAccess } from "../project-access";
import { resolveTicketsScope, ticketScope } from "./tickets-scope";

export async function lockProjectTicketMutation(db: Db, orgId: string, projectId: number) {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`build:tickets:${orgId}:${projectId}`}, 0))`);
}

export async function authorizeTicketMutation(db: Db, access: AccessService, actor: CurrentUserContext, projectId: number) {
  const projectAccess = await resolveProjectAccess(db, access, actor, projectId);
  if (!projectAccess.hasAccess) throw new ForbiddenException("Not authorized to update this project");
  const read = await resolveTicketsScope(access, actor);
  const predicate = read.compose(
    { tenant: tickets.orgId, scope: ticketScope(read.orgId, read.actorId) },
    ({ sql: where }) => where,
    () => sql`false`,
  );
  return { role: projectAccess.role, predicate };
}

export async function readMutationTickets(
  db: Db, actor: CurrentUserContext, projectId: number, ids: number[],
  policy: Awaited<ReturnType<typeof authorizeTicketMutation>>,
) {
  const rows = await db.select({
    id: tickets.id, status: tickets.status, rank: tickets.rank, version: tickets.version,
    assigneeMembershipId: tickets.assigneeMembershipId, dueDate: tickets.dueDate,
    priority: tickets.priority, points: tickets.points, epicId: tickets.epicId, cycleId: tickets.cycleId,
    allowed: sql<boolean>`${policy.predicate}`,
  }).from(tickets).where(and(
    eq(tickets.orgId, actor.orgId), eq(tickets.projectId, projectId),
    inArray(tickets.id, ids), isNull(tickets.deletedAt),
  )).orderBy(tickets.id).for("update");
  if (rows.length !== ids.length) throw new NotFoundException("One or more ticket IDs not found in this project");
  if (rows.some((row) => !row.allowed)) throw new ForbiddenException("Ticket is outside your data scope");
  return rows;
}
