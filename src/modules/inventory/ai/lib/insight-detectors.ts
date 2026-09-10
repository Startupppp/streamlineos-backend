import { createHash } from "node:crypto";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  invLots,
  invProductVariants,
  invPurchaseOrders,
  invStockLevels,
  invStockTransactions,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { availableQtySumSql } from "../../stock-engine/available-sql";
import { cmpDec, isNegative, isPositive } from "../../stock-engine/decimal";
import { ANOMALY_WINDOWS } from "../anomalies/inv-anomaly-detectors";
import type { InsightCandidate } from "../dto/ai-insights.schemas";

/**
 * F3. The fingerprint of the figures a finding was raised on.
 *
 * A finding is a claim about a moment. Between raising "SKU-7 is short" and a
 * human reading it, a receipt can land and the claim can stop being true — and
 * the row would still read exactly the same. Hashing the material figures at
 * detection time is what lets the queue answer "is this still true?" without
 * re-running the detector, and it is what makes F6's `STALE` verdict a
 * different fact from `WRONG` rather than a shade of it.
 *
 * Only figures that would change the decision go in. A cosmetic field would
 * make every finding look stale the moment a product was renamed, and an alarm
 * that cries wolf gets clicked through.
 */
export function hashAnomalyEvidence(parts: readonly unknown[]): string {
  return createHash("sha256")
    .update(parts.map((value) => String(value ?? "")).join("|"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Two decimal places for a sentence a human reads, rounded half-up on the
 * digits rather than through `Math.round(x * 100) / 100`. Quantities reach here
 * as exact 18,4 decimal strings and there is no reason to put one through a
 * float on the way to a paragraph.
 */
export function displayQty(value: string): string {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [whole = "0", frac = ""] = body.split(".");
  const digits = (frac + "000").slice(0, 3);
  let hundredths = BigInt(whole || "0") * 100n + BigInt(digits.slice(0, 2) || "0");
  if (Number(digits[2]) >= 5) hundredths += 1n;
  const text = `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
  return negative && hundredths !== 0n ? `-${text}` : text;
}

/**
 * The six candidate detectors behind the inventory insight queue, lifted out of
 * `inv-ai.service.ts` unchanged.
 *
 * Every one was private, used `this.db` and nothing else, and had no caller
 * outside that service — `collectCandidates` calls exactly these six. The db
 * handle arrives as a parameter; the service keeps the queue, the cache and the
 * status lifecycle.
 */
export async function detectStockoutRisk(db: Db, orgId: string): Promise<InsightCandidate[]> {
    const ninetyDaysAgo = new Date();
    // F3. The window is the registry's, and the registry is what the queue
    // shows the reader. One number, so the caption cannot describe a window
    // the query did not use.
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - ANOMALY_WINDOWS.demandHistoryDays);

    const rows = await db
      .select({
        variantId: invStockLevels.productVariantId,
        variantSku: invProductVariants.sku,
        // A1. This used to be `parseFloat(onHand) - parseFloat(committed) -
        // parseFloat(outgoing)`: three of the five terms, no transit gate, and
        // float arithmetic on 18,4 ledger quantities. It is the engine's
        // expression now, summed in Postgres and read out as an exact decimal.
        available: sql<string>`${availableQtySumSql("inv_stock_levels")}::text`,
        weeklySales: sql<string>`COALESCE((
          SELECT SUM(ABS(t.quantity_change::numeric)) / 13.0
          FROM inv_stock_transactions t
          WHERE t.org_id = ${orgId}
            AND t.product_variant_id = ${invStockLevels.productVariantId}
            AND t.transaction_type = 'SALE'
            AND t.created_at >= ${ninetyDaysAgo.toISOString()}
        ), 0)::text`,
      })
      .from(invStockLevels)
      .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
      .where(eq(invStockLevels.orgId, orgId))
      .groupBy(invStockLevels.productVariantId, invProductVariants.id);

    return rows
      // Exact decimal comparison, not float: `0.1 + 0.2 > 0.3` decides whether
      // an operator is told a SKU is about to run out.
      .filter((r) => isPositive(r.weeklySales) && cmpDec(r.available, r.weeklySales) < 0)
      .map((r) => ({
        insightType: "stockout_risk" as const,
        severity: isNegative(r.available) ? ("high" as const) : ("medium" as const),
        title: `Stockout risk: ${r.variantSku}`,
        body: `Available qty (${displayQty(r.available)}) is below weekly demand (${displayQty(r.weeklySales)}).`,
        sourceRefs: {
          variantId: r.variantId,
          variantSku: r.variantSku,
          available: r.available,
          weeklySales: r.weeklySales,
        },
        sourceKey: String(r.variantId),
        // The demand series is summed across every site, so this figure belongs
        // to the organisation and not to a warehouse. Saying so is what keeps it
        // out of a site operator's queue.
        warehouseId: null,
        windowDays: ANOMALY_WINDOWS.demandHistoryDays,
        evidenceHash: hashAnomalyEvidence([r.variantId, r.available, r.weeklySales]),
      }));
  }

export async function detectDeadStock(db: Db, orgId: string): Promise<InsightCandidate[]> {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - ANOMALY_WINDOWS.deadStockDays);

    const rows = await db
      .select({
        variantId: invStockLevels.productVariantId,
        variantSku: invProductVariants.sku,
        onHand: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric), 0)::text`,
        value: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric * NULLIF(${invStockLevels.averageCost}::numeric, 0)), 0)::text`,
      })
      .from(invStockLevels)
      .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
      .where(
        and(
          eq(invStockLevels.orgId, orgId),
          sql`${invStockLevels.onHand}::numeric > 0`,
          sql`NOT EXISTS (
            SELECT 1 FROM inv_stock_transactions t
            WHERE t.org_id = ${orgId}
              AND t.product_variant_id = ${invStockLevels.productVariantId}
              AND t.transaction_type IN ('SALE', 'TRANSFER_OUT')
              AND t.created_at >= ${ninetyDaysAgo.toISOString()}
          )`,
        ),
      )
      .groupBy(invStockLevels.productVariantId, invProductVariants.id);

    return rows
      .filter((r) => parseFloat(r.value) > 0)
      .map((r) => ({
        insightType: "dead_stock" as const,
        severity: "medium" as const,
        title: `Dead stock: ${r.variantSku}`,
        body: `No sales or outbound movement in ${ANOMALY_WINDOWS.deadStockDays} days. Stock value: ${Math.round(parseFloat(r.value) * 100) / 100}.`,
        sourceRefs: { variantId: r.variantId, variantSku: r.variantSku, value: r.value, onHand: r.onHand },
        sourceKey: String(r.variantId),
        warehouseId: null,
        windowDays: ANOMALY_WINDOWS.deadStockDays,
        evidenceHash: hashAnomalyEvidence([r.variantId, r.onHand, r.value]),
      }));
  }

