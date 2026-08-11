import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { invUserWarehouses, invLocations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** `null` means unrestricted — the caller holds the org-wide scope permission. */
export type WarehouseScope = number[] | null;

export const SCOPE_ALL_PERMISSION = "inventory:warehouses:scope-all";

/**
 * Warehouse-level access scoping.
 *
 * RBAC `DataScope` runs on a user axis (own / team / all) and cannot express
 * "this operator transacts only in these warehouses". `team` scope is also under
 * a standing prohibition until its correlated subquery is removed, so this
 * resolves to a plain id list and is applied as an `IN` predicate — never a
 * correlated subquery.
 *
 * Deny by default: a user without the org-wide permission sees only the
 * warehouses explicitly assigned to them. No assignments means no stock.
 */
@Injectable()
export class WarehouseScopeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async resolve(orgId: string, userId: string): Promise<WarehouseScope> {
    const permissions = await this.access.resolveUserPermissions(orgId, userId);
    if (permissions.has(SCOPE_ALL_PERMISSION)) return null;

    const rows = await this.db
      .select({ warehouseId: invUserWarehouses.warehouseId })
      .from(invUserWarehouses)
      .where(and(eq(invUserWarehouses.orgId, orgId), eq(invUserWarehouses.userId, userId)));

    return rows.map((r) => r.warehouseId);
  }

  /** Predicate over a location column. Unrestricted returns TRUE; empty scope returns FALSE. */
  locationPredicate(scope: WarehouseScope, locationColumn: SQL | string): SQL {
    if (scope === null) return sql`TRUE`;
    if (scope.length === 0) return sql`FALSE`;
    const col = typeof locationColumn === "string" ? sql.raw(locationColumn) : locationColumn;
    return sql`${col} IN (
      SELECT id FROM inv_locations
      WHERE warehouse_id IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})
    )`;
  }

  /** Predicate over a warehouse column. */
  warehousePredicate(scope: WarehouseScope, warehouseColumn: SQL): SQL {
    if (scope === null) return sql`TRUE`;
    if (scope.length === 0) return sql`FALSE`;
    return sql`${warehouseColumn} IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})`;
  }

  /**
   * Write-side gate. Every stock mutation resolves to one or more locations, so
   * asserting here covers receipts, issues, transfers, adjustments and counts
   * without each caller re-implementing the check.
   */
  async assertLocationsInScope(
    tx: Tx,
    orgId: string,
    userId: string,
    locationIds: readonly number[],
  ): Promise<void> {
    const scope = await this.resolve(orgId, userId);
    if (scope === null) return;

    const unique = Array.from(new Set(locationIds));
    if (unique.length === 0) return;

    if (scope.length === 0) {
      throw new ForbiddenException("You are not assigned to any warehouse");
    }

    const allowed = await tx
      .select({ id: invLocations.id })
      .from(invLocations)
      .where(and(
        eq(invLocations.orgId, orgId),
        inArray(invLocations.id, unique),
        inArray(invLocations.warehouseId, scope),
      ));

    if (allowed.length !== unique.length) {
      throw new ForbiddenException("This movement touches a warehouse you are not assigned to");
    }
  }
}
