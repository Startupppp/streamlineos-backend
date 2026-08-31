import { Inject, Injectable } from "@nestjs/common";
import { eq, gte, sql, desc, and, isNull, type SQL } from "drizzle-orm";
import {
  platformVisits,
  platformPayments,
  platformMessages,
  organizations,
  organizationMembers,
  users,
} from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { PARTY_OF_LEAD } from "../crm/crm-party-reads";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

const DAY_MS = 24 * 60 * 60 * 1000;
const inr = (paise: number) => Math.round(paise / 100);

@Injectable()
export class PlatformAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private countLeadParties(...conditions: SQL[]) {
    return this.db
      .select({ n: sql<number>`count(distinct ${businessParties.partyId})::int` })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(and(isNull(businessParties.deletedAt), ...conditions));
  }

  async getDashboardMetrics() {
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * DAY_MS);
    const since7d = new Date(now.getTime() - 7 * DAY_MS);

    const [
      totalCustomers,
      activeCustomers,
      totalUsers,
      totalMessages,
      unreadMessages,
      totalLeads,
      newLeads7d,
      visits30d,
      uniqueVisits30d,
      revenue30d,
      revenueLifetime,
      txCount,
      visitsByDayRows,
      revenueByMonthRows,
    ] = await Promise.all([
      this.db.select({ n: sql<number>`count(*)::int` }).from(organizations).then((r) => r[0]?.n ?? 0),
      this.db
        .select({ n: sql<number>`count(distinct ${organizationMembers.orgId})::int` })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(gte(users.updatedAt, since30d))
        .then((r) => r[0]?.n ?? 0)
        .catch(() => 0),
      this.db.select({ n: sql<number>`count(*)::int` }).from(users).then((r) => r[0]?.n ?? 0),
      this.db.select({ n: sql<number>`count(*)::int` }).from(platformMessages).then((r) => r[0]?.n ?? 0),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformMessages)
        .where(eq(platformMessages.status, "NEW"))
        .then((r) => r[0]?.n ?? 0),
      this.countLeadParties().then((r) => r[0]?.n ?? 0),
      this.countLeadParties(gte(businessParties.createdAt, since7d)).then((r) => r[0]?.n ?? 0),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .then((r) => r[0]?.n ?? 0),
      this.db
        .select({ n: sql<number>`count(distinct ${platformVisits.sessionToken})::int` })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .then((r) => r[0]?.n ?? 0),
      this.db
        .select({ sum: sql<number>`coalesce(sum(${platformPayments.amount}), 0)::int` })
        .from(platformPayments)
        .where(and(eq(platformPayments.status, "captured"), gte(platformPayments.createdAt, since30d)))
        .then((r) => r[0]?.sum ?? 0),
      this.db
        .select({ sum: sql<number>`coalesce(sum(${platformPayments.amount}), 0)::int` })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .then((r) => r[0]?.sum ?? 0),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .then((r) => r[0]?.n ?? 0),
      this.db
        .select({
          date: sql<string>`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .groupBy(sql`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`),
      this.db
        .select({
          month: sql<string>`to_char(${platformPayments.createdAt}, 'YYYY-MM')`,
          amount: sql<number>`coalesce(sum(${platformPayments.amount}), 0)::int`,
        })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .groupBy(sql`to_char(${platformPayments.createdAt}, 'YYYY-MM')`)
        .orderBy(sql`to_char(${platformPayments.createdAt}, 'YYYY-MM')`),
    ]);

    return {
      customers: { total: totalCustomers, activeLast30d: activeCustomers },
      users: { total: totalUsers },
      messages: { total: totalMessages, unread: unreadMessages },
      leads: { total: totalLeads, newLast7d: newLeads7d },
      visits: { last30d: visits30d, uniqueLast30d: uniqueVisits30d },
      revenue: {
        last30dInr: inr(revenue30d),
        lifetimeInr: inr(revenueLifetime),
        transactions: txCount,
      },
      series: {
        visitsByDay: visitsByDayRows,
        revenueByMonth: revenueByMonthRows.map((r) => ({ month: r.month, amount: inr(r.amount) })),
      },
    };
  }

  async getRevenueSummary() {
    const [byStatus, byMonth, byMethod] = await Promise.all([
      this.db
        .select({
          status: platformPayments.status,
          count: sql<number>`count(*)::int`,
          total: sql<number>`coalesce(sum(${platformPayments.amount})::int / 100, 0)`,
        })
        .from(platformPayments)
        .groupBy(platformPayments.status),
      this.db
        .select({
          month: sql<string>`to_char(${platformPayments.createdAt}, 'YYYY-MM')`,
          amount: sql<number>`coalesce(sum(${platformPayments.amount})::int / 100, 0)`,
        })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .groupBy(sql`to_char(${platformPayments.createdAt}, 'YYYY-MM')`)
        .orderBy(sql`to_char(${platformPayments.createdAt}, 'YYYY-MM')`),
      this.db
        .select({
          method: sql<string>`coalesce(${platformPayments.method}, 'unknown')`,
          count: sql<number>`count(*)::int`,
        })
        .from(platformPayments)
        .where(eq(platformPayments.status, "captured"))
        .groupBy(platformPayments.method),
    ]);
    return { byStatus, byMonth, byMethod };
  }

  async getVisitorAnalytics() {
    const since30d = new Date(Date.now() - 30 * DAY_MS);

    const [byDay, topPaths, topReferrers, recent] = await Promise.all([
      this.db
        .select({
          date: sql<string>`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`,
          visits: sql<number>`count(*)::int`,
          unique: sql<number>`count(distinct ${platformVisits.sessionToken})::int`,
        })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .groupBy(sql`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${platformVisits.createdAt}, 'YYYY-MM-DD')`),
      this.db
        .select({ path: platformVisits.path, visits: sql<number>`count(*)::int` })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .groupBy(platformVisits.path)
        .orderBy(desc(sql`count(*)`))
        .limit(10),
      this.db
        .select({ referrer: platformVisits.referrer, visits: sql<number>`count(*)::int` })
        .from(platformVisits)
        .where(gte(platformVisits.createdAt, since30d))
        .groupBy(platformVisits.referrer)
        .orderBy(desc(sql`count(*)`))
        .limit(10),
      this.db
        .select({
          path: platformVisits.path,
          referrer: platformVisits.referrer,
          country: platformVisits.country,
          userAgent: platformVisits.userAgent,
          createdAt: platformVisits.createdAt,
        })
        .from(platformVisits)
        .orderBy(desc(platformVisits.createdAt))
        .limit(50),
    ]);

    return { byDay, topPaths, topReferrers, recent };
  }
}
