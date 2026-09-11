import { sql, type SQL } from "drizzle-orm";
import { invSalesOrders } from "../../../../db/schema";
import type { ResolvedWarehouseScope } from "../../stock-engine/warehouse-scope.service";

/**
 * Which sales orders this caller may see — the list's rule, now the only copy.
 *
 * An order names its warehouse on the row, so this is the plain column
 * predicate. The NULL half is worth stating because it differs by table on
 * purpose: `warehouse_id` is nullable and `NULL IN (…)` is NULL, so an order
 * attributed to no building is INVISIBLE to a scoped caller — exactly what the
 * list has always done. That is the opposite of the ASN header, which keeps an
 * `IS NULL` escape because its warehouse may genuinely not be known yet, and
 * of the handling unit, which is built before it is put anywhere. Each detail
 * follows its own aggregate, and this one follows the list above it.
 *
 * Private and single so the detail and the edit cannot drift from the list.
 */
export function soInScope(scope: ResolvedWarehouseScope): SQL {
  return scope.warehouse(sql`${invSalesOrders.warehouseId}`);
}
