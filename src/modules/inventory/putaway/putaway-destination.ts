import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

export type PutawayDisposition = "STORAGE" | "QUARANTINE";

interface DestinationRow extends Record<string, unknown> {
  id: number;
  code: string;
  warehouse_id: number;
  is_active: boolean;
  is_receivable: boolean | null;
  location_type: string;
}

/**
 * B3, item 1 — the capability half of the check.
 *
 * Capacity is the stock engine's job and it already refuses a movement that
 * would overfill a bin. What the engine cannot answer is whether this bin is
 * allowed to take goods at all, because by the time a command reaches it the
 * business meaning is a list of quantity deltas. So the four things that make a
 * destination legitimate are asserted here, before the movement is built:
 *
 *   it exists in this organisation and is active — an archived bin is not a
 *   destination, and a cross-tenant id must read as "no such location" rather
 *   than as a permission failure;
 *
 *   it stands in the same warehouse as the goods — a putaway is a walk across a
 *   building, and a "putaway" into another building is a transfer, which has its
 *   own document, its own transit location and its own reservation semantics;
 *
 *   it is not where the goods already are — a movement from a bin to itself
 *   writes two ledger rows that cancel out and closes a task nobody walked;
 *
 *   and, for a STORAGE line, it is receivable. `is_receivable` is nullable with
 *   a `true` default, so only an explicit `false` refuses — matching every other
 *   reader of that column. A QUARANTINE line is exempt by construction: the
 *   quarantine bin is created `is_receivable = false` precisely so that nothing
 *   routes goods there by accident, which makes it the one destination that has
 *   to be reached deliberately.
 */
export async function assertDestinationUsable(
  tx: DbOrTx,
  orgId: string,
  destinationId: number,
  context: {
    warehouseId: number;
    fromLocationId: number;
    disposition: PutawayDisposition;
    quarantineLocationId: number | null;
  },
): Promise<void> {
  if (destinationId === context.fromLocationId) {
    throw new BadRequestException(
      "The destination is the location the goods are already standing at",
    );
  }

  if (context.disposition === "QUARANTINE") {
    if (destinationId !== context.quarantineLocationId) {
      throw new BadRequestException(
        "These goods are quarantined and may only be put away to the quarantine location",
      );
    }
    return;
  }

  const [row] = await tx.execute<DestinationRow>(sql`
    SELECT id, code, warehouse_id, is_active, is_receivable, location_type::text AS location_type
      FROM inv_locations
     WHERE org_id = ${orgId} AND id = ${destinationId}
     LIMIT 1
  `);
  if (!row) throw new BadRequestException("No such location");

  if (Number(row.warehouse_id) !== context.warehouseId) {
    throw new BadRequestException(
      `Location ${row.code} is in a different warehouse; move stock between warehouses with a transfer`,
    );
  }
  if (row.is_active !== true) {
    throw new BadRequestException(`Location ${row.code} is not active`);
  }
  if (row.is_receivable === false) {
    throw new BadRequestException(`Location ${row.code} does not accept goods`);
  }
}

/**
 * The warehouse's quarantine bin, or `null` where it has none.
 *
 * Resolved rather than created. Every warehouse made through
 * `InvWarehousesService.createWarehouse` gets one, and a warehouse that somehow
 * has none is a configuration gap a putaway command is the wrong place to paper
 * over — silently inventing a location on the way past would hide it, and the
 * operator would then be told to carry quarantined goods to a bin nobody knows
 * exists. Null here becomes a legible refusal at the call site.
 */
export async function findQuarantineLocation(
  tx: DbOrTx,
  orgId: string,
  warehouseId: number,
): Promise<number | null> {
  const [row] = await tx.execute<{ id: number }>(sql`
    SELECT id FROM inv_locations
     WHERE org_id = ${orgId}
       AND warehouse_id = ${warehouseId}
       AND location_type = 'QUARANTINE'
       AND is_active = true
     ORDER BY id
     LIMIT 1
  `);
  return row ? Number(row.id) : null;
}

/**
 * NEO-8 - where a cross-docked line goes instead of a shelf.
 *
 * The warehouse's outbound staging: a `SHIPPING` location, active and pickable,
 * because the units have to be picked out of it a few hours later. Null when the
 * warehouse has none configured, and the receiving path refuses the cross-dock
 * rather than inventing a bin - putting somebody's goods somewhere nobody chose
 * is worse than telling them the building is not set up for this yet.
 */
export async function findCrossDockStagingLocation(
  tx: DbOrTx,
  orgId: string,
  warehouseId: number,
): Promise<number | null> {
  const [row] = await tx.execute<{ id: number }>(sql`
    SELECT id FROM inv_locations
     WHERE org_id = ${orgId}
       AND warehouse_id = ${warehouseId}
       AND location_type = 'SHIPPING'
       AND is_active = true
       AND is_pickable IS NOT FALSE
     ORDER BY id
     LIMIT 1
  `);
  return row ? Number(row.id) : null;
}
