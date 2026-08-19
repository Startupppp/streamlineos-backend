import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  portfolioProjects,
  projectDailySnapshots,
  projectPortfolios,
  projectPrograms,
  projects,
  projectStatuses,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
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

  // Resolves open/done ticket counts for a set of project IDs.
  // Primary path reads the latest daily snapshot (maintained by the nightly sweep).
  // Projects created since the last sweep have no snapshot row yet; those fall back
  // to a live aggregate so we never silently report 0 for a real project.
  // Cancelled tickets are excluded from open (terminal, but not done).
  private async resolveProjectCounts(
    orgId: string,
    projectIds: number[],
  ): Promise<Map<number, { openCount: number; doneCount: number }>> {
    const snapshotRows = await this.db
      .select({
        projectId: projectDailySnapshots.projectId,
        openCount: sql<number>`COALESCE(SUM(CASE WHEN ${projectDailySnapshots.stateGroup} IN ('backlog', 'unstarted', 'started') THEN ${projectDailySnapshots.count} ELSE 0 END), 0)::int`,
        doneCount: sql<number>`COALESCE(SUM(CASE WHEN ${projectDailySnapshots.stateGroup} = 'completed' THEN ${projectDailySnapshots.count} ELSE 0 END), 0)::int`,
      })
      .from(projectDailySnapshots)
      .where(
        and(
          eq(projectDailySnapshots.orgId, orgId),
          inArray(projectDailySnapshots.projectId, projectIds),
          sql`${projectDailySnapshots.snapshotDate} = (
            SELECT MAX(s2.snapshot_date)
            FROM build.project_daily_snapshots s2
            WHERE s2.project_id = ${projectDailySnapshots.projectId}
          )`,
        ),
      )
      .groupBy(projectDailySnapshots.projectId);

    const countsMap = new Map<number, { openCount: number; doneCount: number }>();
    for (const row of snapshotRows)
      countsMap.set(row.projectId, { openCount: row.openCount, doneCount: row.doneCount });

    const unsnapshottedIds = projectIds.filter((id) => !countsMap.has(id));
    if (unsnapshottedIds.length > 0) {
      const liveRows = await this.db
        .select({
          projectId: tickets.projectId,
          openCount: sql<number>`COALESCE(SUM(CASE WHEN ${projectStatuses.type} IN ('backlog', 'unstarted', 'started') THEN 1 ELSE 0 END), 0)::int`,
          doneCount: sql<number>`COALESCE(SUM(CASE WHEN ${projectStatuses.type} = 'completed' THEN 1 ELSE 0 END), 0)::int`,
        })
        .from(tickets)
        .innerJoin(
          projectStatuses,
          and(
            eq(tickets.orgId, projectStatuses.orgId),
            eq(tickets.projectId, projectStatuses.projectId),
            eq(tickets.status, projectStatuses.name),
          ),
        )
        .where(
          and(
            eq(tickets.orgId, orgId),
            inArray(tickets.projectId, unsnapshottedIds),
            isNull(tickets.deletedAt),
          ),
        )
        .groupBy(tickets.projectId);

      for (const r of liveRows) {
        if (r.projectId !== null)
          countsMap.set(r.projectId, { openCount: r.openCount, doneCount: r.doneCount });
      }
    }

    return countsMap;
  }

  async listPortfolios(orgId: string, query: ListPortfoliosQuery) {
    const { page, limit, status } = query;
    const offset = (page - 1) * limit;
    const conditions = and(
      eq(projectPortfolios.orgId, orgId),
      isNull(projectPortfolios.deletedAt),
      status ? eq(projectPortfolios.status, status) : undefined,
    );
    const [rows, [totalRow]] = await Promise.all([
      this.db
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
        .where(conditions)
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(projectPortfolios).where(conditions),
    ]);
    const total = Number(totalRow?.total ?? 0);
    return {
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
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
        .where(and(eq(portfolioProjects.portfolioId, portfolioId), eq(portfolioProjects.orgId, orgId)))
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
    const countsMap = await this.resolveProjectCounts(orgId, projectIds);

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
