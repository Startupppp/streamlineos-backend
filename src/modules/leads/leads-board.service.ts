import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, asc, sql, count, gte, lte, inArray } from "drizzle-orm";
import { users, crmOptions, crmPipelines, crmPipelineStages } from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { DataScope } from "../access/access.types";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
  pushLeadPartyViewScope,
} from "./lead-party-reader";
import { resolveLeadStatusSemantics } from "./lead-status-semantics";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";

export type BoardOpts = { userId?: string; limitPerStatus?: number; scope?: DataScope };
export type StatsFilters = { dateFrom?: string; dateTo?: string; userId?: string; scope?: DataScope };

@Injectable()
export class LeadsBoardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private async resolveLeadStatusKeys(orgId: string): Promise<string[]> {
    return this.cache.cachedVersioned(`leads:${orgId}`, "status-keys", async () => {
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
        .select({ status: LEAD_PARTY_COLUMNS.status })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...leadPartyScope(orgId)))
        .groupBy(LEAD_PARTY_COLUMNS.status);
      return existing.map((r) => r.status);
    }, CACHE_TTL.MEDIUM);
  }

  async getBoard(orgId: string, opts?: BoardOpts) {
    const hash = Buffer.from(JSON.stringify(opts ?? {})).toString("base64");

    return this.cache.cachedVersioned(`leads:${orgId}`, `board:${hash}`, async () => {
      const baseFilters = leadPartyScope(orgId);

      pushLeadPartyViewScope(baseFilters, orgId, opts?.scope, opts?.userId);

      const statusKeys = await this.resolveLeadStatusKeys(orgId);
      const limitPerStatus = opts?.limitPerStatus ?? 50;

      const columns = {
        id: LEAD_PARTY_COLUMNS.id,
        name: LEAD_PARTY_COLUMNS.name,
        email: LEAD_PARTY_COLUMNS.email,
        phone: LEAD_PARTY_COLUMNS.phone,
        company: LEAD_PARTY_COLUMNS.company,
        source: LEAD_PARTY_COLUMNS.source,
        priority: LEAD_PARTY_COLUMNS.priority,
        status: LEAD_PARTY_COLUMNS.status,
        score: LEAD_PARTY_COLUMNS.score,
        potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
        slaDeadline: LEAD_PARTY_COLUMNS.slaDeadline,
        assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
        createdAt: LEAD_PARTY_COLUMNS.createdAt,
      } as const;

      const perStatusResults = await Promise.all(
        statusKeys.map(async (status) => {
          const statusFilter = [...baseFilters, eq(LEAD_PARTY_COLUMNS.status, status)];
          const raw = await this.db
            .select({ ...columns, _total: sql<string>`count(*) OVER ()` })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(and(...statusFilter))
            // Newest first, and the lead id to break a tie: a column capped at
            // `limitPerStatus` must cut the same place twice or the board
            // shuffles between refreshes.
            .orderBy(desc(LEAD_PARTY_COLUMNS.createdAt), desc(LEAD_PARTY_COLUMNS.id))
            .limit(limitPerStatus);
          const total = raw.length > 0 ? Number(raw[0]._total) : 0;
          const rows = raw.map(({ _total, ...r }) => r);
          return { status, rows, total };
        }),
      );

      const allAssigneeIds = [
        ...new Set(
          perStatusResults.flatMap((col) =>
            col.rows.map((r) => r.assignedToId).filter((id): id is string => !!id),
          ),
        ),
      ];

      const assigneeMap = new Map<string, { id: string; name: string | null; image: string | null }>();
      if (allAssigneeIds.length > 0) {
        const assignees = await this.db
          .select({ id: users.id, name: users.name, image: users.image })
          .from(users)
          .where(inArray(users.id, allAssigneeIds));
        for (const a of assignees) assigneeMap.set(a.id, a);
      }

      const board: Record<string, { leads: Array<Omit<(typeof perStatusResults)[0]["rows"][0], "assignedToId"> & { assignedTo: { id: string; name: string | null; image: string | null } | null }>; total: number }> = {};
      for (const col of perStatusResults) {
        board[col.status] = {
          total: col.total,
          leads: col.rows.map((r) => ({
            ...r,
            assignedTo: r.assignedToId ? (assigneeMap.get(r.assignedToId) ?? null) : null,
          })),
        };
      }

      return board;
    }, CACHE_TTL.SHORT);
  }

  async getStats(orgId: string, filters?: StatsFilters) {
    const statsFilters = leadPartyScope(orgId);
    pushLeadPartyViewScope(statsFilters, orgId, filters?.scope, filters?.userId);

    if (filters?.dateFrom) {
      statsFilters.push(gte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateFrom)));
    }
    if (filters?.dateTo) {
      const to = new Date(filters.dateTo);
      to.setHours(23, 59, 59, 999);
      statsFilters.push(lte(LEAD_PARTY_COLUMNS.createdAt, to));
    }

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [statusCounts, totals, statusOptions] = await Promise.all([
      this.db
        .select({ status: LEAD_PARTY_COLUMNS.status, cnt: count() })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...statsFilters))
        .groupBy(LEAD_PARTY_COLUMNS.status),
      this.db
        .select({
          total: count(),
          totalPotentialValue: sql<string>`COALESCE(SUM(CAST(${LEAD_PARTY_COLUMNS.potentialValue} AS NUMERIC)), 0)`,
          unassigned: sql<string>`COUNT(*) FILTER (WHERE ${LEAD_PARTY_COLUMNS.assignedToId} IS NULL)`,
          thisMonth: sql<string>`COUNT(*) FILTER (WHERE ${LEAD_PARTY_COLUMNS.createdAt} >= ${thisMonthStart.toISOString()})`,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
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
