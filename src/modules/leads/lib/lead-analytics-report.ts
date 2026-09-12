import { and, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
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
  LEAD_PARTY_SCOPE,
  leadPartyScope,
} from "../lead-party-reader";
import { resolveLeadStatusSemantics } from "../lead-status-semantics";
import type { AnalyticsQuery } from "../dto/lead-reports.schemas";
import { type Db } from "../../../db/drizzle.module";
import type { ScopedRead } from "../../access/scoped-read";
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
/**
 * The leads a caller may see, as one predicate. The tenant, the caller's read
 * scope and the live-lead filter arrive together through the `ScopedRead`, and a
 * denied scope matches nothing; extra clauses are ANDed in. Every report in
 * `LeadsReportsService` narrows through this, so none can be handed a scope it
 * did not resolve.
 */
export function visibleLeadsWhere(read: ScopedRead, ...extra: (SQL | undefined)[]): SQL {
  return read.compose(
    {
      tenant: businessParties.organizationId,
      scope: LEAD_PARTY_SCOPE,
      and: [...leadPartyScope(read.orgId), ...extra],
    },
    (where) => where.sql,
    () => sql`false`,
  );
}

const EMPTY_LEAD_ANALYTICS = {
  totalLeads: 0,
  totalLeadsPrevPeriod: 0,
  conversionRate: 0,
  conversionRatePrevPeriod: 0,
  totalRevenue: 0,
  conversionBySource: [] as { source: string; total: number; converted: number; rate: number }[],
  monthlyRevenue: [] as { month: string; revenue: number }[],
  assignmentDistribution: [] as { userId: string; name: string; count: number }[],
};

export interface LeadAnalyticsDeps {
  readonly db: Db;
  readonly access: AccessService;
}

export async function getLeadAnalytics(
  deps: LeadAnalyticsDeps,
  read: ScopedRead,
  filters: AnalyticsQuery,
) {
  if (read.denied) return EMPTY_LEAD_ANALYTICS;
  const orgId = read.orgId;
  const where = visibleLeadsWhere(
    read,
    filters.dateFrom ? gte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateFrom)) : undefined,
    filters.dateTo
      ? lte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateTo + "T23:59:59"))
      : undefined,
  );

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  /*
    The previous period is the SAME leads, one window earlier.

    It was built from a bare `leadPartyScope(orgId)` while the current period
    carried the view scope. So a rep at `own` was shown
    their own total against the organisation's total from a month ago: the
    delta beside it was arithmetic between two different populations, and it
    disclosed the organisation's lead count to the one caller this endpoint was
    already careful not to disclose it to. A comparison figure has to narrow
    with the figure it is compared against or it is not a comparison.
  */
  const prevPeriod = visibleLeadsWhere(
    read,
    gte(LEAD_PARTY_COLUMNS.createdAt, sixtyDaysAgo),
    lte(LEAD_PARTY_COLUMNS.createdAt, thirtyDaysAgo),
  );

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
        .where(where),
      deps.db
        .select({
          total: sql<number>`COUNT(*)::int`,
          converted: sql<number>`COUNT(*) FILTER (WHERE ${convertedExpr})::int`,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(prevPeriod),
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
        .where(where)
        .groupBy(LEAD_PARTY_COLUMNS.source),
      deps.db
        .select({
          assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
          cnt: sql<number>`COUNT(*)::int`,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(where, isNotNull(LEAD_PARTY_COLUMNS.assignedToId)))
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

