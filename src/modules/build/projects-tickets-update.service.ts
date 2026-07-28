import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { ticketAssignees, tickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { CacheService } from "../../common/cache/cache.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ProjectsEmailService } from "./projects-email.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { ProjectsTicketConflictException } from "../../common/http/api-exceptions";
import type { UpdateTicketInput } from "./dto/projects.schemas";
import { normalizeTicketType, resolveAssigneeId } from "./tickets-helpers";
import { computeNextRunAt } from "./projects-recurrence.util";

@Injectable()
export class ProjectsTicketsUpdateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly projectsEmail: ProjectsEmailService,
    private readonly activity: ProjectsActivityService,
    private readonly query: ProjectsTicketsQueryService,
    private readonly read: ProjectsTicketsReadService,
    private readonly transfer: ProjectsTicketsTransferService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly cache: CacheService,
  ) {}

  private async assertValidParent(
    orgId: string,
    childTicketId: number,
    parentTicketId: number,
    projectId: number,
  ): Promise<void> {
    if (parentTicketId === childTicketId) {
      throw new BadRequestException("A ticket cannot be its own parent");
    }
    let current: number | null = parentTicketId;
    let hops = 0;
    while (current != null && hops < 100) {
      if (current === childTicketId) {
        throw new BadRequestException(
          "Cannot set parent: this would create a cycle",
        );
      }
      const row:
        | { parentTicketId: number | null; projectId: number | null }
        | undefined = await this.db.query.tickets.findFirst({
        where: and(eq(tickets.id, current), eq(tickets.orgId, orgId)),
        columns: { parentTicketId: true, projectId: true },
      });
      if (!row) throw new BadRequestException("Parent ticket not found");
      if (hops === 0 && row.projectId !== projectId) {
        throw new BadRequestException("Parent must be in the same project");
      }
      current = row.parentTicketId;
      hops += 1;
    }
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
    if (resolvedAssignee !== undefined)
      updateData.assigneeId = resolvedAssignee;
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
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)),
      columns: {
        title: true,
        status: true,
        priority: true,
        assigneeId: true,
        sprintId: true,
        dueDate: true,
        projectId: true,
        updatedAt: true,
        points: true,
        type: true,
        cycleId: true,
      },
    });
    if (!before || !before.projectId)
      throw new NotFoundException("Ticket not found");

    if (input.expectedUpdatedAt !== undefined) {
      const expected = new Date(input.expectedUpdatedAt);
      if (before.updatedAt.getTime() !== expected.getTime()) {
        throw new ProjectsTicketConflictException();
      }
    }

    const accessResult =
      u.isOrgOwner || u.isPlatformAdmin
        ? { hasAccess: true, role: "OWNER" as string | null }
        : await this.read.checkProjectAccess(
            orgId,
            actingUserId,
            before.projectId,
          );
    if (!accessResult.hasAccess)
      throw new ForbiddenException("Not authorized to update this ticket");

    if (input.parentTicketId != null) {
      await this.assertValidParent(
        orgId,
        ticketId,
        input.parentTicketId,
        before.projectId,
      );
    }

    if (input.status !== undefined) {
      const statusChanged = input.status !== before.status;
      if (statusChanged) {
        await Promise.all([
          this.query.validateTicketStatus(
            before.projectId,
            orgId,
            input.status,
          ),
          this.query.enforceWipLimitForStatus(
            orgId,
            before.projectId,
            input.status,
            ticketId,
          ),
        ]);
        await this.query.assertTransitionAllowed(
          orgId,
          before.projectId,
          before.status,
          input.status,
          {
            userId: actingUserId,
            userProjectRole: accessResult.role,
            isOrgOwner: u.isOrgOwner,
            isPlatformAdmin: u.isPlatformAdmin,
            ticketId,
          },
        );
      } else {
        await this.query.validateTicketStatus(
          before.projectId,
          orgId,
          input.status,
        );
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set(updateData)
        .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)));

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
            projectId: before.projectId,
            orgId,
            previousStatus: before.status,
            newStatus: input.status,
            actorUserId: actingUserId,
          },
          occurredAt: now,
        });
      }
    });

    await Promise.all([
      this.syncAssignees(orgId, ticketId, actingUserId, input),
      this.activity
        .logTicketFieldChanges(orgId, ticketId, actingUserId, before, {
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
        .catch((error) =>
          logger.error("Failed to log ticket activity", { error }),
        ),
    ]);

    void this.transfer
      .notifyNewAssignees(orgId, ticketId, actingUserId, input)
      .catch((error) =>
        logger.error("Failed to notify ticket assignees", { error }),
      );

    if (input.status === "IN_REVIEW" || input.status === "CHANGES_REQUESTED") {
      void this.projectsEmail
        .notifyStatusReview(ticketId, actingUserId, input.status)
        .catch(() => undefined);
    }

    const ticketProjectId = before.projectId;
    this.webhooksDispatch.dispatch(orgId, ticketProjectId, "ticket.updated", {
      id: ticketId,
      projectId: ticketProjectId,
      title: input.title ?? before.title,
      status: input.status ?? before.status,
      priority: input.priority ?? before.priority,
      actor: actingUserId,
      timestamp: now.toISOString(),
    });

    const newAssignee = resolveAssigneeId(input.assigneeId);
    if (newAssignee !== undefined && newAssignee !== before.assigneeId) {
      this.webhooksDispatch.dispatch(
        orgId,
        ticketProjectId,
        "ticket.assigned",
        {
          id: ticketId,
          projectId: ticketProjectId,
          title: input.title ?? before.title,
          status: input.status ?? before.status,
          assigneeId: newAssignee,
          actor: actingUserId,
          timestamp: now.toISOString(),
        },
      );
    }

    void this.cache
      .del(`projects:analytics:${orgId}:${ticketProjectId}`)
      .catch(() => undefined);

    return { updated: true, updatedAt: now.toISOString() };
  }

  private async syncAssignees(
    orgId: string,
    ticketId: number,
    actingUserId: string,
    input: UpdateTicketInput,
  ): Promise<void> {
    if (input.assigneeIds !== undefined) {
      await this.db
        .delete(ticketAssignees)
        .where(eq(ticketAssignees.ticketId, ticketId));
      const allIds = new Set(input.assigneeIds);
      const primary = resolveAssigneeId(input.assigneeId);
      if (primary) allIds.add(primary);
      if (allIds.size > 0) {
        await this.db.insert(ticketAssignees).values(
          Array.from(allIds).map((userId) => ({
            orgId,
            ticketId,
            userId,
            assignedBy: actingUserId,
          })),
        );
      }
      return;
    }

    if (input.assigneeId !== undefined) {
      await this.db
        .delete(ticketAssignees)
        .where(eq(ticketAssignees.ticketId, ticketId));
      const newAssigneeId = resolveAssigneeId(input.assigneeId);
      if (newAssigneeId) {
        await this.db.insert(ticketAssignees).values({
          orgId,
          ticketId,
          userId: newAssigneeId,
          assignedBy: actingUserId,
        });
      }
    }
  }
}