export async function detectVendorDelay(db: Db, orgId: string): Promise<InsightCandidate[]> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.query.invPurchaseOrders.findMany({
      where: and(
        eq(invPurchaseOrders.orgId, orgId),
        sql`${invPurchaseOrders.status} IN ('SENT', 'PARTIAL')`,
        sql`${invPurchaseOrders.expectedDeliveryDate} < ${today}`,
      ),
      with: { vendor: { columns: { id: true, name: true } } },
      limit: 50,
    });

    return rows.map((po) => {
      const expectedDate = po.expectedDeliveryDate ? new Date(po.expectedDeliveryDate) : null;
      const daysDelayed = expectedDate ? Math.floor((Date.now() - expectedDate.getTime()) / 86400000) : 0;
      return {
        insightType: "vendor_delay" as const,
        severity: daysDelayed > 7 ? ("high" as const) : ("medium" as const),
        title: `Vendor delay: PO ${po.poNumber}`,
        body: `PO ${po.poNumber} from ${po.vendor.name} is ${daysDelayed} day(s) past expected delivery.`,
        sourceRefs: { poId: po.id, poNumber: po.poNumber, vendorId: po.vendorId, vendorName: po.vendor.name, daysDelayed },
        sourceKey: String(po.id),
        // F3. A purchase order names exactly one destination, so this finding
        // does belong to a site and a site operator should see it.
        warehouseId: po.warehouseId ?? null,
        windowDays: ANOMALY_WINDOWS.vendorDelayDays,
        evidenceHash: hashAnomalyEvidence([po.id, po.status, po.expectedDeliveryDate]),
      };
    });
  }

