import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { cycles, ticketAssignees, tickets } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { ProjectsActivityService } from "../activity/projects-activity.service";
import type { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import type { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import type { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { TicketVersionConflictException } from "./ticket-version-conflict.exception";
import { decideTicketChange } from "../project-crud/project-access";
import { resolveProjectAssignableMemberships } from "../project-crud/project-assignable-members";
import type { UpdateTicketInput } from "../dto/projects.schemas";
import { normalizeTicketType, resolveAssigneeId } from "./tickets-helpers";
import { computeNextRunAt } from "../lib/projects-recurrence.util";
import { lockProjectTicketMutation } from "../project-crud/project-access";
import { assertTransitionAllowed } from "./projects-tickets-workflow-utils";
import { reserveTicketCapacity } from "../lib/build-ticket-capacity";
import { resolveValidTicketStatuses } from "./ticket-status.util";
import { ProjectsInvalidTicketStatusException } from "../../../../common/http/api-exceptions";
import type { AccessService } from "../../../access/access.service";
import {
  dispatchTicketChangeEffects,
  enqueueTicketChangeWebhooks,
  type TicketChangeEffectRow,
  type TicketChangeFields,
} from "./ticket-change-effects";

export interface ApplyTicketChangeDeps {
  readonly db: Db;
  readonly dispatch: NotificationDispatchService;
  readonly activity: ProjectsActivityService;
  readonly query: {
    authorizeMutation(tx: Db, u: CurrentUserContext, projectId: number, ticketIds: number[]): Promise<unknown>;
  };
  readonly transfer: ProjectsTicketsTransferService;
  readonly webhooksDispatch: ProjectsWebhooksDispatchService;
  readonly automationRunner: BuildAutomationRunnerService;
  readonly cache: CacheService;
  readonly access: AccessService;
}

export interface RestoreTicketRowsInput {
  readonly orgId: string;
  readonly projectId: number;
  readonly deletedAt: Date;
  readonly ticketIds?: readonly number[];
}

export async function restoreTicketRows(
  tx: DbOrTx,
  input: RestoreTicketRowsInput,
): Promise<Array<{ id: number }>> {
  if (input.ticketIds?.length === 0) return [];

  return tx
    .update(tickets)
    .set({ deletedAt: null })
    .where(
      and(
        eq(tickets.orgId, input.orgId),
        eq(tickets.projectId, input.projectId),
        eq(tickets.deletedAt, input.deletedAt),
        ...(input.ticketIds === undefined
          ? []
          : [inArray(tickets.id, [...input.ticketIds])]),
      ),
    )
    .returning({ id: tickets.id });
}

async function assertSelfRefChain(
  tx: DbOrTx,
  orgId: string,
  ticketId: number,
  refId: number,
  field: "parentTicketId" | "epicId",
  projectId: number,
): Promise<void> {
  if (refId === ticketId)
    throw new BadRequestException(
      field === "parentTicketId"
        ? "A ticket cannot be its own parent"
        : "A ticket cannot be its own epic",
    );
  const nextCol = field === "parentTicketId" ? sql.raw('"parent_ticket_id"') : sql.raw('"epic_id"');
  const nextColT = field === "parentTicketId" ? sql.raw('t."parent_ticket_id"') : sql.raw('t."epic_id"');
  const chainRows = await tx.execute<{
    id: number;
    next_id: number | null;
    project_id: number | null;
    depth: number;
  }>(sql`
    WITH RECURSIVE chain(id, next_id, project_id, depth) AS (
      SELECT id, ${nextCol}, project_id, 0
      FROM build.tickets
      WHERE id = ${refId} AND org_id = ${orgId} AND deleted_at IS NULL
      UNION ALL
      SELECT t.id, ${nextColT}, t.project_id, c.depth + 1
      FROM build.tickets t
      JOIN chain c ON t.id = c.next_id
      WHERE t.org_id = ${orgId} AND t.deleted_at IS NULL AND c.depth < 100
    )
    SELECT id, next_id, project_id, depth FROM chain
  `);
  if (chainRows.length === 0)
    throw new BadRequestException(
      field === "parentTicketId" ? "Parent ticket not found" : "Epic ticket not found",
    );
  const firstRow = chainRows[0];
  if (firstRow && Number(firstRow.project_id) !== projectId)
    throw new BadRequestException(
      field === "parentTicketId"
        ? "Parent must be in the same project"
        : "Epic must be in the same project",
    );
  const hasCycle = chainRows.some(
    (r) => Number(r.id) === ticketId || (r.next_id !== null && Number(r.next_id) === ticketId),
  );
  if (hasCycle)
    throw new BadRequestException(
      field === "parentTicketId"
        ? "Cannot set parent: this would create a cycle"
        : "Cannot set epic: this would create a cycle",
    );
  if (chainRows.length === 100 && chainRows[chainRows.length - 1]?.next_id !== null)
    throw new BadRequestException(
      field === "parentTicketId"
        ? "Parent chain exceeds maximum depth"
        : "Epic chain exceeds maximum depth",
    );
}

async function syncAssignees(
  db: DbOrTx,
  orgId: string,
  ticketId: number,
  actingUserId: string,
  input: UpdateTicketInput,
  membershipByUserId: Map<string, number>,
): Promise<void> {
  if (input.assigneeIds !== undefined) {
    await db
      .delete(ticketAssignees)
      .where(and(eq(ticketAssignees.orgId, orgId), eq(ticketAssignees.ticketId, ticketId)));
    const allIds = new Set(input.assigneeIds);
    const primary = resolveAssigneeId(input.assigneeId);
    if (primary) allIds.add(primary);
    if (allIds.size > 0) {
      await db.insert(ticketAssignees).values(
        Array.from(allIds).flatMap((userId) => {
          const membershipId = membershipByUserId.get(userId);
          return membershipId == null ? [] : [{ orgId, ticketId, membershipId, assignedBy: actingUserId }];
        }),
      );
    }
    return;
  }
  if (input.assigneeId !== undefined) {
    await db
      .delete(ticketAssignees)
      .where(and(eq(ticketAssignees.orgId, orgId), eq(ticketAssignees.ticketId, ticketId)));
    const newAssigneeId = resolveAssigneeId(input.assigneeId);
    const membershipId = newAssigneeId ? membershipByUserId.get(newAssigneeId) : undefined;
    if (membershipId !== undefined) {
      await db.insert(ticketAssignees).values({
        orgId,
        ticketId,
        membershipId,
        assignedBy: actingUserId,
      });
    }
  }
}

export async function applyTicketChange(
  deps: ApplyTicketChangeDeps,
  u: CurrentUserContext,
  projectId: number | null,
  ticketId: number,
  input: UpdateTicketInput,
): Promise<{ updated: true; updatedAt: string; version: number }> {
  const orgId = u.orgId;
  const actingUserId = u.userId;
  const now = new Date();
  const changesAssignees = input.assigneeId !== undefined || input.assigneeIds !== undefined;
  if (changesAssignees && !(await deps.access.holds(u, "build:tickets:assign")))
    throw new ForbiddenException("Not authorized to assign this ticket");
  const updateData: Partial<typeof tickets.$inferInsert> = { updatedAt: now };
  if (input.title) updateData.title = input.title;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.type) updateData.type = normalizeTicketType(input.type);
  if (input.status) updateData.status = input.status;
  if (input.priority) updateData.priority = input.priority;
  const resolvedAssignee = resolveAssigneeId(input.assigneeId);
  const pendingActorIds = new Set<string>();
  if (resolvedAssignee) pendingActorIds.add(resolvedAssignee);
  if (input.assigneeIds) input.assigneeIds.forEach((uid) => pendingActorIds.add(uid));
  if (input.epicId !== undefined) updateData.epicId = input.epicId;
  if (input.moduleId !== undefined) updateData.moduleId = input.moduleId;
  if (input.points !== undefined) updateData.points = input.points;
  if (input.cycleId !== undefined) {
    if (input.cycleId != null && projectId !== null) {
      const [cycleRow] = await deps.db
        .select({ id: cycles.id })
        .from(cycles)
        .where(and(eq(cycles.orgId, orgId), eq(cycles.projectId, projectId), eq(cycles.id, input.cycleId), isNull(cycles.deletedAt)))
        .limit(1);
      if (!cycleRow) throw new NotFoundException("Cycle not found in this project");
    }
    updateData.cycleId = input.cycleId;
  }
  if (input.originalEstimate !== undefined) updateData.originalEstimate = input.originalEstimate?.toString();
  if (input.startDate !== undefined) updateData.startDate = input.startDate;
  if (input.dueDate !== undefined) updateData.dueDate = input.dueDate;
  if (input.customerId !== undefined) updateData.customerId = input.customerId;
  if (input.parentTicketId !== undefined) updateData.parentTicketId = input.parentTicketId;
  if (input.health !== undefined) updateData.health = input.health;
  if (input.recurrenceRule != null) {
    updateData.recurrenceRule = input.recurrenceRule;
    updateData.isRecurring = input.isRecurring !== false;
    updateData.recurrenceNextRunAt = computeNextRunAt(input.recurrenceRule);
  } else if (input.recurrenceRule === null || input.isRecurring === false) {
    updateData.recurrenceRule = null;
    updateData.isRecurring = false;
    updateData.recurrenceNextRunAt = null;
  } else if (input.isRecurring === true) {
    updateData.isRecurring = true;
  }
  const before = await deps.db.query.tickets.findFirst({
    where: and(
      eq(tickets.id, ticketId),
      ...(projectId === null ? [] : [eq(tickets.projectId, projectId)]),
      eq(tickets.orgId, orgId),
      isNull(tickets.deletedAt),
    ),
    columns: {
      title: true,
      status: true,
      priority: true,
      assigneeMembershipId: true,
      startDate: true,
      dueDate: true,
      projectId: true,
      reporterId: true,
      updatedAt: true,
      points: true,
      type: true,
      cycleId: true,
      version: true,
    },
    with: { assignee: { columns: { userId: true } } },
  });
  if (!before || !before.projectId) throw new NotFoundException("Ticket not found");
  const ticketProjectId = before.projectId;
  const assigneeMemberships = await resolveProjectAssignableMemberships(deps.db, orgId, ticketProjectId, [...pendingActorIds]);
  for (const uid of pendingActorIds) {
    if (!assigneeMemberships.has(uid)) throw new NotFoundException("Assignee is not an active member of this project");
  }
  if (resolvedAssignee !== undefined) {
    updateData.assigneeMembershipId =
      resolvedAssignee !== null ? (assigneeMemberships.get(resolvedAssignee) ?? null) : null;
  }
  const beforeAssigneeId = before.assignee?.userId ?? null;
  if (input.version !== undefined && input.version !== before.version)
    throw new TicketVersionConflictException(before.version);
  if (input.expectedUpdatedAt !== undefined) {
    const expected = new Date(input.expectedUpdatedAt);
    if (before.updatedAt.getTime() !== expected.getTime()) throw new TicketVersionConflictException(before.version);
  }
  const nextStartDate = input.startDate === undefined ? before.startDate : input.startDate;
  const nextDueDate = input.dueDate === undefined ? before.dueDate : input.dueDate;
  if (nextStartDate && nextDueDate && nextDueDate < nextStartDate)
    throw new BadRequestException("Due date must be on or after start date");
  const accessResult = await decideTicketChange(deps.db, deps.access, u, ticketProjectId);
  const newAssignee = resolveAssigneeId(input.assigneeId);
  const effectRow: TicketChangeEffectRow = {
    id: ticketId,
    reporterId: before.reporterId,
    before: {
      title: before.title,
      status: before.status,
      priority: before.priority,
      assigneeId: beforeAssigneeId,
      dueDate: before.dueDate,
      points: before.points,
      type: before.type,
      cycleId: before.cycleId,
    },
  };
  const changeFields: TicketChangeFields = {
    title: input.title,
    status: input.status,
    priority: input.priority,
    assigneeId: resolveAssigneeId(input.assigneeId),
    dueDate: input.dueDate,
    points: input.points,
    type: input.type ? normalizeTicketType(input.type) : undefined,
    cycleId: updateData.cycleId,
  };
  let updatedVersion: number = before.version;
  await deps.db.transaction(async (tx) => {
    if (!accessResult.rowScoped)
      await lockProjectTicketMutation(tx, orgId, ticketProjectId);
    else {
      await deps.query.authorizeMutation(tx, u, ticketProjectId, [ticketId]);
      if (input.parentTicketId != null || input.epicId != null)
        await lockProjectTicketMutation(tx, orgId, ticketProjectId);
    }
    if (input.parentTicketId != null)
      await assertSelfRefChain(tx, orgId, ticketId, input.parentTicketId, "parentTicketId", ticketProjectId);
    if (input.epicId != null)
      await assertSelfRefChain(tx, orgId, ticketId, input.epicId, "epicId", ticketProjectId);
    if (input.status !== undefined) {
      const valid = await resolveValidTicketStatuses(tx, ticketProjectId, orgId);
      if (!valid.has(input.status)) throw new ProjectsInvalidTicketStatusException(input.status);
      if (input.status !== before.status) {
        await reserveTicketCapacity(tx, orgId, ticketProjectId, [{ status: input.status, count: 1 }], [ticketId]);
        await assertTransitionAllowed(tx, orgId, ticketProjectId, before.status, input.status, {
          userId: actingUserId, userProjectRole: accessResult.role, bypassesWorkflow: accessResult.bypassesWorkflow, ticketId,
        });
      }
    }
    const versionCondition = and(
      eq(tickets.id, ticketId),
      eq(tickets.orgId, orgId),
      isNull(tickets.deletedAt),
      eq(tickets.version, before.version),
    );
    const affected = await tx
      .update(tickets)
      .set(updateData)
      .where(versionCondition)
      .returning({ id: tickets.id, version: tickets.version });
    const [updated] = affected;
    if (!updated) {
      const [current] = await tx
        .select({ version: tickets.version })
        .from(tickets)
        .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
        .limit(1);
      throw new TicketVersionConflictException(current?.version ?? before.version);
    }
    updatedVersion = updated.version;
    if (input.status && input.status !== before.status) {
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "ticket",
        aggregateId: String(ticketId),
        aggregateVersion: updated.version,
        eventType: "build.ticket.status_changed",
        occurredAt: now,
        payload: {
          ticketId, projectId: ticketProjectId, orgId,
          previousStatus: before.status, newStatus: input.status, actorUserId: actingUserId,
        },
      });
    }
    await syncAssignees(tx, orgId, ticketId, actingUserId, input, assigneeMemberships);
    await enqueueTicketChangeWebhooks(deps, u, ticketProjectId, tx, [effectRow], changeFields, now);
  });
  await dispatchTicketChangeEffects(
    deps,
    u,
    ticketProjectId,
    [effectRow],
    changeFields,
    input.assigneeIds ?? (newAssignee ? [newAssignee] : []),
  );
  void deps.cache
    .invalidateNamespace(`build:analytics:${orgId}`)
    .catch(logSideEffectFailure("analytics cache eviction", { orgId, projectId: ticketProjectId }));
  return { updated: true as const, updatedAt: now.toISOString(), version: updatedVersion };
}
