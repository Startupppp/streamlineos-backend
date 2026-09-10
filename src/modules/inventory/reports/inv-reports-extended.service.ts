import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lte, sql, type SQL } from "drizzle-orm";
import {
  invStockLevels,
  invProducts,
  invProductVariants,
  invShipments,
  invLots,
  invAiInsights,
  invChannelStockPublications,
  invQualityInspections,
  invStockReservations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import type { ValuationReportInput, SlowMovingQueryInput, ExpiryReportInput, ReorderQueryInput } from "./dto/inv-reports.schemas";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InvValuationService } from "../valuation/inv-valuation.service";
import { getReorderReportUpgraded } from "./lib/reorder-report";

interface SlowMovingRow extends Record<string, unknown> {
  productVariantId: number;
  variantSku: string;
  variantName: string | null;
  productName: string;
  onHand: number;
  onHandDec: string;
  averageCost: number;
  averageCostDec: string;
  value: number;
  valueDec: string;
  lastMovement: string | null;
  daysSinceLastMovement: number | null;
  totalRows: number;
}


@Injectable()
export class InvReportsExtendedService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly valuation: InvValuationService,
  ) {}

  private async stockScope(orgId: string, userId: string) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    return {
      sql: this.warehouseScope.locationPredicate(scope, sql`${invStockLevels.locationId}`),
      key: this.warehouseScope.scopeKey(scope),
    };
  }

  async getDashboardExtras(orgId: string, userId: string) {
    const scope = await this.stockScope(orgId, userId);
    const thirtyDaysOut = new Date();
    thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
    const thirtyDaysCutoff = thirtyDaysOut.toISOString().slice(0, 10);

    const results = await Promise.allSettled([
      // D5. Summed in `numeric` and projected twice: `exact` is the figure, and
      // the float is the legacy shape the dashboard tile reads. Neither is
      // `parseFloat`-ed — the multiplication happens once, in Postgres, where a
      // decimal is a decimal.
      this.db
        .select({
          exact: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric * COALESCE(${invStockLevels.averageCost}, 0)::numeric), 0)::text`,
          approx: sql<number>`COALESCE(SUM(${invStockLevels.onHand}::numeric * COALESCE(${invStockLevels.averageCost}, 0)::numeric), 0)::float8`,
        })
        .from(invStockLevels)
        .where(and(eq(invStockLevels.orgId, orgId), scope.sql)),

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
        .select({
          exact: sql<string>`COALESCE(SUM(${invStockLevels.qualityHoldQty}::numeric), 0)::text`,
          approx: sql<number>`COALESCE(SUM(${invStockLevels.qualityHoldQty}::numeric), 0)::float8`,
        })
        .from(invStockLevels)
        .where(and(eq(invStockLevels.orgId, orgId), scope.sql)),

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

    const stock = get(results[0], [])[0];
    const hold = get(results[2], [])[0];

    return {
      stockValue: stock?.approx ?? 0,
      stockValueDec: stock?.exact ?? "0",
      expiringLotsCount: get(results[1], 0),
      qualityHoldQty: hold?.approx ?? 0,
      qualityHoldQtyDec: hold?.exact ?? "0",
      activeReservationsCount: get(results[3], 0),
      openShipmentsCount: get(results[4], 0),
      failedChannelSyncsCount: get(results[5], 0),
      openInspectionsCount: get(results[6], 0),
      recentInsights: get(results[7], []),
    };
  }

  /**
   * D5. One valuation implementation, not two.
   *
   * `/inventory/reports/valuation` and `/inventory/valuation` were separate
   * copies of the same FIFO/standard/average dispatch, each with its own
   * `parseFloat` arithmetic and its own idea of a page total. This route now
   * reads the canonical service, so the date grain, the layer evidence and the
   * exact totals arrive here for free and cannot drift out again.
   */
  getValuationReport(orgId: string, userId: string, filters: ValuationReportInput) {
    return this.cache.cached(
      CACHE_KEYS.invValuationReport(
        orgId,
        [
          filters.warehouseId ?? "all",
          filters.categoryId ?? "all",
          filters.asOfDate ?? "live",
          filters.periodId ?? "no-period",
          filters.page,
          filters.limit,
          userId,
        ].join("-"),
      ),
      () => this.valuation.getValuationSummary(orgId, userId, filters),
      CACHE_TTL.MEDIUM,
    );
  }

  /**
   * D5. Value is `Σ(on_hand × average_cost)` per stock row, in `numeric`, not
   * total-on-hand times the unweighted mean of each row's average — which is
   * what `AVG(NULLIF(average_cost, 0))` produced and which is wrong whenever the
   * same variant sits at two locations at two costs. `averageCost` is then the
   * implied unit cost of that value, so the three figures always agree.
   */
  async getSlowMovingReport(orgId: string, userId: string, filters: SlowMovingQueryInput) {
    const { days, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.stockScope(orgId, userId);
    const scopeSql = this.warehouseScope.locationPredicate(
      await this.warehouseScope.resolve(orgId, userId),
      "sl.location_id",
    );
    const cacheKey = CACHE_KEYS.invSlowMovingReport(orgId, `${scope.key}-${days}-${page}-${limit}`);

    return this.cache.cached(
      cacheKey,
      async () => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const rows = await this.db.execute<SlowMovingRow>(sql`
          WITH r AS (
            SELECT
              sl.product_variant_id,
              v.sku   AS variant_sku,
              v.name  AS variant_name,
              p.name  AS product_name,
              SUM(sl.on_hand::numeric) AS on_hand,
              SUM(sl.on_hand::numeric * COALESCE(sl.average_cost, 0)::numeric) AS value,
              (
                SELECT MAX(t.created_at)
                FROM inv_stock_transactions t
                WHERE t.org_id = ${orgId}
                  AND t.product_variant_id = sl.product_variant_id
                  AND t.transaction_type IN ('SALE', 'TRANSFER_OUT')
              ) AS last_movement_at
            FROM inv_stock_levels sl
            JOIN inv_product_variants v ON v.id = sl.product_variant_id
            JOIN inv_products p         ON p.id = v.product_id
            WHERE sl.org_id = ${orgId}
              AND ${scopeSql}
              AND sl.on_hand::numeric > 0
              AND NOT EXISTS (
                SELECT 1 FROM inv_stock_transactions t
                WHERE t.org_id = ${orgId}
                  AND t.product_variant_id = sl.product_variant_id
                  AND t.transaction_type IN ('SALE', 'TRANSFER_OUT')
                  AND t.created_at >= ${cutoff.toISOString()}::timestamp
              )
            GROUP BY sl.product_variant_id, v.sku, v.name, p.name
          )
          SELECT
            r.product_variant_id                        AS "productVariantId",
            r.variant_sku                               AS "variantSku",
            r.variant_name                              AS "variantName",
            r.product_name                              AS "productName",
            r.on_hand::float8                           AS "onHand",
            r.on_hand::text                             AS "onHandDec",
            (CASE WHEN r.on_hand <> 0 THEN r.value / r.on_hand ELSE 0 END)::float8 AS "averageCost",
            (CASE WHEN r.on_hand <> 0 THEN r.value / r.on_hand ELSE 0 END)::text   AS "averageCostDec",
            r.value::float8                             AS "value",
            r.value::text                               AS "valueDec",
            r.last_movement_at::text                    AS "lastMovement",
            EXTRACT(DAY FROM (NOW() - r.last_movement_at))::int AS "daysSinceLastMovement",
            count(*) OVER ()::int                       AS "totalRows"
          FROM r
          ORDER BY "daysSinceLastMovement" DESC NULLS FIRST, r.variant_sku
          LIMIT ${limit} OFFSET ${offset}
        `);

        const total = rows[0]?.totalRows ?? 0;
        return {
          items: rows.map(({ totalRows: _t, ...row }) => row),
          total,
          page,
          totalPages: Math.ceil(total / limit),
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getExpiryReport(orgId: string, userId: string, filters: ExpiryReportInput) {
    const { withinDays, warehouseId, status, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.stockScope(orgId, userId);
    const cacheKey = CACHE_KEYS.invExpiryReport(orgId, `${scope.key}-${withinDays}-${warehouseId ?? "all"}-${status ?? "all"}-${page}`);

    return this.cache.cached(
      cacheKey,
      async () => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() + withinDays);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        // Both the warehouse scope and the caller's own warehouse filter used to
        // appear *only in the cache key*. So a warehouse-restricted operator was
        // shown every site's expiring lots — a §4 scope leak through a report —
        // and `?warehouseId=` silently returned every warehouse while being
        // cached under a key that said it had been filtered.
        //
        // The lot itself carries no location; its stock does. Both predicates
        // therefore constrain the same existence check that already proves the
        // lot has stock, so a lot is listed only where the caller can see the
        // stock that makes it worth listing.
        const visibleStock = (extra: SQL | null) => sql`(
          SELECT COALESCE(SUM(sl.on_hand::numeric), 0)
            FROM inv_stock_levels sl
           WHERE sl.lot_id = ${invLots.id}
             AND sl.org_id = ${orgId}
             AND ${scope.sql}
             ${extra ?? sql``}
        ) > 0`;

        const conditions = [
          eq(invLots.orgId, orgId),
          lte(invLots.expiryDate, cutoffStr),
          visibleStock(
            warehouseId
              ? sql`AND sl.location_id IN (
                    SELECT id FROM inv_locations
                     WHERE org_id = ${orgId} AND warehouse_id = ${warehouseId}
                  )`
              : null,
          ),
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

  /** @see lib/reorder-report.ts — the body moved, the route surface did not. */
  async getReorderReportUpgraded(orgId: string, userId: string, filters: ReorderQueryInput) {
    return getReorderReportUpgraded(this.db, this.warehouseScope, orgId, userId, filters);
  }
}
