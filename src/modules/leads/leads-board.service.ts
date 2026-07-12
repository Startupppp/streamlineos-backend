import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, asc, sql, count, gte, lte, inArray, type SQL } from "drizzle-orm";
import { leads, users, crmOptions, crmPipelines, crmPipelineStages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { pushBranchAssigneeFilter, type BranchContext } from "./branch-filter";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { resolveLeadStatusSemantics } from "./lead-status-semantics";

export type BoardOpts = { userId?: string; branch?: BranchContext; limitPerStatus?: number; scope?: DataScope };
export type StatsFilters = { dateFrom?: string; dateTo?: string; userId?: string; branch?: BranchContext; scope?: DataScope };

function pushLeadsViewScope(
  where: SQL[],
  scope: DataScope | undefined,
  userId: string | undefined,
): void {
  if (!scope) return;
  if (scope === "none") {
    where.push(sql`false`);
    return;
  }
  if (!userId) return;
  where.push(applyScope(scope, userId, { ownerColumn: leads.assignedToId }));
}

@Injectable()
export class LeadsBoardService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveLeadStatusKeys(orgId: string): Promise<string[]> {
    const defaultLeadPipeline = await this.db
      .select({ id: crmPipelines.id })
      .from(crmPipelines)
      .where(and(eq(crmPipelines.orgId, orgId), eq(crmPipelines.type, "lead"), eq(crmPipelines.isDefault, true), eq(crmPipelines.isActive, true)))
      .limit(1)
      .then((r) => r[0]);

    if (defaultLeadPipeline) {
      const stages = await this.db
        .select({ key: crmPipelineStages.key })
        .from(crmPipelineStages)
        .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.pipelineId, defaultLeadPipeline.id), eq(crmPipelineStages.isActive, true)))
        .orderBy(asc(crmPipelineStages.sortOrder));
      if (stages.length > 0) return stages.map((s) => s.key);
    }

    const options = await this.db
      .select({ key: crmOptions.key })
      .from(crmOptions)
      .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status"), eq(crmOptions.isActive, true)))
      .orderBy(asc(crmOptions.sortOrder));
    if (options.length > 0) return options.map((o) => o.key);

    const existing = await this.db
      .selectDistinct({ status: leads.status })
      .from(leads)
      .where(eq(leads.orgId, orgId));
    return existing.map((r) => r.status);
  }

  async getBoard(orgId: string, opts?: BoardOpts) {
    const baseFilters = [eq(leads.orgId, orgId)];

    if (opts?.branch) {
      await pushBranchAssigneeFilter(this.db, baseFilters, leads.assignedToId, opts.branch);
    }

    pushLeadsViewScope(baseFilters, opts?.scope, opts?.userId);

    const statusKeys = await this.resolveLeadStatusKeys(orgId);
    const limitPerStatus = opts?.limitPerStatus ?? 50;

    const columns = {
      id: leads.id,
      name: leads.name,
      email: leads.email,
      phone: leads.phone,
      company: leads.company,
      source: leads.source,
      priority: leads.priority,
      status: leads.status,
      score: leads.score,
      potentialValue: leads.potentialValue,
      slaDeadline: leads.slaDeadline,
      assignedToId: leads.assignedToId,
      createdAt: leads.createdAt,
    } as const;

    const columnResults = await Promise.all(
      statusKeys.map(async (status) => {
        const statusFilter = [...baseFilters, eq(leads.status, status)];
        const [rows, countResult] = await Promise.all([
          this.db
            .select(columns)
            .from(leads)
            .where(and(...statusFilter))
            .orderBy(desc(leads.createdAt))
            .limit(limitPerStatus),
          this.db.select({ total: count() }).from(leads).where(and(...statusFilter)),
        ]);

        const assigneeIds = [...new Set(rows.map((r) => r.assignedToId).filter((id): id is string => !!id))];
        const assigneeMap = new Map<string, { id: string; name: string | null; image: string | null }>();
        if (assigneeIds.length > 0) {
          const assignees = await this.db
            .select({ id: users.id, name: users.name, image: users.image })
            .from(users)
            .where(inArray(users.id, assigneeIds));
          for (const a of assignees) assigneeMap.set(a.id, a);
        }

        return {
          status,
          total: countResult[0]?.total ?? 0,
          leads: rows.map((r) => ({
            ...r,
            assignedTo: r.assignedToId ? (assigneeMap.get(r.assignedToId) ?? null) : null,
          })),
        };
      }),
    );

    const board: Record<string, { leads: (typeof columnResults)[0]["leads"]; total: number }> = {};
    for (const col of columnResults) {
      board[col.status] = { leads: col.leads, total: col.total };
    }

    return board;
  }

  async getStats(orgId: string, filters?: StatsFilters) {
    const statsFilters = [eq(leads.orgId, orgId)];
    if (filters?.branch) {
      await pushBranchAssigneeFilter(this.db, statsFilters, leads.assignedToId, filters.branch);
    }
    pushLeadsViewScope(statsFilters, filters?.scope, filters?.userId);

    if (filters?.dateFrom) {
      statsFilters.push(gte(leads.createdAt, new Date(filters.dateFrom)));
    }
    if (filters?.dateTo) {
      const to = new Date(filters.dateTo);
      to.setHours(23, 59, 59, 999);
      statsFilters.push(lte(leads.createdAt, to));
    }

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [statusCounts, totals, statusOptions] = await Promise.all([
      this.db
        .select({ status: leads.status, cnt: count() })
        .from(leads)
        .where(and(...statsFilters))
        .groupBy(leads.status),
      this.db
        .select({
          total: count(),
          totalPotentialValue: sql<string>`COALESCE(SUM(CAST(${leads.potentialValue} AS NUMERIC)), 0)`,
          unassigned: sql<string>`COUNT(*) FILTER (WHERE ${leads.assignedToId} IS NULL)`,
          thisMonth: sql<string>`COUNT(*) FILTER (WHERE ${leads.createdAt} >= ${thisMonthStart})`,
        })
        .from(leads)
        .where(and(...statsFilters)),
      this.db.select().from(crmOptions).where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status"))),
    ]);

    const semantics = resolveLeadStatusSemantics(statusOptions);
    const byStatusMap = new Map(statusCounts.map((r) => [r.status, Number(r.cnt)]));
    const byStatus: Record<string, number> = {};
    for (const [status, cnt] of byStatusMap) byStatus[status] = cnt;

    const convertedCount = semantics.convertedKeys.reduce((s, k) => s + (byStatusMap.get(k) ?? 0), 0);
    const aggRow = totals[0];
    const total = Number(aggRow?.total ?? 0);
    const conversionRate = total > 0 ? (convertedCount / total) * 100 : 0;

    return {
      total,
      byStatus,
      conversionRate: Math.round(conversionRate * 10) / 10,
      totalPotentialValue: Number(aggRow?.totalPotentialValue ?? 0),
      unassigned: Number(aggRow?.unassigned ?? 0),
      thisMonth: Number(aggRow?.thisMonth ?? 0),
    };
  }
}
