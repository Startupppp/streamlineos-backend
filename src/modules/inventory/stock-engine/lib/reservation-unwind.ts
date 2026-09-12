import { and, eq, inArray, sql } from "drizzle-orm";
import { invStockReservations } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../command-events";
import { releaseCommitted } from "./committed-grain";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Every way a reservation is given back, and nothing that makes one.
 *
 * That is the seam. `createReservationInTx` is the one method in this module
 * that INCREMENTS `committed`: it locks the stock row, runs the sellability
 * gate, the availability gate and the channel-pool gate, and only then promises
 * the units. The four below are the ways the promise ends — released, consumed
 * singly, consumed in a batch by a shipping command, or expired by a background
 * sweep — and they have one thing in common that the create path does not: each
 * decides whether it flipped anything at all (the `status = 'ACTIVE'` predicate,
 * or `FOR UPDATE` then a re-read) and then hands the same grain to
 * `releaseCommitted`. A release that reports work it did not do is the failure
 * mode all four share, and `lib/committed-grain.ts` is the one predicate that
 * keeps the give-back matching the take.
 *
 * Functions over a deps bag rather than a second `@Injectable`: the DI graph and
 * every caller of `ReservationService` are unchanged. `bumpReservationList` is
 * the service's own private cache invalidation, handed over bound — it defers
 * through `registerAfterCommit` and falls back to running inline, and that
 * decision belongs to the service that holds the `CacheService`, not here.
 */
export interface ReservationUnwindDeps {
  readonly db: Db;
  readonly bumpReservationList: (orgId: string) => void;
}

/**
 * The reservation a release actually flipped, or `null` if there was nothing to
 * flip.
 *
 * A5. Releasing is deliberately a no-op on a row that is not ACTIVE, so the
 * caller could not tell a release that happened from one that had already
 * happened — and an event emitted on the second is a duplicate notification for
 * work nobody did. Returned rather than re-read: the row was already selected
 * `FOR UPDATE` here, and reading it again after the update would report the
 * post-release state as if it were the reason for the release.
 */
export interface ReleasedReservation {
  id: number;
  sourceType: string;
  sourceId: string;
  productVariantId: number;
  locationId: number | null;
  lotId: number | null;
  serialId: number | null;
  handlingUnitId: number | null;
  reservedQty: string;
}

/**
 * Releases one hold. Deliberately NOT warehouse-gated — its callers are.
 *
 * It takes a `userId` and spends it on nothing, which reads like the defect it
 * used to enable and is not one: every caller here releases the reservations
 * belonging to its OWN aggregate, found by `source_type` and `source_id` —
 * cancelling a transfer, cancelling a sales order, a project standing down a
 * requirement, a pick substitution. A sales order legitimately spans two
 * buildings, so a gate on this helper would refuse the operator cancelling it.
 * Those commands owe a gate on themselves, not here; `cancelTransfer` in
 * particular does not have one yet.
 *
 * The one path where a CLIENT names a reservation id is
 * `InvStockReservationsService.releaseReservation`, and that is where the gate
 * went — the same split as `createTransfer` / `createTransferInTx`. The public
 * `releaseReservation` that used to sit beside this method was deleted rather
 * than left ungated next to it: it wrapped this in a transaction, had no
 * caller anywhere, and was the obvious wrong thing for a new route to reach
 * for. Reconstruct it as `db.transaction((tx) => releaseReservationInTx(…))`
 * if one is ever needed, with the gate in front.
 */
export async function releaseReservationInTx(
  deps: ReservationUnwindDeps,
  tx: Tx, orgId: string, userId: string, reservationId: number,
): Promise<ReleasedReservation | null> {
  const [reservation] = await tx.execute<{
    id: number; source_type: string; source_id: string;
    location_id: number | null; product_variant_id: number;
    lot_id: number | null; serial_id: number | null; handling_unit_id: number | null;
    reserved_qty: string; status: string;
  }>(sql`
    SELECT id, source_type, source_id, location_id, product_variant_id,
           lot_id, serial_id, handling_unit_id, reserved_qty, status
    FROM inv_stock_reservations
    WHERE id = ${reservationId} AND org_id = ${orgId}
    FOR UPDATE
  `);

  if (!reservation || reservation.status !== "ACTIVE") return null;

  await tx.update(invStockReservations)
    .set({ status: "RELEASED" })
    .where(eq(invStockReservations.id, reservationId));

  deps.bumpReservationList(orgId);

  if (reservation.location_id) {
    await releaseCommitted(tx, orgId, {
      productVariantId: reservation.product_variant_id,
      locationId: reservation.location_id,
      lotId: reservation.lot_id,
      serialId: reservation.serial_id,
      handlingUnitId: reservation.handling_unit_id,
      reservedQty: reservation.reserved_qty,
    });
  }

  return {
    id: Number(reservation.id),
    sourceType: reservation.source_type,
    sourceId: reservation.source_id,
    productVariantId: Number(reservation.product_variant_id),
    locationId: reservation.location_id === null ? null : Number(reservation.location_id),
    lotId: reservation.lot_id === null ? null : Number(reservation.lot_id),
    serialId: reservation.serial_id === null ? null : Number(reservation.serial_id),
    handlingUnitId: reservation.handling_unit_id === null ? null : Number(reservation.handling_unit_id),
    reservedQty: reservation.reserved_qty,
  };
}

