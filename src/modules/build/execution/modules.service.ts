import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, ilike, isNull, sql } from "drizzle-orm";
import { modules, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateModuleInput,
  UpdateModuleInput,
} from "./dto/iterations.schemas";

@Injectable()
export class ModulesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listModules(orgId: string, projectId: number) {
    const moduleList = await this.db
      .select({
        id: modules.id,
        name: modules.name,
        orgId: modules.orgId,
        status: modules.status,
        leadId: modules.leadId,
        endDate: modules.endDate,
        startDate: modules.startDate,
        createdBy: modules.createdBy,
        projectId: modules.projectId,
        createdAt: modules.createdAt,
        updatedAt: modules.updatedAt,
        description: modules.description,
      })
      .from(modules)
      .where(and(eq(modules.projectId, projectId), eq(modules.orgId, orgId)))
      .orderBy(asc(modules.name))
      .limit(100);

    if (moduleList.length === 0) return [];

    const moduleIds = moduleList.map((m) => m.id);
    const statsRows = await this.db
      .select({
        moduleId: tickets.moduleId,
        total: count(),
        completed: count(sql`CASE WHEN ${tickets.status} = 'DONE' THEN 1 END`),
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, orgId),
          isNull(tickets.deletedAt),
          sql`${tickets.moduleId} IN (${sql.join(
            moduleIds.map((mid) => sql`${mid}`),
            sql`, `,
          )})`,
        ),
      )
      .groupBy(tickets.moduleId);

    const statsMap = new Map(statsRows.map((s) => [s.moduleId, s]));

    return moduleList.map((mod) => {
      const stats = statsMap.get(mod.id);
      const total = Number(stats?.total ?? 0);
      const completed = Number(stats?.completed ?? 0);
      return {
        ...mod,
        totalItems: total,
        completedItems: completed,
        progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      };
    });
  }

  async createModule(
    orgId: string,
    userId: string,
    projectId: number,
    input: CreateModuleInput,
  ) {
    const [existing] = await this.db
      .select({ id: modules.id, name: modules.name })
      .from(modules)
      .where(
        and(
          eq(modules.orgId, orgId),
          eq(modules.projectId, projectId),
          ilike(modules.name, input.name.trim()),
        ),
      )
      .limit(1);

    if (existing)
      throw new ConflictException(
        `A module named "${existing.name}" already exists in this project.`,
      );

    const [mod] = await this.db
      .insert(modules)
      .values({
        projectId,
        orgId,
        name: input.name,
        description: input.description,
        status: input.status,
        leadId: input.leadId,
        startDate: input.startDate,
        endDate: input.endDate,
        createdBy: userId,
      })
      .returning();

    return mod;
  }

  async updateModule(
    orgId: string,
    moduleId: number,
    input: UpdateModuleInput,
  ) {
    const [updated] = await this.db
      .update(modules)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(modules.id, moduleId), eq(modules.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Module not found");
    return updated;
  }

  async deleteModule(orgId: string, moduleId: number) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ moduleId: null })
        .where(and(eq(tickets.moduleId, moduleId), eq(tickets.orgId, orgId)));
      await tx
        .delete(modules)
        .where(and(eq(modules.id, moduleId), eq(modules.orgId, orgId)));
    });
    return { success: true };
  }
}
