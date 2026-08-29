import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  invAiInsights,
  invStockLevels,
  invStockTransactions,
  invPurchaseOrders,
  invLots,
  invProductVariants,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { availableQtySumSql } from "../stock-engine/available-sql";
import { cmpDec, isNegative, isPositive } from "../stock-engine/decimal";
import { ANOMALY_WINDOWS, INV_ANOMALY_DETECTORS } from "./anomalies/inv-anomaly-detectors";
import { anomalyVisibilityPredicate } from "./anomalies/inv-anomaly-visibility";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ListInsightsInput, UpdateInsightStatusInput, InsightCandidate } from "./dto/ai-insights.schemas";

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
function hashAnomalyEvidence(parts: readonly unknown[]): string {
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
function displayQty(value: string): string {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [whole = "0", frac = ""] = body.split(".");
  const digits = (frac + "000").slice(0, 3);
  let hundredths = BigInt(whole || "0") * 100n + BigInt(digits.slice(0, 2) || "0");
  if (Number(digits[2]) >= 5) hundredths += 1n;
  const text = `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
  return negative && hundredths !== 0n ? `-${text}` : text;
}

export type OpsBriefSeverity = "high" | "medium" | "low" | "none";

export interface OpsBriefSignal {
  key: string;
  label: string;
  /** A deterministic inventory route. Never model output. */
  href: string;
  count: number;
  severity: OpsBriefSeverity;
}

export interface InventoryOpsBrief {
  generatedAt: string;
  totalSignals: number;
  signals: OpsBriefSignal[];
}

/**
 * One row per detector. A signal with no route would be a dead end -- the
 * acceptance criterion is that every figure in the brief can be opened on the
 * screen that computed it.
 *
 * F3. The label and the route now come from the detector registry rather than
 * from a second list here. Two lists is how a detector ends up described one way
 * on the brief and another way in the queue.
 */
const OPS_BRIEF_SIGNALS = [
  INV_ANOMALY_DETECTORS.stockout_risk,
  INV_ANOMALY_DETECTORS.expiry_risk,
  INV_ANOMALY_DETECTORS.negative_stock,
  INV_ANOMALY_DETECTORS.unusual_adjustments,
  INV_ANOMALY_DETECTORS.vendor_delay,
  INV_ANOMALY_DETECTORS.dead_stock,
] as const;

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function worstSeverity(severities: readonly string[]): OpsBriefSeverity {
  let worst: OpsBriefSeverity = "none";
  let rank = 0;
  for (const severity of severities) {
    const candidate = SEVERITY_RANK[severity] ?? 0;
    if (candidate > rank) {
      rank = candidate;
      worst = severity as OpsBriefSeverity;
    }
  }
  return worst;
}

@Injectable()
export class InvAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * F3. The older insights list, now behind the same gate as the queue.
   *
   * These two routes and the anomaly queue read the same table. Before F3 the
   * queue was warehouse-scoped and this pair were not, which is the worst
   * possible arrangement: a gate a second route walks around only makes the
   * audit look better. Both now call `anomalyVisibilityPredicate`, so there is
   * one definition of who may see a finding and no second one to forget.
   */
  async listInsights(user: CurrentUserContext, filters: ListInsightsInput) {
    const { orgId, userId } = user;
    const { status, type, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const conditions = [eq(invAiInsights.orgId, orgId), anomalyVisibilityPredicate(scope)];
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
        const refs: Record<string, unknown> = e.sourceRefs ?? {};
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
        // F3. Stored on the row, not re-derived on read: what the detector
        // meant *then* survives a threshold change made later.
        warehouseId: c.warehouseId,
        windowDays: c.windowDays,
        evidenceHash: c.evidenceHash,
      })),
    );

    await this.cache.invalidate(CACHE_KEYS.invAiInsightsList(orgId));
    return { generated: newCandidates.length };
  }

  /**
   * F3. Acknowledging or dismissing through the older route.
   *
   * Two changes, and both are about the write rather than the read. The scope
   * predicate is applied to the `UPDATE` itself, so an id learned some other way
   * — a stale tab, a link from a colleague at another site — is not a capability;
   * and the actor and time are recorded, because a status with nobody's name on
   * it is a queue nobody is accountable for.
   *
   * The pre-read is gone. It was a `findFirst` followed by an id-only update,
   * which is a check that does not gate the write it precedes; the affected-row
   * count does, and it is one statement rather than two.
   */
  async updateInsightStatus(
    user: CurrentUserContext,
    insightId: number,
    body: UpdateInsightStatusInput,
  ) {
    const { orgId, userId } = user;
    const scope = await this.warehouseScope.resolve(orgId, userId);

    const [updated] = await this.db
      .update(invAiInsights)
      .set({ status: body.status, acknowledgedBy: userId, acknowledgedAt: new Date() })
      .where(
        and(
          eq(invAiInsights.id, insightId),
          eq(invAiInsights.orgId, orgId),
          anomalyVisibilityPredicate(scope),
        ),
      )
      .returning();

    // A miss is a miss, whatever caused it — wrong tenant, wrong site, or no such
    // row. §4's existence-oracle rule: the caller learns this id is not theirs
    // to act on and nothing more.
    if (!updated) throw new NotFoundException("Not found");

    await this.cache.invalidate(CACHE_KEYS.invAiInsightsList(orgId));
    return updated;
  }

  /**
   * INV-101 — the deterministic half of the Operations Brief.
   *
   * Every figure here is computed by the six detectors that already back the
   * insight engine; no model is involved and nothing is charged. That split is
   * the point: the brief renders on page load from facts, and the narrative is
   * a separate, explicit, paid request over the same numbers. A card that
   * quietly spent credits whenever somebody opened the dashboard would be a
   * bill nobody authorised.
   *
   * Each signal carries the route that answers it, so a reader can always leave
   * the summary for the deterministic screen that produced it.
   */
  async getOpsBrief(orgId: string): Promise<InventoryOpsBrief> {
    const candidates = await this.collectCandidates(orgId);

    const signals = OPS_BRIEF_SIGNALS.map((definition) => {
      const matching = candidates.filter(
        (candidate) => candidate.insightType === definition.type,
      );
      return {
        key: definition.type,
        label: definition.label,
        href: definition.href,
        count: matching.length,
        // The worst thing present, not an average: one high-severity stockout
        // is the headline even beside forty low-severity ones.
        severity: worstSeverity(matching.map((candidate) => candidate.severity)),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      totalSignals: signals.reduce((sum, signal) => sum + signal.count, 0),
      signals,
    };
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
    // F3. The window is the registry's, and the registry is what the queue
    // shows the reader. One number, so the caption cannot describe a window
    // the query did not use.
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - ANOMALY_WINDOWS.demandHistoryDays);

    const rows = await this.db
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

  private async detectDeadStock(orgId: string): Promise<InsightCandidate[]> {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - ANOMALY_WINDOWS.deadStockDays);

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
        body: `No sales or outbound movement in ${ANOMALY_WINDOWS.deadStockDays} days. Stock value: ${Math.round(parseFloat(r.value) * 100) / 100}.`,
        sourceRefs: { variantId: r.variantId, variantSku: r.variantSku, value: r.value, onHand: r.onHand },
        sourceKey: String(r.variantId),
        warehouseId: null,
        windowDays: ANOMALY_WINDOWS.deadStockDays,
        evidenceHash: hashAnomalyEvidence([r.variantId, r.onHand, r.value]),
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
      // Summed across every location the SKU sits in, so the figure is org-wide
      // even when only one site is negative — the sum is what was measured.
      warehouseId: null,
      windowDays: ANOMALY_WINDOWS.negativeStockDays,
      evidenceHash: hashAnomalyEvidence([r.variantId, r.onHand]),
    }));
  }

  private async detectUnusualAdjustments(orgId: string): Promise<InsightCandidate[]> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - ANOMALY_WINDOWS.adjustmentRecentDays);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - ANOMALY_WINDOWS.adjustmentBaselineDays);

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
      body: `${r.recentCount} adjustments in the last ${ANOMALY_WINDOWS.adjustmentRecentDays} days vs ${Math.round((r.trailingAvg ?? 0) * 10) / 10} weekly average.`,
      sourceRefs: { variantId: r.variantId, variantSku: r.variantSku, recentCount: r.recentCount, trailingAvg: r.trailingAvg },
      sourceKey: String(r.variantId),
      warehouseId: null,
      windowDays: ANOMALY_WINDOWS.adjustmentRecentDays,
      evidenceHash: hashAnomalyEvidence([r.variantId, r.recentCount, r.trailingAvg]),
    }));
  }

  private async detectExpiryRisk(orgId: string): Promise<InsightCandidate[]> {
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + ANOMALY_WINDOWS.expiryHorizonDays);
    const cutoff = horizon.toISOString().slice(0, 10);
    const urgent = new Date();
    urgent.setDate(urgent.getDate() + ANOMALY_WINDOWS.expiryUrgentDays);
    const urgentCutoff = urgent.toISOString().slice(0, 10);

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
}
