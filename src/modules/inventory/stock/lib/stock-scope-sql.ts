import { sql, type SQL } from "drizzle-orm";
import type { WarehouseScope } from "../../stock-engine/warehouse-scope.service";

/**
 * The two warehouse-scope SQL helpers from `inv-stock.service.ts`, moved unchanged. Both are pure functions of the resolved scope — no db, no service state — and they are only ever used to build a predicate for the three list queries that stayed behind.
 */
  /**
   * Warehouse scope as a SQL fragment plus a cache discriminator. The
   * discriminator is mandatory: this list is cached per org, so a per-user
   * predicate without it would serve one operator's warehouses to the next.
   */
export function scopeFragment(
scope: WarehouseScope, orgId: string): { sql: SQL; key: string } {
    if (scope === null) return { sql: sql``, key: "all" };
    if (scope.length === 0) return { sql: sql`AND FALSE`, key: "none" };
    return {
      sql: sql`AND ${scopePredicate(scope, orgId, sql.raw("sl.location_id"))}`,
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
export function scopePredicate(
scope: WarehouseScope, orgId: string, locationColumn: SQL): SQL {
    if (scope === null) return sql`TRUE`;
    if (scope.length === 0) return sql`FALSE`;
    const ids = sql.join(scope.map((id) => sql`${id}`), sql`, `);
    return sql`${locationColumn} IN (SELECT id FROM inv_locations WHERE org_id = ${orgId} AND warehouse_id IN (${ids}))`;
  }
