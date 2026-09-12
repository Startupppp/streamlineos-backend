import { sql, type SQL } from "drizzle-orm";
import { invAiInsights } from "../../../../db/schema";
import type { WarehouseScope } from "../../stock-engine/warehouse-scope.service";

/**
 * F3 — who may see a finding, expressed once.
 *
 * There are two ways into `inv_ai_insights`: the anomaly queue, and the older
 * insights list and status route that the dashboard panel still calls. Before
 * this file the queue was scoped and the older pair were not, which is the
 * worst possible arrangement — a gate that a second route walks around is a gate
 * that only makes the audit look better. Both now call this.
 *
 * The rule, and the half that would be easy to get wrong:
 *
 *   * a finding that **names a warehouse** — a late purchase order, an expiring
 *     lot whose stock sits in one place — is visible to a caller who holds that
 *     warehouse, exactly as the underlying record is on its own screen;
 *   * a finding that **names none** aggregates a series across every site the
 *     organisation has. It describes the organisation, so it is shown only to a
 *     caller whose scope *is* the organisation.
 *
 * That second clause is the disclosure that would otherwise slip through. An
 * operator assigned to one depot would read org-wide demand and stock positions
 * off the queue — information the stock screens deny them — and nothing about
 * the screen would look wrong.
 *
 * An empty scope yields `FALSE` rather than an empty `IN ()`, which is a syntax
 * error, and rather than an omitted predicate, which is the failure that matters.
 */
export function anomalyVisibilityPredicate(scope: WarehouseScope): SQL {
  if (scope === null) return sql`TRUE`;
  if (scope.length === 0) return sql`FALSE`;
  return sql`${invAiInsights.warehouseId} IN (${sql.join(
    scope.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}
