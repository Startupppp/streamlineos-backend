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
import { availableQtySql } from "../stock-engine/available-sql";
import { InvValuationService } from "../valuation/inv-valuation.service";

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

interface ReorderRow extends Record<string, unknown> {
  productVariantId: number;
  variantSku: string;
  variantName: string | null;
  productId: number;
  productName: string;
  productSku: string;
  /** B4. Which bin and store are short — the row was always per stock level. */
  locationId: number;
  locationName: string;
  locationCode: string;
  warehouseId: number;
  warehouseName: string;
  warehouseCode: string;
  onHand: number;
  onHandDec: string;
  onOrder: number;
  committed: number;
  availableQty: number;
  availableQtyDec: string;
  reorderPoint: number;
  minStockLevel: number;
  reorderRuleId: number | null;
  minQty: number | null;
  maxQty: number | null;
  reorderQty: number | null;
  /** B4. Outstanding on sent/part-received purchase orders bound for this warehouse. */
  onPurchaseOrderQty: number;
  onPurchaseOrderQtyDec: string;
  /** B4. Outstanding on transfers already dispatched to this warehouse. */
  inTransitQty: number;
  inTransitQtyDec: string;
  /** What the policy alone asks for, before inbound stock is deducted. */
  rawSuggestedQty: number;
  suggestedQty: number;
  suggestedQtyDec: string;
  vendorId: number | null;
  leadTimeDays: number | null;
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

