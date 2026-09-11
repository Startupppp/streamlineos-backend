import { sql, type SQL } from "drizzle-orm";
import { invShipments } from "../../../../db/schema";
import type { ResolvedWarehouseScope } from "../../stock-engine/warehouse-scope.service";

/**
 * Which shipments this caller may see — the list's rule, now the only copy.
 *
 * A shipment names its warehouse directly, so the rule is the plain column
 * predicate. The NULL half of it is worth stating because it differs by table
 * on purpose: `NULL IN (…)` is NULL, so a shipment attributed to no warehouse
 * is INVISIBLE to a scoped operator, exactly as it already was in the list.
 * That is the opposite of the ASN header, which keeps an `IS NULL` escape
 * because its warehouse may genuinely not be known yet. Each detail follows
 * its own aggregate, and this one follows the list above it.
 *
 * Private and single so the detail reads cannot drift from the list: two
 * hand-copied predicates agreeing today is not the same as them being one.
 */
export function shipmentInScope(scope: ResolvedWarehouseScope): SQL {
  return scope.warehouse(sql`${invShipments.warehouseId}`);
}
