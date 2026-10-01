import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  programProjects,
  projectPortfolios,
  projectPrograms,
  projects,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import {
  buildCursorPage,
  buildTupleCursorPage,
  decodeCursor,
  decodeTupleCursor,
} from "../../../common/pagination/cursor";
import {
  keysetAfterMicros,
  keysetAfterValue,
  keysetBeforeMicros,
  keysetBeforeId,
  keysetBeforeValue,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import { assertCanManageProject, resolveProjectReach } from "../core";
import { reachableProjectIdsSql } from "./reachable-linked-projects";
import type {
  CreateProgramInput,
  LinkedProjectsQuery,
  LinkProjectInput,
  ListProgramsQuery,
  ProgramDetailQuery,
  UpdateProgramInput,
} from "./dto/portfolios.schemas";

type ProgramRow = typeof projectPrograms.$inferSelect;
type ProgramPatch = Partial<typeof projectPrograms.$inferInsert>;
type ProgramListSort = ListProgramsQuery["sort"];
type ProgramListOrder = ListProgramsQuery["order"];

const PROGRAM_SEARCH_ID_CAP = 5_000;
const PROGRAM_MICROSECOND_CURSOR =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const PROGRAM_LEGACY_CURSOR =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validProgramTimestamp(value: string): boolean {
  if (PROGRAM_MICROSECOND_CURSOR.test(value)) {
    const parsed = new Date(`${value}Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString() === `${value.slice(0, 23)}Z`
    );
  }
  if (!PROGRAM_LEGACY_CURSOR.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function decodeProgramCursor(
  cursor: string | undefined,
  sort: ProgramListSort,
  order: ProgramListOrder,
) {
  const parts = decodeTupleCursor(cursor, 4);
  if (!parts) return null;
  const [cursorSort, cursorOrder, sortValue, id] = parts;
  if (cursorSort !== sort || cursorOrder !== order || !sortValue || !id) return null;
  const numericId = Number(id);
  if (
    !Number.isSafeInteger(numericId) ||
    numericId <= 0 ||
    numericId > 2_147_483_647
  )
    throw new BadRequestException("Invalid pagination cursor");
  if (sort !== "name" && !validProgramTimestamp(sortValue))
    throw new BadRequestException("Invalid pagination cursor");
  return { sortValue, id: numericId };
}

@Injectable()
export class ProgramsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private async loadProgram(
    orgId: string,
    programId: number,
  ): Promise<ProgramRow> {
    const [row] = await this.db
      .select()
      .from(projectPrograms)
      .where(
        and(
          eq(projectPrograms.id, programId),
          eq(projectPrograms.orgId, orgId),
          isNull(projectPrograms.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Program not found");
    return row;
  }

  private async assertPortfolio(
    orgId: string,
    portfolioId: number,
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: projectPortfolios.id })
      .from(projectPortfolios)
      .where(
        and(
          eq(projectPortfolios.id, portfolioId),
          eq(projectPortfolios.orgId, orgId),
          isNull(projectPortfolios.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Portfolio not found");
  }

  private async searchProgramIds(term: string): Promise<number[] | null> {
    if (term.length < 3) return null;
    const rows = await this.db.execute(
      sql`SELECT app.search_project_program_ids(${term}, ${PROGRAM_SEARCH_ID_CAP + 1}) AS id`,
    );
    if (rows.length > PROGRAM_SEARCH_ID_CAP) return null;
    return rows.map((row) => Number(row["id"]));
  }

  async listPrograms(u: CurrentUserContext, query: ListProgramsQuery) {
    const { orgId } = u;
    const reach = await resolveProjectReach(this.access, u);
    const reachableProjectIds = reachableProjectIdsSql(orgId, reach.where);
    const program = alias(projectPrograms, "program");
    const {
      cursor,
      limit = 20,
      sort = "createdAt",
      order = "desc",
    } = query;
    const position = decodeProgramCursor(cursor, sort, order);
    let searchCondition: SQL | undefined;
    if (query.q) {
      const searchIds = await this.searchProgramIds(query.q);
      searchCondition = searchIds === null
        ? or(ilike(program.name, `%${query.q}%`), ilike(program.description, `%${query.q}%`))
        : searchIds.length > 0
          ? inArray(program.id, searchIds)
          : sql<boolean>`false`;
    }
    const sortColumn = sort === "name"
      ? program.name
      : sort === "updatedAt"
        ? program.updatedAt
        : program.createdAt;
    const cursorCondition = position
      ? sort === "name"
        ? order === "asc"
          ? keysetAfterValue(program.name, program.id, position)
          : keysetBeforeValue(program.name, program.id, position)
        : order === "asc"
          ? keysetAfterMicros(sortColumn, program.id, position)
          : keysetBeforeMicros(sortColumn, program.id, position)
      : undefined;
    const conds = [
      eq(program.orgId, orgId),
      isNull(program.deletedAt),
      searchCondition,
      query.ownerId ? eq(program.ownerId, query.ownerId) : undefined,
      query.health ? eq(program.health, query.health) : undefined,
      query.status ? eq(program.status, query.status) : undefined,
      query.portfolioId !== undefined
        ? eq(program.portfolioId, query.portfolioId)
        : undefined,
      query.projectId !== undefined
        ? sql<boolean>`EXISTS (
            SELECT 1
            FROM ${programProjects} filtered_link
            INNER JOIN ${projects} filtered_project
              ON filtered_project.id = filtered_link.project_id
             AND filtered_project.org_id = filtered_link.org_id
             AND filtered_project.deleted_at IS NULL
            WHERE filtered_link.program_id = ${program.id}
              AND filtered_link.org_id = ${program.orgId}
              AND filtered_link.org_id = ${orgId}
              AND filtered_link.project_id = ${query.projectId}
              AND filtered_link.project_id IN ${reachableProjectIds}
          )`
        : undefined,
      cursorCondition,
    ];
    const orderBy = order === "asc"
      ? [asc(sortColumn), asc(program.id)]
      : [desc(sortColumn), desc(program.id)];

    const rows = await this.db
      .select({
        id: program.id,
        orgId: program.orgId,
        portfolioId: program.portfolioId,
        name: program.name,
        description: program.description,
        ownerId: program.ownerId,
        status: program.status,
        health: program.health,
        createdBy: program.createdBy,
        createdAt: program.createdAt,
        updatedAt: program.updatedAt,
        createdAtCursor: microsecondCursorValue(program.createdAt),
        updatedAtCursor: microsecondCursorValue(program.updatedAt),
        projectCount: sql<number>`(
          SELECT CAST(COUNT(*) AS INT)
          FROM ${programProjects} link
          INNER JOIN ${projects} linked_project ON linked_project.id = link.project_id
            AND linked_project.org_id = link.org_id
            AND linked_project.deleted_at IS NULL
          WHERE link.program_id = program.id
            AND link.org_id = program.org_id
            AND link.project_id IN ${reachableProjectIds}
        )`,
      })
      .from(program)
      .where(and(...conds))
      .orderBy(...orderBy)
      .limit(limit + 1);

    const page = buildTupleCursorPage(rows, limit, (row) => [
      sort,
      order,
      sort === "name"
        ? row.name
        : sort === "updatedAt"
          ? row.updatedAtCursor
          : row.createdAtCursor,
      String(row.id),
    ]);
    return {
      data: page.data.map(({ createdAtCursor, updatedAtCursor, ...row }) => row),
      pagination: page.pagination,
    };
  }

  private async pageProgramProjects(
    orgId: string,
    programId: number,
    reach: SQL,
    query: LinkedProjectsQuery,
  ) {
    const { cursor, limit } = query;
    const pos = decodeCursor(cursor);
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
        addedAt: programProjects.createdAt,
      })
      .from(programProjects)
      .innerJoin(
        projects,
        and(
          eq(projects.id, programProjects.projectId),
          eq(projects.orgId, programProjects.orgId),
        ),
      )
      .where(
        and(
          eq(programProjects.programId, programId),
          eq(programProjects.orgId, orgId),
          isNull(projects.deletedAt),
          reach,
          pos ? keysetBeforeId(programProjects.createdAt, projects.id, pos) : undefined,
        ),
      )
      .orderBy(desc(programProjects.createdAt), desc(projects.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.addedAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
  }

  async getProgram(u: CurrentUserContext, programId: number, query: ProgramDetailQuery) {
    const { orgId } = u;
    const [program, reach] = await Promise.all([
      this.loadProgram(orgId, programId),
      resolveProjectReach(this.access, u),
    ]);
    const projects = await this.pageProgramProjects(orgId, programId, reach.where, {
      cursor: query.projectsCursor,
      limit: query.projectsLimit,
    });
    return { ...program, projects };
  }

  async createProgram(
    orgId: string,
    userId: string,
    input: CreateProgramInput,
  ) {
    if (input.portfolioId !== undefined && input.portfolioId !== null)
      await this.assertPortfolio(orgId, input.portfolioId);
    const [row] = await this.db
      .insert(projectPrograms)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        portfolioId: input.portfolioId ?? null,
        ownerId: input.ownerId ?? null,
        status: input.status ?? "active",
        health: input.health ?? null,
        createdBy: userId,
      })
      .returning();
    if (!row) throw new NotFoundException("Failed to create program");
    this.audit.log({
      action: "program.created",
      userId,
      orgId,
      resourceType: "project_program",
      resourceId: String(row.id),
      metadata: { programId: row.id, name: row.name },
    });
    return row;
  }

  async updateProgram(
    orgId: string,
    userId: string,
    programId: number,
    input: UpdateProgramInput,
  ) {
    await this.loadProgram(orgId, programId);
    if (input.portfolioId !== undefined && input.portfolioId !== null)
      await this.assertPortfolio(orgId, input.portfolioId);
    const patch: ProgramPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined)
      patch.description = input.description ?? null;
    if (input.portfolioId !== undefined)
      patch.portfolioId = input.portfolioId ?? null;
    if (input.ownerId !== undefined) patch.ownerId = input.ownerId ?? null;
    if (input.status !== undefined) patch.status = input.status;
    if (input.health !== undefined) patch.health = input.health ?? null;
    const [updated] = await this.db
      .update(projectPrograms)
      .set(patch)
      .where(
        and(
          eq(projectPrograms.id, programId),
          eq(projectPrograms.orgId, orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Program not found");
    this.audit.log({
      action: "program.updated",
      userId,
      orgId,
      resourceType: "project_program",
      resourceId: String(programId),
      metadata: { programId },
    });
    return updated;
  }

  async deleteProgram(orgId: string, userId: string, programId: number) {
    await this.loadProgram(orgId, programId);
    await this.db
      .update(projectPrograms)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(projectPrograms.id, programId),
          eq(projectPrograms.orgId, orgId),
        ),
      );
    this.audit.log({
      action: "program.deleted",
      userId,
      orgId,
      resourceType: "project_program",
      resourceId: String(programId),
      metadata: { programId },
    });
  }

  async linkProject(
    u: CurrentUserContext,
    programId: number,
    input: LinkProjectInput,
  ) {
    const { orgId, userId } = u;
    await this.loadProgram(orgId, programId);
    await assertCanManageProject(this.db, this.access, u, input.projectId);
    await this.db
      .insert(programProjects)
      .values({ orgId, programId, projectId: input.projectId })
      .onConflictDoNothing();
    this.audit.log({
      action: "program.project_linked",
      userId,
      orgId,
      resourceType: "project_program",
      resourceId: String(programId),
      metadata: { programId, projectId: input.projectId },
    });
    return { success: true };
  }

  async unlinkProject(
    u: CurrentUserContext,
    programId: number,
    projectId: number,
  ) {
    const { orgId, userId } = u;
    await this.loadProgram(orgId, programId);
    await assertCanManageProject(this.db, this.access, u, projectId);
    await this.db
      .delete(programProjects)
      .where(
        and(
          eq(programProjects.programId, programId),
          eq(programProjects.projectId, projectId),
          eq(programProjects.orgId, orgId),
        ),
      );
    this.audit.log({
      action: "program.project_unlinked",
      userId,
      orgId,
      resourceType: "project_program",
      resourceId: String(programId),
      metadata: { programId, projectId },
    });
  }
}
