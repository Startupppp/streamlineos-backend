import { sql, type SQL } from "drizzle-orm";
import { invRecallEvents } from "../../../../db/schema";
import type { ResolvedWarehouseScope } from "../../stock-engine/warehouse-scope.service";

/**
 * INV-109. A recall carries no warehouse of its own; it is attributable
 * through the lots and variants its lines name, and those through the stock
 * they hold. A recall touching nothing an operator can see stays out of their
 * list — and, since INV-SCOPE-QUALITY, out of their detail too.
 *
 * The NULL rule falls out of the EXISTS and is worth naming: a recall whose
 * lines match no stock row in any of the caller's warehouses — including one
 * matching no stock at all — is **excluded**. It is not the ASN rule, where an
 * unattributed row stays visible to everyone; a recall is attributed
 * indirectly, so "no attribution" here means "touches nothing you hold", not
 * "not yet filled in". Lives in one place so the list and the detail cannot
 * drift apart, which is how this defect got written in the first place.
 *
 * Hiding a safety event reads uncomfortably, so worth being explicit:
 * visibility is not what stops recalled goods moving. The allocator refuses a
 * recalled lot under every strategy regardless of who is looking, so scoping
 * changes what an operator reads, never what the engine permits.
 */
export function recallInScope(orgId: string, scope: ResolvedWarehouseScope): SQL | undefined {
  if (scope.unrestricted) return undefined;
  return sql`EXISTS (
    SELECT 1
    FROM inv_recall_lines rl
    JOIN inv_stock_levels sl
      ON sl.org_id = rl.org_id
     AND (sl.lot_id = rl.lot_id
          OR (rl.lot_id IS NULL AND sl.product_variant_id = rl.product_variant_id))
    WHERE rl.org_id = ${orgId}
      AND rl.recall_id = ${invRecallEvents.id}
      AND ${scope.location(sql`sl.location_id`)}
  )`;
}
