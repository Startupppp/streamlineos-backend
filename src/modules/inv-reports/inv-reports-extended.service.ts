import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  invStockLevels,
  invProducts,
  invProductVariants,
  invShipments,
  invLots,
  invReorderRules,
  invAiInsights,
  invChannelStockPublications,
  invQualityInspections,
  invStockReservations,
  invLocations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { ValuationReportInput, SlowMovingQueryInput, ExpiryReportInput } from "./dto/inv-reports.schemas";

@Injectable()
export class InvReportsExtendedService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getDashboardExtras(orgId: string) {
    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysOut = new Date();
    thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
    const thirtyDaysCutoff = thirtyDaysOut.toISOString().slice(0, 10);

    const results = await Promise.allSettled([
      this.db
        .select({ total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric * NULLIF(${invStockLevels.averageCost}::numeric, 0)), 0)::text` })
        .from(invStockLevels)
        .where(eq(invStockLevels.orgId, orgId))
        .then((r) => parseFloat(r[0]?.total ?? "0")),

      this.db
        .select({ count: sql<number>`count(distinct ${invLots.id})::int` })
        .from(invLots)
        .where(
          and(
            eq(invLots.orgId, orgId),
            lte(invLots.expiryDate, thirtyDaysCutoff),
            sql`(SELECT COALESCE(SUM(sl.on_hand::numeric), 0) FROM inv_stock_levels sl WHERE sl.lot_id = ${invLots.id} AND sl.org_id = ${orgId}) > 0`,
          ),
        )
        .then((r) => r[0]?.count ?? 0),

      this.db
        .select({ total: sql<string>`COALESCE(SUM(${invStockLevels.qualityHoldQty}::numeric), 0)::text` })
        .from(invStockLevels)
        .where(eq(invStockLevels.orgId, orgId))
        .then((r) => parseFloat(r[0]?.total ?? "0")),

      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockReservations)
        .where(and(eq(invStockReservations.orgId, orgId), eq(invStockReservations.status, "ACTIVE")))
        .then((r) => r[0]?.count ?? 0),

      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invShipments)
        .where(
          and(
            eq(invShipments.orgId, orgId),
            sql`${invShipments.status} NOT IN ('SHIPPED', 'DELIVERED', 'CANCELLED')`,
          ),
        )
        .then((r) => r[0]?.count ?? 0),

      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invChannelStockPublications)
        .where(and(eq(invChannelStockPublications.orgId, orgId), eq(invChannelStockPublications.status, "FAILED")))
        .then((r) => r[0]?.count ?? 0),

      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invQualityInspections)
        .where(
          and(
            eq(invQualityInspections.orgId, orgId),
            sql`${invQualityInspections.status} IN ('PENDING', 'IN_PROGRESS')`,
          ),
        )
        .then((r) => r[0]?.count ?? 0),

      this.db.query.invAiInsights.findMany({
        where: and(eq(invAiInsights.orgId, orgId), eq(invAiInsights.status, "NEW")),
        orderBy: [desc(invAiInsights.createdAt)],
        limit: 3,
      }),
    ]);

    const get = <T>(result: PromiseSettledResult<T>, fallback: T): T =>
      result.status === "fulfilled" ? result.value : fallback;

    return {
      stockValue: get(results[0], 0),
      expiringLotsCount: get(results[1], 0),
      qualityHoldQty: get(results[2], 0),
      activeReservationsCount: get(results[3], 0),
      openShipmentsCount: get(results[4], 0),
      failedChannelSyncsCount: get(results[5], 0),
      openInspectionsCount: get(results[6], 0),
      recentInsights: get(results[7], []),
    };
  }

  async getValuationReport(orgId: string, filters: ValuationReportInput) {
    const { warehouseId, categoryId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const cacheKey = CACHE_KEYS.invValuationReport(orgId, `${warehouseId ?? "all"}-${categoryId ?? "all"}-${page}-${limit}`);

    return this.cache.cached(
      cacheKey,
      async () => {
        const conditions = [eq(invStockLevels.orgId, orgId)];
        if (warehouseId != null) {
          conditions.push(
            inArray(
              invStockLevels.locationId,
              this.db.select({ id: invLocations.id }).from(invLocations).where(eq(invLocations.warehouseId, warehouseId)),
            ),
          );
        }
        if (categoryId != null) {
          conditions.push(
            inArray(
              invStockLevels.productVariantId,
              this.db
                .select({ id: invProductVariants.id })
                .from(invProductVariants)
                .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
                .where(eq(invProducts.categoryId, categoryId)),
            ),
          );
        }

        const [rows, [countRow]] = await Promise.all([
          this.db
            .select({
              productVariantId: invStockLevels.productVariantId,
              variantSku: invProductVariants.sku,
              variantName: invProductVariants.name,
              productName: invProducts.name,
              costingMethod: invProducts.costingMethod,
              standardCost: invProducts.standardCost,
              onHand: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric), 0)::text`,
              avgCost: sql<string>`COALESCE(AVG(NULLIF(${invStockLevels.averageCost}::numeric, 0)), 0)::text`,
              fifoValue: sql<string>`COALESCE((
                SELECT SUM(vl.remaining_value::numeric)
                FROM inv_valuation_layers vl
                WHERE vl.org_id = ${orgId} AND vl.product_variant_id = ${invStockLevels.productVariantId}
                  AND vl.remaining_quantity::numeric > 0
              ), 0)::text`,
            })
            .from(invStockLevels)
            .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
            .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
            .where(and(...conditions))
            .groupBy(invStockLevels.productVariantId, invProductVariants.id, invProducts.id)
            .orderBy(invProductVariants.sku)
            .limit(limit)
            .offset(offset),
          this.db
            .select({ total: sql<number>`count(distinct ${invStockLevels.productVariantId})::int` })
            .from(invStockLevels)
            .where(and(...conditions)),
        ]);

        const items = rows.map((r) => {
          const onHand = parseFloat(r.onHand);
          let value: number;
          if (r.costingMethod === "FIFO") {
            value = parseFloat(r.fifoValue);
          } else if (r.costingMethod === "STANDARD") {
            value = onHand * parseFloat(r.standardCost ?? "0");
          } else {
            value = onHand * parseFloat(r.avgCost);
          }
          return { ...r, onHand, value: Math.round(value * 100) / 100 };
        });

        const total = countRow?.total ?? 0;
        return { items, total, page, totalPages: Math.ceil(total / limit) };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getSlowMovingReport(orgId: string, filters: SlowMovingQueryInput) {
    const { days, page, limit } = filters;
    const offset = (page - 1) * limit;
    const cacheKey = CACHE_KEYS.invSlowMovingReport(orgId, `${days}-${page}-${limit}`);

    return this.cache.cached(
      cacheKey,
      async () => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const rows = await this.db
          .select({
            productVariantId: invStockLevels.productVariantId,
            variantSku: invProductVariants.sku,
            variantName: invProductVariants.name,
            productName: invProducts.name,
            onHand: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric), 0)::text`,
            averageCost: sql<string>`COALESCE(AVG(NULLIF(${invStockLevels.averageCost}::numeric, 0)), 0)::text`,
            lastMovement: sql<string | null>`(
              SELECT MAX(t.created_at)::text
              FROM inv_stock_transactions t
              WHERE t.org_id = ${orgId}
                AND t.product_variant_id = ${invStockLevels.productVariantId}
                AND t.transaction_type IN ('SALE', 'TRANSFER_OUT')
            )`,
            daysSinceLastMovement: sql<number | null>`
              EXTRACT(DAY FROM (NOW() - (
                SELECT MAX(t.created_at)
                FROM inv_stock_transactions t
                WHERE t.org_id = ${orgId}
                  AND t.product_variant_id = ${invStockLevels.productVariantId}
                  AND t.transaction_type IN ('SALE', 'TRANSFER_OUT')
              )))::int
            `,
          })
          .from(invStockLevels)
          .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
          .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
          .where(
            and(
              eq(invStockLevels.orgId, orgId),
              sql`${invStockLevels.onHand}::numeric > 0`,
              sql`NOT EXISTS (
                SELECT 1 FROM inv_stock_transactions t
                WHERE t.org_id = ${orgId}
                  AND t.product_variant_id = ${invStockLevels.productVariantId}
                  AND t.transaction_type IN ('SALE', 'TRANSFER_OUT')
                  AND t.created_at >= ${cutoff.toISOString()}
              )`,
            ),
          )
          .groupBy(invStockLevels.productVariantId, invProductVariants.id, invProducts.id)
          .orderBy(sql`days_since_last_movement DESC NULLS FIRST`)
          .limit(limit)
          .offset(offset);

        const items = rows.map((r) => ({
          ...r,
          onHand: parseFloat(r.onHand),
          value: Math.round(parseFloat(r.onHand) * parseFloat(r.averageCost) * 100) / 100,
          averageCost: parseFloat(r.averageCost),
        }));

        return { items, page };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getExpiryReport(orgId: string, filters: ExpiryReportInput) {
    const { withinDays, warehouseId, status, page, limit } = filters;
    const offset = (page - 1) * limit;
    const cacheKey = CACHE_KEYS.invExpiryReport(orgId, `${withinDays}-${warehouseId ?? "all"}-${status ?? "all"}-${page}`);

    return this.cache.cached(
      cacheKey,
      async () => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() + withinDays);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        const conditions = [
          eq(invLots.orgId, orgId),
          lte(invLots.expiryDate, cutoffStr),
          sql`(SELECT COALESCE(SUM(sl.on_hand::numeric), 0) FROM inv_stock_levels sl WHERE sl.lot_id = ${invLots.id} AND sl.org_id = ${orgId}) > 0`,
        ];
        if (status) conditions.push(eq(invLots.status, status));

        const [items, [countRow]] = await Promise.all([
          this.db
            .select({
              id: invLots.id,
              lotNumber: invLots.lotNumber,
              expiryDate: invLots.expiryDate,
              status: invLots.status,
              productVariantId: invLots.productVariantId,
              variantSku: invProductVariants.sku,
              variantName: invProductVariants.name,
              productName: invProducts.name,
              totalOnHand: sql<string>`COALESCE((SELECT SUM(sl.on_hand::numeric) FROM inv_stock_levels sl WHERE sl.lot_id = ${invLots.id} AND sl.org_id = ${orgId}), 0)::text`,
              daysUntilExpiry: sql<number>`EXTRACT(DAY FROM (${invLots.expiryDate}::date - CURRENT_DATE))::int`,
            })
            .from(invLots)
            .innerJoin(invProductVariants, eq(invLots.productVariantId, invProductVariants.id))
            .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
            .where(and(...conditions))
            .orderBy(invLots.expiryDate)
            .limit(limit)
            .offset(offset),
          this.db.select({ total: sql<number>`count(*)::int` }).from(invLots).where(and(...conditions)),
        ]);

        return { items, total: countRow?.total ?? 0, page, totalPages: Math.ceil((countRow?.total ?? 0) / limit) };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getReorderReportUpgraded(orgId: string) {
    const stockRows = await this.db
      .select({
        productVariantId: invStockLevels.productVariantId,
        locationId: invStockLevels.locationId,
        onHand: invStockLevels.onHand,
        onOrder: invStockLevels.onOrder,
        committed: invStockLevels.committed,
        averageCost: invStockLevels.averageCost,
        variantSku: invProductVariants.sku,
        variantName: invProductVariants.name,
        productId: invProducts.id,
        productName: invProducts.name,
        productSku: invProducts.sku,
        reorderPoint: invProducts.reorderPoint,
        minStockLevel: invProducts.minStockLevel,
        defaultVendorId: invProducts.defaultVendorId,
      })
      .from(invStockLevels)
      .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
      .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
      .where(
        and(
          eq(invStockLevels.orgId, orgId),
          sql`${invStockLevels.onHand}::numeric <= ${invProducts.reorderPoint}::numeric`,
        ),
      );

    const rules = await this.db
      .select()
      .from(invReorderRules)
      .where(and(eq(invReorderRules.orgId, orgId), eq(invReorderRules.isActive, true)));

    const ruleMap = new Map<string, typeof rules[number]>();
    for (const r of rules) {
      ruleMap.set(`${r.productVariantId}:${r.warehouseId ?? "null"}`, r);
    }

    return stockRows.map((row) => {
      const rule = ruleMap.get(`${row.productVariantId}:null`) ?? ruleMap.get(`${row.productVariantId}:${row.locationId}`);
      const onHand = parseFloat(row.onHand);
      const suggestedQty = rule
        ? rule.maxQty
          ? Math.max(0, parseFloat(rule.maxQty) - onHand)
          : parseFloat(rule.reorderQty ?? "0")
        : Math.max(0, parseFloat(row.reorderPoint) - onHand);

      return {
        productVariantId: row.productVariantId,
        variantSku: row.variantSku,
        variantName: row.variantName,
        productId: row.productId,
        productName: row.productName,
        productSku: row.productSku,
        onHand,
        onOrder: parseFloat(row.onOrder),
        committed: parseFloat(row.committed),
        reorderPoint: parseFloat(row.reorderPoint),
        minStockLevel: parseFloat(row.minStockLevel),
        reorderRuleId: rule?.id ?? null,
        minQty: rule ? parseFloat(rule.minQty) : null,
        maxQty: rule?.maxQty ? parseFloat(rule.maxQty) : null,
        reorderQty: rule?.reorderQty ? parseFloat(rule.reorderQty) : null,
        suggestedQty: Math.round(suggestedQty * 10000) / 10000,
        vendorId: rule?.vendorId ?? row.defaultVendorId ?? null,
        leadTimeDays: rule?.leadTimeDays ?? null,
      };
    });
  }
}
