import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { ResolvedWarehouseScope } from "../stock-engine/warehouse-scope.service";
import type { PackingQueueQueryInput } from "./dto/shipments.schemas";
import { cmpDec } from "../stock-engine/decimal";

export interface PackingQueueRow {
  soId: number;
  soNumber: string;
  status: string;
  orderDate: string;
  warehouseId: number | null;
  customerName: string | null;
  pickedQuantity: string;
  packedQuantity: string;
  packageCount: number;
  openPackageCount: number;
  openPackageId: number | null;
  fullyPacked: boolean;
}

export interface PackingQueuePage {
  items: PackingQueueRow[];
  total: number;
  page: number;
  totalPages: number;
}

/**
 * B6 — the queue the packing bench reads.
 *
 * Off the cartons and the picked quantities, not off `inv_sales_orders.status`
 * alone. A status-only queue drops an order the moment somebody starts packing
 * it, so a half-packed order with an open carton on the bench disappears from
 * the screen of the person packing it; and it shows an order whose goods are
 * still on the shelf as ready to pack.
 *
 * The picked side is joined through `inv_so_lines`, so a wave — whose pick list
 * carries a null `so_id` — counts here exactly as a single-order pick does. Not
 * cached: several packers work this list at once, and an order leaves it the
 * moment its last unit goes in a box.
 */
export async function readPackingQueue(
  db: DbOrTx,
  orgId: string,
  scope: ResolvedWarehouseScope,
  query: PackingQueueQueryInput,
): Promise<PackingQueuePage> {
  const { warehouseId, page, limit } = query;
  const offset = (page - 1) * limit;
  if (scope.isEmpty) return { items: [], total: 0, page, totalPages: 0 };

  const rows = await db.execute<{
    so_id: number;
    so_number: string;
    status: string;
    order_date: string;
    warehouse_id: number | null;
    customer_name: string | null;
    picked_qty: string;
    packed_qty: string;
    package_count: number;
    open_package_count: number;
    open_package_id: number | null;
    total: number;
  }>(sql`
    WITH picked AS (
      SELECT sol.so_id, SUM(pll.quantity_picked) AS qty
        FROM inv_pick_list_lines pll
        JOIN inv_pick_lists pl
          ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
        JOIN inv_so_lines sol
          ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
       WHERE pll.org_id = ${orgId}
         AND pl.status <> 'CANCELLED'
       GROUP BY sol.so_id
    ),
    packed AS (
      SELECT pkg.so_id,
             COALESCE(SUM(contents.qty), 0) AS qty,
             COUNT(*) AS package_count,
             COUNT(*) FILTER (WHERE pkg.status = 'OPEN') AS open_package_count,
             MIN(pkg.id) FILTER (WHERE pkg.status = 'OPEN') AS open_package_id
        FROM inv_packages pkg
        LEFT JOIN LATERAL (
          SELECT SUM(quantity) AS qty
            FROM inv_package_lines
           WHERE org_id = pkg.org_id AND package_id = pkg.id
        ) contents ON TRUE
       WHERE pkg.org_id = ${orgId} AND pkg.so_id IS NOT NULL
       GROUP BY pkg.so_id
    )
    SELECT so.id AS so_id,
           so.so_number,
           so.status::text AS status,
           so.order_date::text AS order_date,
           so.warehouse_id,
           bp.display_name AS customer_name,
           COALESCE(picked.qty, 0)::text AS picked_qty,
           COALESCE(packed.qty, 0)::text AS packed_qty,
           COALESCE(packed.package_count, 0)::int AS package_count,
           COALESCE(packed.open_package_count, 0)::int AS open_package_count,
           packed.open_package_id,
           COUNT(*) OVER ()::int AS total
      FROM inv_sales_orders so
      LEFT JOIN picked ON picked.so_id = so.id
      LEFT JOIN packed ON packed.so_id = so.id
      LEFT JOIN business_parties bp
        ON bp.organization_id = so.org_id AND bp.party_id = so.client_party_id
     WHERE so.org_id = ${orgId}
       AND so.status IN ('PICKED', 'PACKED')
       AND (COALESCE(picked.qty, 0) > 0 OR COALESCE(packed.package_count, 0) > 0)
       AND ${warehouseId === undefined ? sql`TRUE` : sql`so.warehouse_id = ${warehouseId}`}
       AND ${scope.warehouse(sql.raw("so.warehouse_id"))}
     ORDER BY so.order_date, so.id
     LIMIT ${limit} OFFSET ${offset}
  `);

  const total = Number(rows[0]?.total ?? 0);
  return {
    items: rows.map((row) => ({
      soId: Number(row.so_id),
      soNumber: row.so_number,
      status: row.status,
      orderDate: row.order_date,
      warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
      customerName: row.customer_name,
      pickedQuantity: String(row.picked_qty),
      packedQuantity: String(row.packed_qty),
      packageCount: Number(row.package_count),
      openPackageCount: Number(row.open_package_count),
      openPackageId: row.open_package_id === null ? null : Number(row.open_package_id),
      fullyPacked: cmpDec(String(row.packed_qty), String(row.picked_qty)) >= 0,
    })),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}
