import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { invUserWarehouses, invLocations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** `null` means unrestricted — the caller holds the org-wide scope permission. */
export type WarehouseScope = number[] | null;

/** A scope resolved once, carrying its predicates and its cache discriminator. */
export interface ResolvedWarehouseScope {
  /** Cache discriminator — must appear in the key of any list this scope filters. */
  key: string;
  /** The caller holds no warehouse at all, so every scoped list is empty. */
  isEmpty: boolean;
  /** The caller holds the org-wide permission; no predicate is applied. */
  unrestricted: boolean;
  warehouse: (column: SQL) => SQL;
  location: (column: SQL | string) => SQL;
  /**
   * In scope when any one of the given attributions names a permitted
   * warehouse.
   *
   * Almost every inventory document names its warehouse nullably and some name
   * a location instead, so a row can be attributed either way. Requiring both
   * would deny a reservation whose location is in scope purely because its
   * warehouse column is null.
   */
  anyOf: (...predicates: SQL[]) => SQL;
}

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

  /**
   * The cache discriminator for a resolved scope.
   *
   * A scoped list cached under a scope-free key serves one caller's warehouses
   * to the next, which defeats the scope in both directions. Three call sites
   * derived this by hand before; it lives here so the next one cannot get it
   * subtly different.
   */
  scopeKey(scope: WarehouseScope): string {
    if (scope === null) return "all";
    if (scope.length === 0) return "none";
    return [...scope].sort((a, b) => a - b).join(".");
  }

  /** Resolve once and carry the predicate builders and cache key together. */
  async forUser(orgId: string, userId: string): Promise<ResolvedWarehouseScope> {
    const scope = await this.resolve(orgId, userId);
    return {
      key: this.scopeKey(scope),
      isEmpty: scope !== null && scope.length === 0,
      unrestricted: scope === null,
      warehouse: (column: SQL) => this.warehousePredicate(scope, column),
      location: (column: SQL | string) => this.locationPredicate(scope, column),
      anyOf: (...predicates: SQL[]) =>
        scope === null ? sql`TRUE` : sql`(${sql.join(predicates, sql` OR `)})`,
    };
  }

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

  /** Warehouse ids as a SQL list, for callers embedding their own subquery. */
  warehouseIdList(scope: WarehouseScope): SQL | null {
    if (scope === null || scope.length === 0) return null;
    return sql.join(scope.map((id) => sql`${id}`), sql`, `);
  }

  /** Predicate over a warehouse column. */
  warehousePredicate(scope: WarehouseScope, warehouseColumn: SQL): SQL {
    if (scope === null) return sql`TRUE`;
    if (scope.length === 0) return sql`FALSE`;
    return sql`${warehouseColumn} IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})`;
  }

  /**
   * Object gate for a document that names its warehouse.
   *
   * Throws NotFound rather than Forbidden: a 403 on an id the caller may not see
   * confirms the record exists, which turns a probe into an existence oracle. A
   * document attributed to no warehouse is attributable to none of the caller's,
   * so it is not visible either.
   */
  async assertWarehouseVisible(
    orgId: string,
    userId: string,
    warehouseId: number | null | undefined,
  ): Promise<void> {
    const scope = await this.resolve(orgId, userId);
    if (scope === null) return;
    if (warehouseId == null || !scope.includes(warehouseId))
      throw new NotFoundException("Not found");
  }

  /** The same gate for a document that names a location instead of a warehouse. */
  async assertLocationVisible(
    orgId: string,
    userId: string,
    locationId: number | null | undefined,
  ): Promise<void> {
    const scope = await this.resolve(orgId, userId);
    if (scope === null) return;
    if (locationId == null) throw new NotFoundException("Not found");
    const [inScope] = await this.db
      .select({ id: invLocations.id })
      .from(invLocations)
      .where(and(
        eq(invLocations.orgId, orgId),
        eq(invLocations.id, locationId),
        inArray(invLocations.warehouseId, scope),
      ));
    if (!inScope) throw new NotFoundException("Not found");
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
