import { and, asc, eq, gte, sql } from "drizzle-orm";
import {
  invProductVariants,
  invProducts,
  invStockLevels,
  invStockTransactions,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { addDec } from "../../stock-engine/decimal";
import { fromExact } from "../forecast/exact";
import type { ForecastingInput } from "../dto/replenishment.schemas";

/**
 * The replenishment forecast, split out of `replenishment-reads.ts` so neither
 * file sits above the 300-line ratchet. A forecast and a reorder suggestion are
 * different questions — one projects demand forward, the other says what to buy
 * now — so this is the seam that was already there rather than an arbitrary cut.
 */
export async function getForecasting(
  db: Db,
  orgId: string,
  filters: ForecastingInput,
) {
    const { variantId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const stockQuery = db
      .select({
        variantId: invStockLevels.productVariantId,
        onHand: sql<string>`SUM(${invStockLevels.onHand}::numeric)::text`,
        onOrder: sql<string>`SUM(${invStockLevels.onOrder}::numeric)::text`,
        variantSku: invProductVariants.sku,
        variantName: invProductVariants.name,
        productName: invProducts.name,
      })
      .from(invStockLevels)
      .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
      .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
      .where(and(eq(invStockLevels.orgId, orgId), variantId != null ? eq(invStockLevels.productVariantId, variantId) : undefined))
      .groupBy(invStockLevels.productVariantId, invProductVariants.id, invProducts.id)
      .orderBy(asc(invProductVariants.sku), asc(invStockLevels.productVariantId))
      .limit(limit)
      .offset(offset);

    const salesQuery = db
      .select({
        variantId: invStockTransactions.productVariantId,
        weekStart: sql<string>`date_trunc('week', ${invStockTransactions.createdAt})::text`,
        weeklyQty: sql<string>`SUM(ABS(${invStockTransactions.quantityChange}::numeric))::text`,
      })
      .from(invStockTransactions)
      .where(
        and(
          eq(invStockTransactions.orgId, orgId),
          eq(invStockTransactions.transactionType, "SALE"),
          gte(invStockTransactions.createdAt, ninetyDaysAgo),
          variantId != null ? eq(invStockTransactions.productVariantId, variantId) : undefined,
        ),
      )
      .groupBy(invStockTransactions.productVariantId, sql`date_trunc('week', ${invStockTransactions.createdAt})`);

    const [stockRows, salesRows, [countRow]] = await Promise.all([
      stockQuery,
      salesQuery,
      db
        .select({ total: sql<number>`count(distinct ${invStockLevels.productVariantId})::int` })
        .from(invStockLevels)
        .where(and(eq(invStockLevels.orgId, orgId), variantId != null ? eq(invStockLevels.productVariantId, variantId) : undefined)),
    ]);

    const salesByVariant = new Map<number, number[]>();
    for (const s of salesRows) {
      const list = salesByVariant.get(s.variantId) ?? [];
      // A weekly demand figure feeding an average: a statistic, so it crosses
      // into a float here, once, by the named boundary.
      list.push(fromExact(s.weeklyQty));
      salesByVariant.set(s.variantId, list);
    }

    const items = stockRows.map((row) => {
      const weeklySales = salesByVariant.get(row.variantId) ?? [];
      const avgWeeklyDemand =
        weeklySales.length > 0 ? weeklySales.reduce((a, b) => a + b, 0) / weeklySales.length : 0;
      // Exact ledger quantities. `available` here is deliberately the *future*
      // position — on hand plus on order — and not availability-to-promise;
      // `availableQtySql` answers the other question.
      const onHand = row.onHand;
      const onOrder = row.onOrder;
      const position = addDec(onHand, onOrder);
      const positionValue = fromExact(position);
      // Projections are estimates, not quantities anybody owns, so they stay in
      // floating point and are labelled as projections.
      const projectedWeeks = [1, 2, 3, 4].map((w) => ({
        week: w,
        projectedDemand: Math.round(avgWeeklyDemand * w * 100) / 100,
        projectedStock:
          Math.round(Math.max(0, positionValue - avgWeeklyDemand * w) * 100) / 100,
      }));
      const weeksOfStock = avgWeeklyDemand > 0 ? positionValue / avgWeeklyDemand : null;
      const stockoutRisk = weeksOfStock != null ? (weeksOfStock < 2 ? "HIGH" : weeksOfStock < 4 ? "MEDIUM" : "LOW") : "NONE";

      return {
        variantId: row.variantId,
        variantSku: row.variantSku,
        variantName: row.variantName,
        productName: row.productName,
        onHand,
        onOrder,
        avgWeeklyDemand: Math.round(avgWeeklyDemand * 100) / 100,
        weeksOfStock: weeksOfStock != null ? Math.round(weeksOfStock * 100) / 100 : null,
        stockoutRisk,
        projectedWeeks,
      };
    });

    return { items, total: countRow?.total ?? 0, page, totalPages: Math.ceil((countRow?.total ?? 0) / limit) };
  }
