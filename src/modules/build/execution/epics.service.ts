import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, isNull, sql, type SQL } from "drizzle-orm";
import { tickets, workItemRelations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
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
import { allocateTicketNumbers, assertProjectInOrg } from "../core";
import { reserveTicketCapacity, TicketVersionConflictException } from "../core/tickets";

@Injectable()
export class EpicsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
        ? ilike(tickets.title, `%${query.q.trim().replace(/[%_\\]/g, "\\$&")}%`)
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
    const [epic] = await this.db.transaction(async (tx) => {
      await reserveTicketCapacity(tx, orgId, projectId, [{ status: "TODO", count: 1 }]);
      const nextNumber = await allocateTicketNumbers(tx, orgId, projectId);

      return tx
        .insert(tickets)
        .values({
          orgId,
          projectId,
          ticketNumber: nextNumber,
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
        })
        .returning();
    });

    return epic;
  }

  async updateEpic(orgId: string, projectId: number, epicId: number, input: UpdateEpicInput) {
    const before = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, epicId), eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), eq(tickets.type, "EPIC"), isNull(tickets.deletedAt)),
      columns: { version: true },
    });
    if (!before) throw new NotFoundException("Epic not found");
    if (input.version !== before.version) throw new TicketVersionConflictException(before.version);

    const { version: _v, ...rest } = input;
    const [updated] = await this.db
      .update(tickets)
      .set({ ...rest, updatedAt: new Date() })
      .where(
        and(
          eq(tickets.id, epicId),
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          eq(tickets.type, "EPIC"),
          isNull(tickets.deletedAt),
          eq(tickets.version, before.version),
        ),
      )
      .returning();
    if (!updated) {
      const [current] = await this.db.select({ version: tickets.version }).from(tickets).where(and(eq(tickets.id, epicId), eq(tickets.orgId, orgId))).limit(1);
      throw new TicketVersionConflictException(current?.version ?? before.version);
    }
    return updated;
  }

  async deleteEpic(orgId: string, projectId: number, epicId: number) {
    const epic = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, epicId),
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.type, "EPIC"),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true },
    });
    if (!epic) throw new NotFoundException("Epic not found");
    await this.db.transaction(async (tx) => {
      await tx.update(tickets).set({ epicId: null }).where(and(eq(tickets.epicId, epicId), eq(tickets.orgId, orgId)));
      await tx.delete(tickets).where(and(eq(tickets.id, epicId), eq(tickets.orgId, orgId)));
    });
    return { success: true };
  }
}
