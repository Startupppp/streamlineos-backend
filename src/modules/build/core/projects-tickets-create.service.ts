import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { resolveOrganizationActorsByUserIds } from "../../../common/organization/organization-actor";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import { logSideEffectFailure } from "../../../common/logger/side-effect";
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
import { allocateTicketNumbers } from "./lib/allocate-ticket-number";

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

    const reporterUserId = body.reporterId ?? u.userId;
    const allAssigneeIds = new Set<string>();
    if (body.assigneeId) allAssigneeIds.add(body.assigneeId);
    if (body.assigneeIds) body.assigneeIds.forEach((uid) => allAssigneeIds.add(uid));

    const batchIds = new Set<string>([u.userId, reporterUserId, ...allAssigneeIds]);
    const actorMap = await resolveOrganizationActorsByUserIds(this.db, u.orgId, [...batchIds]);

    for (const uid of allAssigneeIds) {
      if (!actorMap.has(uid))
        throw new NotFoundException("Assignee is not a member of this organization");
    }

    const assigneeMembershipId = body.assigneeId
      ? (actorMap.get(body.assigneeId)?.membershipId ?? null)
      : null;
    const reporterMembershipId = actorMap.get(reporterUserId)?.membershipId ?? null;

    const [ticket] = await this.db.transaction(async (tx) => {
      const nextTicketNumber = await allocateTicketNumbers(tx, u.orgId, projectId);

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
          assigneeMembershipId,
          reporterId: reporterUserId,
          reporterMembershipId,
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

      if (allAssigneeIds.size > 0) {
        await tx.insert(ticketAssignees).values(
          Array.from(allAssigneeIds).map((userId) => ({
            orgId: u.orgId,
            ticketId: created.id,
            userId,
            membershipId: actorMap.get(userId)?.membershipId ?? null,
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
        userMembershipId: actorMap.get(u.userId)?.membershipId ?? null,
        action: "created",
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
      .catch(logSideEffectFailure("analytics cache eviction", { orgId: u.orgId, projectId }));

    return ticket;
  }

  async createFromFeedback(
    orgId: string,
    actingUserId: string,
    projectId: number,
    input: { title: string; description: string; type?: string },
  ): Promise<{ id: number }> {
    const feedbackActorMap = await resolveOrganizationActorsByUserIds(this.db, orgId, [actingUserId]);
    const feedbackActorMembershipId = feedbackActorMap.get(actingUserId)?.membershipId ?? null;
    const [ticket] = await this.db.transaction(async (tx) => {
      const nextNum = await allocateTicketNumbers(tx, orgId, projectId);

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
        userMembershipId: feedbackActorMembershipId,
        action: "created",
      });

      return [created];
    });

    return ticket;
  }
}
