import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  projectMembers,
  projectStatuses,
  tickets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ProjectsEmailService } from "./projects-email.service";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { ImportTicketsInput, UpdateTicketInput } from "./dto/projects.schemas";
import { resolveAssigneeId } from "./tickets-helpers";

@Injectable()
export class ProjectsTicketsTransferService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly read: ProjectsTicketsReadService,
    private readonly notifications: NotificationsService,
    private readonly projectsEmail: ProjectsEmailService,
  ) {}

  async exportTickets(u: CurrentUserContext, projectId: number) {
    const { hasAccess } = await this.read.checkProjectAccess(u.orgId, u.userId, projectId);
    if (!hasAccess) throw new NotFoundException("Not found");

    const rows = await this.db
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
      .leftJoin(users, eq(tickets.assigneeId, users.id))
      .where(and(eq(tickets.orgId, u.orgId), eq(tickets.projectId, projectId)))
      .orderBy(tickets.ticketNumber);

    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      type: r.type,
      status: r.status,
      priority: r.priority,
      points: r.points ?? null,
      dueDate: r.dueDate ?? null,
      assignee: r.assigneeName ?? (r.assigneeFirstName && r.assigneeLastName
        ? `${r.assigneeFirstName} ${r.assigneeLastName}`.trim()
        : r.assigneeEmail ?? null),
    }));
  }

  async importTickets(u: CurrentUserContext, projectId: number, body: ImportTicketsInput) {
    const { hasAccess } = await this.read.checkProjectAccess(u.orgId, u.userId, projectId);
    if (!hasAccess) throw new NotFoundException("Not found");

    const [validStatuses, memberEmails] = await Promise.all([
      this.db
        .select({ name: projectStatuses.name })
        .from(projectStatuses)
        .where(and(eq(projectStatuses.orgId, u.orgId), eq(projectStatuses.projectId, projectId))),
      this.db
        .select({ userId: projectMembers.userId, email: users.email })
        .from(projectMembers)
        .innerJoin(users, eq(projectMembers.userId, users.id))
        .where(eq(projectMembers.projectId, projectId)),
    ]);

    const validStatusSet = new Set(validStatuses.map((s) => s.name));
    const emailToUserId = new Map(memberEmails.map((m) => [m.email, m.userId]));
    const defaultStatus = validStatuses[0]?.name ?? "TODO";

    const skipped: Array<{ row: number; reason: string }> = [];
    const toCreate: Array<typeof tickets.$inferInsert & { _rowIndex: number }> = [];

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
        assigneeId,
        dueDate: row.dueDate ?? undefined,
        reporterId: u.userId,
        _rowIndex: i + 1,
      });
    }

    if (toCreate.length === 0) {
      return { created: 0, skipped };
    }

    const CHUNK_SIZE = 100;
    let createdCount = 0;

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);

      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, u.orgId)));

      let nextNum = (maxRow?.maxNum ?? 0) + 1;

      const rowsWithNumbers = toCreate.map((item) => {
        const ticketNumber = nextNum++;
        const { _rowIndex, ...values } = item;
        return { values: { ...values, ticketNumber }, _rowIndex };
      });

      for (let i = 0; i < rowsWithNumbers.length; i += CHUNK_SIZE) {
        const chunk = rowsWithNumbers.slice(i, i + CHUNK_SIZE);
        try {
          await tx.insert(tickets).values(chunk.map((r) => r.values));
          createdCount += chunk.length;
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          for (const r of chunk) {
            skipped.push({ row: r._rowIndex, reason: msg });
          }
        }
      }
    });

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
    if (notifyIds.size === 0) return;

    const ticketData = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)),
      columns: { title: true, projectId: true },
    });

    await Promise.all(
      Array.from(notifyIds)
        .filter((userId) => userId !== actingUserId)
        .map((userId) =>
          this.notifications
            .create({
              orgId,
              userId,
              type: "INFO",
              title: "Ticket Assigned to You",
              message: `You have been assigned to ticket "${ticketData?.title ?? `#${ticketId}`}".`,
              link: ticketData?.projectId ? `/projects/${ticketData.projectId}?ticket=${ticketId}` : undefined,
            })
            .catch((error) => logger.error("Failed to create ticket assignment notification", { error })),
        ),
    );

    void this.projectsEmail
      .notifyTicketAssignees(actingUserId, ticketId, Array.from(notifyIds))
      .catch(() => undefined);
  }
}
