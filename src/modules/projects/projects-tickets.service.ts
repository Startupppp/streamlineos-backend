import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, or, sql } from "drizzle-orm";
import {
  projectMembers,
  ticketActivityLog,
  ticketAssignees,
  ticketAttachments,
  ticketComments,
  ticketLabelMappings,
  tickets,
  ticketTypeEnum,
  ticketWatchers,
  timesheets,
  workItemRelations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { NotificationsService } from "../notifications/notifications.service";
import { ProjectsEmailService } from "./projects-email.service";
import { ProjectsActivityService } from "./projects-activity.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsWorkQueryService } from "./projects-work-query.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import {
  ProjectsTicketConflictException,
} from "../../common/http/api-exceptions";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import type {
  AllWorkQuery,
  BulkUpdateInput,
  CreateTicketInput,
  ImportTicketsInput,
  ReorderInput,
  TicketsListQuery,
  UpdateTicketInput,
} from "./dto/projects.schemas";
import { computeNextRunAt } from "./projects-recurrence.util";
import { resolveAssigneeId } from "./tickets-helpers";

type TicketType = (typeof ticketTypeEnum.enumValues)[number];

function normalizeTicketType(type: string): TicketType {
  const upper = type.toUpperCase();
  const mapped = upper === "FEATURE" ? "STORY" : upper;
  return ticketTypeEnum.enumValues.find((v) => v === mapped) ?? "TASK";
}

@Injectable()
export class ProjectsTicketsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly projectsEmail: ProjectsEmailService,
    private readonly activity: ProjectsActivityService,
    private readonly audit: AuditService,
    private readonly query: ProjectsTicketsQueryService,
    private readonly workQuery: ProjectsWorkQueryService,
    private readonly transfer: ProjectsTicketsTransferService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly cache: CacheService,
  ) {}

  async listTickets(u: CurrentUserContext, projectId: number, query: TicketsListQuery) {
    return this.workQuery.listTickets(u, projectId, query);
  }

  async createTicket(u: CurrentUserContext, projectId: number, body: CreateTicketInput) {
    const { hasAccess } = await this.workQuery.checkProjectAccess(u.orgId, u.userId, projectId);
    if (!hasAccess) throw new NotFoundException("Not found");

    if (body.status !== undefined) {
      await this.query.validateTicketStatus(projectId, u.orgId, body.status);
    }

    const [ticket] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);

      const maxTicketResult = await tx
        .select({ maxTicketNumber: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, u.orgId)));

      const nextTicketNumber = (maxTicketResult[0]?.maxTicketNumber || 0) + 1;

      const isRecurring = body.isRecurring === true && body.recurrenceRule != null;
      const recurrenceNextRunAt = isRecurring && body.recurrenceRule
        ? computeNextRunAt(body.recurrenceRule)
        : undefined;

      const [created] = await tx
        .insert(tickets)
        .values({
          orgId: u.orgId,
          projectId,
          ticketNumber: nextTicketNumber,
          title: body.title,
          description: body.description,
          type: normalizeTicketType(body.type),
          priority: body.priority ?? "MEDIUM",
          assigneeId: body.assigneeId,
          reporterId: body.reporterId ?? u.userId,
          sprintId: body.sprintId,
          epicId: body.epicId,
          cycleId: body.cycleId,
          points: body.points,
          link: body.link,
          originalEstimate: body.originalEstimate?.toString(),
          parentTicketId: body.parentTicketId,
          status: body.status ?? "TODO",
          isRecurring,
          recurrenceRule: isRecurring ? body.recurrenceRule : undefined,
          recurrenceNextRunAt,
        })
        .returning();

      const allAssigneeIds = new Set<string>();
      if (body.assigneeId) allAssigneeIds.add(body.assigneeId);
      if (body.assigneeIds) body.assigneeIds.forEach((uid) => allAssigneeIds.add(uid));

      if (allAssigneeIds.size > 0) {
        await tx.insert(ticketAssignees).values(
          Array.from(allAssigneeIds).map((userId) => ({
            ticketId: created.id,
            userId,
            assignedBy: u.userId,
          })),
        );
      }

      const watcherIds = new Set<string>([u.userId]);
      allAssigneeIds.forEach((id) => watcherIds.add(id));
      await tx.insert(ticketWatchers).values(
        Array.from(watcherIds).map((userId) => ({ ticketId: created.id, userId })),
      );

      await tx.insert(ticketActivityLog).values({
        orgId: u.orgId,
        ticketId: created.id,
        userId: u.userId,
        action: "created",
      });

      return [created];
    });

    const allNotifyIds = new Set<string>();
    if (body.assigneeId) allNotifyIds.add(body.assigneeId);
    if (body.assigneeIds) body.assigneeIds.forEach((uid) => allNotifyIds.add(uid));

    await Promise.all(
      Array.from(allNotifyIds)
        .filter((userId) => userId !== u.userId)
        .map((userId) =>
          this.notifications
            .create({
              orgId: u.orgId,
              userId,
              type: "INFO",
              title: "Ticket Assigned to You",
              message: `You have been assigned to ticket "${body.title}" (${body.type}).`,
              link: `/projects/${projectId}?ticket=${ticket.id}`,
            })
            .catch((error) => logger.error("Failed to create ticket assignment notification", { error })),
        ),
    );

    this.webhooksDispatch.dispatch(u.orgId, projectId, "ticket.created", {
      id: ticket.id,
      projectId,
      title: ticket.title,
      status: ticket.status,
      type: ticket.type,
      priority: ticket.priority,
      assigneeId: ticket.assigneeId ?? null,
      actor: u.userId,
      timestamp: new Date().toISOString(),
    });

    void this.cache.del(`projects:analytics:${u.orgId}:${projectId}`).catch(() => undefined);

    return ticket;
  }

  async createFromFeedback(
    orgId: string,
    actingUserId: string,
    projectId: number,
    input: { title: string; description: string; type?: string },
  ): Promise<{ id: number }> {
    const [ticket] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);

      const maxResult = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));

      const nextNum = (maxResult[0]?.maxNum ?? 0) + 1;

      const [created] = await tx
        .insert(tickets)
        .values({
          orgId,
          projectId,
          ticketNumber: nextNum,
          title: input.title,
          description: input.description,
          type: normalizeTicketType(input.type ?? "BUG"),
          priority: "MEDIUM",
          reporterId: actingUserId,
          status: "TODO",
        })
        .returning({ id: tickets.id });

      await tx.insert(ticketWatchers).values({ ticketId: created.id, userId: actingUserId });
      await tx.insert(ticketActivityLog).values({
        orgId,
        ticketId: created.id,
        userId: actingUserId,
        action: "created",
      });

      return [created];
    });

    return ticket;
  }

  async getTicket(u: CurrentUserContext, ticketId: number) {
    return this.workQuery.getTicket(u, ticketId);
  }

  async updateTicket(u: CurrentUserContext, ticketId: number, input: UpdateTicketInput) {
    const orgId = u.orgId;
    const actingUserId = u.userId;
    const now = new Date();
    const updateData: Partial<typeof tickets.$inferInsert> = { updatedAt: now };
    if (input.title) updateData.title = input.title;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.type) updateData.type = normalizeTicketType(input.type);
    if (input.status) updateData.status = input.status;
    if (input.priority) updateData.priority = input.priority;
    const resolvedAssignee = resolveAssigneeId(input.assigneeId);
    if (resolvedAssignee !== undefined) updateData.assigneeId = resolvedAssignee;
    if (input.sprintId !== undefined) updateData.sprintId = input.sprintId;
    if (input.epicId !== undefined) updateData.epicId = input.epicId;
    if (input.moduleId !== undefined) updateData.moduleId = input.moduleId;
    if (input.points !== undefined) updateData.points = input.points;
    if (input.cycleId !== undefined) updateData.cycleId = input.cycleId;
    if (input.originalEstimate !== undefined) updateData.originalEstimate = input.originalEstimate?.toString();
    if (input.startDate !== undefined) updateData.startDate = input.startDate;
    if (input.dueDate !== undefined) updateData.dueDate = input.dueDate;
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
      columns: { title: true, status: true, priority: true, assigneeId: true, sprintId: true, dueDate: true, projectId: true, updatedAt: true, points: true, type: true, cycleId: true },
    });
    if (!before || !before.projectId) throw new NotFoundException("Ticket not found");

    if (input.expectedUpdatedAt !== undefined) {
      const expected = new Date(input.expectedUpdatedAt);
      if (before.updatedAt.getTime() !== expected.getTime()) {
        throw new ProjectsTicketConflictException();
      }
    }

    const accessResult = u.isOrgOwner || u.isPlatformAdmin
      ? { hasAccess: true, role: "OWNER" as string | null }
      : await this.workQuery.checkProjectAccess(orgId, actingUserId, before.projectId);
    if (!accessResult.hasAccess) throw new ForbiddenException("Not authorized to update this ticket");

    if (input.status !== undefined) {
      const statusChanged = input.status !== before.status;
      if (statusChanged) {
        await Promise.all([
          this.query.validateTicketStatus(before.projectId, orgId, input.status),
          this.query.enforceWipLimitForStatus(orgId, before.projectId, input.status, ticketId),
        ]);
        await this.query.assertTransitionAllowed(orgId, before.projectId, before.status, input.status, {
          userId: actingUserId,
          userProjectRole: accessResult.role,
          isOrgOwner: u.isOrgOwner,
          isPlatformAdmin: u.isPlatformAdmin,
          ticketId,
        });
      } else {
        await this.query.validateTicketStatus(before.projectId, orgId, input.status);
      }
    }

    await this.db
      .update(tickets)
      .set(updateData)
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)));

    await Promise.all([
      this.syncAssignees(ticketId, actingUserId, input),
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
        .catch((error) => logger.error("Failed to log ticket activity", { error })),
    ]);

    void this.transfer.notifyNewAssignees(orgId, ticketId, actingUserId, input).catch((error) =>
      logger.error("Failed to notify ticket assignees", { error }),
    );

    if (input.status === "IN_REVIEW" || input.status === "CHANGES_REQUESTED") {
      void this.projectsEmail.notifyStatusReview(ticketId, actingUserId, input.status).catch(() => undefined);
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
      this.webhooksDispatch.dispatch(orgId, ticketProjectId, "ticket.assigned", {
        id: ticketId,
        projectId: ticketProjectId,
        title: input.title ?? before.title,
        status: input.status ?? before.status,
        assigneeId: newAssignee,
        actor: actingUserId,
        timestamp: now.toISOString(),
      });
    }

    void this.cache.del(`projects:analytics:${orgId}:${ticketProjectId}`).catch(() => undefined);

    return { updated: true, updatedAt: now.toISOString() };
  }

  private async syncAssignees(ticketId: number, actingUserId: string, input: UpdateTicketInput): Promise<void> {
    if (input.assigneeIds !== undefined) {
      await this.db.delete(ticketAssignees).where(eq(ticketAssignees.ticketId, ticketId));
      const allIds = new Set(input.assigneeIds);
      const primary = resolveAssigneeId(input.assigneeId);
      if (primary) allIds.add(primary);
      if (allIds.size > 0) {
        await this.db.insert(ticketAssignees).values(
          Array.from(allIds).map((userId) => ({ ticketId, userId, assignedBy: actingUserId })),
        );
      }
      return;
    }

    if (input.assigneeId !== undefined) {
      await this.db.delete(ticketAssignees).where(eq(ticketAssignees.ticketId, ticketId));
      const newAssigneeId = resolveAssigneeId(input.assigneeId);
      if (newAssigneeId) {
        await this.db.insert(ticketAssignees).values({ ticketId, userId: newAssigneeId, assignedBy: actingUserId });
      }
    }
  }

  async deleteTicket(orgId: string, userId: string, ticketId: number, force: boolean) {
    const existing = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)),
      columns: { id: true, projectId: true, title: true },
    });
    if (!existing || !existing.projectId) throw new NotFoundException("Ticket not found");

    const { hasAccess } = await this.workQuery.checkProjectAccess(orgId, userId, existing.projectId);
    if (!hasAccess) throw new ForbiddenException("Not authorized to delete this ticket");

    if (!force) {
      const blockedBy = await this.db.query.workItemRelations.findMany({
        where: and(
          eq(workItemRelations.relatedWorkItemId, ticketId),
          eq(workItemRelations.relationType, "blocks"),
        ),
        columns: { workItemId: true },
      });
      if (blockedBy.length > 0) {
        throw new ConflictException(
          `This ticket is blocked by ${blockedBy.length} other ticket(s). Add ?force=true to delete anyway.`,
        );
      }
    }

    await this.db.transaction(async (tx) => {
      await tx.update(tickets).set({ parentTicketId: null }).where(eq(tickets.parentTicketId, ticketId));
      await tx.update(tickets).set({ epicId: null }).where(eq(tickets.epicId, ticketId));

      await tx.delete(ticketAssignees).where(eq(ticketAssignees.ticketId, ticketId));
      await tx.delete(ticketComments).where(eq(ticketComments.ticketId, ticketId));
      await tx.delete(ticketAttachments).where(eq(ticketAttachments.ticketId, ticketId));
      await tx.delete(ticketLabelMappings).where(eq(ticketLabelMappings.ticketId, ticketId));
      await tx.delete(ticketWatchers).where(eq(ticketWatchers.ticketId, ticketId));
      await tx.delete(timesheets).where(eq(timesheets.ticketId, ticketId));
      await tx
        .delete(workItemRelations)
        .where(or(eq(workItemRelations.workItemId, ticketId), eq(workItemRelations.relatedWorkItemId, ticketId)));

      await tx.delete(tickets).where(eq(tickets.id, ticketId));
    });

    this.webhooksDispatch.dispatch(orgId, existing.projectId, "ticket.deleted", {
      id: ticketId,
      projectId: existing.projectId,
      title: existing.title,
      actor: userId,
      timestamp: new Date().toISOString(),
    });

    void this.cache.del(`projects:analytics:${orgId}:${existing.projectId}`).catch(() => undefined);

    return { deleted: true };
  }

  async bulkUpdate(u: CurrentUserContext, projectId: number, body: BulkUpdateInput) {
    return this.query.bulkUpdate(u, projectId, body);
  }

  async reorder(u: CurrentUserContext, projectId: number, body: ReorderInput) {
    return this.query.reorder(u.orgId, projectId, body, {
      userId: u.userId,
      isOrgOwner: u.isOrgOwner,
      isPlatformAdmin: u.isPlatformAdmin,
    });
  }

  async exportTickets(u: CurrentUserContext, projectId: number) {
    return this.transfer.exportTickets(u, projectId);
  }

  async importTickets(u: CurrentUserContext, projectId: number, body: ImportTicketsInput) {
    return this.transfer.importTickets(u, projectId, body);
  }

  async searchOrgTickets(orgId: string, userId: string, q: string, limit: number) {
    return this.workQuery.searchOrgTickets(orgId, userId, q, limit);
  }

  async getMyWork(orgId: string, userId: string) {
    return this.workQuery.getMyWork(orgId, userId);
  }

  async getAllWork(u: CurrentUserContext, query: AllWorkQuery) {
    return this.workQuery.getAllWork(u, query);
  }
}
