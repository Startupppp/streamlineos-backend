import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  invAiInsights,
  invStockLevels,
  invStockTransactions,
  invPurchaseOrders,
  invLots,
  invProductVariants,
  invProducts,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { ListInsightsInput, UpdateInsightStatusInput, InsightCandidate } from "./dto/ai-insights.schemas";

@Injectable()
export class InvAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async listInsights(orgId: string, filters: ListInsightsInput) {
    const { status, type, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions = [eq(invAiInsights.orgId, orgId)];
    if (status) conditions.push(eq(invAiInsights.status, status));
    if (type) conditions.push(eq(invAiInsights.insightType, type));

    const where = and(...conditions);
    const [items, [countRow]] = await Promise.all([
      this.db.query.invAiInsights.findMany({
        where,
        orderBy: [desc(invAiInsights.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ total: sql<number>`count(*)::int` }).from(invAiInsights).where(where),
    ]);

    return { items, total: countRow?.total ?? 0, page, totalPages: Math.ceil((countRow?.total ?? 0) / limit) };
  }

  async generateInsights(orgId: string) {
    const candidates = await this.collectCandidates(orgId);
    const existing = await this.db.query.invAiInsights.findMany({
      where: and(eq(invAiInsights.orgId, orgId), eq(invAiInsights.status, "NEW")),
      columns: { insightType: true, sourceRefs: true },
    });

    const existingKeys = new Set<string>(
      existing.map((e) => {
        const refs = e.sourceRefs as Record<string, unknown>;
        return `${e.insightType}:${refs["_key"] ?? ""}`;
      }),
    );

    const newCandidates = candidates.filter(
      (c) => !existingKeys.has(`${c.insightType}:${c.sourceKey}`),
    );

    if (newCandidates.length === 0) return { generated: 0 };

    await this.db.insert(invAiInsights).values(
      newCandidates.map((c) => ({
        orgId,
        insightType: c.insightType,
        severity: c.severity,
        title: c.title,
        body: c.body,
        sourceRefs: { ...c.sourceRefs, _key: c.sourceKey },
        status: "NEW" as const,
      })),
    );

    await this.cache.invalidate(CACHE_KEYS.invAiInsightsList(orgId));
    return { generated: newCandidates.length };
  }

  async updateInsightStatus(orgId: string, insightId: number, body: UpdateInsightStatusInput) {
    const insight = await this.db.query.invAiInsights.findFirst({
      where: and(eq(invAiInsights.id, insightId), eq(invAiInsights.orgId, orgId)),
    });
    if (!insight) throw new NotFoundException("Insight not found");

    const [updated] = await this.db
      .update(invAiInsights)
      .set({ status: body.status })
      .where(and(eq(invAiInsights.id, insightId), eq(invAiInsights.orgId, orgId)))
      .returning();

    await this.cache.invalidate(CACHE_KEYS.invAiInsightsList(orgId));
    return updated;
  }

  private async collectCandidates(orgId: string): Promise<InsightCandidate[]> {
    const results = await Promise.allSettled([
      this.detectStockoutRisk(orgId),
      this.detectDeadStock(orgId),
      this.detectVendorDelay(orgId),
      this.detectNegativeStock(orgId),
      this.detectUnusualAdjustments(orgId),
      this.detectExpiryRisk(orgId),
    ]);

    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  private async detectStockoutRisk(orgId: string): Promise<InsightCandidate[]> {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const rows = await this.db
      .select({
        variantId: invStockLevels.productVariantId,
        variantSku: invProductVariants.sku,
        onHand: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric), 0)::text`,
        committed: sql<string>`COALESCE(SUM(${invStockLevels.committed}::numeric), 0)::text`,
        outgoing: sql<string>`COALESCE(SUM(${invStockLevels.outgoingQty}::numeric), 0)::text`,
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
      .filter((r) => {
        const available = parseFloat(r.onHand) - parseFloat(r.committed) - parseFloat(r.outgoing);
        const weekly = parseFloat(r.weeklySales);
        return weekly > 0 && available < weekly;
      })
      .map((r) => {
        const available = parseFloat(r.onHand) - parseFloat(r.committed) - parseFloat(r.outgoing);
        const weekly = parseFloat(r.weeklySales);
        return {
          insightType: "stockout_risk" as const,
          severity: available < 0 ? ("high" as const) : ("medium" as const),
          title: `Stockout risk: ${r.variantSku}`,
          body: `Available qty (${Math.round(available * 100) / 100}) is below weekly demand (${Math.round(weekly * 100) / 100}).`,
          sourceRefs: { variantId: r.variantId, variantSku: r.variantSku },
          sourceKey: String(r.variantId),
        };
      });
  }

  private async detectDeadStock(orgId: string): Promise<InsightCandidate[]> {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const rows = await this.db
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
        body: `No sales or outbound movement in 90 days. Stock value: ${Math.round(parseFloat(r.value) * 100) / 100}.`,
        sourceRefs: { variantId: r.variantId, variantSku: r.variantSku, value: r.value },
        sourceKey: String(r.variantId),
      }));
  }

  private async detectVendorDelay(orgId: string): Promise<InsightCandidate[]> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.db.query.invPurchaseOrders.findMany({
      where: and(
        eq(invPurchaseOrders.orgId, orgId),
        sql`${invPurchaseOrders.status} IN ('SENT', 'PARTIAL')`,
        sql`${invPurchaseOrders.expectedDeliveryDate} < ${today}`,
      ),
      with: { vendor: { columns: { id: true, name: true } } },
      limit: 50,
    });

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

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
      };
    });
  }

  private async detectNegativeStock(orgId: string): Promise<InsightCandidate[]> {
    const rows = await this.db
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
    }));
  }

  private async detectUnusualAdjustments(orgId: string): Promise<InsightCandidate[]> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const rows = await this.db
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
      body: `${r.recentCount} adjustments in the last 7 days vs ${Math.round((r.trailingAvg ?? 0) * 10) / 10} weekly average.`,
      sourceRefs: { variantId: r.variantId, variantSku: r.variantSku, recentCount: r.recentCount },
      sourceKey: String(r.variantId),
    }));
  }

  private async detectExpiryRisk(orgId: string): Promise<InsightCandidate[]> {
    const fourteenDaysOut = new Date();
    fourteenDaysOut.setDate(fourteenDaysOut.getDate() + 14);
    const cutoff = fourteenDaysOut.toISOString().slice(0, 10);
    const sevenDaysOut = new Date();
    sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
    const urgentCutoff = sevenDaysOut.toISOString().slice(0, 10);

    const rows = await this.db
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
      sourceRefs: { lotId: r.lotId, lotNumber: r.lotNumber, variantId: r.variantId, expiryDate: r.expiryDate, onHand: r.onHand },
      sourceKey: String(r.lotId),
    }));
  }
}
