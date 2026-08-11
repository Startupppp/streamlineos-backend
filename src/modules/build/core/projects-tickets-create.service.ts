import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  projects,
  ticketActivityLog,
  ticketAssignees,
  tickets,
  ticketWatchers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { NotificationsService } from "../../notifications/notifications.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { CreateTicketInput } from "./dto/projects.schemas";
import { computeNextRunAt } from "./projects-recurrence.util";
import { normalizeTicketType } from "./tickets-helpers";

@Injectable()
export class ProjectsTicketsCreateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly dispatch: NotificationDispatchService,
    private readonly query: ProjectsTicketsQueryService,
    private readonly read: ProjectsTicketsReadService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly automationRunner: BuildAutomationRunnerService,
    private readonly cache: CacheService,
  ) {}

  async createTicket(
    u: CurrentUserContext,
    projectId: number,
    body: CreateTicketInput,
  ) {
    const { hasAccess } = await this.read.checkProjectAccess(
      u.orgId,
      u.userId,
      projectId,
    );
    if (!hasAccess) throw new NotFoundException("Not found");

    if (body.status !== undefined)
      await this.query.validateTicketStatus(projectId, u.orgId, body.status);

    if (body.epicId != null) {
      const epicRow = await this.db.query.tickets.findFirst({
        where: and(
          eq(tickets.id, body.epicId),
          eq(tickets.orgId, u.orgId),
          eq(tickets.projectId, projectId),
          isNull(tickets.deletedAt),
        ),
        columns: { id: true },
      });
      if (!epicRow)
        throw new BadRequestException("Epic ticket not found in this project");
    }

    const [ticket] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);

      const maxTicketResult = await tx
        .select({
          maxTicketNumber: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)`,
        })
        .from(tickets)
        .where(
          and(eq(tickets.projectId, projectId), eq(tickets.orgId, u.orgId)),
        );

      const nextTicketNumber = (maxTicketResult[0]?.maxTicketNumber || 0) + 1;

      const isRecurring =
        body.isRecurring === true && body.recurrenceRule != null;
      const recurrenceNextRunAt =
        isRecurring && body.recurrenceRule
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
      if (body.assigneeIds)
        body.assigneeIds.forEach((uid) => allAssigneeIds.add(uid));

      if (allAssigneeIds.size > 0) {
        await tx.insert(ticketAssignees).values(
          Array.from(allAssigneeIds).map((userId) => ({
            orgId: u.orgId,
            ticketId: created.id,
            userId,
            assignedBy: u.userId,
          })),
        );
      }

      const watcherIds = new Set<string>([u.userId]);
      allAssigneeIds.forEach((id) => watcherIds.add(id));
      await tx.insert(ticketWatchers).values(
        Array.from(watcherIds).map((userId) => ({
          orgId: u.orgId,
          ticketId: created.id,
          userId,
        })),
      );

      await tx.insert(ticketActivityLog).values({
        orgId: u.orgId,
        ticketId: created.id,
        userId: u.userId,
        action: "created",
      });

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: u.orgId,
        aggregateType: "ticket",
        aggregateId: String(created.id),
        aggregateVersion: 1,
        eventType: "build.ticket.created",
        payload: {
          ticketId: created.id,
          projectId,
          orgId: u.orgId,
          title: created.title,
          type: created.type,
          status: created.status,
          assigneeId: created.assigneeId ?? null,
          createdBy: u.userId,
        },
        occurredAt: new Date(),
      });

      return [created];
    });

    const allNotifyIds = new Set<string>();
    if (body.assigneeId) allNotifyIds.add(body.assigneeId);
    if (body.assigneeIds)
      body.assigneeIds.forEach((uid) => allNotifyIds.add(uid));

    const notifyTargets = Array.from(allNotifyIds).filter(
      (userId) => userId !== u.userId,
    );
    if (notifyTargets.length > 0) {
      const [projectRow] = await this.db
        .select({ key: projects.key })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)))
        .limit(1);

      const ticketKey = projectRow?.key
        ? `${projectRow.key}-${ticket.ticketNumber}`
        : String(ticket.ticketNumber);
      const ticketLink = `/projects/${projectId}/tickets/${encodeURIComponent(ticketKey)}`;

      // REG-004: was a raw notifications.create() per target, which bypassed
      // routing, preferences, dedupe and the PIPE-003 visibility check. One emit
      // for the whole target set also batches routing instead of N round trips.
      await this.dispatch
        .emit({
          eventKey: "build.ticket.assigned",
          orgId: u.orgId,
          actorUserId: u.userId,
          targetUserIds: notifyTargets,
          entityType: "ticket",
          entityId: String(ticket.id),
          title: "Ticket Assigned to You",
          message: `You have been assigned to ticket "${body.title}" (${body.type}).`,
          link: ticketLink,
          metadata: {
            ticketId: ticket.id,
            ticketKey,
            priority: ticket.priority,
            status: ticket.status,
            type: ticket.type,
          },
        })
        .catch((error: unknown) =>
          logger.error("Failed to dispatch ticket assignment notification", { error }),
        );
    }

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

    this.automationRunner.runForTicketEvent(u.orgId, projectId, "ticket.created", {
      ticketId: ticket.id,
      projectId,
      orgId: u.orgId,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      assigneeId: ticket.assigneeId ?? null,
      type: ticket.type,
    });

    void this.cache
      .del(`projects:analytics:${u.orgId}:${projectId}`)
      .catch(() => undefined);

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
        .select({
          maxNum: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)`,
        })
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

      await tx
        .insert(ticketWatchers)
        .values({ orgId, ticketId: created.id, userId: actingUserId });
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
}
