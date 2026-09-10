import { and, eq, gte, sql } from "drizzle-orm";
import { invProductVariants, invPurchaseOrders, invStockTransactions } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { ANOMALY_WINDOWS } from "../anomalies/inv-anomaly-detectors";
import type { InsightCandidate } from "../dto/ai-insights.schemas";
import { hashAnomalyEvidence } from "./insight-detectors";

/**
 * The two insight detectors that read activity rather than stock state — late
 * purchase orders, and adjustments outside the usual range. Split out of
 * `insight-detectors.ts` so neither file sits above the 300-line ratchet.
 *
 * The cut follows the data rather than the line count: the four that stayed all
 * read `inv_stock_levels` or `inv_lots` and answer "what is on the shelf"; these
 * two read `inv_purchase_orders` and `inv_stock_transactions` and answer "what
 * has been happening".
 */
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
