import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, eq, gt, ilike, isNull, or, sql } from "drizzle-orm";
import { modules, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateModuleInput,
  ModuleListQuery,
  UpdateModuleInput,
} from "./dto/iterations.schemas";
import { assertProjectInOrg } from "../core/project-access";
import { buildTupleCursorPage, decodeTupleCursor } from "../../../common/pagination/cursor";

@Injectable()
export class ModulesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listModules(orgId: string, projectId: number, query: ModuleListQuery = {}) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const limit = query.pageSize ?? 100;
    const cursor = query.cursor ? decodeTupleCursor(query.cursor, 2) : null;
    if (query.cursor && (!cursor || !/^\d+$/.test(cursor[1]))) {
      throw new BadRequestException("Invalid pagination cursor");
    }
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
      .where(and(
        eq(modules.projectId, projectId),
        eq(modules.orgId, orgId),
        cursor
          ? or(
              gt(modules.name, cursor[0]),
              and(eq(modules.name, cursor[0]), gt(modules.id, Number(cursor[1]))),
            )
          : undefined,
      ))
      .orderBy(asc(modules.name), asc(modules.id))
      .limit(limit + 1);

    if (moduleList.length === 0) return buildTupleCursorPage([], limit, () => []);

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

    const rows = moduleList.map((mod) => {
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
    return buildTupleCursorPage(rows, limit, (row) => [row.name, String(row.id)]);
  }

  async createModule(
    orgId: string,
    userId: string,
    projectId: number,
    input: CreateModuleInput,
  ) {
    // `listModules` above resolves the project; this did not, so a cross-tenant `:projectId` fell
    // through the duplicate-name check and the INSERT then hit the composite tenant FK as a 500.
    await assertProjectInOrg(this.db, orgId, projectId);
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
    projectId: number,
    moduleId: number,
    input: UpdateModuleInput,
  ) {
    const [updated] = await this.db
      .update(modules)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(modules.id, moduleId), eq(modules.projectId, projectId), eq(modules.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Module not found");
    return updated;
  }

  async deleteModule(orgId: string, projectId: number, moduleId: number) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ moduleId: null })
        .where(and(eq(tickets.moduleId, moduleId), eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));
      const removed = await tx
        .delete(modules)
        .where(and(eq(modules.id, moduleId), eq(modules.projectId, projectId), eq(modules.orgId, orgId)))
        .returning({ id: modules.id });
      if (removed.length === 0) throw new NotFoundException("Module not found");
    });
    return { success: true };
  }
}
