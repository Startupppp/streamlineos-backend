import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, getTableName, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  invLocations,
  invProducts,
  invProductVariants,
  invStockLevels,
  invStockTransactions,
  invWarehouses,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { buildCursorPage, decodeTimestampCursor } from "../../../common/pagination/cursor";
import { keysetBeforeMicros, microsecondCursorValue } from "../../../common/pagination/keyset";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { CostVisibilityService, stripCostFields } from "../stock-engine/cost-visibility";
import { availableQtySql } from "../stock-engine/available-sql";
import type {
  ListStockLevelsInput, ListTransactionsInput, AvailabilityQueryInput,
} from "./dto/inv-stock.schemas";
import { scopeFragment, scopePredicate } from "./lib/stock-scope-sql";
import { RESPONSE_SHAPE, toStockLevelItem } from "./lib/stock-level-row";
import { readAvailability } from "./lib/availability-rollup";

/**
 * Re-exported so the service's public surface is what it always was — the wire
 * shape moved to sit with the function that builds it, not away from its
 * consumers.
 */
export type { StockLevelItem } from "./lib/stock-level-row";

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

/**
 * The table as it is spelled in `listStockLevels`' `FROM` clause.
 *
 * `availableQtySql` takes the alias its caller used, because the expression
 * mentions five columns by name and has to reach the right table. The query
 * below does not alias `inv_stock_levels`, so Postgres names it after itself and
 * this is that name -- read off the schema rather than typed out, so a table
 * rename cannot leave a string behind that still compiles.
 *
 * This is the trap already recorded in this module and it is worth restating:
 * the same expression inside Drizzle's RELATIONAL query builder is a runtime
 * `missing FROM-clause entry`, because that builder renames the root table to
 * its TypeScript key (`"invStockLevels"`) while the expression still says
 * `inv_stock_levels`. It typechecks, it builds, and it 500s. That is the reason
 * this list is an explicit `select()` with joins rather than a `findMany` with
 * `with:` like `listTransactions` beside it.
 */
const STOCK_LEVELS_TABLE = getTableName(invStockLevels);

@Injectable()
export class InvStockService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly costVisibility: CostVisibilityService,
  ) {}


  async listStockLevels(orgId: string, userId: string, filters: ListStockLevelsInput) {
    const { warehouseId, locationId, productId, variantId, lotId, serialId, lowStock, negative, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const scopeKey = this.warehouseScope.scopeKey(scope);
    const showCost = await this.costVisibility.canSeeCost(orgId, userId);
    const hash = `${RESPONSE_SHAPE}:${showCost ? "cost" : "nocost"}:${scopeKey}:${warehouseId ?? ""}:${locationId ?? ""}:${productId ?? ""}:${variantId ?? ""}:${lotId ?? ""}:${serialId ?? ""}:${lowStock ?? ""}:${negative ?? ""}:${search ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(`inv:stock:levels:${orgId}`, hash, async () => {
      /*
       * One predicate, shared by the page and by its count.
       * These were two hand-copied ten-line blocks of SQL, which is a filter
       * waiting to be added to one of them and not the other -- a page that
       * disagrees with its own total.
       */
      const conditions: SQL[] = [
        eq(invStockLevels.orgId, orgId),
        scopePredicate(scope, orgId, sql`${invStockLevels.locationId}`),
      ];
      if (locationId) conditions.push(eq(invStockLevels.locationId, locationId));
      if (variantId) conditions.push(eq(invStockLevels.productVariantId, variantId));
      if (lotId) conditions.push(eq(invStockLevels.lotId, lotId));
      if (serialId) conditions.push(eq(invStockLevels.serialId, serialId));
      if (negative) conditions.push(sql`${invStockLevels.onHand}::numeric < 0`);
      if (warehouseId) conditions.push(
        sql`${invStockLevels.locationId} IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId} AND org_id = ${orgId})`,
      );
      if (productId) conditions.push(
        sql`${invStockLevels.productVariantId} IN (SELECT id FROM inv_product_variants WHERE product_id = ${productId})`,
      );
      if (search) conditions.push(
        sql`${invStockLevels.productVariantId} IN (SELECT app.search_inventory_variant_ids(${search}, ${SEARCH_MATCH_CAP}))`,
      );
      /*
       * Deliberately still a correlated subquery rather than the joined
       * `inv_products` below: the count query carries no joins, and a predicate
       * that means one thing on the page and another in the total is the bug
       * this block was just collapsed to prevent.
       */
      if (lowStock) conditions.push(
        sql`${invStockLevels.onHand}::numeric <= COALESCE((SELECT p.reorder_point::numeric FROM inv_product_variants v JOIN inv_products p ON p.id = v.product_id WHERE v.id = ${invStockLevels.productVariantId}), 0)`,
      );
      const where = and(...conditions);

      /*
       * The joins are LEFT and carry no `deleted_at` filter. The row being
       * listed is the stock, not the catalogue entry: a variant that has been
       * retired while units of it are still standing in a bin is exactly the row
       * an operator most needs named, and filtering it here would put the dash
       * back on the one line that has to be explained.
       */
      // [B1-08] Run data + count queries in parallel.
      const [rows, countRows] = await Promise.all([
        this.db
          .select({
            id: invStockLevels.id,
            onHand: invStockLevels.onHand,
            committed: invStockLevels.committed,
            onOrder: invStockLevels.onOrder,
            available: sql<string>`${availableQtySql(STOCK_LEVELS_TABLE)}::text`.as("available"),
            blockedQty: sql<string>`COALESCE(${invStockLevels.blockedQty}, '0')`.as("blocked_qty"),
            qualityHoldQty: sql<string>`COALESCE(${invStockLevels.qualityHoldQty}, '0')`.as("quality_hold_qty"),
            averageCost: invStockLevels.averageCost,
            productVariant: {
              id: invProductVariants.id,
              name: invProductVariants.name,
              sku: invProductVariants.sku,
              productId: invProducts.id,
              productName: invProducts.name,
              productSku: invProducts.sku,
              reorderPoint: invProducts.reorderPoint,
            },
            location: {
              id: invLocations.id,
              name: invLocations.name,
              code: invLocations.code,
              warehouseId: invWarehouses.id,
              warehouseName: invWarehouses.name,
            },
          })
          .from(invStockLevels)
          .leftJoin(invProductVariants, eq(invProductVariants.id, invStockLevels.productVariantId))
          .leftJoin(invProducts, eq(invProducts.id, invProductVariants.productId))
          .leftJoin(invLocations, eq(invLocations.id, invStockLevels.locationId))
          .leftJoin(invWarehouses, eq(invWarehouses.id, invLocations.warehouseId))
          .where(where)
          .orderBy(desc(invStockLevels.updatedAt))
          .limit(limit)
          .offset(offset),
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(invStockLevels)
          .where(where),
      ]);

      const total = Number(countRows[0]?.count ?? 0);
      const items = rows.map(toStockLevelItem);
      /*
       * `averageCost` is the one cost-bearing field on this row and
       * `stripCostFields` knows it under both spellings, so renaming it out of
       * snake_case did not quietly disarm the strip. That is asserted rather
       * than assumed -- see `stock-levels-response-shape.spec.ts`.
       */
      return {
        items: showCost ? items : stripCostFields(items),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
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

  /** @see lib/availability-rollup.ts — the rollup moved, the scope decision did not. */
  async getAvailability(orgId: string, userId: string, filters: AvailabilityQueryInput) {
    const scope = scopeFragment(await this.warehouseScope.resolve(orgId, userId), orgId);
    return readAvailability(this.db, orgId, filters, scope);
  }
}
