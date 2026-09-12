import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../../../../../db/drizzle.module";
import { availableQtySql, availableQtySumSql } from "../../../stock-engine/available-sql";
import { cmpDec, subDec } from "../../../stock-engine/decimal";

/**
 * Which bins a recommended transfer actually moves between, and which lots it
 * takes.
 *
 * Split from the approval flow because these three answer one question the flow
 * does not ask itself: a recommendation names two WAREHOUSES, and a transfer
 * document needs two LOCATIONS and a lot allocation. Everything about picking
 * those — the FEFO order, the empty-bin refusals — lives here; the flow above
 * decides whether the approval may happen at all.
 *
 * Plain `db` parameters rather than a deps bag: these three need nothing else.
 */

/**
 * Where the goods leave from.
 *
 * A transfer document names one source location, so the whole move comes out
 * of the bin with the most sellable stock rather than being spread across
 * every bin in the warehouse. `availableQtySumSql` is the one availability
 * formula (`available-sql.ts`), so blocked, quality-held and picked stock is
 * already out of this number.
 */
/** One source lot, in the order FEFO wants it consumed. */
export interface SourceAllocation {
  lotId: number | null;
  lotNumber: string | null;
  expiryDate: string | null;
  /** Exact decimal string — what this lot contributes to the move. */
  quantity: string;
}

export async function sourceLocation(
  db: Db,
  orgId: string,
  productVariantId: number,
  warehouseId: number,
): Promise<number> {
  const [row] = await db.execute<{ location_id: number }>(sql`
    SELECT l.id AS location_id
    FROM inv_locations l
    JOIN inv_stock_levels sl
      ON sl.org_id = l.org_id
     AND sl.location_id = l.id
     AND sl.product_variant_id = ${productVariantId}
    WHERE l.org_id = ${orgId}
      AND l.warehouse_id = ${warehouseId}
      AND l.is_active = true
    GROUP BY l.id
    HAVING ${availableQtySumSql("sl")} > 0
    ORDER BY ${availableQtySumSql("sl")} DESC, l.id
    LIMIT 1
  `);
  if (!row) {
    throw new BadRequestException(
      "The donor warehouse has no unheld stock of this item to send.",
    );
  }
  return Number(row.location_id);
}

export async function destinationLocation(
  db: Db,orgId: string, warehouseId: number): Promise<number> {
  const [row] = await db.execute<{ id: number }>(sql`
    SELECT id FROM inv_locations
    WHERE org_id = ${orgId}
      AND warehouse_id = ${warehouseId}
      AND is_active = true
      AND is_sellable IS NOT FALSE
    ORDER BY id
    LIMIT 1
  `);
  if (!row) {
    throw new BadRequestException(
      "The receiving warehouse has no active sellable location to receive into.",
    );
  }
  return Number(row.id);
}

/**
 * Which lots go, in FEFO order.
 *
 * Earliest expiry first, un-lotted stock last: sending the freshest lot and
 * leaving the one that expires next month behind is how a network with spare
 * stock still writes it off. A lot on quality hold contributes nothing here
 * because `availableQtySql` has already subtracted the held quantity, so the
 * hold is respected without a second rule that could disagree with the first.
 */
export async function allocateFefo(
  db: Db,
  orgId: string,
  productVariantId: number,
  locationId: number,
  quantity: string,
): Promise<SourceAllocation[]> {
  const rows = await db.execute<{
    lot_id: number | null;
    lot_number: string | null;
    expiry_date: string | null;
    available: string;
  }>(sql`
    SELECT sl.lot_id,
           lot.lot_number,
           lot.expiry_date::text AS expiry_date,
           ${availableQtySql("sl")}::text AS available
    FROM inv_stock_levels sl
    LEFT JOIN inv_lots lot ON lot.org_id = sl.org_id AND lot.id = sl.lot_id
    WHERE sl.org_id = ${orgId}
      AND sl.product_variant_id = ${productVariantId}
      AND sl.location_id = ${locationId}
      AND (lot.id IS NULL OR lot.status = 'ACTIVE')
    ORDER BY lot.expiry_date ASC NULLS LAST, sl.lot_id ASC NULLS LAST, sl.id
  `);

  const allocations: SourceAllocation[] = [];
  let outstanding = quantity;

  for (const row of rows) {
    if (cmpDec(outstanding, "0") <= 0) break;
    const available = row.available;
    if (cmpDec(available, "0") <= 0) continue;
    const take = cmpDec(available, outstanding) < 0 ? available : outstanding;
    allocations.push({
      lotId: row.lot_id === null ? null : Number(row.lot_id),
      lotNumber: row.lot_number,
      expiryDate: row.expiry_date,
      quantity: take,
    });
    outstanding = subDec(outstanding, take);
  }

  if (allocations.length === 0 || cmpDec(outstanding, "0") > 0) {
    throw new BadRequestException(
      "The donor warehouse no longer holds enough unheld stock to cover this move.",
    );
  }
  return allocations;
}
