import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, ilike, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  portfolioProjects,
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
  decodeCursor,
} from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { resolveProjectCounts } from "./portfolio-project-counts";
import { assertCanManageProject, escapeLike, resolveProjectReach } from "../core";
import { reachableProjectIdsSql } from "./reachable-linked-projects";
import type {
  CreatePortfolioInput,
  LinkedProjectsQuery,
  LinkProjectInput,
  ListPortfoliosQuery,
  PortfolioDetailQuery,
  UpdatePortfolioInput,
} from "./dto/portfolios.schemas";

type PortfolioRow = typeof projectPortfolios.$inferSelect;
type PortfolioPatch = Partial<typeof projectPortfolios.$inferInsert>;

@Injectable()
export class PortfoliosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private async loadPortfolio(
    orgId: string,
    portfolioId: number,
  ): Promise<PortfolioRow> {
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

  async listPortfolios(u: CurrentUserContext, query: ListPortfoliosQuery) {
    const { orgId } = u;
    const reach = await resolveProjectReach(this.access, u);
    const portfolio = alias(projectPortfolios, "portfolio");
    const { cursor, limit, q, status, sort } = query;
    const pos = decodeCursor(cursor);
    if (cursor !== undefined && pos === null) {
      throw new BadRequestException("Invalid pagination cursor");
    }
    const conds = [
      eq(portfolio.orgId, orgId),
      isNull(portfolio.deletedAt),
      q ? ilike(portfolio.name, `${escapeLike(q)}%`) : undefined,
      status ? eq(portfolio.status, status) : undefined,
    ];
    if (pos) {
      if (sort === "name") {
        conds.push(keysetBeforeId(portfolio.updatedAt, portfolio.id, pos));
      } else {
        conds.push(keysetBeforeId(portfolio.createdAt, portfolio.id, pos));
      }
    }

    const orderBy =
      sort === "updatedAt"
        ? [desc(portfolio.updatedAt), desc(portfolio.id)]
        : sort === "name"
          ? [asc(portfolio.name), asc(portfolio.id)]
          : [desc(portfolio.createdAt), desc(portfolio.id)];

    const rows = await this.db
      .select({
        id: portfolio.id,
        orgId: portfolio.orgId,
        name: portfolio.name,
        description: portfolio.description,
        ownerId: portfolio.ownerId,
        status: portfolio.status,
        health: portfolio.health,
        strategicGoal: portfolio.strategicGoal,
        createdBy: portfolio.createdBy,
        createdAt: portfolio.createdAt,
        updatedAt: portfolio.updatedAt,
        projectCount: sql<number>`(
          SELECT CAST(COUNT(*) AS INT)
          FROM ${portfolioProjects} link
          INNER JOIN ${projects} linked_project ON linked_project.id = link.project_id
            AND linked_project.org_id = link.org_id
            AND linked_project.deleted_at IS NULL
          WHERE link.portfolio_id = portfolio.id
            AND link.org_id = portfolio.org_id
            AND link.project_id IN ${reachableProjectIdsSql(orgId, reach.where)}
        )`,
      })
      .from(portfolio)
      .where(and(...conds))
      .orderBy(...orderBy)
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
  }

  private async pagePortfolioProjects(
    orgId: string,
    portfolioId: number,
    reach: SQL,
    query: LinkedProjectsQuery,
  ) {
    const { cursor, limit } = query;
    const pos = decodeCursor(cursor);
    if (cursor !== undefined && pos === null) {
      throw new BadRequestException("Invalid pagination cursor");
    }
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
        addedAt: portfolioProjects.createdAt,
      })
      .from(portfolioProjects)
      .innerJoin(
        projects,
        and(
          eq(projects.id, portfolioProjects.projectId),
          eq(projects.orgId, portfolioProjects.orgId),
        ),
      )
      .where(
        and(
          eq(portfolioProjects.portfolioId, portfolioId),
          eq(portfolioProjects.orgId, orgId),
          isNull(projects.deletedAt),
          reach,
          pos ? keysetBeforeId(portfolioProjects.createdAt, projects.id, pos) : undefined,
        ),
      )
      .orderBy(desc(portfolioProjects.createdAt), desc(projects.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.addedAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));

    if (page.data.length === 0) return { data: [], pagination: page.pagination };

    const countsMap = await resolveProjectCounts(
      this.db,
      orgId,
      page.data.map((p) => p.id),
    );

    return {
      data: page.data.map(({ addedAt: _addedAt, ...p }) => ({
        ...p,
        openCount: countsMap.get(p.id)?.openCount ?? 0,
        doneCount: countsMap.get(p.id)?.doneCount ?? 0,
      })),
      pagination: page.pagination,
    };
  }

  private async pagePortfolioPrograms(
    orgId: string,
    portfolioId: number,
    query: LinkedProjectsQuery,
  ) {
    const { cursor, limit } = query;
    const pos = decodeCursor(cursor);
    if (cursor !== undefined && pos === null) {
      throw new BadRequestException("Invalid pagination cursor");
    }
    const rows = await this.db
      .select({
        id: projectPrograms.id,
        name: projectPrograms.name,
        status: projectPrograms.status,
        createdAt: projectPrograms.createdAt,
      })
      .from(projectPrograms)
      .where(
        and(
          eq(projectPrograms.portfolioId, portfolioId),
          eq(projectPrograms.orgId, orgId),
          isNull(projectPrograms.deletedAt),
          pos ? keysetBeforeId(projectPrograms.createdAt, projectPrograms.id, pos) : undefined,
        ),
      )
      .orderBy(desc(projectPrograms.createdAt), desc(projectPrograms.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));

    return {
      data: page.data.map(({ createdAt: _createdAt, ...p }) => p),
      pagination: page.pagination,
    };
  }

  async getPortfolio(u: CurrentUserContext, portfolioId: number, query: PortfolioDetailQuery) {
    const { orgId } = u;
    const [portfolio, reach] = await Promise.all([
      this.loadPortfolio(orgId, portfolioId),
      resolveProjectReach(this.access, u),
    ]);
    const [projects, programs] = await Promise.all([
      this.pagePortfolioProjects(orgId, portfolioId, reach.where, {
        cursor: query.projectsCursor,
        limit: query.projectsLimit,
      }),
      this.pagePortfolioPrograms(orgId, portfolioId, {
        cursor: query.programsCursor,
        limit: query.programsLimit,
      }),
    ]);
    return { ...portfolio, projects, programs };
  }

  async createPortfolio(
    orgId: string,
    userId: string,
    input: CreatePortfolioInput,
  ) {
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

  async updatePortfolio(
    orgId: string,
    userId: string,
    portfolioId: number,
    input: UpdatePortfolioInput,
  ) {
    await this.loadPortfolio(orgId, portfolioId);
    const patch: PortfolioPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined)
      patch.description = input.description ?? null;
    if (input.ownerId !== undefined) patch.ownerId = input.ownerId ?? null;
    if (input.status !== undefined) patch.status = input.status;
    if (input.health !== undefined) patch.health = input.health ?? null;
    if (input.strategicGoal !== undefined)
      patch.strategicGoal = input.strategicGoal ?? null;
    const [updated] = await this.db
      .update(projectPortfolios)
      .set(patch)
      .where(
        and(
          eq(projectPortfolios.id, portfolioId),
          eq(projectPortfolios.orgId, orgId),
        ),
      )
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
      .where(
        and(
          eq(projectPortfolios.id, portfolioId),
          eq(projectPortfolios.orgId, orgId),
        ),
      );
    this.audit.log({
      action: "portfolio.deleted",
      userId,
      orgId,
      resourceType: "project_portfolio",
      resourceId: String(portfolioId),
      metadata: { portfolioId },
    });
  }

  async linkProject(
    u: CurrentUserContext,
    portfolioId: number,
    input: LinkProjectInput,
  ) {
    const { orgId, userId } = u;
    await this.loadPortfolio(orgId, portfolioId);
    await assertCanManageProject(this.db, this.access, u, input.projectId);
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

  async unlinkProject(
    u: CurrentUserContext,
    portfolioId: number,
    projectId: number,
  ) {
    const { orgId, userId } = u;
    await this.loadPortfolio(orgId, portfolioId);
    await assertCanManageProject(this.db, this.access, u, projectId);
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
