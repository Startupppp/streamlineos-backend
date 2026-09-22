import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.types";
import {
  cycles,
  ticketAssignees,
  tickets,
} from "../../../db/schema";
import type { AccessService } from "../../access/access.service";
import type { BulkUpdateInput } from "./dto/projects.schemas";
import {
  authorizeTicketMutation,
  lockProjectTicketMutation,
  readMutationTickets,
} from "./build-ticket-mutation-policy";
import {
  emitBatchStatusChanges,
  validateBatchTransition,
} from "./build-ticket-batch-workflow";
import { resolveAssigneeId } from "./tickets-helpers";
import { resolveProjectAssignableMemberships } from "./project-access";

export async function bulkMutateTickets(
  db: Db,
  access: AccessService,
  actor: CurrentUserContext,
  projectId: number,
  body: BulkUpdateInput,
) {
  const ids = [...new Set(body.ticketIds)];
  if (!ids.length || ids.length > 100)
    throw new BadRequestException("Select between 1 and 100 tickets");
  if (
    body.assigneeId !== undefined &&
    (await access.scopeFor(actor, "build:tickets:assign")) === "none"
  )
    throw new ForbiddenException("Not authorized to assign tickets");
  return db.transaction(async (tx) => {
    const policy = await authorizeTicketMutation(tx, access, actor, projectId);
    await lockProjectTicketMutation(tx, actor.orgId, projectId);
    const rows = await readMutationTickets(tx, actor, projectId, ids, policy);
    const now = new Date();
    const update: Partial<typeof tickets.$inferInsert> = { updatedAt: now };
    const assigneeId = resolveAssigneeId(body.assigneeId);
    if (assigneeId !== undefined) {
      const assigneeMemberships = await resolveProjectAssignableMemberships(
        tx,
        actor.orgId,
        projectId,
        assigneeId === null ? [] : [assigneeId],
      );
      const assigneeMembershipId =
        assigneeId === null ? undefined : assigneeMemberships.get(assigneeId);
      if (assigneeId !== null && assigneeMembershipId === undefined)
        throw new NotFoundException(
          "Assignee is not an active member of this project",
        );
      update.assigneeMembershipId = assigneeMembershipId ?? null;
    }
    let resolvedCycleId: number | null | undefined;
    if (body.cycleId !== undefined) {
      if (body.cycleId != null) {
        const [cycleRow] = await tx
          .select({ id: cycles.id })
          .from(cycles)
          .where(and(eq(cycles.orgId, actor.orgId), eq(cycles.projectId, projectId), eq(cycles.id, body.cycleId)))
          .limit(1);
        if (!cycleRow) throw new NotFoundException("Cycle not found in this project");
      }
      resolvedCycleId = body.cycleId;
    }
    if (body.parentTicketId != null) {
      if (ids.includes(body.parentTicketId))
        throw new BadRequestException("Cannot set a ticket as its own parent");
      const [ancestorRow] = await tx.execute(sql`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_ticket_id FROM build.tickets
          WHERE id = ${body.parentTicketId} AND org_id = ${actor.orgId} AND project_id = ${projectId} AND deleted_at IS NULL
          UNION
          SELECT t.id, t.parent_ticket_id FROM build.tickets t JOIN ancestors a ON t.id = a.parent_ticket_id
          WHERE t.org_id = ${actor.orgId} AND t.project_id = ${projectId} AND t.deleted_at IS NULL
        ) SELECT EXISTS(SELECT 1 FROM ancestors) AS found,
          EXISTS(SELECT 1 FROM ancestors WHERE id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})) AS cycle
      `);
      if (!ancestorRow?.found)
        throw new NotFoundException("Parent ticket not found in this project");
      if (ancestorRow?.cycle)
        throw new BadRequestException(
          "Cannot set parent: this would create a cycle",
        );
    }
    if (body.status !== undefined) {
      const effectiveRows = rows.map((row) => ({
        ...row,
        assigneeMembershipId:
          update.assigneeMembershipId === undefined
            ? row.assigneeMembershipId
            : update.assigneeMembershipId,
        cycleId: resolvedCycleId === undefined ? row.cycleId : resolvedCycleId,
        priority: body.priority ?? row.priority,
      }));
      await validateBatchTransition(
        tx,
        actor,
        projectId,
        effectiveRows,
        body.status,
        policy.role,
      );
      update.status = body.status;
    }
    if (resolvedCycleId !== undefined) update.cycleId = resolvedCycleId;
    if (body.priority !== undefined) update.priority = body.priority;
    if (body.parentTicketId !== undefined)
      update.parentTicketId = body.parentTicketId;
    const updated = await tx
      .update(tickets)
      .set({ ...update, version: sql`${tickets.version} + 1` })
      .where(
        and(
          eq(tickets.orgId, actor.orgId),
          eq(tickets.projectId, projectId),
          inArray(tickets.id, ids),
          isNull(tickets.deletedAt),
        ),
      )
      .returning({ id: tickets.id });
    if (assigneeId !== undefined) {
      await tx
        .delete(ticketAssignees)
        .where(
          and(
            eq(ticketAssignees.orgId, actor.orgId),
            inArray(ticketAssignees.ticketId, ids),
          ),
        );
      const membershipId = update.assigneeMembershipId;
      if (membershipId != null)
        await tx.insert(ticketAssignees).values(
          ids.map((ticketId) => ({
            orgId: actor.orgId,
            ticketId,
            membershipId,
            assignedBy: actor.userId,
          })),
        );
    }
    if (body.status !== undefined)
      await emitBatchStatusChanges(
        tx,
        actor,
        projectId,
        rows,
        body.status,
        now,
      );
    return { updated: updated.length, ticketIds: updated.map((row) => row.id) };
  });
}
