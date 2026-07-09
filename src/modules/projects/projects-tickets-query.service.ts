import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
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

  async assertTransitionAllowed(
    orgId: string,
    projectId: number,
    fromText: string,
    toText: string,
    context: {
      userId: string;
      userProjectRole: string | null;
      isOrgOwner: boolean;
      isPlatformAdmin: boolean;
      ticketId: number;
    },
  ): Promise<void> {
    const transitions = await this.db
      .select({
        fromStatusId: workflowTransitions.fromStatusId,
        toStatusId: workflowTransitions.toStatusId,
        requiresApproval: workflowTransitions.requiresApproval,
        requiredFields: workflowTransitions.requiredFields,
        allowedRoles: workflowTransitions.allowedRoles,
      })
      .from(workflowTransitions)
      .where(and(eq(workflowTransitions.orgId, orgId), eq(workflowTransitions.projectId, projectId), isNull(workflowTransitions.deletedAt)));

    if (transitions.length === 0) return;

    const statuses = await this.db
      .select({ id: projectStatuses.id, name: projectStatuses.name, wipLimit: projectStatuses.wipLimit })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.orgId, orgId), eq(projectStatuses.projectId, projectId)));

    const nameToId = new Map(statuses.map((s) => [s.name, s.id]));
    const idToStatus = new Map(statuses.map((s) => [s.id, s]));

    const resolvedFrom = nameToId.get(fromText);
    const resolvedTo = nameToId.get(toText);

    if (resolvedFrom === undefined || resolvedTo === undefined) return;

    const matchingTransitions = transitions.filter(
      (t) => t.toStatusId === resolvedTo && (t.fromStatusId === resolvedFrom || t.fromStatusId === null),
    );

    if (matchingTransitions.length === 0) {
      throw new BadRequestException(`Transition from '${fromText}' to '${toText}' is not allowed by this project's workflow.`);
    }

    const bypassPrivilege = context.isOrgOwner || context.isPlatformAdmin;

    for (const transition of matchingTransitions) {
      if (transition.requiresApproval && !bypassPrivilege) {
        throw new BadRequestException(
          `This transition requires approval before moving to '${toText}'. Submit an approval request first.`,
        );
      }

      if (Array.isArray(transition.allowedRoles) && transition.allowedRoles.length > 0 && !bypassPrivilege) {
        if (!context.userProjectRole || !transition.allowedRoles.includes(context.userProjectRole)) {
          throw new BadRequestException(
            `Your project role ('${context.userProjectRole ?? "unknown"}') is not allowed to make this transition.`,
          );
        }
      }

      if (Array.isArray(transition.requiredFields) && transition.requiredFields.length > 0) {
        const ticketRows = await this.db
          .select({
            assigneeId: tickets.assigneeId,
            dueDate: tickets.dueDate,
            priority: tickets.priority,
            points: tickets.points,
            epicId: tickets.epicId,
            sprintId: tickets.sprintId,
          })
          .from(tickets)
          .where(and(eq(tickets.id, context.ticketId), eq(tickets.orgId, orgId)))
          .limit(1);

        if (ticketRows.length > 0) {
          const row = ticketRows[0];
          const missing: string[] = [];
          for (const field of transition.requiredFields) {
            if (field === "assigneeId" && !row.assigneeId) missing.push(field);
            else if (field === "dueDate" && !row.dueDate) missing.push(field);
            else if (field === "priority" && !row.priority) missing.push(field);
            else if (field === "points" && (row.points === null || row.points === undefined)) missing.push(field);
            else if (field === "epicId" && !row.epicId) missing.push(field);
            else if (field === "sprintId" && !row.sprintId) missing.push(field);
          }
          if (missing.length > 0) {
            throw new BadRequestException(
              `Cannot move to '${toText}': the following fields are required: ${missing.join(", ")}.`,
            );
          }
        }
      }
    }

    const toStatus = idToStatus.get(resolvedTo);
    if (toStatus?.wipLimit != null) {
      const [countResult] = await this.db
        .select({ cnt: count() })
        .from(tickets)
        .where(
          and(
            eq(tickets.orgId, orgId),
            eq(tickets.projectId, projectId),
            eq(tickets.status, toText),
            ne(tickets.id, context.ticketId),
          ),
        );
      const currentCount = Number(countResult?.cnt ?? 0);
      if (currentCount >= toStatus.wipLimit) {
        throw new BadRequestException(
          `Column '${toText}' has reached its WIP limit of ${toStatus.wipLimit}. Move or complete an existing ticket first.`,
        );
      }
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

  async reorder(
    orgId: string,
    projectId: number,
    body: ReorderInput,
    context: { userId: string; isOrgOwner: boolean; isPlatformAdmin: boolean },
  ) {
    if (body.items.length === 0) return { success: true };

    const distinctStatuses = [...new Set(body.items.map((i) => i.status))];
    const valid = await resolveValidTicketStatuses(this.db, projectId, orgId, distinctStatuses);
    for (const status of distinctStatuses) {
      if (!valid.has(status)) throw new ProjectsInvalidTicketStatusException(status);
    }

    const memberRow = await this.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, context.userId)))
      .limit(1);
    const userProjectRole = memberRow[0]?.role ?? null;

    const itemIds = body.items.map((i) => i.id);
    const prevRows = await this.db
      .select({ id: tickets.id, status: tickets.status })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), inArray(tickets.id, itemIds)));
    const prevMap = new Map(prevRows.map((r) => [r.id, r.status]));
    for (const item of body.items) {
      const prev = prevMap.get(item.id);
      if (prev !== undefined && prev !== item.status) {
        await this.assertTransitionAllowed(orgId, projectId, prev, item.status, {
          userId: context.userId,
          userProjectRole,
          isOrgOwner: context.isOrgOwner,
          isPlatformAdmin: context.isPlatformAdmin,
          ticketId: item.id,
        });
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
