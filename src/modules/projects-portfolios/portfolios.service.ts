import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { portfolioProjects, projectPortfolios, projectPrograms, projects } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
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
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
      .limit(1);
    if (!row) throw new BadRequestException("Project not found in org");
  }

  async listPortfolios(orgId: string, query: ListPortfoliosQuery) {
    return this.db
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
          SELECT CAST(COUNT(*) AS INT) FROM ${portfolioProjects}
          WHERE ${portfolioProjects.portfolioId} = ${projectPortfolios.id}
        )`,
      })
      .from(projectPortfolios)
      .where(
        and(
          eq(projectPortfolios.orgId, orgId),
          isNull(projectPortfolios.deletedAt),
          query.status ? eq(projectPortfolios.status, query.status) : undefined,
        ),
      )
      .limit(100);
  }

  async getPortfolio(orgId: string, portfolioId: number) {
    const portfolio = await this.loadPortfolio(orgId, portfolioId);
    const linkedProjects = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
      })
      .from(portfolioProjects)
      .innerJoin(projects, eq(projects.id, portfolioProjects.projectId))
      .where(and(eq(portfolioProjects.portfolioId, portfolioId), eq(portfolioProjects.orgId, orgId)))
      .limit(100);
    const programs = await this.db
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
      .limit(100);
    return { ...portfolio, projects: linkedProjects, programs };
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