export async function detectNegativeStock(db: Db, orgId: string): Promise<InsightCandidate[]> {
    const rows = await db
      .select({
        variantId: invStockLevels.productVariantId,
        variantSku: invProductVariants.sku,
        onHand: sql<string>`SUM(${invStockLevels.onHand}::numeric)::text`,
      })
      .from(invStockLevels)
      .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
      .where(and(eq(invStockLevels.orgId, orgId), sql`${invStockLevels.onHand}::numeric < 0`))
      .groupBy(invStockLevels.productVariantId, invProductVariants.id);

    return rows.map((r) => ({
      insightType: "negative_stock" as const,
      severity: "high" as const,
      title: `Negative stock: ${r.variantSku}`,
      body: `Stock on hand is negative (${r.onHand}). Investigate overselling or missing receipts.`,
      sourceRefs: { variantId: r.variantId, variantSku: r.variantSku, onHand: r.onHand },
      sourceKey: String(r.variantId),
      // Summed across every location the SKU sits in, so the figure is org-wide
      // even when only one site is negative — the sum is what was measured.
      warehouseId: null,
      windowDays: ANOMALY_WINDOWS.negativeStockDays,
      evidenceHash: hashAnomalyEvidence([r.variantId, r.onHand]),
    }));
  }

export async function detectUnusualAdjustments(db: Db, orgId: string): Promise<InsightCandidate[]> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - ANOMALY_WINDOWS.adjustmentRecentDays);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - ANOMALY_WINDOWS.adjustmentBaselineDays);

    const rows = await db
      .select({
        variantId: invStockTransactions.productVariantId,
        variantSku: invProductVariants.sku,
        recentCount: sql<number>`COUNT(*) FILTER (WHERE ${invStockTransactions.createdAt} >= ${sevenDaysAgo.toISOString()})::int`,
        trailingAvg: sql<number>`(COUNT(*) FILTER (WHERE ${invStockTransactions.createdAt} < ${sevenDaysAgo.toISOString()} AND ${invStockTransactions.createdAt} >= ${thirtyDaysAgo.toISOString()})::float / 3.0)`,
      })
      .from(invStockTransactions)
      .innerJoin(invProductVariants, eq(invStockTransactions.productVariantId, invProductVariants.id))
      .where(
        and(
          eq(invStockTransactions.orgId, orgId),
          sql`${invStockTransactions.transactionType} IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT')`,
          gte(invStockTransactions.createdAt, thirtyDaysAgo),
        ),
      )
      .groupBy(invStockTransactions.productVariantId, invProductVariants.id)
      .having(sql`COUNT(*) FILTER (WHERE ${invStockTransactions.createdAt} >= ${sevenDaysAgo.toISOString()}) > 3 * (COUNT(*) FILTER (WHERE ${invStockTransactions.createdAt} < ${sevenDaysAgo.toISOString()} AND ${invStockTransactions.createdAt} >= ${thirtyDaysAgo.toISOString()})::float / 3.0)`);

    return rows.map((r) => ({
      insightType: "unusual_adjustments" as const,
      severity: "medium" as const,
      title: `Unusual adjustments: ${r.variantSku}`,
      body: `${r.recentCount} adjustments in the last ${ANOMALY_WINDOWS.adjustmentRecentDays} days vs ${Math.round((r.trailingAvg ?? 0) * 10) / 10} weekly average.`,
      sourceRefs: { variantId: r.variantId, variantSku: r.variantSku, recentCount: r.recentCount, trailingAvg: r.trailingAvg },
      sourceKey: String(r.variantId),
      warehouseId: null,
      windowDays: ANOMALY_WINDOWS.adjustmentRecentDays,
      evidenceHash: hashAnomalyEvidence([r.variantId, r.recentCount, r.trailingAvg]),
    }));
  }

