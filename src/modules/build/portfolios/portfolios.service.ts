import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  portfolioProjects,
  projectPortfolios,
  projectPrograms,
  projects,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { resolveProjectCounts } from "./portfolio-project-counts";
import type {
  CreatePortfolioInput,
  LinkProjectInput,
  ListPortfoliosQuery,
  UpdatePortfolioInput,
} from "./dto/portfolios.schemas";

type PortfolioRow = typeof projectPortfolios.$inferSelect;
type PortfolioPatch = Partial<typeof projectPortfolios.$inferInsert>;

@Injectable()
export class PortfoliosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async loadPortfolio(orgId: string, portfolioId: number): Promise<PortfolioRow> {
    const [row] = await this.db
      .select()
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
    return row;
  }

  private async assertProject(orgId: string, projectId: number): Promise<void> {
    const [row] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!row) throw new BadRequestException("Project not found in org");
  }

  async listPortfolios(orgId: string, query: ListPortfoliosQuery) {
    const { cursor, limit, status } = query;
    const pos = decodeCursor(cursor);
    const conds = [
      eq(projectPortfolios.orgId, orgId),
      isNull(projectPortfolios.deletedAt),
      status ? eq(projectPortfolios.status, status) : undefined,
    ];
    if (pos) conds.push(keysetBeforeId(projectPortfolios.createdAt, projectPortfolios.id, pos));

    const rows = await this.db
      .select({
        id: projectPortfolios.id,
        orgId: projectPortfolios.orgId,
        name: projectPortfolios.name,
        description: projectPortfolios.description,
        ownerId: projectPortfolios.ownerId,
        status: projectPortfolios.status,
        health: projectPortfolios.health,
        strategicGoal: projectPortfolios.strategicGoal,
        createdBy: projectPortfolios.createdBy,
        createdAt: projectPortfolios.createdAt,
        updatedAt: projectPortfolios.updatedAt,
        projectCount: sql<number>`(
          SELECT CAST(COUNT(*) AS INT)
          FROM ${portfolioProjects}
          INNER JOIN ${projects} ON ${projects.id} = ${portfolioProjects.projectId}
            AND ${projects.deletedAt} IS NULL
          WHERE ${portfolioProjects.portfolioId} = ${projectPortfolios.id}
        )`,
      })
      .from(projectPortfolios)
      .where(and(...conds))
      .orderBy(desc(projectPortfolios.createdAt), desc(projectPortfolios.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
  }

  async getPortfolio(orgId: string, portfolioId: number) {
    const portfolio = await this.loadPortfolio(orgId, portfolioId);

    const [linkedProjects, programs] = await Promise.all([
      this.db
        .select({
          id: projects.id,
          name: projects.name,
          key: projects.key,
          status: projects.status,
        })
        .from(portfolioProjects)
        .innerJoin(projects, eq(projects.id, portfolioProjects.projectId))
        .where(and(
          eq(portfolioProjects.portfolioId, portfolioId),
          eq(portfolioProjects.orgId, orgId),
          isNull(projects.deletedAt),
        ))
        .limit(100),
      this.db
        .select({
          id: projectPrograms.id,
          name: projectPrograms.name,
          status: projectPrograms.status,
        })
        .from(projectPrograms)
        .where(
          and(
            eq(projectPrograms.portfolioId, portfolioId),
            eq(projectPrograms.orgId, orgId),
            isNull(projectPrograms.deletedAt),
          ),
        )
        .limit(100),
    ]);

    if (linkedProjects.length === 0)
      return { ...portfolio, projects: [], programs };

    const projectIds = linkedProjects.map((p) => p.id);
    const countsMap = await resolveProjectCounts(this.db, orgId, projectIds);

    return {
      ...portfolio,
      projects: linkedProjects.map((p) => ({
        ...p,
        openCount: countsMap.get(p.id)?.openCount ?? 0,
        doneCount: countsMap.get(p.id)?.doneCount ?? 0,
      })),
      programs,
    };
  }

  async createPortfolio(orgId: string, userId: string, input: CreatePortfolioInput) {
    const [row] = await this.db
      .insert(projectPortfolios)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        ownerId: input.ownerId ?? null,
        status: input.status ?? "active",
        health: input.health ?? null,
        strategicGoal: input.strategicGoal ?? null,
        createdBy: userId,
      })
      .returning();
    if (!row) throw new NotFoundException("Failed to create portfolio");
    this.audit.log({
      action: "portfolio.created",
      userId,
      orgId,
      resourceType: "project_portfolio",
      resourceId: String(row.id),
      metadata: { portfolioId: row.id, name: row.name },
    });
    return row;
  }

  async updatePortfolio(orgId: string, userId: string, portfolioId: number, input: UpdatePortfolioInput) {
    await this.loadPortfolio(orgId, portfolioId);
    const patch: PortfolioPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.ownerId !== undefined) patch.ownerId = input.ownerId ?? null;
    if (input.status !== undefined) patch.status = input.status;
    if (input.health !== undefined) patch.health = input.health ?? null;
    if (input.strategicGoal !== undefined) patch.strategicGoal = input.strategicGoal ?? null;
    const [updated] = await this.db
      .update(projectPortfolios)
      .set(patch)
      .where(and(eq(projectPortfolios.id, portfolioId), eq(projectPortfolios.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Portfolio not found");
    this.audit.log({
      action: "portfolio.updated",
      userId,
      orgId,
      resourceType: "project_portfolio",
      resourceId: String(portfolioId),
      metadata: { portfolioId },
    });
    return updated;
  }

  async deletePortfolio(orgId: string, userId: string, portfolioId: number) {
    await this.loadPortfolio(orgId, portfolioId);
    await this.db
      .update(projectPortfolios)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectPortfolios.id, portfolioId), eq(projectPortfolios.orgId, orgId)));
    this.audit.log({
      action: "portfolio.deleted",
      userId,
      orgId,
      resourceType: "project_portfolio",
      resourceId: String(portfolioId),
      metadata: { portfolioId },
    });
  }

  async linkProject(orgId: string, userId: string, portfolioId: number, input: LinkProjectInput) {
    await this.loadPortfolio(orgId, portfolioId);
    await this.assertProject(orgId, input.projectId);
    await this.db
      .insert(portfolioProjects)
      .values({ orgId, portfolioId, projectId: input.projectId })
      .onConflictDoNothing();
    this.audit.log({
      action: "portfolio.project_linked",
      userId,
      orgId,
      resourceType: "project_portfolio",
      resourceId: String(portfolioId),
      metadata: { portfolioId, projectId: input.projectId },
    });
    return { success: true };
  }

  async unlinkProject(orgId: string, userId: string, portfolioId: number, projectId: number) {
    await this.loadPortfolio(orgId, portfolioId);
    await this.db
      .delete(portfolioProjects)
      .where(
        and(
          eq(portfolioProjects.portfolioId, portfolioId),
          eq(portfolioProjects.projectId, projectId),
          eq(portfolioProjects.orgId, orgId),
        ),
      );
    this.audit.log({
      action: "portfolio.project_unlinked",
      userId,
      orgId,
      resourceType: "project_portfolio",
      resourceId: String(portfolioId),
      metadata: { portfolioId, projectId },
    });
  }
}
