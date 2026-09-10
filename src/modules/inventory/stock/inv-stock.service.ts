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

/**
 * The response shape, as a cache-key discriminator.
 *
 * `listStockLevels` is cached, and the row shape changed: the response used to
 * carry the driver's own snake_case column names and no joins at all, so
 * `on_hand` arrived where the client reads `onHand` and every product and
 * location name rendered as a dash. Entries of that old shape are still sitting
 * in Redis under the current namespace version at deploy time, and the version
 * is per-org -- there is no boot-time hook that could bump every tenant's.
 *
 * So the shape rides in the key instead of relying on eviction. A new deploy
 * simply reads at a key no old entry occupies, which costs one cold fill per
 * key and cannot serve a single stale row of the previous shape. Bump it
 * whenever the fields below change again.
 */
const RESPONSE_SHAPE = "s2";

/**
 * One stock-level row as it reaches the wire.
 *
 * Written out rather than inferred because the frontend hook writes it out too
 * (`RawStockLevel` in `hooks/api/inventory/stock-levels.ts`) and the two halves
 * are a contract: this is the shape that hook parses, field for field, and the
 * nesting mirrors `listTransactions` because that is how this module already
 * hands a client an identity for a variant and a bin.
 *
 * Every quantity is a STRING. These are Postgres `numeric` columns, the driver
 * returns them as strings, and the hook's type says string and calls `Number()`
 * on them. Declaring a number here and shipping a string is precisely how the
 * table came to read `NaN`.
 */
export interface StockLevelItem {
  id: number;
  onHand: string;
  committed: string;
  onOrder: string;
  available: string;
  blockedQty: string;
  qualityHoldQty: string;
  averageCost: string | null;
  productVariant: {
    id: number;
    name: string | null;
    sku: string | null;
    product: { id: number; name: string; sku: string; reorderPoint: string | null } | null;
  } | null;
  location: {
    id: number;
    name: string;
    code: string;
    warehouse: { id: number; name: string } | null;
  } | null;
}

/**
 * The row as the join hands it over.
 *
 * Drizzle's `select()` groups columns one level deep and no further -- a third
 * level is not a nested selection to it, it is a value, and it fails to compile.
 * So the product and the warehouse ride flat inside their parent's group and are
 * re-nested by `toStockLevelItem` below. That is also why nothing here is
 * nullable-by-group: a group mixing two tables is never nullified wholesale by
 * the driver mapper, so each field arrives null on its own and the parent object
 * is decided explicitly.
 */
interface StockLevelJoinRow {
  id: number;
  onHand: string;
  committed: string;
  onOrder: string;
  available: string;
  blockedQty: string;
  qualityHoldQty: string;
  averageCost: string | null;
  productVariant: {
    id: number | null;
    name: string | null;
    sku: string | null;
    productId: number | null;
    productName: string | null;
    productSku: string | null;
    reorderPoint: string | null;
  };
  location: {
    id: number | null;
    name: string | null;
    code: string | null;
    warehouseId: number | null;
    warehouseName: string | null;
  };
}

/**
 * Re-nests a joined row into the shape the client parses.
 *
 * The null checks are per-field rather than a single `id === null` probe on
 * purpose: `name` and `code` are `NOT NULL` columns, so testing them is what
 * narrows them from `string | null` to `string` without an assertion, and an
 * assertion is the thing that would let a genuinely absent join through as a
 * half-built object.
 */
export function toStockLevelItem(row: StockLevelJoinRow): StockLevelItem {
  const variant = row.productVariant;
  const location = row.location;

  const product =
    variant.productId !== null && variant.productName !== null && variant.productSku !== null
      ? { id: variant.productId, name: variant.productName, sku: variant.productSku, reorderPoint: variant.reorderPoint }
      : null;

  const warehouse =
    location.warehouseId !== null && location.warehouseName !== null
      ? { id: location.warehouseId, name: location.warehouseName }
      : null;

  return {
    id: row.id,
    onHand: row.onHand,
    committed: row.committed,
    onOrder: row.onOrder,
    available: row.available,
    blockedQty: row.blockedQty,
    qualityHoldQty: row.qualityHoldQty,
    averageCost: row.averageCost,
    productVariant:
      variant.id === null
        ? null
        : { id: variant.id, name: variant.name, sku: variant.sku, product },
    location:
      location.id === null || location.name === null || location.code === null
        ? null
        : { id: location.id, name: location.name, code: location.code, warehouse },
  };
}

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
    return {
      sql: sql`AND ${this.scopePredicate(scope, orgId, sql.raw("sl.location_id"))}`,
      key: [...scope].sort((a, b) => a - b).join("."),
    };
  }

  /**
   * The same scope as a bare predicate over a location column the caller names.
   *
   * `scopeFragment` above splices into hand-written SQL that aliases
   * `inv_stock_levels` as `sl`; `listStockLevels` builds its `WHERE` out of
   * Drizzle conditions over the unaliased table. One of them has to say which
   * column it means, so both go through this and the subquery -- which is the
   * part that decides who may see which building -- exists once.
   */
  private scopePredicate(scope: WarehouseScope, orgId: string, locationColumn: SQL): SQL {
    if (scope === null) return sql`TRUE`;
    if (scope.length === 0) return sql`FALSE`;
    const ids = sql.join(scope.map((id) => sql`${id}`), sql`, `);
    return sql`${locationColumn} IN (SELECT id FROM inv_locations WHERE org_id = ${orgId} AND warehouse_id IN (${ids}))`;
  }

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
        this.scopePredicate(scope, orgId, sql`${invStockLevels.locationId}`),
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
