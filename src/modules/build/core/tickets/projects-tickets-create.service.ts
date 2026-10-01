import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { resolveOrganizationActorsByUserIds } from "../../../../common/organization/organization-actor";
import { and, eq, isNull } from "drizzle-orm";
import {
  cycles,
  projects,
  ticketActivityLog,
  ticketAssignees,
  tickets,
  ticketWatchers,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { CacheService } from "../../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { NotificationsService } from "../../../notifications/notifications.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { CreateTicketInput } from "../dto/projects.schemas";
import { computeNextRunAt } from "../lib/projects-recurrence.util";
import { buildTicketHref, buildTicketKey } from "../lib/build-app-paths";
import { normalizeTicketType } from "./tickets-helpers";
import { AccessService } from "../../../access/access.service";
import { assertProjectVisible, resolveProjectAssignableMemberships } from "../project-crud/project-access";
import { withSavepoint } from "../../../data-quality/savepoint";
import { BuildTicketCreationService } from "./build-ticket-creation.service";

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
    private readonly access: AccessService,
  ) {}

  async createTicket(
    u: CurrentUserContext,
    projectId: number,
    body: CreateTicketInput,
  ) {
    await assertProjectVisible(this.db, this.access, u, projectId);

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

    if (body.cycleId != null) {
      const [cycleRow] = await this.db
        .select({ id: cycles.id })
        .from(cycles)
        .where(
          and(
            eq(cycles.orgId, u.orgId),
            eq(cycles.projectId, projectId),
            eq(cycles.id, body.cycleId),
            isNull(cycles.deletedAt),
          ),
        )
        .limit(1);
      if (!cycleRow)
        throw new NotFoundException("Cycle not found in this project");
    }
    const resolvedCycleId = body.cycleId;

    const reporterUserId = body.reporterId ?? u.userId;
    const allAssigneeIds = new Set<string>();
    if (body.assigneeId) allAssigneeIds.add(body.assigneeId);
    if (body.assigneeIds) body.assigneeIds.forEach((uid) => allAssigneeIds.add(uid));
    if (
      allAssigneeIds.size > 0 &&
      !(await this.access.holds(u, "build:tickets:assign"))
    )
      throw new ForbiddenException("Not authorized to assign tickets");

    const batchIds = new Set<string>([u.userId, reporterUserId]);
    const actorMap = await resolveOrganizationActorsByUserIds(this.db, u.orgId, [...batchIds]);
    if (!actorMap.has(u.userId))
      throw new NotFoundException("Creating member is not active in this organization");
    if (body.reporterId !== undefined && !actorMap.has(reporterUserId))
      throw new NotFoundException("Reporter is not an active member of this organization");
    const assigneeMemberships = await resolveProjectAssignableMemberships(
      this.db,
      u.orgId,
      projectId,
      [...allAssigneeIds],
    );
    for (const uid of allAssigneeIds)
      if (!assigneeMemberships.has(uid))
        throw new NotFoundException("Assignee is not an active member of this project");

    const assigneeMembershipId = body.assigneeId
      ? (assigneeMemberships.get(body.assigneeId) ?? null)
      : null;
    const reporterMembershipId = actorMap.get(reporterUserId)?.membershipId ?? null;

    const creator = new BuildTicketCreationService(
      this.db,
      this.webhooksDispatch,
      this.automationRunner,
      this.cache,
    );
    let createdResult: Awaited<ReturnType<BuildTicketCreationService["createInTransaction"]>>;
    const ticket = await this.db.transaction(async (tx) => {

      const isRecurring =
        body.isRecurring === true && body.recurrenceRule != null;
      const recurrenceNextRunAt =
        isRecurring && body.recurrenceRule
          ? computeNextRunAt(body.recurrenceRule)
          : undefined;

      createdResult = await creator.createInTransaction(tx, {
        orgId: u.orgId,
        projectId,
        actor: { userId: u.userId, membershipId: actorMap.get(u.userId)?.membershipId ?? null },
        drafts: [{
          title: body.title,
          description: body.description,
          type: normalizeTicketType(body.type),
          priority: body.priority ?? "MEDIUM",
          assigneeMembershipId,
          reporterId: reporterUserId,
          reporterMembershipId,
          epicId: body.epicId,
          cycleId: resolvedCycleId,
          points: body.points,
          link: body.link,
          originalEstimate: body.originalEstimate?.toString(),
          parentTicketId: body.parentTicketId,
          status: body.status ?? "TODO",
          dueDate: body.dueDate,
          isRecurring,
          recurrenceRule: isRecurring ? body.recurrenceRule : undefined,
          recurrenceNextRunAt,
          automationAssigneeUserId: body.assigneeId ?? null,
        }],
      });
      const created = createdResult.tickets[0]!;

      if (allAssigneeIds.size > 0) {
        await tx.insert(ticketAssignees).values(
          Array.from(allAssigneeIds).map((userId) => ({
            orgId: u.orgId,
            ticketId: created.id,
            userId,
            membershipId: assigneeMemberships.get(userId)!,
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
          membershipId:
            assigneeMemberships.get(userId) ?? actorMap.get(userId)!.membershipId,
        })),
      );

      return created;
    });
    creator.publish(createdResult!);

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

      const ticketKey = buildTicketKey(projectRow?.key, ticket.ticketNumber);
      const ticketLink = buildTicketHref(projectId, ticketKey);

      await withSavepoint(() =>
        this.dispatch.emit({
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
      ).catch((error: unknown) =>
        logger.error("Failed to dispatch ticket assignment notification", { error }),
      );
    }

    return ticket;
  }

  async createFromFeedback(
    orgId: string,
    actingUserId: string,
    projectId: number,
    input: { title: string; description: string; type?: string; assigneeMembershipId?: number | null },
  ): Promise<{ id: number }> {
    const feedbackActorMap = await resolveOrganizationActorsByUserIds(this.db, orgId, [actingUserId]);
    const feedbackActorMembershipId = feedbackActorMap.get(actingUserId)?.membershipId ?? null;
    const creator = new BuildTicketCreationService(this.db, this.webhooksDispatch, this.automationRunner, this.cache);
    let createdResult: Awaited<ReturnType<BuildTicketCreationService["createInTransaction"]>>;
    const ticket = await this.db.transaction(async (tx) => {
      createdResult = await creator.createInTransaction(tx, {
        orgId,
        projectId,
        actor: { userId: actingUserId, membershipId: feedbackActorMembershipId },
        drafts: [{
          title: input.title,
          description: input.description,
          type: normalizeTicketType(input.type ?? "BUG"),
          priority: "MEDIUM",
          reporterId: actingUserId,
          status: "TODO",
          assigneeMembershipId: input.assigneeMembershipId ?? null,
        }],
      });
      const created = createdResult.tickets[0]!;

      await tx
        .insert(ticketWatchers)
        .values({ orgId, ticketId: created.id, membershipId: feedbackActorMembershipId! });
      return created;
    });
    creator.publish(createdResult!);

    return ticket;
  }
}
