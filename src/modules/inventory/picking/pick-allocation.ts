import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";

/**
 * Where a picker is being sent for one sales-order line.
 *
 * R3, item 1 — a union rather than a record with a nullable `locationId`.
 *
 * The old shape let "we found a bin" and "we found nothing" be the same type,
 * distinguished only by a null every caller had to remember to check, and the
 * one caller that forgot was `confirmPick`: `input.locationId ?? line.locationId`
 * evaluated to null, the projection grain was skipped, and picked stock stayed
 * sellable with no error anywhere. A line that resolves to nothing is now its
 * own variant, so a caller cannot read a location off it without deciding what
 * to do about the other case.
 */
export type PickAllocation =
  | {
      status: "ALLOCATED";
      locationId: number;
      lotId: number | null;
      serialId: number | null;
    }
  /** No reservation and no eligible stock. The line is real work that needs a decision, not a walk. */
  | { status: "NEEDS_DECISION" };

/** What a wave line needs to know before anybody walks anywhere. */
export interface AllocatableLine {
  soLineId: number;
  productVariantId: number;
  quantity: string;
  /**
   * D2. The order this line serves, so the allocator can honour that customer's
   * contracted shelf-life floor. A wave spans several orders and therefore
   * several agreements — resolving one floor for the whole wave would apply the
   * strictest customer's term to everybody else's stock, and relax theirs to it.
   */
  soId: number | null;
}

/** Resolves a line to a stock row, in the order of what is already promised. */
export type LotFinder = (
  productVariantId: number,
  quantity: string,
  soId: number | null,
) => Promise<{ locationId: number; lotId?: number } | null>;

/**
 * The fallback half of the allocator, on its own so both callers share it.
 *
 * R3 gives `confirmPick` a second chance to resolve a bin for a picker who
 * supplied none, and the only safe way to do that is the same `LotFinder` a wave
 * create and a sales-order reserve already use — reached through
 * `SoCoreService.findAvailableLotForLine`. A private second allocator in this
 * module is how picking once came to promise expired lots and stock sitting on a
 * lorry: the copy predated the terms that exclude them.
 */
export async function allocateFromAvailableStock(
  findLot: LotFinder,
  productVariantId: number,
  quantity: string,
  soId: number | null = null,
): Promise<PickAllocation> {
  const found = await findLot(productVariantId, quantity, soId);
  if (!found) return { status: "NEEDS_DECISION" };
  return {
    status: "ALLOCATED",
    locationId: found.locationId,
    lotId: found.lotId ?? null,
    // The shared helper resolves a lot, never a serial, because a sales-order
    // reserve does not either. A serial-tracked line is settled at the shelf
    // from the scan instead, which is the only place the actual unit is known.
    serialId: null,
  };
}

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
 *      R3 narrows this to a reservation that actually names a **location**.
 *      `location_id` is nullable on `inv_stock_reservations` — a warehouse-level
 *      hold names no bin — and taking one of those still counted as "allocated",
 *      which blocked the fallback below and stranded the line with no bin. A
 *      reservation with no location tells the picker nothing, so it is treated
 *      as no answer.
 *
 *   2. **`findAvailableLotForLine`, otherwise** — the same eligibility, FEFO and
 *      FIFO helper a sales-order reserve uses, reached through `SoCoreService`.
 *      Not a second allocator, for the reason `allocateFromAvailableStock` gives.
 *
 * A line that resolves to neither is still inserted — the wave is a real list of
 * work and `getWave` sorts those last — but it comes back `NEEDS_DECISION` so
 * the wave's creator is told which lines need one, rather than a null nobody
 * reads.
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
       AND res.location_id IS NOT NULL
       AND res.source_line_id = ANY(ARRAY[${sql.join(
         lines.map((l) => sql`${String(l.soLineId)}`),
         sql`, `,
       )}]::text[])
     ORDER BY res.source_line_id, res.id
  `);

  for (const row of reserved) {
    if (row.location_id === null) continue;
    allocations.set(Number(row.source_line_id), {
      status: "ALLOCATED",
      locationId: Number(row.location_id),
      lotId: row.lot_id === null ? null : Number(row.lot_id),
      serialId: row.serial_id === null ? null : Number(row.serial_id),
    });
  }

  for (const line of lines) {
    if (allocations.has(line.soLineId)) continue;
    allocations.set(
      line.soLineId,
      await allocateFromAvailableStock(findLot, line.productVariantId, line.quantity, line.soId),
    );
  }

  return allocations;
}
