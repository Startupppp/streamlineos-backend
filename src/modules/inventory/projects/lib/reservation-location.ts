import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { invLocations, invStockLevels, invStockReservations } from "../../../../db/schema";
import {
  type WarehouseScope,
  type WarehouseScopeService,
} from "../../stock-engine/warehouse-scope.service";
import { availableQtySql } from "../../stock-engine/available-sql";
import { addDec, cmpDec } from "../../stock-engine/decimal";
import { PROJECT_REQUIREMENT_SOURCE } from "../inv-projects.constants";

/**
 * Where a project hold is taken from, and where its existing holds stand.
 *
 * Split out of `inv-projects.service.ts` (1016 lines) unchanged: these three
 * read the database and the warehouse scope and nothing else off the service,
 * so they take both as parameters rather than reaching through `this`. No
 * behaviour is altered — the bodies are moved verbatim and the reasoning that
 * came with them is moved with them, because that reasoning is the part that is
 * expensive to reconstruct.
 */
export async function assertHoldsInScope(
    warehouseScope: WarehouseScopeService,
    orgId: string,
    userId: string,
    holds: readonly { locationId: number | null }[],
  ): Promise<void> {
    for (const hold of holds) {
      await warehouseScope.assertLocationVisible(orgId, userId, hold.locationId);
    }
  }

  /**
   * B1 — which bin a project hold should be taken from.
   *
   * `ReservationService` refuses a reservation with no location, and rightly:
   * a promise that names no bin cannot lock a stock row, cannot be checked
   * against availability and cannot decrement `committed` anywhere. But a site
   * engineer names a dark store, not a bin — so the bin has to be resolved here.
   *
   * The rule is "the single pickable location at that store with the most
   * available, if it can cover the whole quantity". A single location and not a
   * spread, because `uniq_inv_reservations_org_source_active` allows exactly one
   * active hold per requirement line: a split would need several rows and the
   * second would collide. When nothing covers it in one place the call is
   * refused **naming the largest single-bin figure**, so the operator can split
   * the requirement or move stock rather than guess why it failed.
   *
   * The candidate bins are narrowed to the caller's warehouses. Without that, a
   * requirement naming no store — the normal state of a line nobody has planned
   * yet — sends this org-wide, and a picker assigned to one building auto-takes a
   * hold in another. Worse than the read it looks like: `assertHoldsInScope` would
   * then refuse them the release, so the hold they just created would be stuck
   * standing with nobody able to give it back. Gating the pick and gating the
   * release are the same gate asked at both ends.
   */
export async function resolveReservationLocation(
    db: Db,
    warehouseScope: WarehouseScopeService,
    orgId: string,
    productVariantId: number,
    warehouseId: number | undefined,
    qty: string,
    /**
     * What this requirement already holds, by location.
     *
     * A top-up releases the existing hold and re-takes the total in the same
     * transaction, so the units it is currently sitting on are about to become
     * available again — but `availableQtySql` subtracts them as `committed`
     * right now. Without crediting them back, topping up a hold of 24 by 16
     * looks for a bin with 40 available and finds one with 16, and the operator
     * is told to transfer stock in that is already standing in front of them.
     */
    heldHere: ReadonlyMap<number, string>,
    /** The caller's warehouses; `null` is the org-wide permission and adds no predicate. */
    scope: WarehouseScope,
  ): Promise<{ locationId: number; available: string } | { locationId: null; best: string }> {
    const rows = await db
      .select({
        locationId: invStockLevels.locationId,
        available: sql<string>`${availableQtySql("inv_stock_levels")}::text`,
      })
      .from(invStockLevels)
      .innerJoin(invLocations, eq(invStockLevels.locationId, invLocations.id))
      .where(
        and(
          eq(invStockLevels.orgId, orgId),
          eq(invStockLevels.productVariantId, productVariantId),
          eq(invLocations.isPickable, true),
          // Built through the service rather than an `inArray`, so `null` renders
          // TRUE and an empty scope renders FALSE. An `inArray(col, [])` is the
          // shape that quietly means something else on a caller holding nothing.
          warehouseScope.warehousePredicate(scope, sql`${invLocations.warehouseId}`),
          ...(warehouseId != null ? [eq(invLocations.warehouseId, warehouseId)] : []),
        ),
      )
      .orderBy(desc(sql`${availableQtySql("inv_stock_levels")}`));

    let best = "0";
    let bestLocation: { locationId: number; available: string } | null = null;
    for (const row of rows) {
      const effective = addDec(row.available, heldHere.get(row.locationId) ?? "0");
      if (cmpDec(effective, best) > 0) best = effective;
      if (cmpDec(effective, qty) >= 0 && (bestLocation === null || cmpDec(effective, bestLocation.available) > 0)) {
        bestLocation = { locationId: row.locationId, available: effective };
      }
    }
    return bestLocation ?? { locationId: null, best };
  }

  /** Where this requirement's active holds are standing, and how much at each. */
export async function heldByLocation(
  db: Db,
  orgId: string,
  requirementId: number,
): Promise<Map<number, string>> {
    const rows = await db
      .select({
        locationId: invStockReservations.locationId,
        qty: sql<string>`SUM(${invStockReservations.reservedQty}::numeric)::text`,
      })
      .from(invStockReservations)
      .where(
        and(
          eq(invStockReservations.orgId, orgId),
          eq(invStockReservations.sourceType, PROJECT_REQUIREMENT_SOURCE),
          eq(invStockReservations.sourceLineId, String(requirementId)),
          eq(invStockReservations.status, "ACTIVE"),
        ),
      )
      .groupBy(invStockReservations.locationId);
    const map = new Map<number, string>();
    for (const row of rows) if (row.locationId != null) map.set(row.locationId, row.qty);
    return map;
  }
