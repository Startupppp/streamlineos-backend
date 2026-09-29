import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  projectMembers,
  organizationMembers,
  projects,
  projectStatuses,
  tickets,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import { NotificationsService } from "../../../notifications/notifications.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { AccessService } from "../../../access/access.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import { resolveProjectAccess } from "../project-crud/project-access";
import { resolveTicketsScope, ticketScope } from "../lib/tickets-scope";
import type { ScopedWhere } from "../../../access/scoped-read";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { ImportTicketsInput, UpdateTicketInput } from "../dto/projects.schemas";
import { resolveAssigneeId } from "./tickets-helpers";
import { allocateTicketNumbers } from "../lib/allocate-ticket-number";
import { reserveTicketCapacity } from "../lib/build-ticket-capacity";
import { CacheService } from "../../../../common/cache/cache.service";
import { buildTicketHref, buildTicketKey } from "../lib/build-app-paths";

const EXPORT_ROW_CAP = 5_000;
const ASSIGNMENT_NOTIFY_CAP = 100;

@Injectable()
export class ProjectsTicketsTransferService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly read: ProjectsTicketsReadService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly dispatch: NotificationDispatchService,
    private readonly cache: CacheService,
  ) {}

  async exportTickets(u: CurrentUserContext, projectId: number, ticketIds?: number[]) {
    const [{ hasAccess }, read] = await Promise.all([
      resolveProjectAccess(this.db, this.access, u, projectId),
      resolveTicketsScope(this.access, u),
    ]);
    if (!hasAccess) throw new NotFoundException("Not found");
    if (read.denied) return { rows: [], truncated: false };

    const ticketIdFilter =
      ticketIds !== undefined && ticketIds.length > 0
        ? [inArray(tickets.id, ticketIds)]
        : [];

    const fetched = await read.read(
      {
        tenant: tickets.orgId,
        scope: ticketScope(read.orgId, read.actorId),
        and: [eq(tickets.projectId, projectId), isNull(tickets.deletedAt), ...ticketIdFilter],
      },
      ({ sql: where }: ScopedWhere) => this.db
        .select({
          number: tickets.ticketNumber,
          title: tickets.title,
          type: tickets.type,
          status: tickets.status,
          priority: tickets.priority,
          points: tickets.points,
          dueDate: tickets.dueDate,
          assigneeName: users.name,
          assigneeFirstName: users.firstName,
          assigneeLastName: users.lastName,
          assigneeEmail: users.email,
        })
        .from(tickets)
        .leftJoin(organizationMembers, and(eq(organizationMembers.orgId, tickets.orgId), eq(organizationMembers.id, tickets.assigneeMembershipId)))
        .leftJoin(users, eq(organizationMembers.userId, users.id))
        .where(where)
        .orderBy(tickets.ticketNumber)
        .limit(EXPORT_ROW_CAP + 1),
      () => [],
    );

    const truncated = fetched.length > EXPORT_ROW_CAP;
    const slice = truncated ? fetched.slice(0, EXPORT_ROW_CAP) : fetched;

    return {
      rows: slice.map((r) => ({
        number: r.number,
        title: r.title,
        type: r.type,
        status: r.status,
        priority: r.priority,
        points: r.points ?? null,
        dueDate: r.dueDate ?? null,
        assignee:
          r.assigneeName ??
          (r.assigneeFirstName && r.assigneeLastName
            ? `${r.assigneeFirstName} ${r.assigneeLastName}`.trim()
            : (r.assigneeEmail ?? null)),
      })),
      truncated,
    };
  }

  async importTickets(u: CurrentUserContext, projectId: number, body: ImportTicketsInput) {
    const { hasAccess } = await resolveProjectAccess(this.db, this.access, u, projectId);
    if (!hasAccess) throw new NotFoundException("Not found");
    if (
      body.rows.some((row) => row.assigneeEmail !== undefined) &&
      !(await this.access.holds(u, "build:tickets:assign"))
    )
      throw new ForbiddenException("Not authorized to assign tickets");

    const [validStatuses, memberEmails] = await Promise.all([
      this.db
        .select({ name: projectStatuses.name })
        .from(projectStatuses)
        .where(and(eq(projectStatuses.orgId, u.orgId), eq(projectStatuses.projectId, projectId))),
      this.db
        .select({ userId: organizationMembers.userId, email: users.email, membershipId: organizationMembers.id })
        .from(projectMembers)
        .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectMembers.orgId), eq(organizationMembers.id, projectMembers.membershipId)))
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(projectMembers.orgId, u.orgId),
            eq(projectMembers.projectId, projectId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        ),
    ]);

    const validStatusSet = new Set(validStatuses.map((s) => s.name));
    const emailToUserId = new Map(memberEmails.map((m) => [m.email, m.userId]));
    const userIdToMembershipId = new Map(
      memberEmails.map((m) => [m.userId, m.membershipId]),
    );
    const defaultStatus = validStatuses[0]?.name ?? "TODO";

    const skipped: Array<{ row: number; reason: string }> = [];
    const toCreate: Array<typeof tickets.$inferInsert & { rowIndex: number }> = [];

    for (let i = 0; i < body.rows.length; i++) {
      const row = body.rows[i];
      if (!row) continue;

      if (row.status && !validStatusSet.has(row.status)) {
        skipped.push({ row: i + 1, reason: `Status '${row.status}' does not exist in this project` });
        continue;
      }

      let assigneeId: string | undefined;
      if (row.assigneeEmail) {
        const uid = emailToUserId.get(row.assigneeEmail);
        if (!uid) {
          skipped.push({ row: i + 1, reason: `Email '${row.assigneeEmail}' is not a project member` });
          continue;
        }
        assigneeId = uid;
      }

      toCreate.push({
        orgId: u.orgId,
        projectId,
        ticketNumber: 0,
        title: row.title,
        type: row.type ?? "TASK",
        status: row.status ?? defaultStatus,
        priority: row.priority ?? "MEDIUM",
        points: row.points ?? undefined,
        assigneeMembershipId: assigneeId ? (userIdToMembershipId.get(assigneeId) ?? null) : null,
        dueDate: row.dueDate ?? undefined,
        reporterId: u.userId,
        rowIndex: i + 1,
      });
    }

    if (toCreate.length === 0) {
      return { created: 0, skipped };
    }

    const CHUNK_SIZE = 100;
    let createdCount = 0;

    await this.db.transaction(async (tx) => {
      await reserveTicketCapacity(tx, u.orgId, projectId, toCreate.map(row => ({ status: row.status ?? "TODO", count: 1 })));
      let nextNum = await allocateTicketNumbers(tx, u.orgId, projectId, toCreate.length);

      const rowsWithNumbers = toCreate.map((item) => {
        const ticketNumber = nextNum++;
        const { rowIndex, ...values } = item;
        return { values: { ...values, ticketNumber }, rowIndex };
      });

      for (let i = 0; i < rowsWithNumbers.length; i += CHUNK_SIZE) {
        const chunk = rowsWithNumbers.slice(i, i + CHUNK_SIZE);
        const n = await tx.transaction(async (sp) => {
          await sp.insert(tickets).values(chunk.map((r) => r.values));
          return chunk.length;
        }).catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : "Unknown error";
          for (const r of chunk) {
            skipped.push({ row: r.rowIndex, reason: msg });
          }
          return 0;
        });
        createdCount += n;
      }
    });

    await this.cache
      .invalidateNamespace(`build:analytics:${u.orgId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId: u.orgId, projectId }));

    return { created: createdCount, skipped };
  }

  async notifyNewAssignees(
    orgId: string,
    ticketId: number,
    actingUserId: string,
    input: UpdateTicketInput,
  ): Promise<void> {
    const notifyIds = new Set<string>();
    if (input.assigneeIds !== undefined) {
      input.assigneeIds.forEach((uid) => notifyIds.add(uid));
    } else {
      const primary = resolveAssigneeId(input.assigneeId);
      if (primary) notifyIds.add(primary);
    }
    await this.notifyAssignedTickets(orgId, [ticketId], actingUserId, Array.from(notifyIds));
  }

  async notifyAssignedTickets(
    orgId: string,
    ticketIds: readonly number[],
    actingUserId: string,
    assigneeUserIds: readonly string[],
  ): Promise<void> {
    const notifyTargets = [...new Set(assigneeUserIds)].filter((userId) => userId !== actingUserId);
    const uniqueTicketIds = [...new Set(ticketIds)];
    if (notifyTargets.length === 0 || uniqueTicketIds.length === 0) return;
    if (uniqueTicketIds.length > ASSIGNMENT_NOTIFY_CAP)
      throw new BadRequestException("Too many tickets for one assignment notification batch");

    const ticketRows = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        projectId: tickets.projectId,
        ticketNumber: tickets.ticketNumber,
        priority: tickets.priority,
        status: tickets.status,
        type: tickets.type,
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, orgId),
          inArray(tickets.id, uniqueTicketIds),
          isNull(tickets.deletedAt),
        ),
      )
      .limit(uniqueTicketIds.length);
    if (ticketRows.length === 0) return;

    const projectIds = [...new Set(ticketRows.map((row) => row.projectId))];
    const projectKeyById = new Map<number, string | null>();
    const projectRows = await this.db
      .select({ id: projects.id, key: projects.key })
      .from(projects)
      .where(
        and(
          eq(projects.orgId, orgId),
          inArray(projects.id, projectIds),
          isNull(projects.deletedAt),
        ),
      )
      .limit(projectIds.length);
    for (const row of projectRows) projectKeyById.set(row.id, row.key);

    for (const row of ticketRows) {
      const ticketKey = buildTicketKey(projectKeyById.get(row.projectId), row.ticketNumber);
      await this.dispatch
        .emit({
          eventKey: "build.ticket.assigned",
          orgId,
          actorUserId: actingUserId,
          targetUserIds: notifyTargets,
          entityType: "ticket",
          entityId: String(row.id),
          title: "Ticket Assigned to You",
          message: `You have been assigned to ticket "${row.title}".`,
          link: buildTicketHref(row.projectId, ticketKey),
          metadata: {
            ticketId: row.id,
            ticketKey,
            priority: row.priority,
            status: row.status,
            type: row.type,
          },
        })
        .catch((error: unknown) =>
          logger.error("Failed to dispatch ticket assignment notification", { error }),
        );
    }

  }
}
