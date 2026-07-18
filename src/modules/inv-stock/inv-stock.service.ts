import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  invStockLevels, invStockTransactions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type {
  ListStockLevelsInput, ListTransactionsInput, AvailabilityQueryInput,
} from "./dto/inv-stock.schemas";

@Injectable()
export class InvStockService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async listStockLevels(orgId: string, filters: ListStockLevelsInput) {
    const { warehouseId, locationId, productId, variantId, lotId, serialId, lowStock, negative, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${warehouseId ?? ""}:${locationId ?? ""}:${productId ?? ""}:${variantId ?? ""}:${lotId ?? ""}:${serialId ?? ""}:${lowStock ?? ""}:${negative ?? ""}:${search ?? ""}:${limit}:${offset}`;

    return this.cache.cached(CACHE_KEYS.invStockLevels(orgId, hash), async () => {

      const rows = await this.db.execute<{
        id: number; org_id: string; product_variant_id: number; location_id: number;
        lot_id: number | null; serial_id: number | null;
        on_hand: string; committed: string; on_order: string;
        blocked_qty: string | null; quality_hold_qty: string | null;
        outgoing_qty: string | null; average_cost: string | null; updated_at: string;
      }>(sql`
        SELECT sl.*,
          (sl.on_hand::numeric - sl.committed::numeric - COALESCE(sl.blocked_qty, 0)::numeric - COALESCE(sl.quality_hold_qty, 0)::numeric) AS available
        FROM inv_stock_levels sl
        WHERE sl.org_id = ${orgId}
          ${locationId ? sql`AND sl.location_id = ${locationId}` : sql``}
          ${variantId ? sql`AND sl.product_variant_id = ${variantId}` : sql``}
          ${lotId ? sql`AND sl.lot_id = ${lotId}` : sql``}
          ${serialId ? sql`AND sl.serial_id = ${serialId}` : sql``}
          ${negative ? sql`AND sl.on_hand::numeric < 0` : sql``}
          ${warehouseId ? sql`AND sl.location_id IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId} AND org_id = ${orgId})` : sql``}
          ${productId ? sql`AND sl.product_variant_id IN (SELECT id FROM inv_product_variants WHERE product_id = ${productId})` : sql``}
          ${search ? sql`AND sl.product_variant_id IN (SELECT v.id FROM inv_product_variants v JOIN inv_products p ON p.id = v.product_id WHERE p.org_id = ${orgId} AND (p.name ILIKE ${"%" + search + "%"} OR p.sku ILIKE ${"%" + search + "%"} OR v.sku ILIKE ${"%" + search + "%"}))` : sql``}
          ${lowStock ? sql`AND sl.on_hand::numeric <= COALESCE((SELECT p.reorder_point::numeric FROM inv_product_variants v JOIN inv_products p ON p.id = v.product_id WHERE v.id = sl.product_variant_id), 0)` : sql``}
        ORDER BY sl.updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      const [countResult] = await this.db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM inv_stock_levels sl
        WHERE sl.org_id = ${orgId}
          ${locationId ? sql`AND sl.location_id = ${locationId}` : sql``}
          ${variantId ? sql`AND sl.product_variant_id = ${variantId}` : sql``}
          ${lotId ? sql`AND sl.lot_id = ${lotId}` : sql``}
          ${serialId ? sql`AND sl.serial_id = ${serialId}` : sql``}
          ${negative ? sql`AND sl.on_hand::numeric < 0` : sql``}
          ${warehouseId ? sql`AND sl.location_id IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId} AND org_id = ${orgId})` : sql``}
          ${productId ? sql`AND sl.product_variant_id IN (SELECT id FROM inv_product_variants WHERE product_id = ${productId})` : sql``}
          ${search ? sql`AND sl.product_variant_id IN (SELECT v.id FROM inv_product_variants v JOIN inv_products p ON p.id = v.product_id WHERE p.org_id = ${orgId} AND (p.name ILIKE ${"%" + search + "%"} OR p.sku ILIKE ${"%" + search + "%"} OR v.sku ILIKE ${"%" + search + "%"}))` : sql``}
          ${lowStock ? sql`AND sl.on_hand::numeric <= COALESCE((SELECT p.reorder_point::numeric FROM inv_product_variants v JOIN inv_products p ON p.id = v.product_id WHERE v.id = sl.product_variant_id), 0)` : sql``}
      `);

      const total = countResult?.count ?? 0;
      return { items: rows, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  async listTransactions(orgId: string, filters: ListTransactionsInput) {
    const { productVariantId, warehouseId, locationId, transactionType, direction, search, fromDate, toDate, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions: SQL[] = [eq(invStockTransactions.orgId, orgId)];
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
      sql`${invStockTransactions.productVariantId} IN (SELECT v.id FROM inv_product_variants v JOIN inv_products p ON p.id = v.product_id WHERE p.org_id = ${orgId} AND (p.name ILIKE ${"%" + search + "%"} OR p.sku ILIKE ${"%" + search + "%"} OR v.sku ILIKE ${"%" + search + "%"} OR v.barcode ILIKE ${"%" + search + "%"}))`,
    );

    const where = and(...conditions);
    const [items, countResult] = await Promise.all([
      this.db.query.invStockTransactions.findMany({
        where,
        orderBy: [desc(invStockTransactions.createdAt)],
        limit,
        offset,
        with: {
          productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
          location: {
            columns: { id: true, name: true, code: true },
            with: { warehouse: { columns: { id: true, name: true } } },
          },
          creator: { columns: { id: true, name: true } },
        },
      }),
      this.db.select({ count: sql<number>`count(*)::int` }).from(invStockTransactions).where(where),
    ]);

    return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
  }

  async getAvailability(orgId: string, filters: AvailabilityQueryInput) {
    const { variantId, warehouseId } = filters;

    const [stockRow] = await this.db.execute<{
      on_hand: string; committed: string; blocked_qty: string; quality_hold_qty: string;
    }>(sql`
      SELECT
        COALESCE(SUM(on_hand::numeric), 0)::text AS on_hand,
        COALESCE(SUM(committed::numeric), 0)::text AS committed,
        COALESCE(SUM(COALESCE(blocked_qty, 0)::numeric), 0)::text AS blocked_qty,
        COALESCE(SUM(COALESCE(quality_hold_qty, 0)::numeric), 0)::text AS quality_hold_qty
      FROM inv_stock_levels sl
      WHERE sl.org_id = ${orgId} AND sl.product_variant_id = ${variantId}
      ${warehouseId ? sql`AND sl.location_id IN (SELECT id FROM inv_locations WHERE warehouse_id = ${warehouseId})` : sql``}
    `);

    const [incomingRow] = await this.db.execute<{ incoming: string }>(sql`
      SELECT COALESCE(SUM((pl.quantity::numeric - pl.quantity_received::numeric)), 0)::text AS incoming
      FROM inv_po_lines pl
      JOIN inv_purchase_orders po ON po.id = pl.po_id
      WHERE po.org_id = ${orgId}
        AND pl.product_variant_id = ${variantId}
        AND po.status IN ('SENT', 'PARTIAL')
        ${warehouseId ? sql`AND po.warehouse_id = ${warehouseId}` : sql``}
    `);

    const [outgoingRow] = await this.db.execute<{ outgoing: string }>(sql`
      SELECT COALESCE(SUM((sl.quantity::numeric - sl.quantity_shipped::numeric)), 0)::text AS outgoing
      FROM inv_so_lines sl
      JOIN inv_sales_orders so ON so.id = sl.so_id
      WHERE so.org_id = ${orgId}
        AND sl.product_variant_id = ${variantId}
        AND so.status IN ('CONFIRMED', 'SHIPPED')
        ${warehouseId ? sql`AND so.warehouse_id = ${warehouseId}` : sql``}
    `);

    const onHand = parseFloat(stockRow?.on_hand ?? "0");
    const committed = parseFloat(stockRow?.committed ?? "0");
    const blocked = parseFloat(stockRow?.blocked_qty ?? "0");
    const qualityHold = parseFloat(stockRow?.quality_hold_qty ?? "0");
    const incoming = parseFloat(incomingRow?.incoming ?? "0");
    const outgoing = parseFloat(outgoingRow?.outgoing ?? "0");

    const available = onHand - committed - blocked - qualityHold;
    const forecasted = onHand + incoming - outgoing;

    const warehouseBreakdown = await this.db.execute<{
      warehouse_id: number; warehouse_name: string;
      on_hand: string; committed: string; available: string;
    }>(sql`
      SELECT
        w.id AS warehouse_id,
        w.name AS warehouse_name,
        COALESCE(SUM(sl.on_hand::numeric), 0)::text AS on_hand,
        COALESCE(SUM(sl.committed::numeric), 0)::text AS committed,
        COALESCE(SUM(sl.on_hand::numeric - sl.committed::numeric - COALESCE(sl.blocked_qty, 0)::numeric - COALESCE(sl.quality_hold_qty, 0)::numeric), 0)::text AS available
      FROM inv_stock_levels sl
      JOIN inv_locations loc ON loc.id = sl.location_id
      JOIN inv_warehouses w ON w.id = loc.warehouse_id
      WHERE sl.org_id = ${orgId} AND sl.product_variant_id = ${variantId}
      ${warehouseId ? sql`AND w.id = ${warehouseId}` : sql``}
      GROUP BY w.id, w.name
    `);

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
