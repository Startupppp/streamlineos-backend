import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  ilike,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { cycles, projectStatuses, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateCycleInput,
  CycleListQuery,
  UpdateCycleInput,
} from "./dto/iterations.schemas";
import { assertProjectAccess } from "../core";
import { assertProjectVisible } from "../core/project-crud/project-access";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { sqlstateOf } from "../../../common/observability/error-classification";
import { TicketVersionConflictException } from "../core/tickets";
import {
  buildCursorPage,
  decodeIntegerCursor,
} from "../../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

@Injectable()
export class CyclesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async listCycles(actor: CurrentUserContext, projectId: number, query: CycleListQuery) {
    await assertProjectVisible(this.db, this.access, actor, projectId);
    const { orgId } = actor;
    const limit = Math.min(query.limit ?? 50, PAGE_SIZE_CAP);
    const cursor = decodeIntegerCursor(query.cursor);

    const conditions = [
      eq(cycles.projectId, projectId),
      eq(cycles.orgId, orgId),
      isNull(cycles.deletedAt),
    ];
    if (query.status) conditions.push(eq(cycles.status, query.status));
    if (query.q) {
      const escaped = query.q.replace(/[%_\\]/g, "\\$&");
      conditions.push(ilike(cycles.name, `%${escaped}%`));
    }
    if (query.from) conditions.push(gte(cycles.endDate, query.from));
    if (query.to) conditions.push(lte(cycles.startDate, query.to));
    if (cursor) {
      const keyset = or(
        gt(cycles.startDate, cursor.sortValue),
        and(eq(cycles.startDate, cursor.sortValue), gt(cycles.id, cursor.id)),
      );
      if (keyset) conditions.push(keyset);
    }

    const cycleList = await this.db
      .select({
        id: cycles.id,
        orgId: cycles.orgId,
        projectId: cycles.projectId,
        name: cycles.name,
        description: cycles.description,
        goal: cycles.goal,
        capacity: cycles.capacity,
        startDate: cycles.startDate,
        endDate: cycles.endDate,
        status: cycles.status,
        version: cycles.version,
        createdBy: cycles.createdBy,
        createdAt: cycles.createdAt,
        updatedAt: cycles.updatedAt,
      })
      .from(cycles)
      .where(and(...conditions))
      .orderBy(asc(cycles.startDate), asc(cycles.id))
      .limit(limit + 1);

    if (cycleList.length === 0)
      return buildCursorPage([], limit, () => ({ sortValue: "", id: "" }));

