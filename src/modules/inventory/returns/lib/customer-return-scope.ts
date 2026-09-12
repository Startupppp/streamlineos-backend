import { sql, type SQL } from "drizzle-orm";
import { invCustomerReturns } from "../../../../db/schema";
import type { ResolvedWarehouseScope } from "../../stock-engine/warehouse-scope.service";

/**
 * Which returns this caller may see — the list's rule, now the only copy.
 *
 * A return carries no warehouse of its own. It is attributable through
 * whichever source document it came back against — the order or the shipment
 * — and a return with neither belongs to no warehouse.
 *
 * The NULL rule falls out of that and is worth stating, because it differs by
 * table on purpose. A NULL `so_id` makes `NULL IN (…)` NULL, likewise a NULL
 * `shipment_id`, and `NULL OR NULL` is NULL, so a return anchored to neither
 * document is **excluded** from a scoped caller's view. That is the opposite
 * of the ASN detail, where an unattributed row stays visible to everyone: an
 * ASN header names its warehouse nullably because it may not be known yet,
 * whereas a return with no order and no shipment is anchored to nothing and
 * showing it to every operator in the org would be a different list from the
 * one this has always been. Each detail follows its own aggregate.
 */
export function returnInScope(orgId: string, scope: ResolvedWarehouseScope): SQL {
  return scope.anyOf(
    sql`${invCustomerReturns.soId} IN (SELECT id FROM inv_sales_orders WHERE org_id = ${orgId} AND ${scope.warehouse(sql.raw("warehouse_id"))})`,
    sql`${invCustomerReturns.shipmentId} IN (SELECT id FROM inv_shipments WHERE org_id = ${orgId} AND ${scope.warehouse(sql.raw("warehouse_id"))})`,
  );
}
