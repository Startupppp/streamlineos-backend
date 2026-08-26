import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  supportTickets,
  supportTicketActivity,
  supportQueues,
  automationRules,
  automationRuns,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import type { SupportReportFiltersInput } from "./dto/support.schemas";

const TICKET_TRIGGER_PREFIX = "ticket.";

export interface ScopedFilters extends SupportReportFiltersInput {
  scopeToUserId?: string;
}

@Injectable()
export class SupportReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private baseConditions(orgId: string, filters: ScopedFilters): SQL[] {
    const conditions: SQL[] = [eq(supportTickets.orgId, orgId)];
    if (filters.dateFrom) conditions.push(gte(supportTickets.createdAt, filters.dateFrom));
    if (filters.dateTo) conditions.push(lte(supportTickets.createdAt, filters.dateTo));
    if (filters.queueId) conditions.push(eq(supportTickets.queueId, filters.queueId));
    if (filters.channel) conditions.push(eq(supportTickets.sourceChannel, filters.channel));
    const agentId = filters.scopeToUserId ?? filters.agentId;
    if (agentId) conditions.push(eq(supportTickets.assigneeId, agentId));
    return conditions;
  }

  private isDefaultFilters(filters: SupportReportFiltersInput): boolean {
    return !filters.dateFrom && !filters.dateTo && !filters.agentId && !filters.queueId && !filters.channel;
  }

  async getOverview(orgId: string, filters: ScopedFilters) {
    const fetch = async () => {
      const conditions = this.baseConditions(orgId, filters);

      const [row] = await this.db
        .select({
          newTickets: sql<number>`COUNT(*)::int`,
          openTickets: sql<number>`COUNT(*) FILTER (WHERE ${supportTickets.status} IN ('OPEN', 'IN_PROGRESS', 'WAITING'))::int`,
          resolvedCount: sql<number>`COUNT(*) FILTER (WHERE ${supportTickets.resolvedAt} IS NOT NULL)::int`,
          avgFirstResponseMinutes: sql<number | null>`
            AVG(EXTRACT(EPOCH FROM (${supportTickets.firstRespondedAt} - ${supportTickets.createdAt})) / 60)
            FILTER (WHERE ${supportTickets.firstRespondedAt} IS NOT NULL)`,
          avgResolutionMinutes: sql<number | null>`
            AVG(EXTRACT(EPOCH FROM (${supportTickets.resolvedAt} - ${supportTickets.createdAt})) / 60)
            FILTER (WHERE ${supportTickets.resolvedAt} IS NOT NULL)`,
          slaEligible: sql<number>`COUNT(*) FILTER (WHERE ${supportTickets.slaDeadline} IS NOT NULL AND ${supportTickets.resolvedAt} IS NOT NULL)::int`,
          slaBreachedResolved: sql<number>`
            COUNT(*) FILTER (WHERE ${supportTickets.slaDeadline} IS NOT NULL AND ${supportTickets.resolvedAt} IS NOT NULL AND ${supportTickets.resolvedAt} > ${supportTickets.slaDeadline})::int`,
          slaBreachedOpen: sql<number>`
            COUNT(*) FILTER (WHERE ${supportTickets.slaDeadline} IS NOT NULL AND ${supportTickets.resolvedAt} IS NULL AND ${supportTickets.slaDeadline} < now())::int`,
        })
        .from(supportTickets)
        .where(and(...conditions));

      const reopenConditions: SQL[] = [eq(supportTicketActivity.orgId, orgId), eq(supportTicketActivity.action, "reopened")];
      if (filters.dateFrom) reopenConditions.push(gte(supportTicketActivity.createdAt, filters.dateFrom));
      if (filters.dateTo) reopenConditions.push(lte(supportTicketActivity.createdAt, filters.dateTo));
      const [reopenRow] = await this.db
        .select({ reopenedCount: sql<number>`COUNT(DISTINCT ${supportTicketActivity.supportTicketId})::int` })
        .from(supportTicketActivity)
        .where(and(...reopenConditions));

      const byChannel = await this.db
        .select({ channel: supportTickets.sourceChannel, count: sql<number>`COUNT(*)::int` })
        .from(supportTickets)
        .where(and(...conditions))
        .groupBy(supportTickets.sourceChannel);

      const byPriority = await this.db
        .select({ priority: supportTickets.priority, count: sql<number>`COUNT(*)::int` })
        .from(supportTickets)
        .where(and(...conditions))
        .groupBy(supportTickets.priority);

      const byCategory = await this.db
        .select({ category: supportTickets.category, count: sql<number>`COUNT(*)::int` })
        .from(supportTickets)
        .where(and(...conditions))
        .groupBy(supportTickets.category);

      const breachCount = (row?.slaBreachedResolved ?? 0) + (row?.slaBreachedOpen ?? 0);
      const slaCompliancePct =
        row && row.slaEligible > 0
          ? Math.round(((row.slaEligible - row.slaBreachedResolved) / row.slaEligible) * 1000) / 10
          : null;

      return {
        newTickets: row?.newTickets ?? 0,
        openTickets: row?.openTickets ?? 0,
        backlog: row?.openTickets ?? 0,
        avgFirstResponseMinutes: row?.avgFirstResponseMinutes ? Math.round(row.avgFirstResponseMinutes) : null,
        avgResolutionMinutes: row?.avgResolutionMinutes ? Math.round(row.avgResolutionMinutes) : null,
        slaBreachCount: breachCount,
        slaCompliancePct,
        reopenRate:
          row && row.resolvedCount > 0 ? Math.round(((reopenRow?.reopenedCount ?? 0) / row.resolvedCount) * 1000) / 10 : 0,
        ticketsByChannel: byChannel,
        ticketsByPriority: byPriority,
        ticketsByCategory: byCategory.map((r) => ({ category: r.category ?? "uncategorized", count: r.count })),
      };
    };

    if (!this.isDefaultFilters(filters) || filters.scopeToUserId) return fetch();
    return this.cache.cachedForOrg(orgId, "support:reports:overview", fetch, CACHE_TTL.SHORT);
  }

  async getAgentPerformance(orgId: string, filters: ScopedFilters) {
    const conditions = this.baseConditions(orgId, filters);
    conditions.push(sql`${supportTickets.assigneeId} IS NOT NULL`);

    return this.db
      .select({
        agentId: supportTickets.assigneeId,
        ticketsHandled: sql<number>`COUNT(*)::int`,
        ticketsResolved: sql<number>`COUNT(*) FILTER (WHERE ${supportTickets.resolvedAt} IS NOT NULL)::int`,
        avgFirstResponseMinutes: sql<number | null>`
          AVG(EXTRACT(EPOCH FROM (${supportTickets.firstRespondedAt} - ${supportTickets.createdAt})) / 60)
          FILTER (WHERE ${supportTickets.firstRespondedAt} IS NOT NULL)`,
        avgResolutionMinutes: sql<number | null>`
          AVG(EXTRACT(EPOCH FROM (${supportTickets.resolvedAt} - ${supportTickets.createdAt})) / 60)
          FILTER (WHERE ${supportTickets.resolvedAt} IS NOT NULL)`,
      })
      .from(supportTickets)
      .where(and(...conditions))
      .groupBy(supportTickets.assigneeId)
      .orderBy(sql`COUNT(*) DESC`);
  }

  async getQueuePerformance(orgId: string, filters: ScopedFilters) {
    const conditions = this.baseConditions(orgId, filters);
    conditions.push(sql`${supportTickets.queueId} IS NOT NULL`);

    const rows = await this.db
      .select({
        queueId: supportTickets.queueId,
        queueName: supportQueues.name,
        ticketsHandled: sql<number>`COUNT(*)::int`,
        openTickets: sql<number>`COUNT(*) FILTER (WHERE ${supportTickets.status} IN ('OPEN', 'IN_PROGRESS', 'WAITING'))::int`,
        avgResolutionMinutes: sql<number | null>`
          AVG(EXTRACT(EPOCH FROM (${supportTickets.resolvedAt} - ${supportTickets.createdAt})) / 60)
          FILTER (WHERE ${supportTickets.resolvedAt} IS NOT NULL)`,
      })
      .from(supportTickets)
      .leftJoin(supportQueues, eq(supportQueues.id, supportTickets.queueId))
      .where(and(...conditions))
      .groupBy(supportTickets.queueId, supportQueues.name)
      .orderBy(sql`COUNT(*) DESC`);

    return rows.map((r) => ({ ...r, queueName: r.queueName ?? "Unknown queue" }));
  }

  async getChannelPerformance(orgId: string, filters: ScopedFilters) {
    const conditions = this.baseConditions(orgId, filters);

    return this.db
      .select({
        channel: supportTickets.sourceChannel,
        ticketsHandled: sql<number>`COUNT(*)::int`,
        avgFirstResponseMinutes: sql<number | null>`
          AVG(EXTRACT(EPOCH FROM (${supportTickets.firstRespondedAt} - ${supportTickets.createdAt})) / 60)
          FILTER (WHERE ${supportTickets.firstRespondedAt} IS NOT NULL)`,
        avgResolutionMinutes: sql<number | null>`
          AVG(EXTRACT(EPOCH FROM (${supportTickets.resolvedAt} - ${supportTickets.createdAt})) / 60)
          FILTER (WHERE ${supportTickets.resolvedAt} IS NOT NULL)`,
      })
      .from(supportTickets)
      .where(and(...conditions))
      .groupBy(supportTickets.sourceChannel)
      .orderBy(sql`COUNT(*) DESC`);
  }

  async getAutomationPerformance(orgId: string, filters: SupportReportFiltersInput) {
    const conditions: SQL[] = [
      eq(automationRuns.orgId, orgId),
      sql`${automationRuns.triggerEvent} LIKE ${`${TICKET_TRIGGER_PREFIX}%`}`,
    ];
    if (filters.dateFrom) conditions.push(gte(automationRuns.createdAt, filters.dateFrom));
    if (filters.dateTo) conditions.push(lte(automationRuns.createdAt, filters.dateTo));

    const rows = await this.db
      .select({
        ruleId: automationRuns.ruleId,
        ruleName: automationRules.name,
        total: sql<number>`COUNT(*)::int`,
        succeeded: sql<number>`COUNT(*) FILTER (WHERE ${automationRuns.status} = 'success')::int`,
        failed: sql<number>`COUNT(*) FILTER (WHERE ${automationRuns.status} = 'failed')::int`,
        skipped: sql<number>`COUNT(*) FILTER (WHERE ${automationRuns.status} = 'skipped')::int`,
      })
      .from(automationRuns)
      .leftJoin(automationRules, eq(automationRules.id, automationRuns.ruleId))
      .where(and(...conditions))
      .groupBy(automationRuns.ruleId, automationRules.name)
      .orderBy(sql`COUNT(*) DESC`);

    return rows.map((r) => ({ ...r, ruleName: r.ruleName ?? "Deleted automation" }));
  }
}
