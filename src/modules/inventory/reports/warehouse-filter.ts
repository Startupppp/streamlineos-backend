import { sql, type SQL } from "drizzle-orm";

/**
 * The locations that belong to one warehouse, as a subquery.
 *
 * `inv_grns` names a `location_id` and has no warehouse column, so "this
 * warehouse's receipts" can only be asked through `inv_locations` — which is
 * exactly the resolution `WarehouseScopeService.locationPredicate` already
 * performs for the *scope*. This is the same resolution for an explicit
 * *filter*, kept in one place so a report and a list cannot drift into
 * disagreeing about which receipts belong to a warehouse.
 *
 * A filter is not a scope. This narrows a result the scope predicate has
 * already bounded; used on its own it would look like an access control and be
 * none, so every call site applies it beside `scope.location(...)`, never
 * instead of it.
 */
export function locationsInWarehouse(orgId: string, warehouseId: number): SQL {
  return sql`(SELECT id FROM inv_locations WHERE org_id = ${orgId} AND warehouse_id = ${warehouseId})`;
}
