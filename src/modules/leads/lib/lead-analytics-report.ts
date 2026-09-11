import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  deals,
  users,
  crmOptions,
  crmPipelineStages,
} from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
  pushLeadPartyViewScope,
} from "../lead-party-reader";
import { resolveLeadStatusSemantics } from "../lead-status-semantics";
import type { AnalyticsQuery } from "../dto/lead-reports.schemas";
import { type Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";

/**
 * The funnel report, which is not the same kind of thing as the rest of the file
 * it came from.
 *
 * `LeadsReportsService` is otherwise a set of cached aggregates over leads and
 * lead activities: each one takes an org id, groups a single table and is served
 * from `cachedVersioned`. This one is the exception on every axis. It is the only
 * report that is deliberately **not** cached, because it is the only one that
 * takes a caller `DataScope` — a cached answer would be one user's view of the
 * funnel handed to the next. It is the only one that reads `deals` at all, since
 * revenue lives there and not on the lead. And it is the only one that consults
 * `AccessService`, because the assignment distribution must name only the people
 * who may see leads, so a rep's workload is not disclosed to someone who cannot
 * open a lead in the first place.
 *
 * Those three facts are the seam, and they were being read through a hundred and
 * sixty lines that sat between two one-line cached reports.
 *
 * A deps bag and a free function rather than a second `@Injectable`: the DI graph
 * and every caller are unchanged, and `LeadsReportsService.getLeadAnalytics`
 * still exists as the entry point the controller and the tenant-isolation spec
 * both drive.
 */
export interface LeadAnalyticsDeps {
  readonly db: Db;
  readonly access: AccessService;
}

export async function getLeadAnalytics(
  deps: LeadAnalyticsDeps,
  orgId: string,
  filters: AnalyticsQuery,
  viewScope?: { scope: DataScope; userId: string },
) {
  const f = leadPartyScope(orgId);
  pushLeadPartyViewScope(f, orgId, viewScope?.scope, viewScope?.userId);
  if (filters.dateFrom)
    f.push(gte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateFrom)));
  if (filters.dateTo)
    f.push(lte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateTo + "T23:59:59")));

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const statusOptions = await deps.db
    .select()
    .from(crmOptions)
    .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
  const semantics = resolveLeadStatusSemantics(statusOptions);

  const convertedExpr =
    semantics.convertedKeys.length > 0
      ? sql`${LEAD_PARTY_COLUMNS.status} = ANY(ARRAY[${sql.join(
          semantics.convertedKeys.map((k) => sql`${k}`),
          sql`, `,
        )}])`
      : sql`false`;

  const [totalsRows, prevPeriodRows, wonStages, sourceRows, assignRows, permittedMembers] =
    await Promise.all([
      deps.db
        .select({
          total: sql<number>`COUNT(*)::int`,
          converted: sql<number>`COUNT(*) FILTER (WHERE ${convertedExpr})::int`,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...f)),
      deps.db
        .select({
          total: sql<number>`COUNT(*)::int`,
          converted: sql<number>`COUNT(*) FILTER (WHERE ${convertedExpr})::int`,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(
          and(
            ...leadPartyScope(orgId),
            gte(LEAD_PARTY_COLUMNS.createdAt, sixtyDaysAgo),
            lte(LEAD_PARTY_COLUMNS.createdAt, thirtyDaysAgo),
          ),
        ),
      deps.db
        .select({ key: crmPipelineStages.key })
        .from(crmPipelineStages)
        .where(
          and(
            eq(crmPipelineStages.orgId, orgId),
            eq(crmPipelineStages.stageType, "won"),
          ),
        ),
      deps.db
        .select({
          source: LEAD_PARTY_COLUMNS.source,
          total: sql<number>`COUNT(*)::int`,
          converted: sql<number>`COUNT(*) FILTER (WHERE ${convertedExpr})::int`,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...f))
        .groupBy(LEAD_PARTY_COLUMNS.source),
      deps.db
        .select({
          assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
          cnt: sql<number>`COUNT(*)::int`,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...f, isNotNull(LEAD_PARTY_COLUMNS.assignedToId)))
        .groupBy(LEAD_PARTY_COLUMNS.assignedToId),
      deps.access.membersWithPermission(orgId, "crm:leads:view"),
    ]);

  const permittedUserIds = permittedMembers.map((m) => m.userId);
  const salesUsers = permittedUserIds.length > 0
    ? await deps.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, permittedUserIds))
    : [];

  const totalLeads = totalsRows[0]?.total ?? 0;
  const converted = totalsRows[0]?.converted ?? 0;
  const conversionRate =
    totalLeads > 0 ? Math.round((converted / totalLeads) * 100) : 0;

  const prevTotal = prevPeriodRows[0]?.total ?? 0;
  const prevConverted = prevPeriodRows[0]?.converted ?? 0;
  const prevConversionRate =
    prevTotal > 0 ? Math.round((prevConverted / prevTotal) * 100) : 0;

  const wonStageKeys = wonStages.length ? wonStages.map((s) => s.key) : ["WON"];

  const [revenueRow, wonDeals] = await Promise.all([
    deps.db
      .select({
        totalRevenue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
      })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, wonStageKeys)))
      .then((r) => r[0]),
    deps.db
      .select({ value: deals.value, createdAt: deals.createdAt })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, wonStageKeys))),
  ]);

  const totalRevenue = revenueRow?.totalRevenue ?? 0;

  const conversionBySource: {
    source: string;
    total: number;
    converted: number;
    rate: number;
  }[] = sourceRows.map((r) => ({
    source: r.source.replace(/_/g, " "),
    total: r.total,
    converted: r.converted,
    rate: r.total > 0 ? Math.round((r.converted / r.total) * 100) : 0,
  }));

  const monthMap = new Map<string, number>();
  for (const d of wonDeals) {
    const date = d.createdAt;
    if (!date) continue;
    const m = new Date(date);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
    monthMap.set(key, (monthMap.get(key) ?? 0) + Number(d.value ?? 0));
  }
  const monthlyRevenue = [...monthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6)
    .map(([month, revenue]) => ({ month, revenue }));

  const assignMap = new Map<string, number>();
  for (const row of assignRows) {
    if (row.assignedToId) assignMap.set(row.assignedToId, row.cnt);
  }
  const assignmentDistribution = salesUsers.map((u) => ({
    userId: u.id,
    name: u.name ?? "Unknown",
    count: assignMap.get(u.id) ?? 0,
  }));

  return {
    totalLeads,
    totalLeadsPrevPeriod: prevTotal,
    conversionRate,
    conversionRatePrevPeriod: prevConversionRate,
    totalRevenue,
    conversionBySource,
    monthlyRevenue,
    assignmentDistribution,
  };
}

