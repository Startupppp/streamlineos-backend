import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { ticketAssignees, tickets } from "../../../db/schema";
import { resolveOrganizationActorsByUserIds } from "../../../common/organization/organization-actor";
import type { OrganizationActor } from "../../../common/organization/organization-actor";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { logger } from "../../../common/logger/logger.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { systemJobCovers } from "../../../common/auth/principal";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { ProjectsTicketConflictException } from "../../../common/http/api-exceptions";
import type { UpdateTicketInput } from "./dto/projects.schemas";
import { normalizeTicketType, resolveAssigneeId } from "./tickets-helpers";
import { computeNextRunAt } from "./projects-recurrence.util";
import { lockProjectTicketMutation } from "./build-ticket-mutation-policy";
import { assertTransitionAllowed } from "./projects-tickets-workflow-utils";
import { reserveTicketCapacity } from "./build-ticket-capacity";
import { resolveValidTicketStatuses } from "./ticket-status.util";
import { ProjectsInvalidTicketStatusException } from "../../../common/http/api-exceptions";

@Injectable()
export class ProjectsTicketsUpdateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly activity: ProjectsActivityService,
    private readonly query: ProjectsTicketsQueryService,
    private readonly read: ProjectsTicketsReadService,
    private readonly transfer: ProjectsTicketsTransferService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly automationRunner: BuildAutomationRunnerService,
    private readonly cache: CacheService,
  ) {}

  private async assertSelfRefChain(
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

    const nextCol =
      field === "parentTicketId" ? sql.raw('"parent_ticket_id"') : sql.raw('"epic_id"');
    const nextColT =
      field === "parentTicketId" ? sql.raw('t."parent_ticket_id"') : sql.raw('t."epic_id"');

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

  async updateTicket(
    u: CurrentUserContext,
    ticketId: number,
    input: UpdateTicketInput,
  ) {
    const orgId = u.orgId;
    const actingUserId = u.userId;
    const now = new Date();
    const updateData: Partial<typeof tickets.$inferInsert> = { updatedAt: now };
    if (input.title) updateData.title = input.title;
    if (input.description !== undefined)
      updateData.description = input.description;
    if (input.type) updateData.type = normalizeTicketType(input.type);
    if (input.status) updateData.status = input.status;
    if (input.priority) updateData.priority = input.priority;
    const resolvedAssignee = resolveAssigneeId(input.assigneeId);

    const pendingActorIds = new Set<string>();
    if (resolvedAssignee) pendingActorIds.add(resolvedAssignee);
    if (input.assigneeIds) input.assigneeIds.forEach((uid) => pendingActorIds.add(uid));

    let assigneeActors = new Map<string, OrganizationActor>();
    if (pendingActorIds.size > 0) {
      assigneeActors = await resolveOrganizationActorsByUserIds(this.db, orgId, [...pendingActorIds]);
      for (const uid of pendingActorIds) {
        if (!assigneeActors.has(uid))
          throw new NotFoundException("Assignee is not a member of this organization");
      }
    }

    if (resolvedAssignee !== undefined) {
      updateData.assigneeMembershipId = resolvedAssignee !== null
        ? (assigneeActors.get(resolvedAssignee)?.membershipId ?? null)
        : null;
    }
    if (input.sprintId !== undefined) updateData.sprintId = input.sprintId;
    if (input.epicId !== undefined) updateData.epicId = input.epicId;
    if (input.moduleId !== undefined) updateData.moduleId = input.moduleId;
    if (input.points !== undefined) updateData.points = input.points;
    if (input.cycleId !== undefined) updateData.cycleId = input.cycleId;
    if (input.originalEstimate !== undefined)
      updateData.originalEstimate = input.originalEstimate?.toString();
    if (input.startDate !== undefined) updateData.startDate = input.startDate;
    if (input.dueDate !== undefined) updateData.dueDate = input.dueDate;
    if (input.customerId !== undefined)
      updateData.customerId = input.customerId;
    if (input.parentTicketId !== undefined)
      updateData.parentTicketId = input.parentTicketId;
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

    const before = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)),
      columns: {
        title: true,
        status: true,
        priority: true,
        assigneeMembershipId: true,
        sprintId: true,
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
    });
    if (!before || !before.projectId)
      throw new NotFoundException("Ticket not found");
    const ticketProjectId = before.projectId;
    const beforeAssigneeId: string | null = null;
    const beforeAssigneeMembershipId = before.assigneeMembershipId;

    if (input.version !== undefined && input.version !== before.version)
      throw new ProjectsTicketConflictException();

    if (input.expectedUpdatedAt !== undefined) {
      const expected = new Date(input.expectedUpdatedAt);
      if (before.updatedAt.getTime() !== expected.getTime()) {
        throw new ProjectsTicketConflictException();
      }
    }

    const nextStartDate = input.startDate === undefined ? before.startDate : input.startDate;
    const nextDueDate = input.dueDate === undefined ? before.dueDate : input.dueDate;
    if (nextStartDate && nextDueDate && nextDueDate < nextStartDate)
      throw new BadRequestException("Due date must be on or after start date");

    const accessResult =
      u.isOrgOwner || systemJobCovers(u.principal, "build:tickets:update")
        ? { hasAccess: true, role: "OWNER" as string | null }
        : await this.read.checkProjectAccess(
            orgId,
            actingUserId,
            ticketProjectId,
          );
    if (!accessResult.hasAccess)
      throw new ForbiddenException("Not authorized to update this ticket");

    const newAssignee = resolveAssigneeId(input.assigneeId);
    await this.db.transaction(async (tx) => {
      if (systemJobCovers(u.principal, "build:tickets:update"))
        await lockProjectTicketMutation(tx, orgId, ticketProjectId);
      else
        await this.query.authorizeMutation(tx, u, ticketProjectId, [ticketId]);
      if (input.parentTicketId != null)
        await this.assertSelfRefChain(tx, orgId, ticketId, input.parentTicketId, "parentTicketId", ticketProjectId);
      if (input.epicId != null)
        await this.assertSelfRefChain(tx, orgId, ticketId, input.epicId, "epicId", ticketProjectId);
      if (input.status !== undefined) {
        const valid = await resolveValidTicketStatuses(tx, ticketProjectId, orgId);
        if (!valid.has(input.status)) throw new ProjectsInvalidTicketStatusException(input.status);
        if (input.status !== before.status) {
          await reserveTicketCapacity(tx, orgId, ticketProjectId, [{ status: input.status, count: 1 }], [ticketId]);
          await assertTransitionAllowed(tx, orgId, ticketProjectId, before.status, input.status, {
            userId: actingUserId, userProjectRole: accessResult.role, isOrgOwner: u.isOrgOwner, ticketId,
          });
        }
      }
      const versionCondition =
        and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt), eq(tickets.version, before.version));
      const affected = await tx
        .update(tickets)
        .set({ ...updateData, version: sql`${tickets.version} + 1` })
        .where(versionCondition)
        .returning({ id: tickets.id });
      if (affected.length === 0)
        throw new ConflictException("Ticket was modified by another request — refresh and retry");

      if (input.status && input.status !== before.status) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "ticket",
          aggregateId: String(ticketId),
          aggregateVersion: now.getTime(),
          eventType: "build.ticket.status_changed",
          payload: {
            ticketId,
            projectId: ticketProjectId,
            orgId,
            previousStatus: before.status,
            newStatus: input.status,
            actorUserId: actingUserId,
          },
          occurredAt: now,
        });
      }

      await this.syncAssignees(tx, orgId, ticketId, actingUserId, input, assigneeActors);

      await this.webhooksDispatch.enqueue(tx, orgId, ticketProjectId, "ticket.updated", {
        id: ticketId,
        projectId: ticketProjectId,
        title: input.title ?? before.title,
        status: input.status ?? before.status,
        priority: input.priority ?? before.priority,
        actor: actingUserId,
        timestamp: now.toISOString(),
      });
      if (newAssignee !== undefined && (newAssignee ? assigneeActors.get(newAssignee)?.membershipId ?? null : null) !== beforeAssigneeMembershipId) {
        await this.webhooksDispatch.enqueue(tx, orgId, ticketProjectId, "ticket.assigned", {
          id: ticketId,
          projectId: ticketProjectId,
          title: input.title ?? before.title,
          status: input.status ?? before.status,
          assigneeId: newAssignee,
          actor: actingUserId,
          timestamp: now.toISOString(),
        });
      }
    });

    await this.activity
      .logTicketFieldChanges(orgId, ticketId, actingUserId, { ...before, assigneeId: beforeAssigneeId }, {
          title: input.title,
          status: input.status,
          priority: input.priority,
          assigneeId: resolveAssigneeId(input.assigneeId),
          sprintId: input.sprintId,
          dueDate: input.dueDate,
          points: input.points,
          type: input.type,
          cycleId: input.cycleId,
      })
      .catch((error) => logger.error("Failed to log ticket activity", { error }));

    // Awaited, not fired: `notifyNewAssignees` reaches `NotificationDispatchService.emit`,
    // which inserts the outbox row on the AMBIENT transaction. Left floating it raced this
    // request's COMMIT, and a chunk that resumed afterwards wrote to a committed handle —
    // the assignee was simply never told. The ambient transaction is still open here.
    await this.transfer
      .notifyNewAssignees(orgId, ticketId, actingUserId, input)
      .catch((error) =>
        logger.error("Failed to notify ticket assignees", { error }),
      );

    if (input.status === "IN_REVIEW" || input.status === "CHANGES_REQUESTED") {
      const reviewTarget = input.status === "IN_REVIEW" ? before.reporterId : newAssignee;
      if (reviewTarget) {
        await this.dispatch.emit({
          eventKey: input.status === "IN_REVIEW"
            ? "build.ticket.review_requested"
            : "build.ticket.changes_requested",
          orgId,
          actorUserId: actingUserId,
          targetUserIds: [reviewTarget],
          entityType: "ticket",
          entityId: String(ticketId),
          title: input.status === "IN_REVIEW" ? "Ticket ready for review" : "Changes requested on your ticket",
          message: `Ticket "${before.title}" changed to ${input.status}.`,
          link: `/projects/${before.projectId}/tickets/${ticketId}`,
          variables: { ticketId, status: input.status, title: before.title },
        });
      }
    }


    const afterPayload = {
      ticketId,
      projectId: ticketProjectId,
      orgId,
      title: input.title ?? before.title,
      status: input.status ?? before.status,
      priority: input.priority ?? before.priority,
      assigneeId: newAssignee !== undefined ? newAssignee : beforeAssigneeId,
      type: input.type ? normalizeTicketType(input.type) : before.type,
    };

    this.automationRunner.runForTicketEvent(orgId, ticketProjectId, "ticket.updated", afterPayload);

    if (input.status && input.status !== before.status) {
      this.automationRunner.runForTicketEvent(orgId, ticketProjectId, "ticket.status_changed", afterPayload);
    }

    if (newAssignee !== undefined && (newAssignee ? assigneeActors.get(newAssignee)?.membershipId ?? null : null) !== beforeAssigneeMembershipId) {
      this.automationRunner.runForTicketEvent(orgId, ticketProjectId, "ticket.assigned", afterPayload);
    }

    void this.cache
      .del(`projects:analytics:${orgId}:${ticketProjectId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId, projectId: ticketProjectId }));

    return { updated: true, updatedAt: now.toISOString() };
  }

  private async syncAssignees(
    db: DbOrTx,
    orgId: string,
    ticketId: number,
    actingUserId: string,
    input: UpdateTicketInput,
    actorMap: Map<string, OrganizationActor>,
  ): Promise<void> {
    if (input.assigneeIds !== undefined) {
      await db
        .delete(ticketAssignees)
        .where(eq(ticketAssignees.ticketId, ticketId));
      const allIds = new Set(input.assigneeIds);
      const primary = resolveAssigneeId(input.assigneeId);
      if (primary) allIds.add(primary);
      if (allIds.size > 0) {
        await db.insert(ticketAssignees).values(
          Array.from(allIds).flatMap((userId) => {
            const membershipId = actorMap.get(userId)?.membershipId;
            return membershipId == null ? [] : [{ orgId, ticketId, membershipId, assignedBy: actingUserId }];
          }),
        );
      }
      return;
    }

    if (input.assigneeId !== undefined) {
      await db
        .delete(ticketAssignees)
        .where(eq(ticketAssignees.ticketId, ticketId));
      const newAssigneeId = resolveAssigneeId(input.assigneeId);
      if (newAssigneeId && actorMap.get(newAssigneeId)?.membershipId != null) {
        await db.insert(ticketAssignees).values({
          orgId,
          ticketId,
          membershipId: actorMap.get(newAssigneeId)!.membershipId,
          assignedBy: actingUserId,
        });
      }
    }
  }
}