    const cycleIds = cycleList.map((c) => c.id);
    const statsRows = await this.db
      .select({
        cycleId: tickets.cycleId,
        total: count(),
        completed: count(sql`CASE WHEN EXISTS (
          SELECT 1
          FROM ${projectStatuses} cycle_status
          WHERE cycle_status.org_id = ${orgId}
            AND cycle_status.project_id = ${projectId}
            AND cycle_status.name = ${tickets.status}
            AND cycle_status.type = 'completed'
        ) THEN 1 END`),
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, orgId),
          isNull(tickets.deletedAt),
          sql`${tickets.cycleId} IN (${sql.join(
            cycleIds.map((cid) => sql`${cid}`),
            sql`, `,
          )})`,
        ),
      )
      .groupBy(tickets.cycleId);

    const statsMap = new Map(statsRows.map((s) => [s.cycleId, s]));

    const rows = cycleList.map((cycle) => {
      const stats = statsMap.get(cycle.id);
      const total = Number(stats?.total ?? 0);
      const completed = Number(stats?.completed ?? 0);
      return {
        ...cycle,
        totalItems: total,
        completedItems: completed,
        progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      };
    });

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.startDate,
      id: String(row.id),
    }));
  }

  async createCycle(
    actor: CurrentUserContext,
    projectId: number,
    input: CreateCycleInput,
  ) {
    await assertProjectAccess(this.db, this.access, actor, projectId);
    const { orgId, userId } = actor;
    const overlapping = await this.db
      .select({ id: cycles.id })
      .from(cycles)
      .where(
        and(
          eq(cycles.projectId, projectId),
          eq(cycles.orgId, orgId),
          isNull(cycles.deletedAt),
          or(
            and(
              lte(cycles.startDate, input.startDate),
              gte(cycles.endDate, input.startDate),
            ),
            and(
              lte(cycles.startDate, input.endDate),
              gte(cycles.endDate, input.endDate),
            ),
            and(
              gte(cycles.startDate, input.startDate),
              lte(cycles.endDate, input.endDate),
            ),
          ),
        ),
      )
      .limit(1);

    if (overlapping.length > 0)
      throw new ConflictException(
        "Cycle dates overlap with an existing cycle.",
      );

    let cycle: typeof cycles.$inferSelect | undefined;
    try {
      [cycle] = await this.db
        .insert(cycles)
        .values({
          projectId,
          orgId,
          name: input.name,
          description: input.description,
          capacity: input.capacity,
          startDate: input.startDate,
          endDate: input.endDate,
          createdBy: userId,
        })
        .returning();
    } catch (error: unknown) {
      if (sqlstateOf(error) === "23P01")
        throw new ConflictException(
          "Cycle dates overlap with an existing cycle.",
        );
      throw error;
    }

    return cycle;
  }

  async updateCycle(
    actor: CurrentUserContext,
    projectId: number,
    cycleId: number,
    input: UpdateCycleInput,
  ) {
    await assertProjectAccess(this.db, this.access, actor, projectId);
    const { orgId } = actor;
    const before = await this.db.query.cycles.findFirst({
      where: and(
        eq(cycles.id, cycleId),
        eq(cycles.projectId, projectId),
        eq(cycles.orgId, orgId),
      ),
      columns: { version: true },
    });
    if (!before) throw new NotFoundException("Cycle not found");
    if (input.version !== before.version)
      throw new TicketVersionConflictException(before.version);

    if (input.status === "active") {
      const [existing] = await this.db
        .select({ id: cycles.id })
        .from(cycles)
        .where(
          and(
            eq(cycles.status, "active"),
            eq(cycles.projectId, projectId),
            eq(cycles.orgId, orgId),
            isNull(cycles.deletedAt),
          ),
        )
        .limit(1);

      if (existing && existing.id !== cycleId)
        throw new ConflictException(
          "Only one active cycle is allowed at a time per project.",
        );
    }

    const { version: _v, ...rest } = input;
    let updated: typeof cycles.$inferSelect | undefined;
    try {
      [updated] = await this.db
        .update(cycles)
        .set({ ...rest, updatedAt: new Date() })
        .where(
          and(
            eq(cycles.id, cycleId),
            eq(cycles.projectId, projectId),
            eq(cycles.orgId, orgId),
            eq(cycles.version, before.version),
          ),
        )
        .returning();
    } catch (error: unknown) {
      if (sqlstateOf(error) === "23505")
        throw new ConflictException(
          "Only one active cycle is allowed at a time per project.",
        );
      if (sqlstateOf(error) === "23P01")
        throw new ConflictException(
          "Cycle dates overlap with an existing cycle.",
        );
      throw error;
    }

    if (!updated) {
      const [current] = await this.db
        .select({ version: cycles.version })
        .from(cycles)
        .where(and(eq(cycles.id, cycleId), eq(cycles.orgId, orgId)))
        .limit(1);
      throw new TicketVersionConflictException(
        current?.version ?? before.version,
      );
    }
    return updated;
  }

  async deleteCycle(actor: CurrentUserContext, projectId: number, cycleId: number) {
    await assertProjectAccess(this.db, this.access, actor, projectId);
    const { orgId } = actor;
    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ cycleId: null })
        .where(and(eq(tickets.cycleId, cycleId), eq(tickets.orgId, orgId)));
      const removed = await tx
        .delete(cycles)
        .where(
          and(
            eq(cycles.id, cycleId),
            eq(cycles.projectId, projectId),
            eq(cycles.orgId, orgId),
          ),
        )
        .returning({ id: cycles.id });
      if (removed.length === 0) throw new NotFoundException("Cycle not found");
    });
    return { success: true };
  }
}
