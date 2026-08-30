import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { ReservationService } from "../stock-engine/reservation.service";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import { type PickGrain, assertClaimHeldBy, waveIsComplete } from "./pick-line";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * B4, item 2 — everything a closing pick line sets in motion, in one place.
 *
 * Confirming a pick and reporting an exception both close a line, and both then
 * have to move the same four things: the reservation behind it, the sales
 * order's status, the wave's status, and the availability projection. Two
 * copies of that sequence would be two chances to get its *order* wrong, and the
 * order is the part that silently loses stock (see `PickConfirmService`).
 */
@Injectable()
export class PickCompletionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly projection: StockProjectionService,
    private readonly reservations: ReservationService,
  ) {}

  /**
   * B4, item 3 — a wave belongs to whoever picked it up.
   *
   * Confirming an unclaimed wave claims it, so the common case needs no separate
   * call; confirming somebody else's is refused. The check is the point of the
   * assignment: each confirm is already bounded by `quantity_to_pick`, so a
   * second picker's confirm would be rejected — but only after they had walked
   * the aisle and taken the goods off the shelf. The double count is physical
   * before it is ever a number.
   */
  async claimForConfirm(
    tx: Tx,
    orgId: string,
    userId: string,
    pickListId: number,
  ): Promise<void> {
    const claimed = await tx.execute<{ assigned_to: string | null }>(sql`
      UPDATE inv_pick_lists
         SET assigned_to = ${userId}, claimed_at = NOW(), updated_at = NOW()
       WHERE org_id = ${orgId} AND id = ${pickListId} AND assigned_to IS NULL
      RETURNING assigned_to
    `);
    if (claimed.length > 0) return;

    const [held] = await tx.execute<{ assigned_to: string | null }>(sql`
      SELECT assigned_to FROM inv_pick_lists
       WHERE org_id = ${orgId} AND id = ${pickListId}
    `);
    assertClaimHeldBy(held?.assigned_to ?? null, userId);
  }

  /**
   * Consumes the reservations behind a sales-order line, once the line's whole
   * ordered quantity is in a tote.
   *
   * Whole-line rather than proportional, and that is forced by the projection
   * rather than chosen: `EXPECTED_OUTGOING` subtracts the *entire* remaining
   * `committed` at the grain, so partially consuming a reservation would drop
   * `committed` by the picked part while the outgoing term stayed clamped at
   * zero, and availability would rise by units that are standing in a tote.
   * While the line is only partly picked the reservation still covers all of it
   * and the arithmetic is already right, so there is nothing to do.
   *
   * Counted across every non-cancelled pick list, not just this wave: a line can
   * legitimately be picked partly by a wave and partly by a single-order pick.
   *
   * `FOR UPDATE` with the ACTIVE predicate is the concurrency guard. A second
   * confirm blocks on the row, re-evaluates the predicate after the lock, and
   * finds nothing — where two unlocked readers would both call
   * `releaseCommitted` and subtract the same reservation twice.
   *
   * Returns the grains the released reservations sat on, because those rows'
   * `outgoing_qty` has to be recomputed too: the pick may have come off a
   * different bin from the one the order reserved.
   */
  async consumeCoveredReservations(
    tx: Tx,
    orgId: string,
    userId: string,
    soLineId: number | null,
    idempotencyKey: string,
  ): Promise<PickGrain[]> {
    if (soLineId === null) return [];

    const [covered] = await tx.execute<{ covered: boolean }>(sql`
      SELECT (sol.quantity::numeric <= COALESCE((
               SELECT SUM(pll.quantity_picked::numeric)
                 FROM inv_pick_list_lines pll
                 JOIN inv_pick_lists pl
                   ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
                WHERE pll.org_id = sol.org_id
                  AND pll.so_line_id = sol.id
                  AND pl.status <> 'CANCELLED'
             ), 0)) AS covered
        FROM inv_so_lines sol
       WHERE sol.org_id = ${orgId} AND sol.id = ${soLineId}
    `);
    if (covered?.covered !== true) return [];

    const rows = await tx.execute<{
      id: number;
      location_id: number | null;
      product_variant_id: number;
      lot_id: number | null;
      serial_id: number | null;
      handling_unit_id: number | null;
      reserved_qty: string;
    }>(sql`
      SELECT id, location_id, product_variant_id, lot_id, serial_id, handling_unit_id, reserved_qty
        FROM inv_stock_reservations
       WHERE org_id = ${orgId}
         AND source_type = 'inv_sales_order'
         AND source_line_id = ${String(soLineId)}
         AND status = 'ACTIVE'
       ORDER BY id
       FOR UPDATE
    `);
    if (rows.length === 0) return [];

    const consumed = await this.reservations.consumeReservationsBatch(
      tx,
      orgId,
      userId,
      rows.map((r) => ({
        id: Number(r.id),
        locationId: r.location_id === null ? null : Number(r.location_id),
        productVariantId: Number(r.product_variant_id),
        lotId: r.lot_id === null ? null : Number(r.lot_id),
        serialId: r.serial_id === null ? null : Number(r.serial_id),
        handlingUnitId: r.handling_unit_id === null ? null : Number(r.handling_unit_id),
        reservedQty: r.reserved_qty,
      })),
    );

    if (consumed.length > 0) {
      // A5. The set is the fact — one event for the command, keyed on the
      // command's own idempotency key, rather than one per reservation. Same
      // shape as the shipping path, so a consumer reads one payload.
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.RESERVATION_CONSUMED,
        aggregateType: "inv_stock_reservation",
        aggregateId: idempotencyKey,
        actorUserId: userId,
        payload: {
          reservationIds: consumed,
          sourceType: "inv_sales_order",
          sourceLineId: String(soLineId),
          consumedBy: "picking.confirm",
        },
      });
    }

    return rows.flatMap((r) =>
      r.location_id === null
        ? []
        : [
            {
              productVariantId: Number(r.product_variant_id),
              locationId: Number(r.location_id),
              lotId: r.lot_id === null ? null : Number(r.lot_id),
              handlingUnitId: r.handling_unit_id === null || r.handling_unit_id === undefined
                ? null
                : Number(r.handling_unit_id),
              serialId: r.serial_id === null ? null : Number(r.serial_id),
            },
          ],
    );
  }

  /**
   * B4, item 2 — the order says it is picked once all of it is.
   *
   * Wave picking never moved the sales order at all, so an order whose every
   * unit was in a tote still read CONFIRMED, and `packSo` — which requires
   * PICKED — refused to pack goods the picker was holding.
   *
   * One statement, and the comparison stays in the database as `numeric`:
   * deciding a whole order is picked on the strength of float comparisons is how
   * an order ships one unit short and nothing notices. Guarded on the statuses a
   * pick may advance from, so a shipped or cancelled order is never walked
   * backwards.
   */
  async rollUpSoStatus(tx: Tx, orgId: string, soLineId: number | null): Promise<void> {
    if (soLineId === null) return;
    await tx.execute(sql`
      UPDATE inv_sales_orders so
         SET status = 'PICKED', updated_at = NOW()
       WHERE so.org_id = ${orgId}
         AND so.id = (SELECT sol.so_id FROM inv_so_lines sol
                       WHERE sol.org_id = ${orgId} AND sol.id = ${soLineId})
         AND so.status IN ('CONFIRMED', 'PARTIALLY_RESERVED', 'RESERVED')
         AND NOT EXISTS (
           SELECT 1
             FROM inv_so_lines line
            WHERE line.org_id = so.org_id
              AND line.so_id = so.id
              AND line.quantity::numeric > COALESCE((
                    SELECT SUM(pll.quantity_picked::numeric)
                      FROM inv_pick_list_lines pll
                      JOIN inv_pick_lists pl
                        ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
                     WHERE pll.org_id = line.org_id
                       AND pll.so_line_id = line.id
                       AND pl.status <> 'CANCELLED'
                  ), 0)
         )
    `);
  }

  /**
   * Flips the wave's status, and announces the walk once it is over.
   *
   * The update is conditional on the status actually changing, so the event is
   * emitted on the transition rather than on every confirm that happens to
   * arrive after it — and a replayed command, which never reaches here, cannot
   * emit a second one either.
   */
  async finishWave(
    tx: Tx,
    orgId: string,
    userId: string,
    pickListId: number,
  ): Promise<boolean> {
    const complete = await waveIsComplete(tx, orgId, pickListId);
    const next = complete ? "COMPLETED" : "IN_PROGRESS";

    const flipped = await tx.execute<{ id: number }>(sql`
      UPDATE inv_pick_lists
         SET status = ${next}, updated_at = NOW()
       WHERE org_id = ${orgId} AND id = ${pickListId} AND status <> ${next}
      RETURNING id
    `);

    if (complete && flipped.length > 0) {
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.PICK_COMPLETED,
        aggregateType: "inv_pick_list",
        aggregateId: String(pickListId),
        actorUserId: userId,
        payload: { pickListId, completedBy: userId },
      });
    }

    return complete;
  }

  /** The recompute, deduplicated by grain so one row is never written twice. */
  async syncGrains(tx: Tx, orgId: string, grains: PickGrain[]): Promise<void> {
    const seen = new Set<string>();
    for (const grain of grains) {
      const key = [
        grain.productVariantId,
        grain.locationId,
        grain.lotId ?? "",
        grain.serialId ?? "",
        grain.handlingUnitId ?? "",
      ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      await this.projection.syncOutgoing(tx, orgId, grain);
    }
  }
}
