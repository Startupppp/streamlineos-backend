import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { tickets, workItemRelations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreateEpicInput,
  EpicListQuery,
  UpdateEpicInput,
} from "./dto/iterations.schemas";
import {
  buildCursorPage,
  decodeTimestampCursor,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import { assertProjectInOrg } from "../core";
import { AuditService } from "../../../common/audit/audit.service";
import { BuildTicketCreationService, ProjectsTicketsUpdateService } from "../core/tickets";

@Injectable()
export class EpicsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ticketCreation: BuildTicketCreationService,
    private readonly ticketChange: ProjectsTicketsUpdateService,
    private readonly audit: AuditService,
  ) {}

  async listEpics(orgId: string, projectId: number, query: EpicListQuery = {}) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const limit = Math.min(query.limit ?? PAGE_SIZE_CAP, PAGE_SIZE_CAP);
    const position = decodeTimestampCursor(query.cursor);
    const conditions: (SQL<unknown> | undefined)[] = [
      eq(tickets.orgId, orgId),
      eq(tickets.projectId, projectId),
      eq(tickets.type, "EPIC"),
      isNull(tickets.deletedAt),
      query.status ? eq(tickets.status, query.status) : undefined,
      query.health ? eq(tickets.health, query.health) : undefined,
      query.q && query.q.trim()
        ? sql`to_tsvector('english', coalesce(${tickets.title},'')) @@ plainto_tsquery('english', ${query.q.trim()})`
        : undefined,
      query.ownerId
        ? sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${query.ownerId})`
        : undefined,
      position
        ? keysetBeforeMicros(tickets.createdAt, tickets.id, position)
        : undefined,
    ];

    const epics = await this.db.query.tickets.findMany({
      where: and(...conditions),
      with: {
        assignee: { with: { user: { columns: { id: true, name: true, firstName: true, lastName: true, email: true, image: true } } } },
      },
      extras: {
        createdAtMicros: microsecondCursorValue(tickets.createdAt).as(
          "created_at_micros",
        ),
      },
      orderBy: [desc(tickets.createdAt), desc(tickets.id)],
      limit: limit + 1,
    });

    const depCountMap = new Map<number, number>();
    if (epics.length > 0) {
      const idList = sql.join(
        epics.map((e) => sql`${e.id}`),
        sql`, `,
      );
      const [asSource, asTarget] = await Promise.all([
        this.db
          .select({ id: workItemRelations.workItemId })
          .from(workItemRelations)
          .where(
            and(
              eq(workItemRelations.orgId, orgId),
              sql`${workItemRelations.workItemId} IN (${idList})`,
            ),
          ),
        this.db
          .select({ id: workItemRelations.relatedWorkItemId })
          .from(workItemRelations)
          .where(
            and(
              eq(workItemRelations.orgId, orgId),
              sql`${workItemRelations.relatedWorkItemId} IN (${idList})`,
            ),
          ),
      ]);
      for (const r of [...asSource, ...asTarget])
        depCountMap.set(r.id, (depCountMap.get(r.id) ?? 0) + 1);
    }

    const rows = epics.map((epic) => ({
      ...epic,
      dependencyCount: depCountMap.get(epic.id) ?? 0,
    }));

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAtMicros,
      id: String(row.id),
    }));
  }

  async createEpic(orgId: string, userId: string, projectId: number, input: CreateEpicInput) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const created = await this.ticketCreation.create({
      orgId,
      projectId,
      actor: { userId, membershipId: null },
      drafts: [{
          title: input.title,
          description: input.description,
          type: "EPIC",
          priority: input.priority ?? "MEDIUM",
          assigneeMembershipId: undefined,
          reporterId: userId,
          points: input.points,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          status: "TODO",
      }],
    });
    return created.tickets[0];
  }

  async updateEpic(u: CurrentUserContext, projectId: number, epicId: number, input: UpdateEpicInput) {
    const before = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, epicId), eq(tickets.orgId, u.orgId), eq(tickets.projectId, projectId), eq(tickets.type, "EPIC"), isNull(tickets.deletedAt)),
      columns: { id: true, version: true },
    });
    if (!before) throw new NotFoundException("Epic not found");

    await this.ticketChange.updateTicket(u, projectId, epicId, {
      version: input.version,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId ?? "" }),
      ...(input.health !== undefined && { health: input.health }),
      ...(input.startDate !== undefined && { startDate: input.startDate }),
      ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
      ...(input.points !== undefined && { points: input.points }),
    });

    const updated = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, epicId), eq(tickets.orgId, u.orgId), isNull(tickets.deletedAt)),
      columns: {
        id: true, orgId: true, projectId: true, ticketNumber: true, title: true,
        description: true, type: true, status: true, priority: true, health: true,
        epicId: true, cycleId: true, assigneeMembershipId: true, points: true,
        storyPoints: true, startDate: true, dueDate: true, rank: true, timeSpent: true,
        completionPercentage: true, deletedAt: true, createdAt: true, updatedAt: true,
        version: true,
      },
    });
    if (!updated) throw new NotFoundException("Epic not found after update");
    return updated;
  }

  async deleteEpic(u: CurrentUserContext, projectId: number, epicId: number) {
    const epic = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, epicId),
        eq(tickets.orgId, u.orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.type, "EPIC"),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true },
    });
    if (!epic) throw new NotFoundException("Epic not found");
    await this.db.update(tickets).set({ deletedAt: new Date() }).where(and(eq(tickets.id, epicId), eq(tickets.orgId, u.orgId)));
    this.audit.log({
      action: "epic.deleted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "ticket",
      resourceId: String(epicId),
      metadata: { epicId, projectId },
    });
    return { success: true };
  }
}
