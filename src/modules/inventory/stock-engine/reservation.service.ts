import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { invStockReservations, invStockLevels } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventorySettingsService } from "./inventory-settings.service";
import { ChannelPoolService } from "./channel-pool.service";
import { availableQty, cmpDec } from "./decimal";
import { INV_ERRORS, type ReservationInput } from "./stock-engine.types";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "./command-events";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

interface CommittedKey {
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
  /** NEO-4. The pallet, or null for loose. Part of the key for the same reason. */
  handlingUnitId: number | null;
  reservedQty: string;
}

/**
 * The grain a reservation is against, as one predicate both halves share.
 *
 * It is exported and shared because the asymmetry WAS the bug. The increment
 * found its row with one predicate and the release matched with another, and
 * the two drifted apart twice: first on `lot_id`, where releasing decremented
 * every lot at the location, and then on `ownership`, where it decremented the
 * consigned row standing at the same bin as the owned one. `GREATEST(0, ...)`
 * absorbed the over-subtraction both times, so reserved stock read as available
 * and could be promised twice, silently.
 *
 * `ownership = 'OWNED'` is a gate rather than a term, which is the kind this
 * module keeps forgetting — `availableQty` and `availableQtySql` both carry the
 * same one, with the same note: consigned stock is on hand and is not ours, and
 * forgetting it offers a supplier's goods for sale. `stock-projection.service`
 * added it (NEO-11); this path did not.
 *
 * @param alias the table's alias at the call site, or "" when it has none.
 */
export function committedGrainPredicate(
  orgId: string,
  grain: {
    productVariantId: number;
    locationId: number;
    lotId: number | null;
    serialId: number | null;
    handlingUnitId: number | null;
  },
  alias = "",
): SQL {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : name);
  return sql`
    ${col("org_id")} = ${orgId}
      AND ${col("product_variant_id")} = ${grain.productVariantId}
      AND ${col("location_id")} = ${grain.locationId}
      AND (${col("lot_id")} IS NOT DISTINCT FROM ${grain.lotId})
      AND (${col("serial_id")} IS NOT DISTINCT FROM ${grain.serialId})
      AND (${col("handling_unit_id")} IS NOT DISTINCT FROM ${grain.handlingUnitId})
      AND ${col("ownership")} = 'OWNED'
  `;
}

/** Releases committed on the SAME grain the reservation incremented. */
async function releaseCommitted(tx: Tx, orgId: string, key: CommittedKey): Promise<void> {
  await tx.execute(sql`
    UPDATE inv_stock_levels
    SET committed = GREATEST(0, committed - ${key.reservedQty}::numeric)
    WHERE ${committedGrainPredicate(orgId, key)}
  `);
}

