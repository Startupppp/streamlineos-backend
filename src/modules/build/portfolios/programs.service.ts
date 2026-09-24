import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
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
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
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

@Injectable()
export class ProgramsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
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

  private async assertProject(orgId: string, projectId: number): Promise<void> {
    const [row] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.orgId, orgId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new BadRequestException("Project not found in org");
  }

  async listPrograms(orgId: string, query: ListProgramsQuery) {
    const program = alias(projectPrograms, "program");
    const { cursor, limit } = query;
    const pos = decodeCursor(cursor);
    const conds = [
      eq(program.orgId, orgId),
      isNull(program.deletedAt),
      query.status ? eq(program.status, query.status) : undefined,
      query.portfolioId ? eq(program.portfolioId, query.portfolioId) : undefined,
    ];
    if (pos) conds.push(keysetBeforeId(program.createdAt, program.id, pos));

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
        projectCount: sql<number>`(
          SELECT CAST(COUNT(*) AS INT)
          FROM ${programProjects} link
          INNER JOIN ${projects} linked_project ON linked_project.id = link.project_id
            AND linked_project.org_id = link.org_id
            AND linked_project.deleted_at IS NULL
          WHERE link.program_id = program.id
            AND link.org_id = program.org_id
        )`,
      })
      .from(program)
      .where(and(...conds))
      .orderBy(desc(program.createdAt), desc(program.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
  }

  private async pageProgramProjects(
    orgId: string,
    programId: number,
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

  async getProgram(orgId: string, programId: number, query: ProgramDetailQuery) {
    const program = await this.loadProgram(orgId, programId);
    const projects = await this.pageProgramProjects(orgId, programId, {
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
    orgId: string,
    userId: string,
    programId: number,
    input: LinkProjectInput,
  ) {
    await this.loadProgram(orgId, programId);
    await this.assertProject(orgId, input.projectId);
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
    orgId: string,
    userId: string,
    programId: number,
    projectId: number,
  ) {
    await this.loadProgram(orgId, programId);
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