export async function detectExpiryRisk(db: Db, orgId: string): Promise<InsightCandidate[]> {
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + ANOMALY_WINDOWS.expiryHorizonDays);
    const cutoff = horizon.toISOString().slice(0, 10);
    const urgent = new Date();
    urgent.setDate(urgent.getDate() + ANOMALY_WINDOWS.expiryUrgentDays);
    const urgentCutoff = urgent.toISOString().slice(0, 10);

    const rows = await db
      .select({
        lotId: invLots.id,
        lotNumber: invLots.lotNumber,
        expiryDate: invLots.expiryDate,
        variantSku: invProductVariants.sku,
        variantId: invLots.productVariantId,
        onHand: sql<string>`COALESCE((
          SELECT SUM(sl.on_hand::numeric)
          FROM inv_stock_levels sl
          WHERE sl.lot_id = ${invLots.id} AND sl.org_id = ${orgId}
        ), 0)::text`,
        /**
         * F3. The site, but only when there is exactly one.
         *
         * A lot's stock can sit in several warehouses, and attributing the whole
         * quantity to one of them would put a figure on a site it was not
         * computed for. `NULL` when it spans sites is the honest answer, and the
         * queue reads that as org-wide information.
         */
        soleWarehouseId: sql<number | null>`(
          SELECT CASE WHEN COUNT(DISTINCT loc.warehouse_id) = 1
                      THEN MIN(loc.warehouse_id) END
          FROM inv_stock_levels sl
          JOIN inv_locations loc ON loc.id = sl.location_id
          WHERE sl.lot_id = ${invLots.id}
            AND sl.org_id = ${orgId}
            AND sl.on_hand::numeric > 0
        )`,
      })
      .from(invLots)
      .innerJoin(invProductVariants, eq(invLots.productVariantId, invProductVariants.id))
      .where(
        and(
          eq(invLots.orgId, orgId),
          lte(invLots.expiryDate, cutoff),
          sql`(SELECT COALESCE(SUM(sl.on_hand::numeric), 0) FROM inv_stock_levels sl WHERE sl.lot_id = ${invLots.id} AND sl.org_id = ${orgId}) > 0`,
        ),
      )
      .limit(50);

    return rows.map((r) => ({
      insightType: "expiry_risk" as const,
      severity: (r.expiryDate ?? "") <= urgentCutoff ? ("high" as const) : ("medium" as const),
      title: `Expiry risk: ${r.variantSku} lot ${r.lotNumber}`,
      body: `Lot ${r.lotNumber} (${r.variantSku}) expires on ${r.expiryDate} with ${r.onHand} units remaining.`,
      sourceRefs: {
        lotId: r.lotId,
        lotNumber: r.lotNumber,
        variantId: r.variantId,
        expiryDate: r.expiryDate,
        onHand: r.onHand,
        warehouseId: r.soleWarehouseId ?? null,
      },
      sourceKey: String(r.lotId),
      warehouseId: r.soleWarehouseId ?? null,
      windowDays: ANOMALY_WINDOWS.expiryHorizonDays,
      evidenceHash: hashAnomalyEvidence([r.lotId, r.expiryDate, r.onHand]),
    }));
  }
