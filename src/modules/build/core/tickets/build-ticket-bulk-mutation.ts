import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { TicketVersionConflictException } from "./ticket-version-conflict.exception";
import { and, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.types";
import {
  cycles,
  ticketAssignees,
  ticketLabelMappings,
  ticketLabels,
  tickets,
} from "../../../../db/schema";
import type { AccessService } from "../../../access/access.service";
import type { BulkUpdateInput } from "../dto/projects.schemas";
import {
  authorizeTicketMutation,
  lockProjectTicketMutation,
  readMutationTickets,
} from "../project-crud/project-access";
import {
  emitBatchStatusChanges,
  validateBatchTransition,
} from "./build-ticket-batch-workflow";
import { resolveAssigneeId } from "./tickets-helpers";
import {
  readBulkTicketMeta,
  readMembershipUserIds,
} from "./build-ticket-bulk-effects";
import {
  dispatchTicketChangeEffects,
  enqueueTicketChangeWebhooks,
  type TicketChangeEffectDeps,
  type TicketChangeEffectRow,
  type TicketChangeFields,
} from "./ticket-change-effects";
import { resolveProjectAssignableMemberships } from "../project-crud/project-assignable-members";

export async function bulkMutateTickets(
  db: Db,
  access: AccessService,
  actor: CurrentUserContext,
  projectId: number,
  body: BulkUpdateInput,
  effectDeps?: TicketChangeEffectDeps,
) {
  const ids = [...new Set(body.ticketIds)];
  if (!ids.length || ids.length > 100)
    throw new BadRequestException("Select between 1 and 100 tickets");
  if (
    body.assigneeId !== undefined &&
    (await access.scopeFor(actor, "build:tickets:assign")) === "none"
  )
    throw new ForbiddenException("Not authorized to assign tickets");
  const effectRows: TicketChangeEffectRow[] = [];
  const assigneeId = resolveAssigneeId(body.assigneeId);
  const changeFields: TicketChangeFields = {
    status: body.status,
    priority: body.priority,
    assigneeId,
    cycleId: body.cycleId,
  };
  const result = await db.transaction(async (tx) => {
    const policy = await authorizeTicketMutation(tx, access, actor, projectId);
    await lockProjectTicketMutation(tx, actor.orgId, projectId);
    const rows = await readMutationTickets(tx, actor, projectId, ids, policy);
    if (body.versions !== undefined) {
      for (const row of rows) {
        const expectedVersion = body.versions[String(row.id)];
        if (expectedVersion !== undefined && expectedVersion !== row.version)
          throw new TicketVersionConflictException(row.version);
      }
    }
    const now = new Date();
    const update: Partial<typeof tickets.$inferInsert> = { updatedAt: now };
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
          .where(
            and(
              eq(cycles.orgId, actor.orgId),
              eq(cycles.projectId, projectId),
              eq(cycles.id, body.cycleId),
              isNull(cycles.deletedAt),
            ),
          )
          .limit(1);
        if (!cycleRow)
          throw new NotFoundException("Cycle not found in this project");
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
        policy,
      );
      update.status = body.status;
    }
    if (resolvedCycleId !== undefined) update.cycleId = resolvedCycleId;
    if (body.priority !== undefined) update.priority = body.priority;
    if (body.parentTicketId !== undefined)
      update.parentTicketId = body.parentTicketId;
    if (body.archive) {
      const blockerRows = await tx
        .select({
          parentTicketId: tickets.parentTicketId,
          childCount: count(),
        })
        .from(tickets)
        .where(
          and(
            eq(tickets.orgId, actor.orgId),
            eq(tickets.projectId, projectId),
            inArray(tickets.parentTicketId, ids),
            notInArray(tickets.id, ids),
            isNull(tickets.deletedAt),
          ),
        )
        .groupBy(tickets.parentTicketId);
      const blockersMap = new Map<number, number>();
      for (const row of blockerRows) {
        if (row.parentTicketId !== null) {
          blockersMap.set(row.parentTicketId, row.childCount);
        }
      }
      if (blockersMap.size > 0) {
        return {
          updated: 0,
          ticketIds: [],
          blocked: Array.from(blockersMap.entries()).map(
            ([ticketId, dependencyCount]) => ({
              ticketId,
              reason:
                "Has active sub-tickets that are not included in the selection",
              dependencyCount,
            }),
          ),
        };
      }
      update.deletedAt = now;
    }
    if (body.labelIds !== undefined && body.labelIds.length > 0) {
      const existingLabels = await tx
        .select({ id: ticketLabels.id })
        .from(ticketLabels)
        .where(
          and(
            eq(ticketLabels.orgId, actor.orgId),
            inArray(ticketLabels.id, body.labelIds),
          ),
        )
        .limit(body.labelIds.length);
      const existingLabelIds = new Set(existingLabels.map((l) => l.id));
      const missingLabelIds = body.labelIds.filter(
        (id) => !existingLabelIds.has(id),
      );
      if (missingLabelIds.length > 0)
        throw new NotFoundException(
          `Labels not found: ${missingLabelIds.join(", ")}`,
        );
    }
    const updated = await tx
      .update(tickets)
      .set(update)
      .where(
        and(
          eq(tickets.orgId, actor.orgId),
          eq(tickets.projectId, projectId),
          inArray(tickets.id, ids),
          isNull(tickets.deletedAt),
        ),
      )
      .returning({ id: tickets.id, version: tickets.version });
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
    if (
      body.labelIds !== undefined &&
      body.labelIds.length > 0 &&
      updated.length > 0
    ) {
      const mappings = updated.flatMap(({ id: ticketId }) =>
        body.labelIds!.map((labelId) => ({
          orgId: actor.orgId,
          ticketId,
          labelId,
        })),
      );
      await tx
        .insert(ticketLabelMappings)
        .values(mappings)
        .onConflictDoNothing();
    }
    if (body.status !== undefined)
      await emitBatchStatusChanges(
        tx,
        actor,
        projectId,
        rows,
        body.status,
        now,
        new Map(updated.map((r) => [r.id, r.version])),
      );
    if (effectDeps) {
      const ticketMeta = await readBulkTicketMeta(
        tx,
        actor.orgId,
        updated.map((row) => row.id),
      );
      const assigneeUserIdByMembership = await readMembershipUserIds(
        tx,
        actor.orgId,
        rows
          .map((row) => row.assigneeMembershipId)
          .filter((id): id is number => id != null),
      );
      for (const row of updated) {
        const beforeRow = rows.find((r) => r.id === row.id);
        const meta = ticketMeta.get(row.id);
        effectRows.push({
          id: row.id,
          reporterId: meta?.reporterId ?? null,
          before: {
            title: meta?.title ?? "",
            status: beforeRow?.status ?? body.status ?? "TODO",
            priority: beforeRow?.priority ?? "MEDIUM",
            assigneeId:
              beforeRow?.assigneeMembershipId != null
                ? (assigneeUserIdByMembership.get(beforeRow.assigneeMembershipId) ?? null)
                : null,
            dueDate: beforeRow?.dueDate ?? null,
            points: beforeRow?.points ?? null,
            type: meta?.type ?? "TASK",
            cycleId: beforeRow?.cycleId ?? null,
          },
        });
      }
      await enqueueTicketChangeWebhooks(
        effectDeps,
        actor,
        projectId,
        tx,
        effectRows,
        changeFields,
        now,
      );
    }
    return { updated: updated.length, ticketIds: updated.map((row) => row.id) };
  });
  if (effectDeps)
    await dispatchTicketChangeEffects(
      effectDeps,
      actor,
      projectId,
      effectRows,
      changeFields,
      assigneeId ? [assigneeId] : [],
    );
  return result;
}
