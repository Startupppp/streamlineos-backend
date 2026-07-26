import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { revenueEvents, subscriptions } from "../../db/schema";

@Injectable()
export class RevenueAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async recordEvent(data: {
    type:
      | "new_subscription"
      | "upgrade"
      | "downgrade"
      | "churn"
      | "reactivation"
      | "addon_purchase"
      | "refund";
    orgId: string;
    plan?: string;
    previousPlan?: string;
    mrr: number;
    amount?: number;
    metadata?: Record<string, unknown>;
  }) {
    await this.db.insert(revenueEvents).values({
      type: data.type,
      orgId: data.orgId,
      plan: data.plan,
      previousPlan: data.previousPlan,
      mrr: data.mrr,
      amount: data.amount,
      metadata: data.metadata,
    });
  }

  async getMetrics() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [activeCount, trialCount, churnCount, expansionResult, refundCount, newSubCount] =
      await Promise.all([
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(subscriptions)
          .where(eq(subscriptions.status, "ACTIVE")),
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(subscriptions)
          .where(eq(subscriptions.status, "TRIAL")),
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(revenueEvents)
          .where(eq(revenueEvents.type, "churn")),
        this.db
          .select({ total: sql<number>`coalesce(sum(${revenueEvents.mrr}), 0)` })
          .from(revenueEvents)
          .where(
            and(
              eq(revenueEvents.type, "upgrade"),
              gte(revenueEvents.createdAt, thirtyDaysAgo),
            ),
          ),
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(revenueEvents)
          .where(eq(revenueEvents.type, "refund")),
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(revenueEvents)
          .where(eq(revenueEvents.type, "new_subscription")),
      ]);

    const totalActive = Number(activeCount[0]?.count ?? 0);
    const totalTrial = Number(trialCount[0]?.count ?? 0);
    const totalChurn = Number(churnCount[0]?.count ?? 0);
    const totalRefunds = Number(refundCount[0]?.count ?? 0);
    const totalNewSubs = Number(newSubCount[0]?.count ?? 0);
    const expansionRevenue = Number(expansionResult[0]?.total ?? 0);

    const mrrResult = await this.db
      .select({ total: sql<number>`coalesce(sum(${revenueEvents.mrr}), 0)` })
      .from(revenueEvents)
      .innerJoin(subscriptions, eq(revenueEvents.orgId, subscriptions.orgId))
      .where(
        and(
          eq(subscriptions.status, "ACTIVE"),
          eq(revenueEvents.type, "new_subscription"),
        ),
      );

    const mrr = Number(mrrResult[0]?.total ?? 0);
    const arr = mrr * 12;
    const arpu = totalActive > 0 ? Math.round(mrr / totalActive) : 0;
    const churnRate =
      totalActive > 0 ? Math.round((totalChurn / totalActive) * 100) : 0;

    const ltv = churnRate > 0 ? Math.round(arpu / (churnRate / 100)) : arpu * 24;
    const totalEver = totalActive + totalTrial + totalChurn;
    const trialConversionRate =
      totalEver > 0 ? Math.round((totalActive / totalEver) * 100 * 10) / 10 : 0;
    const refundRate =
      totalNewSubs > 0 ? Math.round((totalRefunds / totalNewSubs) * 100 * 10) / 10 : 0;

    return {
      mrr,
      arr,
      arpu,
      churnRate,
      activeSubscriptions: totalActive,
      trialSubscriptions: totalTrial,
      ltv,
      cac: 0,
      expansionRevenue,
      trialConversionRate,
      refundRate,
    };
  }

  async getTimeSeriesData(period: string) {
    const months = period === "3m" ? 3 : period === "12m" ? 12 : 6;
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    const events = await this.db
      .select({
        type: revenueEvents.type,
        mrr: revenueEvents.mrr,
        createdAt: revenueEvents.createdAt,
      })
      .from(revenueEvents)
      .where(gte(revenueEvents.createdAt, since))
      .orderBy(revenueEvents.createdAt);

    const byMonth: Record<
      string,
      { month: string; newMrr: number; churnMrr: number; netNew: number }
    > = {};

    for (const event of events) {
      const key = event.createdAt.toISOString().slice(0, 7);
      if (!byMonth[key])
        byMonth[key] = { month: key, newMrr: 0, churnMrr: 0, netNew: 0 };
      if (
        event.type === "new_subscription" ||
        event.type === "upgrade" ||
        event.type === "reactivation"
      ) {
        byMonth[key].newMrr += event.mrr;
      }
      if (event.type === "churn" || event.type === "downgrade") {
        byMonth[key].churnMrr += event.mrr;
      }
      byMonth[key].netNew = byMonth[key].newMrr - byMonth[key].churnMrr;
    }

    return Object.values(byMonth).sort((a, b) =>
      a.month.localeCompare(b.month),
    );
  }
}