@Injectable()
export class ReservationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settingsService: InventorySettingsService,
    private readonly channelPools: ChannelPoolService,
  ) {}

  async createReservation(orgId: string, userId: string, input: ReservationInput): Promise<typeof invStockReservations.$inferSelect> {
    return this.db.transaction(async (tx) => this.createReservationInTx(tx, orgId, userId, input));
  }

  async createReservationInTx(tx: Tx, orgId: string, userId: string, input: ReservationInput): Promise<typeof invStockReservations.$inferSelect> {
    const settings = await this.settingsService.get(orgId);

    // A reservation without a location cannot lock a stock row, cannot be checked
    // for availability and cannot decrement committed anywhere — it is a promise
    // with nothing behind it. Every internal caller already resolves a location.
    if (!input.locationId) throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

    await tx.insert(invStockLevels).values({
      orgId, productVariantId: input.productVariantId,
      locationId: input.locationId, lotId: input.lotId ?? null,
      serialId: input.serialId ?? null,
      handlingUnitId: input.handlingUnitId ?? null,
      onHand: "0", committed: "0", onOrder: "0",
      blockedQty: "0", qualityHoldQty: "0", outgoingQty: "0",
    }).onConflictDoNothing();

    // A2/A5. `is_sellable` is selected because `availableQty` gates on it, and
    // an absent field is not `false` — so omitting it made the transit gate dead
    // code on the one path that increments `committed`. This is the last line of
    // defence: whatever an allocator upstream decided, a reservation is the
    // moment stock is actually promised to somebody.
    const [level] = await tx.execute<{
      id: number; on_hand: string; committed: string; blocked_qty: string;
      quality_hold_qty: string; outgoing_qty: string; is_sellable: boolean | null;
      /**
       * Selected so `availableQty`'s consignment gate can fire here at all. It
       * treats `undefined` as "this caller has not been taught about
       * consignment" and falls through to the arithmetic — so omitting the
       * column did not merely skip a check, it made a consigned row compute as
       * if it were ours. The predicate above already excludes those rows; this
       * is the second line, because the file's own comment calls the
       * availability check the last one.
       */
      ownership: "OWNED" | "VENDOR" | "CUSTOMER" | null;
      warehouse_id: number;
    }>(sql`
      SELECT sl.id, sl.on_hand, sl.committed, sl.blocked_qty,
             sl.quality_hold_qty, sl.outgoing_qty, sl.ownership,
             loc.is_sellable, loc.warehouse_id
      FROM inv_stock_levels sl
      JOIN inv_locations loc
        ON loc.org_id = sl.org_id AND loc.id = sl.location_id
      WHERE ${committedGrainPredicate(orgId, {
        productVariantId: input.productVariantId,
        locationId: input.locationId,
        lotId: input.lotId ?? null,
        serialId: input.serialId ?? null,
        handlingUnitId: input.handlingUnitId ?? null,
      }, "sl")}
      FOR UPDATE OF sl
    `);

    if (!level) throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

    // Refused whatever the backorder setting says. Allowing backorders means
    // "you may promise stock you do not have yet"; it does not mean "you may
    // promise stock that is on a lorry". Without this, an org with backorders on
    // skips the availability check entirely and reserves at a transit location
    // regardless — and the transfer's completion then issues those units away,
    // leaving `committed` behind and availability negative for good.
    if (level.is_sellable === false) {
      throw new BadRequestException({
        code: INV_ERRORS.INSUFFICIENT_STOCK,
        message: "Stock at this location is not sellable and cannot be reserved",
      });
    }

    const available = availableQty(level);

    if (!settings.allowBackorders && cmpDec(available, input.qty) < 0) {
      throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK });
    }

    // NEO-1. The row check above asks whether the units are physically free where
    // they stand. This asks whether anybody else has already been promised them.
    // It is deliberately on this path and not on the allocator that chose the
    // location: a reservation is the moment stock is actually promised to
    // somebody, and every promise in the product passes through here.
    //
    // Unlike the row check, it holds whatever `allowBackorders` says. Backorders
    // mean "you may promise stock you have not received"; they have never meant
    // "you may promise the same unit to two customers", and a channel pool exists
    // precisely to stop the second.
    await this.channelPools.assertPromisable(tx, orgId, {
      productVariantId: input.productVariantId,
      warehouseId: input.warehouseId ?? Number(level.warehouse_id),
      qty: input.qty,
      forChannelId: input.channelId ?? null,
    });

    await tx.update(invStockLevels)
      .set({ committed: sql`committed + ${input.qty}::numeric` })
      .where(eq(invStockLevels.id, level.id));

    const [reservation] = await tx.insert(invStockReservations).values({
      orgId,
      sourceType: input.sourceType, sourceId: input.sourceId,
      sourceLineId: input.sourceLineId ?? null,
      productVariantId: input.productVariantId,
      warehouseId: input.warehouseId ?? null,
      locationId: input.locationId ?? null,
      lotId: input.lotId ?? null, serialId: input.serialId ?? null,
      handlingUnitId: input.handlingUnitId ?? null,
      reservedQty: input.qty, status: "ACTIVE",
      expiresAt: input.expiresAt ?? null,
    }).returning();

    return reservation!;
  }

  async releaseReservationInTx(
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

  async releaseReservation(
    orgId: string, userId: string, reservationId: number,
  ): Promise<ReleasedReservation | null> {
    return this.db.transaction((tx) => this.releaseReservationInTx(tx, orgId, userId, reservationId));
  }

  async consumeReservation(orgId: string, userId: string, reservationId: number): Promise<void> {
    return this.db.transaction(async (tx) => {
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
  async consumeReservationsBatch(
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

  async expireStale(orgId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
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
}
