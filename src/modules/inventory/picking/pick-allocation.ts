import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";

/** Where a picker is being sent for one sales-order line. */
export interface PickAllocation {
  locationId: number | null;
  lotId: number | null;
  serialId: number | null;
}

/** What a wave line needs to know before anybody walks anywhere. */
export interface AllocatableLine {
  soLineId: number;
  productVariantId: number;
  quantity: string;
}

/** Resolves a line to a stock row, in the order of what is already promised. */
export type LotFinder = (
  productVariantId: number,
  quantity: string,
) => Promise<{ locationId: number; lotId?: number } | null>;

/**
 * B4, item 1 — a wave line with no location is a task with no instruction.
 *
 * `createWave` used to insert every line with a null location, lot and serial,
 * so `getWave` sorted the walk by a column that was always null and the picker
 * was told what to fetch and never where from. Worse downstream: `outgoing_qty`
 * is keyed on (variant, location, lot, serial), so a confirm against a line with
 * no location had no grain to write to and skipped the projection entirely —
 * picked stock stayed sellable.
 *
 * Two sources, in this order, and the order is the whole point:
 *
 *   1. **An ACTIVE reservation for that sales-order line.** Reserving is the
 *      moment stock was promised, and it named a row. Sending the picker
 *      anywhere else splits the promise from the goods: `committed` sits on the
 *      reserved bin and `outgoing_qty` lands on the picked one, and availability
 *      is reduced twice for one set of units.
 *
 *   2. **`findAvailableLotForLine`, otherwise** — the same eligibility, FEFO and
 *      FIFO helper a sales-order reserve uses, reached through `SoCoreService`.
 *      Not a second allocator: a private copy is how this module came to promise
 *      expired lots and stock sitting on a lorry, because the copy predated the
 *      terms that exclude them.
 *
 * A line that resolves to neither is inserted with a null location, deliberately
 * — the wave is still a real list of work, and `getWave` sorts those last
 * because they need a decision rather than a walk.
 */
export async function allocateWaveLines(
  db: Db,
  orgId: string,
  lines: ReadonlyArray<AllocatableLine>,
  findLot: LotFinder,
): Promise<Map<number, PickAllocation>> {
  const allocations = new Map<number, PickAllocation>();
  if (lines.length === 0) return allocations;

  const reserved = await db.execute<{
    source_line_id: string;
    location_id: number | null;
    lot_id: number | null;
    serial_id: number | null;
  }>(sql`
    SELECT DISTINCT ON (res.source_line_id)
           res.source_line_id, res.location_id, res.lot_id, res.serial_id
      FROM inv_stock_reservations res
     WHERE res.org_id = ${orgId}
       AND res.source_type = 'inv_sales_order'
       AND res.status = 'ACTIVE'
       AND res.source_line_id = ANY(ARRAY[${sql.join(
         lines.map((l) => sql`${String(l.soLineId)}`),
         sql`, `,
       )}]::text[])
     ORDER BY res.source_line_id, res.id
  `);

  for (const row of reserved) {
    allocations.set(Number(row.source_line_id), {
      locationId: row.location_id === null ? null : Number(row.location_id),
      lotId: row.lot_id === null ? null : Number(row.lot_id),
      serialId: row.serial_id === null ? null : Number(row.serial_id),
    });
  }

  for (const line of lines) {
    if (allocations.has(line.soLineId)) continue;
    const found = await findLot(line.productVariantId, line.quantity);
    allocations.set(line.soLineId, {
      locationId: found?.locationId ?? null,
      lotId: found?.lotId ?? null,
      // The shared helper resolves a lot, never a serial, because a sales-order
      // reserve does not either. A serial-tracked line is settled at the shelf
      // from the scan instead, which is the only place the actual unit is known.
      serialId: null,
    });
  }

  return allocations;
}
