import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The per-warehouse code every transit location carries. One per warehouse, so
 * `(warehouse_id, code)` — the existing `uniq_inv_locations_warehouse_code`
 * unique index — is exactly the uniqueness this needs.
 */
export const TRANSIT_LOCATION_CODE = "TRANSIT";

/** Shown wherever a location name is rendered. */
export const TRANSIT_LOCATION_NAME = "In Transit";

/**
 * A2 — goods on a truck have to stand somewhere.
 *
 * A transfer used to post TRANSFER_OUT at dispatch and TRANSFER_IN at
 * completion, and in between the goods were on no stock level at all: org-wide
 * on-hand fell by the transferred quantity, inventory valuation fell with it,
 * and nothing anywhere told a planner that 400 units were in a van.
 *
 * The vocabulary for the fix already existed and was read by nothing — the
 * `inv_location_type` enum has carried a `TRANSIT` value and `inv_locations` an
 * `is_sellable` column since they were written. This service is what finally
 * uses them: every warehouse gets one non-sellable, non-pickable,
 * non-receivable location, and a dispatch parks its goods there until they
 * arrive. Availability excludes it because it is not sellable (see
 * `available-sql.ts`), so the stock is visible and countable without ever being
 * promised to a customer.
 *
 * Created on demand rather than at warehouse creation, so a warehouse that
 * predates this code — and every warehouse created by a code path that does not
 * know about transit — still works.
 */
@Injectable()
export class TransitLocationService {
  /**
   * The id of `warehouseId`'s transit location, creating it if it is absent.
   *
   * Three statements, of which only the first runs in the normal case:
   *
   *  1. a plain read — after `0530a_transit_locations` every existing warehouse
   *     already has one, so this is the whole cost of a dispatch;
   *  2. `INSERT … ON CONFLICT DO NOTHING`, which is what makes two concurrent
   *     first dispatches out of the same warehouse produce one location rather
   *     than two;
   *  3. a re-select.
   *
   * `DO NOTHING` does not wait on a conflicting row that another transaction
   * has inserted but not yet committed — it skips, and the re-select cannot see
   * the uncommitted row either. That window is narrow (one warehouse, its first
   * ever dispatch, two callers at once) but it is real, so the last resort is an
   * `ON CONFLICT … DO UPDATE`, which *does* block on the other transaction and
   * then returns the id it committed. It is a no-op update: it exists to take
   * the lock, not to change the row.
   */
  async resolve(tx: Tx, orgId: string, warehouseId: number): Promise<number> {
    const existing = await this.select(tx, orgId, warehouseId);
    if (existing !== null) return existing;

    const inserted = await tx.execute<{ id: number }>(sql`
      INSERT INTO inv_locations (
        org_id, warehouse_id, name, code, location_type,
        is_pickable, is_receivable, is_sellable, capacity, is_active
      )
      VALUES (
        ${orgId}, ${warehouseId}, ${TRANSIT_LOCATION_NAME}, ${TRANSIT_LOCATION_CODE}, 'TRANSIT',
        false, false, false, NULL, true
      )
      ON CONFLICT (warehouse_id, code) DO NOTHING
      RETURNING id
    `);
    if (inserted[0]) return Number(inserted[0].id);

    const afterInsert = await this.select(tx, orgId, warehouseId);
    if (afterInsert !== null) return afterInsert;

    const settled = await tx.execute<{ id: number }>(sql`
      INSERT INTO inv_locations (
        org_id, warehouse_id, name, code, location_type,
        is_pickable, is_receivable, is_sellable, capacity, is_active
      )
      VALUES (
        ${orgId}, ${warehouseId}, ${TRANSIT_LOCATION_NAME}, ${TRANSIT_LOCATION_CODE}, 'TRANSIT',
        false, false, false, NULL, true
      )
      ON CONFLICT (warehouse_id, code)
        DO UPDATE SET warehouse_id = inv_locations.warehouse_id
      RETURNING id
    `);
    const id = settled[0]?.id;
    if (id === undefined)
      throw new Error(
        `Could not resolve a transit location for warehouse ${warehouseId}`,
      );
    return Number(id);
  }

  private async select(
    tx: Tx,
    orgId: string,
    warehouseId: number,
  ): Promise<number | null> {
    const rows = await tx.execute<{ id: number }>(sql`
      SELECT id FROM inv_locations
      WHERE org_id = ${orgId}
        AND warehouse_id = ${warehouseId}
        AND code = ${TRANSIT_LOCATION_CODE}
      LIMIT 1
    `);
    return rows[0] ? Number(rows[0].id) : null;
  }
}
