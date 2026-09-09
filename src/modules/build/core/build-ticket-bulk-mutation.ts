import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.types";
import { organizationMembers, sprints, ticketAssignees, tickets } from "../../../db/schema";
import type { AccessService } from "../../access/access.service";
import type { BulkUpdateInput } from "./dto/projects.schemas";
import { authorizeTicketMutation, lockProjectTicketMutation, readMutationTickets } from "./build-ticket-mutation-policy";
import { emitBatchStatusChanges, validateBatchTransition } from "./build-ticket-batch-workflow";
import { resolveAssigneeId } from "./tickets-helpers";

export async function bulkMutateTickets(db: Db, access: AccessService, actor: CurrentUserContext, projectId: number, body: BulkUpdateInput) {
  const ids = [...new Set(body.ticketIds)];
  if (!ids.length || ids.length > 100) throw new BadRequestException("Select between 1 and 100 tickets");
  return db.transaction(async (tx) => {
    const policy = await authorizeTicketMutation(tx, access, actor, projectId);
    await lockProjectTicketMutation(tx, actor.orgId, projectId);
    const rows = await readMutationTickets(tx, actor, projectId, ids, policy);
    const now = new Date();
    const update: Partial<typeof tickets.$inferInsert> = { updatedAt: now };
    const assigneeId = resolveAssigneeId(body.assigneeId);
    if (assigneeId !== undefined) {
      const assignee = assigneeId === null ? undefined : await tx.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.orgId, actor.orgId), eq(organizationMembers.userId, assigneeId), eq(organizationMembers.status, "ACTIVE")),
        columns: { id: true },
      });
      if (assigneeId !== null && !assignee) throw new NotFoundException("Assignee is not an active member of this organization");
      update.assigneeMembershipId = assignee?.id ?? null;
    }
    if (body.sprintId != null) {
      const sprint = await tx.query.sprints.findFirst({ where: and(
        eq(sprints.orgId, actor.orgId), eq(sprints.projectId, projectId), eq(sprints.id, body.sprintId), isNull(sprints.deletedAt),
      ), columns: { id: true } });
      if (!sprint) throw new NotFoundException("Sprint not found in this project");
    }
    if (body.parentTicketId != null) {
      if (ids.includes(body.parentTicketId)) throw new BadRequestException("Cannot set a ticket as its own parent");
      const [ancestor] = await tx.execute<{ found: boolean; cycle: boolean }>(sql`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_ticket_id FROM build.tickets
          WHERE id = ${body.parentTicketId} AND org_id = ${actor.orgId} AND project_id = ${projectId} AND deleted_at IS NULL
          UNION
          SELECT t.id, t.parent_ticket_id FROM build.tickets t JOIN ancestors a ON t.id = a.parent_ticket_id
          WHERE t.org_id = ${actor.orgId} AND t.project_id = ${projectId} AND t.deleted_at IS NULL
        ) SELECT EXISTS(SELECT 1 FROM ancestors) AS found,
          EXISTS(SELECT 1 FROM ancestors WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})) AS cycle
      `);
      if (!ancestor?.found) throw new NotFoundException("Parent ticket not found in this project");
      if (ancestor.cycle) throw new BadRequestException("Cannot set parent: this would create a cycle");
    }
    if (body.status !== undefined) {
      const effectiveRows = rows.map((row) => ({ ...row,
        assigneeMembershipId: update.assigneeMembershipId === undefined ? row.assigneeMembershipId : update.assigneeMembershipId,
        sprintId: body.sprintId === undefined ? row.sprintId : body.sprintId,
        priority: body.priority ?? row.priority,
      }));
      await validateBatchTransition(tx, actor, projectId, effectiveRows, body.status, policy.role);
      update.status = body.status;
    }
    if (body.sprintId !== undefined) update.sprintId = body.sprintId;
    if (body.priority !== undefined) update.priority = body.priority;
    if (body.parentTicketId !== undefined) update.parentTicketId = body.parentTicketId;
    const updated = await tx.update(tickets).set({ ...update, version: sql`${tickets.version} + 1` }).where(and(
      eq(tickets.orgId, actor.orgId), eq(tickets.projectId, projectId), inArray(tickets.id, ids), isNull(tickets.deletedAt),
    )).returning({ id: tickets.id });
    if (assigneeId !== undefined) {
      await tx.delete(ticketAssignees).where(and(eq(ticketAssignees.orgId, actor.orgId), inArray(ticketAssignees.ticketId, ids)));
      const membershipId = update.assigneeMembershipId;
      if (membershipId != null) await tx.insert(ticketAssignees).values(ids.map((ticketId) => ({
        orgId: actor.orgId, ticketId, membershipId, assignedBy: actor.userId,
      })));
    }
    if (body.status !== undefined) await emitBatchStatusChanges(tx, actor, projectId, rows, body.status, now);
    return { updated: updated.length, ticketIds: updated.map((row) => row.id) };
  });
}
