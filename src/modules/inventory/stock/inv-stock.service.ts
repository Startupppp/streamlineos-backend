import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  invStockTransactions,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { buildCursorPage, decodeTimestampCursor } from "../../../common/pagination/cursor";
import { keysetBeforeMicros, microsecondCursorValue } from "../../../common/pagination/keyset";
import { WarehouseScopeService, type WarehouseScope } from "../stock-engine/warehouse-scope.service";
import { CostVisibilityService, stripCostFields } from "../stock-engine/cost-visibility";
import { availableQtySql, availableQtySumSql } from "../stock-engine/available-sql";
import type {
  ListStockLevelsInput, ListTransactionsInput, AvailabilityQueryInput,
} from "./dto/inv-stock.schemas";

/**
 * Ceiling on matching variants a text search resolves.
 *
 * The search runs through a SECURITY DEFINER function so the trigram indexes are
 * reachable at all — under RLS the planner will not use them, because the tenant
 * qual is not leakproof and may not run second. An unbounded set-returning
 * function is materialised in full, so it takes a limit: a query broad enough to
 * exceed this is a filter that is not filtering.
 */
const SEARCH_MATCH_CAP = 500;

@Injectable()
export class InvStockService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly costVisibility: CostVisibilityService,
  ) {}

  /**
   * Warehouse scope as a SQL fragment plus a cache discriminator. The
   * discriminator is mandatory: this list is cached per org, so a per-user
   * predicate without it would serve one operator's warehouses to the next.
   */
  private scopeFragment(scope: WarehouseScope, orgId: string): { sql: SQL; key: string } {
    if (scope === null) return { sql: sql``, key: "all" };
    if (scope.length === 0) return { sql: sql`AND FALSE`, key: "none" };
    const ids = sql.join(scope.map((id) => sql`${id}`), sql`, `);
    return {
      sql: sql`AND sl.location_id IN (SELECT id FROM inv_locations WHERE org_id = ${orgId} AND warehouse_id IN (${ids}))`,
      key: [...scope].sort((a, b) => a - b).join("."),
    };
  }

  async listStockLevels(orgId: string, userId: string, filters: ListStockLevelsInput) {
    const { warehouseId, locationId, productId, variantId, lotId, serialId, lowStock, negative, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = this.scopeFragment(await this.warehouseScope.resolve(orgId, userId), orgId);
    const showCost = await this.costVisibility.canSeeCost(orgId, userId);
    const hash = `${showCost ? "cost" : "nocost"}:${scope.key}:${warehouseId ?? ""}:${locationId ?? ""}:${productId ?? ""}:${variantId ?? ""}:${lotId ?? ""}:${serialId ?? ""}:${lowStock ?? ""}:${negative ?? ""}:${search ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(`inv:stock:levels:${orgId}`, hash, async () => {

      // [B1-08] Run data + count queries in parallel.
      // [B1-10] Explicit column projection instead of SELECT sl.*.
      // [B1-23] No typed generic on db.execute; fields read via Number()/String() converters below.
      const [rows, countRows] = await Promise.all([
        this.db.execute(sql`
          SELECT
            sl.id,
            sl.org_id,
            sl.product_variant_id,
            sl.location_id,
            sl.lot_id,
            sl.serial_id,
            sl.on_hand,
            sl.committed,
            sl.on_order,
            sl.blocked_qty,
            sl.quality_hold_qty,
            sl.outgoing_qty,
            sl.average_cost,
            sl.updated_at,
            ${availableQtySql("sl")} AS available
          FROM inv_stock_levels sl
          WHERE sl.org_id = ${orgId}
            ${scope.sql}
            ${locationId ? sql`AND sl.location_id = ${locationId}` : sql``}
            ${variantId ? sql`AND sl.product_variant_id = ${variantId}` : sql``}
            ${lotId ? sql`AND sl.lot_id = ${lotId}` : sql``}
            ${serialId ? sql`AND sl.serial_id = ${serialId}` : sql``}
            ${negative ? sql`AND sl.on_hand::numeric < 0` : sql``}
            ${warehouseId ? sql`AND sl.location_id IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId} AND org_id = ${orgId})` : sql``}
            ${productId ? sql`AND sl.product_variant_id IN (SELECT id FROM inv_product_variants WHERE product_id = ${productId})` : sql``}
            ${search ? sql`AND sl.product_variant_id IN (SELECT app.search_inventory_variant_ids(${search}, ${SEARCH_MATCH_CAP}))` : sql``}
            ${lowStock ? sql`AND sl.on_hand::numeric <= COALESCE((SELECT p.reorder_point::numeric FROM inv_product_variants v JOIN inv_products p ON p.id = v.product_id WHERE v.id = sl.product_variant_id), 0)` : sql``}
          ORDER BY sl.updated_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `),
        this.db.execute(sql`
          SELECT count(*)::int AS count FROM inv_stock_levels sl
          WHERE sl.org_id = ${orgId}
            ${scope.sql}
            ${locationId ? sql`AND sl.location_id = ${locationId}` : sql``}
            ${variantId ? sql`AND sl.product_variant_id = ${variantId}` : sql``}
            ${lotId ? sql`AND sl.lot_id = ${lotId}` : sql``}
            ${serialId ? sql`AND sl.serial_id = ${serialId}` : sql``}
            ${negative ? sql`AND sl.on_hand::numeric < 0` : sql``}
            ${warehouseId ? sql`AND sl.location_id IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId} AND org_id = ${orgId})` : sql``}
            ${productId ? sql`AND sl.product_variant_id IN (SELECT id FROM inv_product_variants WHERE product_id = ${productId})` : sql``}
            ${search ? sql`AND sl.product_variant_id IN (SELECT app.search_inventory_variant_ids(${search}, ${SEARCH_MATCH_CAP}))` : sql``}
            ${lowStock ? sql`AND sl.on_hand::numeric <= COALESCE((SELECT p.reorder_point::numeric FROM inv_product_variants v JOIN inv_products p ON p.id = v.product_id WHERE v.id = sl.product_variant_id), 0)` : sql``}
        `),
      ]);

      const countRow = countRows[0];
      const total = Number(countRow?.["count"] ?? 0);
      const items = showCost ? rows : stripCostFields(rows);
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  /**
   * G1. The ledger list, keyset-paginated.
   *
   * `created_at` alone is not a total order here: one posting writes every line
   * of a receipt inside a single transaction, so a dozen rows share a `now()` to
   * the microsecond. A cursor on the timestamp would land mid-group and either
   * repeat those rows or step over them, which on an append-only ledger reads as
   * stock that was never received. The cursor is therefore `(created_at, id)`,
   * `id` being unique per tenant by `uniq_inv_stock_transactions_org_id`.
   *
   * No ceiling id is pinned, and it would be wrong to pin one. D7's export needs
   * a set that cannot grow, because it checksums it; a reader scrolling
   * backwards through time needs the opposite — rows written above the cursor
   * are newer than everything the reader has seen, sit on the far side of the
   * `<` bound, and are simply not on any page the reader has left to turn.
   */
  async listTransactions(orgId: string, userId: string, filters: ListTransactionsInput) {
    const { productVariantId, warehouseId, locationId, transactionType, direction, search, fromDate, toDate, page, limit, cursor } = filters;
    const position = decodeTimestampCursor(cursor);
    const offset = (page - 1) * limit;
    const conditions: SQL[] = [eq(invStockTransactions.orgId, orgId)];
    const scoped = this.warehouseScope.locationPredicate(
      await this.warehouseScope.resolve(orgId, userId),
      sql`${invStockTransactions.locationId}`,
    );
    conditions.push(scoped);
    if (productVariantId) conditions.push(eq(invStockTransactions.productVariantId, productVariantId));
    if (locationId) conditions.push(eq(invStockTransactions.locationId, locationId));
    if (transactionType) conditions.push(eq(invStockTransactions.transactionType, transactionType));
    if (fromDate) conditions.push(gte(invStockTransactions.createdAt, new Date(fromDate)));
    if (toDate) conditions.push(lte(invStockTransactions.createdAt, new Date(toDate)));
    if (direction === "in") conditions.push(sql`${invStockTransactions.quantityChange}::numeric > 0`);
    if (direction === "out") conditions.push(sql`${invStockTransactions.quantityChange}::numeric < 0`);
    if (warehouseId) conditions.push(
      sql`${invStockTransactions.locationId} IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId} AND org_id = ${orgId})`,
    );
    if (search) conditions.push(
      sql`${invStockTransactions.productVariantId} IN (SELECT app.search_inventory_variant_ids(${search}, ${SEARCH_MATCH_CAP}))`,
    );

    const showCost = await this.costVisibility.canSeeCost(orgId, userId);
    const where = and(...conditions);

    const rowsPromise = this.db.query.invStockTransactions.findMany({
      where: position
        ? and(where, keysetBeforeMicros(invStockTransactions.createdAt, invStockTransactions.id, position))
        : where,
      orderBy: [desc(invStockTransactions.createdAt), desc(invStockTransactions.id)],
      limit: limit + 1,
      offset: position ? 0 : offset,
      extras: {
        cursorAt: microsecondCursorValue(invStockTransactions.createdAt).as("cursor_at"),
      },
      with: {
        productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
        location: {
          columns: { id: true, name: true, code: true },
          with: { warehouse: { columns: { id: true, name: true } } },
        },
        creator: { columns: { id: true, name: true } },
      },
    });
    // `count(*)` over a tenant's ledger is the other half of what offset costs,
    // and a cursor walk has no use for it — there is no "page 7 of 92" to render.
    const totalPromise: Promise<number | null> = position
      ? Promise.resolve(null)
      : this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(invStockTransactions)
          .where(where)
          .then((rows) => rows[0]?.count ?? 0);
    const [rows, total] = await Promise.all([rowsPromise, totalPromise]);

    const cursorPage = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.cursorAt,
      id: String(row.id),
    }));
    const items = cursorPage.data.map(({ cursorAt: _cursorAt, ...row }) => row);

    return {
      items: showCost ? items : stripCostFields(items),
      total,
      page,
      totalPages: total === null ? null : Math.ceil(total / limit),
      ...cursorPage.pagination,
    };
  }

  async getAvailability(orgId: string, userId: string, filters: AvailabilityQueryInput) {
    const { variantId, warehouseId } = filters;
    const scope = this.scopeFragment(await this.warehouseScope.resolve(orgId, userId), orgId);

    // [B1-09] stockRow, incomingRow, outgoingRow are fully independent — run in parallel.
    // [B1-23] No typed generic on db.execute; fields read via String()/Number() converters below.
    const [stockRows, incomingRows, outgoingRows, warehouseBreakdown] = await Promise.all([
      this.db.execute(sql`
        SELECT
          COALESCE(SUM(on_hand::numeric), 0)::text AS on_hand,
          COALESCE(SUM(committed::numeric), 0)::text AS committed,
          COALESCE(SUM(COALESCE(blocked_qty, 0)::numeric), 0)::text AS blocked_qty,
          COALESCE(SUM(COALESCE(quality_hold_qty, 0)::numeric), 0)::text AS quality_hold_qty,
          COALESCE(SUM(COALESCE(outgoing_qty, 0)::numeric), 0)::text AS outgoing_qty,
          -- A2. Availability is summed per row, by the one definition, because
          -- it is now a function of where each row stands as well as of its
          -- buckets. Summing the buckets first and subtracting afterwards -- as
          -- this did -- cannot express "and none of it is in a van", so goods in
          -- transit were promisable. on_hand above deliberately still counts
          -- them: they exist, and the org's total must not dip while they move.
          ${availableQtySumSql("sl")}::text AS available
        FROM inv_stock_levels sl
        WHERE sl.org_id = ${orgId} AND sl.product_variant_id = ${variantId}
        ${scope.sql}
        ${warehouseId ? sql`AND sl.location_id IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId})` : sql``}
      `),
      this.db.execute(sql`
        SELECT COALESCE(SUM((pl.quantity::numeric - pl.quantity_received::numeric)), 0)::text AS incoming
        FROM inv_po_lines pl
        JOIN inv_purchase_orders po ON po.id = pl.po_id
        WHERE po.org_id = ${orgId}
          AND pl.product_variant_id = ${variantId}
          AND po.status IN ('SENT', 'PARTIAL')
          ${warehouseId ? sql`AND po.warehouse_id = ${warehouseId}` : sql``}
      `),
      this.db.execute(sql`
        SELECT COALESCE(SUM((sl.quantity::numeric - sl.quantity_shipped::numeric)), 0)::text AS outgoing
        FROM inv_so_lines sl
        JOIN inv_sales_orders so ON so.id = sl.so_id
        WHERE so.org_id = ${orgId}
          AND sl.product_variant_id = ${variantId}
          AND so.status IN ('CONFIRMED', 'SHIPPED')
          ${warehouseId ? sql`AND so.warehouse_id = ${warehouseId}` : sql``}
      `),
      this.db.execute(sql`
        SELECT
          w.id AS warehouse_id,
          w.name AS warehouse_name,
          COALESCE(SUM(sl.on_hand::numeric), 0)::text AS on_hand,
          COALESCE(SUM(sl.committed::numeric), 0)::text AS committed,
          ${availableQtySumSql("sl")}::text AS available
        FROM inv_stock_levels sl
        JOIN inv_locations loc ON loc.id = sl.location_id
        JOIN inv_warehouses w ON w.id = loc.warehouse_id
        WHERE sl.org_id = ${orgId} AND sl.product_variant_id = ${variantId}
        ${warehouseId ? sql`AND w.id = ${warehouseId}` : sql``}
        GROUP BY w.id, w.name
      `),
    ]);

    const stockRow = stockRows[0];
    const incomingRow = incomingRows[0];
    const outgoingRow = outgoingRows[0];

    const onHand = parseFloat(String(stockRow?.["on_hand"] ?? "0"));
    const committed = parseFloat(String(stockRow?.["committed"] ?? "0"));
    const incoming = parseFloat(String(incomingRow?.["incoming"] ?? "0"));
    const outgoing = parseFloat(String(outgoingRow?.["outgoing"] ?? "0"));

    // A1/A2. Exact and complete, and computed by the one definition in
    // `available-sql.ts`. This used to be a TypeScript re-derivation from the
    // summed buckets: it dropped outgoing_qty, it used floats, and once
    // availability became location-aware it could not have been made right at
    // all, because the sum has already thrown away which location each row was.
    //
    // `outgoing` below is open sales-order demand, not the `outgoing_qty`
    // projection bucket — picked, not yet shipped. Conflating the two is easy
    // and produces a number that looks right.
    const available = parseFloat(String(stockRow?.["available"] ?? "0"));
    const forecasted = onHand + incoming - outgoing;

    return {
      variantId,
      onHand: onHand.toFixed(4),
      available: available.toFixed(4),
      committed: committed.toFixed(4),
      incoming: incoming.toFixed(4),
      outgoing: outgoing.toFixed(4),
      forecasted: forecasted.toFixed(4),
      warehouseBreakdown,
    };
  }
}