  /**
   * D5. The shortfall is decided in Postgres, in `numeric`.
   *
   * It used to be `Math.max(0, parseFloat(rule.maxQty) - parseFloat(row.onHand))`
   * — a purchasing quantity chosen from two floats. Two other defects went with
   * it: the rule lookup keyed a warehouse map by `location_id`, so a
   * warehouse-scoped rule never matched and every such variant silently fell back
   * to the product-level reorder point; and `availableQty` was selected but
   * dropped before the response, so the screen's availability column read
   * `undefined`. Both are fixed here rather than mirrored.
   */
  /**
   * What to buy, per stock level, with the building each row is about.
   *
   * Every other report in this file resolves the caller's warehouses through
   * `stockScope` — the dashboard extras, the slow-moving list and the expiry
   * report all do — and this one took no `userId` at all. It is a row per
   * `inv_stock_levels`, so it projected `warehouse_id`, `warehouse_name`,
   * `location_name` and the on-hand, available, on-order, in-transit and
   * committed quantities for every site in the organisation, to anybody holding
   * the reports key. That is the whole stock position of every building the
   * caller has never worked in, in one paginated screen.
   *
   * A read posts no movements, so the engine's `assertLocationsInScope` was
   * never on this path either.
   *
   * The predicate goes on the `inv_stock_levels` scan inside the CTE rather than
   * on the outer select, so the row is never built: the inbound sub-selects that
   * hang off it — what is on a purchase order for this warehouse, what is in a
   * van heading to it — are correlated to `sl.location_id` and would otherwise
   * be computed and returned for buildings the caller cannot see, which is the
   * same disclosure by a quieter route.
   */
  async getReorderReportUpgraded(orgId: string, userId: string, filters: ReorderQueryInput) {
    const { page, limit } = filters;
    const offset = (page - 1) * limit;
    /*
     * `stockScope` renders `"inv_stock_levels"."location_id"`, and this query
     * aliases the table as `sl` inside its CTE. A fully-qualified name there is
     * not a redundant spelling of the alias — it is `missing FROM-clause entry
     * for table "inv_stock_levels"` at runtime, in a statement that typechecks
     * and builds perfectly well. So the predicate is built against the alias by
     * name, which is what `locationPredicate`'s string overload exists for.
     */
    const scopeSql = this.warehouseScope.locationPredicate(
      await this.warehouseScope.resolve(orgId, userId),
      "sl.location_id",
    );

    const rows = await this.db.execute<ReorderRow>(sql`
      WITH r AS (
        SELECT
          sl.product_variant_id,
          v.sku  AS variant_sku,
          v.name AS variant_name,
          p.id   AS product_id,
          p.name AS product_name,
          p.sku  AS product_sku,
          sl.on_hand::numeric    AS on_hand,
          sl.on_order::numeric   AS on_order,
          sl.committed::numeric  AS committed,
          ${availableQtySql("sl")} AS available_qty,
          p.reorder_point::numeric   AS reorder_point,
          p.min_stock_level::numeric AS min_stock_level,
          p.default_vendor_id,
          -- B4. Which store this row is about.
          --
          -- The report has always been one row **per stock level**, so a SKU low
          -- at two dark stores produced two rows that were identical on every
          -- projected column. The frontend keyed its list on
          -- productId + variantSku, and React silently dropped one of them --
          -- an operator reading the low-stock list saw fewer stores than were
          -- actually short. Projecting the warehouse fixes the key and answers
          -- the question the row was always about: low *where*.
          -- The row's true identity: one row per stock level, and a SKU can sit
          -- in two bins of the same store. Keying on the warehouse alone still
          -- collided, so the bin is projected as well.
          sl.location_id     AS location_id,
          loc.name           AS location_name,
          loc.code           AS location_code,
          loc.warehouse_id   AS warehouse_id,
          wh.name            AS warehouse_name,
          wh.code            AS warehouse_code,
          p.lead_time_days   AS product_lead_time_days,
          (SELECT ven.lead_time_days FROM inv_vendors ven
            WHERE ven.id = p.default_vendor_id AND ven.org_id = ${orgId}) AS vendor_lead_time_days,
          rule.id            AS rule_id,
          rule.min_qty       AS rule_min_qty,
          rule.max_qty       AS rule_max_qty,
          rule.reorder_qty   AS rule_reorder_qty,
          rule.vendor_id     AS rule_vendor_id,
          rule.lead_time_days AS rule_lead_time_days,
          -- B4. What is already coming, so the suggestion does not buy it twice.
          --
          -- What is inbound is the outstanding quantity on purchase orders that have
          -- been sent (or part-received) plus the quantity sitting in a van
          -- between two dark stores. Both are stock this warehouse is going to
          -- get without anybody ordering anything, and a suggestion that ignores
          -- them is how a business ends up with three months of cement.
          --
          -- Scoped to the *warehouse this stock row is in*: a purchase order
          -- headed for one facility does not cover a stockout at another, which
          -- is exactly the case the transfer board exists for.
          COALESCE((
            SELECT SUM(GREATEST(pol.quantity::numeric - pol.quantity_received::numeric, 0))
            FROM inv_po_lines pol
            JOIN inv_purchase_orders po
              ON po.id = pol.po_id AND po.org_id = pol.org_id
            WHERE pol.org_id = ${orgId}
              AND pol.product_variant_id = sl.product_variant_id
              AND po.status IN ('SENT', 'PARTIAL')
              AND (po.warehouse_id IS NULL OR po.warehouse_id = (
                SELECT loc.warehouse_id FROM inv_locations loc WHERE loc.id = sl.location_id
              ))
          ), 0) AS on_po_qty,
          COALESCE((
            SELECT SUM(GREATEST(tl.quantity::numeric - tl.quantity_received::numeric, 0))
            FROM inv_stock_transfer_lines tl
            JOIN inv_stock_transfers t
              ON t.id = tl.transfer_id AND t.org_id = tl.org_id
            WHERE tl.org_id = ${orgId}
              AND tl.product_variant_id = sl.product_variant_id
              AND t.status = 'IN_TRANSIT'
              AND t.to_warehouse_id = (
                SELECT loc.warehouse_id FROM inv_locations loc WHERE loc.id = sl.location_id
              )
          ), 0) AS in_transit_qty,
          -- B4. The order policy, most specific first.
          --
          -- A per-warehouse reorder rule wins, then the SKU's own
          -- reorder_quantity, then the deficit to the reorder point. The middle
          -- term is new: reorder_point has always answered *when* to buy, and
          -- until now nothing answered *how much*, so every suggestion for a SKU
          -- without a rule proposed the bare deficit — which puts stock exactly
          -- back on the reorder point and triggers the same suggestion tomorrow.
          CASE
            WHEN rule.id IS NOT NULL AND rule.max_qty IS NOT NULL
              THEN GREATEST(rule.max_qty - sl.on_hand::numeric, 0)
            WHEN rule.id IS NOT NULL AND rule.reorder_qty IS NOT NULL
              THEN rule.reorder_qty
            WHEN p.reorder_quantity IS NOT NULL
              THEN p.reorder_quantity::numeric
            ELSE GREATEST(p.reorder_point::numeric - sl.on_hand::numeric, 0)
          END AS raw_suggested_qty
        FROM inv_stock_levels sl
        JOIN inv_product_variants v ON v.id = sl.product_variant_id
        JOIN inv_products p         ON p.id = v.product_id
        JOIN inv_locations loc      ON loc.id = sl.location_id AND loc.org_id = sl.org_id
        JOIN inv_warehouses wh      ON wh.id = loc.warehouse_id AND wh.org_id = sl.org_id
        LEFT JOIN LATERAL (
          SELECT rr.id, rr.min_qty::numeric AS min_qty, rr.max_qty::numeric AS max_qty,
                 rr.reorder_qty::numeric AS reorder_qty, rr.vendor_id, rr.lead_time_days
          FROM inv_reorder_rules rr
          WHERE rr.org_id = ${orgId}
            AND rr.is_active
            AND rr.product_variant_id = sl.product_variant_id
            AND (
              rr.warehouse_id IS NULL
              OR rr.warehouse_id = (SELECT loc.warehouse_id FROM inv_locations loc WHERE loc.id = sl.location_id)
            )
          ORDER BY (rr.warehouse_id IS NULL) ASC, rr.id ASC
          LIMIT 1
        ) rule ON TRUE
        WHERE sl.org_id = ${orgId}
          AND sl.on_hand::numeric <= p.reorder_point::numeric
          AND ${scopeSql}
      )
      SELECT
        r.product_variant_id      AS "productVariantId",
        r.variant_sku             AS "variantSku",
        r.variant_name            AS "variantName",
        r.product_id              AS "productId",
        r.product_name            AS "productName",
        r.product_sku             AS "productSku",
        r.location_id             AS "locationId",
        r.location_name           AS "locationName",
        r.location_code           AS "locationCode",
        r.warehouse_id            AS "warehouseId",
        r.warehouse_name          AS "warehouseName",
        r.warehouse_code          AS "warehouseCode",
        r.on_hand::float8         AS "onHand",
        r.on_hand::text           AS "onHandDec",
        r.on_order::float8        AS "onOrder",
        r.committed::float8       AS "committed",
        r.available_qty::float8   AS "availableQty",
        r.available_qty::text     AS "availableQtyDec",
        r.reorder_point::float8   AS "reorderPoint",
        r.min_stock_level::float8 AS "minStockLevel",
        r.rule_id                 AS "reorderRuleId",
        r.rule_min_qty::float8    AS "minQty",
        r.rule_max_qty::float8    AS "maxQty",
        r.rule_reorder_qty::float8 AS "reorderQty",
        r.on_po_qty::float8       AS "onPurchaseOrderQty",
        r.on_po_qty::text         AS "onPurchaseOrderQtyDec",
        r.in_transit_qty::float8  AS "inTransitQty",
        r.in_transit_qty::text    AS "inTransitQtyDec",
        r.raw_suggested_qty::float8 AS "rawSuggestedQty",
        -- What is left to buy once what is already coming is counted. Floored at
        -- zero: a SKU whose inbound already covers the gap needs no order, and a
        -- negative "suggestion" is not something anybody can act on.
        GREATEST(r.raw_suggested_qty - r.on_po_qty - r.in_transit_qty, 0)::float8 AS "suggestedQty",
        GREATEST(r.raw_suggested_qty - r.on_po_qty - r.in_transit_qty, 0)::text   AS "suggestedQtyDec",
        COALESCE(r.rule_vendor_id, r.default_vendor_id) AS "vendorId",
        -- B4. Rule first, then the SKU's catalogue lead time, then the default
        -- vendor's. A null here used to be the norm, which made every "will it
        -- arrive in time" question unanswerable.
        COALESCE(r.rule_lead_time_days, r.product_lead_time_days, r.vendor_lead_time_days) AS "leadTimeDays",
        count(*) OVER ()::int     AS "totalRows"
      FROM r
      ORDER BY r.variant_sku, r.product_variant_id, r.warehouse_id, r.location_id
      LIMIT ${limit} OFFSET ${offset}
    `);

    const total = rows[0]?.totalRows ?? 0;
    return {
      items: rows.map(({ totalRows: _t, ...row }) => row),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}
