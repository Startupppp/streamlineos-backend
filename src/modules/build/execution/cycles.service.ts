import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { cycles, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateCycleInput, CycleListQuery, UpdateCycleInput } from "./dto/iterations.schemas";

@Injectable()
export class CyclesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listCycles(orgId: string, projectId: number, query: CycleListQuery) {
    const conditions = [eq(cycles.projectId, projectId), eq(cycles.orgId, orgId)];
    if (query.status) conditions.push(eq(cycles.status, query.status));

    const cycleList = await this.db
      .select({
        id: cycles.id,
        orgId: cycles.orgId,
        projectId: cycles.projectId,
        name: cycles.name,
        description: cycles.description,
        startDate: cycles.startDate,
        endDate: cycles.endDate,
        status: cycles.status,
        createdBy: cycles.createdBy,
        createdAt: cycles.createdAt,
        updatedAt: cycles.updatedAt,
      })
      .from(cycles)
      .where(and(...conditions))
      .orderBy(cycles.startDate)
      .limit(100);

    if (cycleList.length === 0) return [];

    const cycleIds = cycleList.map((c) => c.id);
    const statsRows = await this.db
      .select({
        cycleId: tickets.cycleId,
        total: count(),
        completed: count(sql`CASE WHEN ${tickets.status} = 'DONE' THEN 1 END`),
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, orgId),
          isNull(tickets.deletedAt),
          sql`${tickets.cycleId} IN (${sql.join(cycleIds.map((cid) => sql`${cid}`), sql`, `)})`,
        ),
      )
      .groupBy(tickets.cycleId);

    const statsMap = new Map(statsRows.map((s) => [s.cycleId, s]));

    return cycleList.map((cycle) => {
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
  }

  async createCycle(orgId: string, userId: string, projectId: number, input: CreateCycleInput) {
    const overlapping = await this.db
      .select({ id: cycles.id })
      .from(cycles)
      .where(
        and(
          eq(cycles.projectId, projectId),
          eq(cycles.orgId, orgId),
          or(
            and(lte(cycles.startDate, input.startDate), gte(cycles.endDate, input.startDate)),
            and(lte(cycles.startDate, input.endDate), gte(cycles.endDate, input.endDate)),
            and(gte(cycles.startDate, input.startDate), lte(cycles.endDate, input.endDate)),
          ),
        ),
      )
      .limit(1);

    if (overlapping.length > 0)
      throw new ConflictException("Cycle dates overlap with an existing cycle.");

    const [cycle] = await this.db
      .insert(cycles)
      .values({
        projectId,
        orgId,
        name: input.name,
        description: input.description,
        startDate: input.startDate,
        endDate: input.endDate,
        createdBy: userId,
      })
      .returning();

    return cycle;
  }

  async updateCycle(orgId: string, projectId: number, cycleId: number, input: UpdateCycleInput) {
    if (input.status === "active") {
      const [existing] = await this.db
        .select({ id: cycles.id })
        .from(cycles)
        .where(
          and(eq(cycles.status, "active"), eq(cycles.projectId, projectId), eq(cycles.orgId, orgId)),
        )
        .limit(1);

      if (existing && existing.id !== cycleId)
        throw new ConflictException("Only one active cycle is allowed at a time per project.");
    }

    const [updated] = await this.db
      .update(cycles)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(cycles.id, cycleId), eq(cycles.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Cycle not found");
    return updated;
  }

  async deleteCycle(orgId: string, cycleId: number) {
    await this.db.transaction(async (tx) => {
      await tx.update(tickets).set({ cycleId: null }).where(and(eq(tickets.cycleId, cycleId), eq(tickets.orgId, orgId)));
      await tx.delete(cycles).where(and(eq(cycles.id, cycleId), eq(cycles.orgId, orgId)));
    });
    return { success: true };
  }
}