export async function consumeReservation(
  deps: ReservationUnwindDeps,
  orgId: string,
  userId: string,
  reservationId: number,
): Promise<void> {
  return deps.db.transaction(async (tx) => {
    const [reservation] = await tx.execute<{
      id: number; source_type: string; source_id: string;
      location_id: number | null; product_variant_id: number;
      lot_id: number | null; serial_id: number | null; handling_unit_id: number | null;
      reserved_qty: string; status: string;
    }>(sql`
      SELECT id, source_type, source_id, location_id, product_variant_id,
             lot_id, serial_id, handling_unit_id, reserved_qty, status
      FROM inv_stock_reservations WHERE id = ${reservationId} AND org_id = ${orgId}
      FOR UPDATE
    `);

    if (!reservation || reservation.status !== "ACTIVE") return;

    await tx.update(invStockReservations).set({ status: "CONSUMED" }).where(eq(invStockReservations.id, reservationId));

    deps.bumpReservationList(orgId);

    if (reservation.location_id) {
      await releaseCommitted(tx, orgId, {
        productVariantId: reservation.product_variant_id,
        locationId: reservation.location_id,
        lotId: reservation.lot_id,
        serialId: reservation.serial_id,
        handlingUnitId: reservation.handling_unit_id,
        reservedQty: reservation.reserved_qty,
      });
    }

    // A5. Emitted here rather than left to the caller, because this entry
    // point owns its own transaction: a caller emitting after it returns
    // would be publishing outside the transaction that committed the change.
    await emitInventoryCommandEvent(tx, {
      orgId,
      eventType: INVENTORY_COMMAND_EVENTS.RESERVATION_CONSUMED,
      aggregateType: "inv_stock_reservation",
      aggregateId: String(reservationId),
      actorUserId: userId,
      payload: {
        reservationIds: [Number(reservation.id)],
        sourceType: reservation.source_type,
        sourceId: reservation.source_id,
        // Same shape as the batch paths, so a consumer reads one payload
        // rather than two that happen to overlap.
        consumedBy: "reservation.consume",
      },
    });
  });
}

/**
 * Consumes a set of reservations, and reports which ones it actually flipped.
 *
 * A5. The `status = 'ACTIVE'` predicate means the caller's list is a request,
 * not a result: a reservation already consumed by an earlier attempt is
 * silently skipped. The returned ids are the ones this call is responsible
 * for, and they are what the consuming command puts on its
 * `inventory.reservation.consumed` event — an event naming reservations that
 * were consumed by somebody else is evidence of nothing.
 */
export async function consumeReservationsBatch(
  deps: ReservationUnwindDeps,
  tx: Tx,
  orgId: string,
  userId: string,
  reservations: ReadonlyArray<{
    id: number;
    locationId: number | null;
    productVariantId: number;
    lotId?: number | null;
    serialId?: number | null;
    handlingUnitId?: number | null;
    reservedQty: string;
  }>,
): Promise<number[]> {
  if (reservations.length === 0) return [];

  const activeIds = reservations.map((r) => r.id);

  const consumed = await tx.execute<{ id: number }>(sql`
    UPDATE inv_stock_reservations
    SET status = 'CONSUMED', updated_at = NOW()
    WHERE id = ANY(ARRAY[${sql.join(activeIds.map((id) => sql`${id}`), sql`, `)}]::int[])
      AND org_id = ${orgId}
      AND status = 'ACTIVE'
    RETURNING id
  `);

  deps.bumpReservationList(orgId);

  const withLocation = reservations.filter((r) => r.locationId !== null);
  for (const r of withLocation) {
    await releaseCommitted(tx, orgId, {
      productVariantId: r.productVariantId,
      locationId: r.locationId!,
      lotId: r.lotId ?? null,
      serialId: r.serialId ?? null,
      handlingUnitId: r.handlingUnitId ?? null,
      reservedQty: r.reservedQty,
    });
  }

  return consumed.map((row) => Number(row.id));
}

export async function expireStale(
  deps: ReservationUnwindDeps,
  orgId: string,
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const stale = await tx.execute<{
      id: number; location_id: number | null; product_variant_id: number;
      lot_id: number | null; serial_id: number | null; handling_unit_id: number | null;
      reserved_qty: string;
    }>(sql`
      SELECT id, location_id, product_variant_id, lot_id, serial_id, handling_unit_id, reserved_qty
      FROM inv_stock_reservations
      WHERE org_id = ${orgId}
        AND status = 'ACTIVE'
        AND expires_at IS NOT NULL
        AND expires_at < NOW()
      ORDER BY id
      FOR UPDATE
      LIMIT 500
    `);

    if (stale.length === 0) return 0;

    const ids = stale.map((r) => Number(r.id));
    await tx.update(invStockReservations)
      .set({ status: "EXPIRED" })
      .where(and(eq(invStockReservations.orgId, orgId), inArray(invStockReservations.id, ids)));

    deps.bumpReservationList(orgId);

    for (const r of stale) {
      if (r.location_id === null) continue;
      await releaseCommitted(tx, orgId, {
        productVariantId: Number(r.product_variant_id),
        locationId: r.location_id,
        lotId: r.lot_id,
        serialId: r.serial_id,
        handlingUnitId: r.handling_unit_id,
        reservedQty: r.reserved_qty,
      });
    }

    return stale.length;
  });
}
