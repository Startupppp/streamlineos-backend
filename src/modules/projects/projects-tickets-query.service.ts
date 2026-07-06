import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  projectMembers,
  projectStatuses,
  projects,
  ticketAssignees,
  tickets,
  workflowTransitions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { resolveValidTicketStatuses } from "./ticket-status.util";
import { ProjectsInvalidTicketStatusException } from "../../common/http/api-exceptions";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { BulkUpdateInput, ReorderInput } from "./dto/projects.schemas";

@Injectable()
export class ProjectsTicketsQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async validateTicketStatus(projectId: number, orgId: string, status: string): Promise<void> {
    const valid = await resolveValidTicketStatuses(this.db, projectId, orgId, [status]);
    if (!valid.has(status)) throw new ProjectsInvalidTicketStatusException(status);
  }

  async assertTransitionAllowed(orgId: string, projectId: number, fromText: string, toText: string): Promise<void> {
    try {
      const transitions = await this.db
        .select({ fromStatusId: workflowTransitions.fromStatusId, toStatusId: workflowTransitions.toStatusId })
        .from(workflowTransitions)
        .where(and(eq(workflowTransitions.orgId, orgId), eq(workflowTransitions.projectId, projectId), isNull(workflowTransitions.deletedAt)));
      if (transitions.length === 0) return;
      const statuses = await this.db
        .select({ id: projectStatuses.id, name: projectStatuses.name })
        .from(projectStatuses)
        .where(and(eq(projectStatuses.orgId, orgId), eq(projectStatuses.projectId, projectId)));
      const nameToId = new Map(statuses.map((s) => [s.name, s.id]));
      const resolvedFrom = nameToId.get(fromText);
      const resolvedTo = nameToId.get(toText);
      if (resolvedFrom === undefined || resolvedTo === undefined) return;
      const allowed = transitions.some(
        (t) => t.toStatusId === resolvedTo && (t.fromStatusId === resolvedFrom || t.fromStatusId === null),
      );
      if (!allowed) {
        throw new BadRequestException(`Transition from '${fromText}' to '${toText}' is not allowed by this project's workflow.`);
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
    }
  }

  async bulkUpdate(u: CurrentUserContext, projectId: number, body: BulkUpdateInput) {
    const member = await this.db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, u.userId)),
    });
    if (!member) throw new ForbiddenException("Not a project member.");

    if (body.status !== undefined) {
      await this.validateTicketStatus(projectId, u.orgId, body.status);
    }

    const updateData: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() };
    if (body.assigneeId !== undefined) updateData.assigneeId = body.assigneeId;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.sprintId !== undefined) updateData.sprintId = body.sprintId;
    if (body.priority !== undefined) updateData.priority = body.priority;

    const updated = await this.db
      .update(tickets)
      .set(updateData)
      .where(and(eq(tickets.orgId, u.orgId), eq(tickets.projectId, projectId), inArray(tickets.id, body.ticketIds)))
      .returning({ id: tickets.id });

    return { updated: updated.length, ticketIds: updated.map((t) => t.id) };
  }

  async reorder(orgId: string, projectId: number, body: ReorderInput) {
    if (body.items.length === 0) return { success: true };

    const distinctStatuses = [...new Set(body.items.map((i) => i.status))];
    const valid = await resolveValidTicketStatuses(this.db, projectId, orgId, distinctStatuses);
    for (const status of distinctStatuses) {
      if (!valid.has(status)) throw new ProjectsInvalidTicketStatusException(status);
    }

    const itemIds = body.items.map((i) => i.id);
    const prevRows = await this.db
      .select({ id: tickets.id, status: tickets.status })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), inArray(tickets.id, itemIds)));
    const prevMap = new Map(prevRows.map((r) => [r.id, r.status]));
    for (const item of body.items) {
      const prev = prevMap.get(item.id);
      if (prev !== undefined && prev !== item.status) {
        await this.assertTransitionAllowed(orgId, projectId, prev, item.status);
      }
    }

    await this.db.transaction(async (tx) => {
      for (const item of body.items) {
        await tx
          .update(tickets)
          .set({ status: item.status, order: item.order, updatedAt: new Date() })
          .where(
            and(
              eq(tickets.id, item.id),
              eq(tickets.projectId, projectId),
              eq(tickets.orgId, orgId),
            ),
          );
      }
    });

    return { success: true };
  }

  async searchOrgTickets(orgId: string, userId: string, q: string, limit: number) {
    const memberProjectIds = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, userId));

    const ids = memberProjectIds.map((r) => r.projectId);
    if (ids.length === 0) return [];

    const rows = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        priority: tickets.priority,
        ticketNumber: tickets.ticketNumber,
        projectId: tickets.projectId,
        projectKey: projects.key,
        projectName: projects.name,
      })
      .from(tickets)
      .innerJoin(projects, eq(tickets.projectId, projects.id))
      .where(
        and(
          eq(tickets.orgId, orgId),
          inArray(tickets.projectId, ids),
          q.length > 0
            ? or(
                sql`${tickets.title} ILIKE ${"%" + q + "%"}`,
                sql`CAST(${tickets.ticketNumber} AS TEXT) ILIKE ${"%" + q + "%"}`,
                sql`CONCAT(${projects.key}, '-', CAST(${tickets.ticketNumber} AS TEXT)) ILIKE ${"%" + q + "%"}`,
              )
            : undefined,
        ),
      )
      .orderBy(desc(tickets.updatedAt))
      .limit(limit);

    return rows;
  }

  async getMyWork(orgId: string, userId: string) {
    const assigneeRows = await this.db
      .select({ ticketId: ticketAssignees.ticketId })
      .from(ticketAssignees)
      .where(eq(ticketAssignees.userId, userId));

    const assigneeTicketIds = assigneeRows.map((r) => r.ticketId);

    const assigneeCondition =
      assigneeTicketIds.length > 0
        ? or(eq(tickets.assigneeId, userId), inArray(tickets.id, assigneeTicketIds))
        : eq(tickets.assigneeId, userId);

    return this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        priority: tickets.priority,
        type: tickets.type,
        dueDate: tickets.dueDate,
        ticketNumber: tickets.ticketNumber,
        projectId: projects.id,
        projectName: projects.name,
        projectKey: projects.key,
      })
      .from(tickets)
      .innerJoin(projects, eq(tickets.projectId, projects.id))
      .where(
        and(
          eq(tickets.orgId, orgId),
          ne(projects.status, "ARCHIVED"),
          assigneeCondition,
        ),
      )
      .orderBy(
        sql`${tickets.dueDate} ASC NULLS LAST`,
        sql`CASE ${tickets.priority} WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END ASC`,
      );
  }
}
