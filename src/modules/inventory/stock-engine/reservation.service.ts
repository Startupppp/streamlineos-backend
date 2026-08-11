import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { invStockReservations, invStockLevels, invStockTransactions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InventorySettingsService } from "./inventory-settings.service";
import { availableQty, cmpDec } from "./decimal";
import { INV_ERRORS, type ReservationInput } from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface CommittedKey {
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
  reservedQty: string;
}

/**
 * Releases committed on the SAME natural key the reservation incremented.
 * Matching on (org, variant, location) alone decremented every lot row at that
 * location, and GREATEST(0, ...) silently absorbed the over-subtraction — so
 * reserved stock read as available and could be sold twice.
 */
async function releaseCommitted(tx: Tx, orgId: string, key: CommittedKey): Promise<void> {
  await tx.execute(sql`
    UPDATE inv_stock_levels
    SET committed = GREATEST(0, committed - ${key.reservedQty}::numeric)
    WHERE org_id = ${orgId}
      AND product_variant_id = ${key.productVariantId}
      AND location_id = ${key.locationId}
      AND (lot_id IS NOT DISTINCT FROM ${key.lotId})
      AND (serial_id IS NOT DISTINCT FROM ${key.serialId})
  `);
}

@Injectable()
export class ReservationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settingsService: InventorySettingsService,
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
      onHand: "0", committed: "0", onOrder: "0",
      blockedQty: "0", qualityHoldQty: "0", outgoingQty: "0",
    }).onConflictDoNothing();

    const [level] = await tx.execute<{
      id: number; on_hand: string; committed: string; blocked_qty: string;
      quality_hold_qty: string; outgoing_qty: string;
    }>(sql`
      SELECT id, on_hand, committed, blocked_qty, quality_hold_qty, outgoing_qty
      FROM inv_stock_levels
      WHERE org_id = ${orgId} AND product_variant_id = ${input.productVariantId}
        AND location_id = ${input.locationId}
        AND (lot_id IS NOT DISTINCT FROM ${input.lotId ?? null})
        AND (serial_id IS NOT DISTINCT FROM ${input.serialId ?? null})
      FOR UPDATE
    `);

    if (!level) throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

    const available = availableQty(level);

    if (!settings.allowBackorders && cmpDec(available, input.qty) < 0) {
      throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK });
    }

    await tx.update(invStockLevels)
      .set({ committed: sql`committed + ${input.qty}::numeric` })
      .where(eq(invStockLevels.id, level.id));

    await tx.insert(invStockTransactions).values({
      orgId, productVariantId: input.productVariantId,
      locationId: input.locationId ?? null,
      lotId: input.lotId ?? null, serialId: input.serialId ?? null,
      transactionType: "RESERVATION_CREATE",
      quantityChange: "0",
      quantityBefore: "0", quantityAfter: "0",
      referenceType: input.sourceType, referenceId: input.sourceId,
      metadata: { reservedQty: input.qty } as Record<string, unknown>,
      reason: "reservation",
      createdBy: userId,
    });

    const [reservation] = await tx.insert(invStockReservations).values({
      orgId,
      sourceType: input.sourceType, sourceId: input.sourceId,
      sourceLineId: input.sourceLineId ?? null,
      productVariantId: input.productVariantId,
      warehouseId: input.warehouseId ?? null,
      locationId: input.locationId ?? null,
      lotId: input.lotId ?? null, serialId: input.serialId ?? null,
      reservedQty: input.qty, status: "ACTIVE",
      expiresAt: input.expiresAt ?? null,
    }).returning();

    return reservation!;
  }

  async releaseReservationInTx(tx: Tx, orgId: string, userId: string, reservationId: number): Promise<void> {
    const [reservation] = await tx.execute<{
      id: number; location_id: number | null; product_variant_id: number;
      lot_id: number | null; serial_id: number | null; reserved_qty: string; status: string;
    }>(sql`
      SELECT id, location_id, product_variant_id, lot_id, serial_id, reserved_qty, status
      FROM inv_stock_reservations
      WHERE id = ${reservationId} AND org_id = ${orgId}
      FOR UPDATE
    `);

    if (!reservation || reservation.status !== "ACTIVE") return;

    await tx.update(invStockReservations)
      .set({ status: "RELEASED" })
      .where(eq(invStockReservations.id, reservationId));

    if (reservation.location_id) {
      await releaseCommitted(tx, orgId, {
        productVariantId: reservation.product_variant_id,
        locationId: reservation.location_id,
        lotId: reservation.lot_id,
        serialId: reservation.serial_id,
        reservedQty: reservation.reserved_qty,
      });
    }

    await tx.insert(invStockTransactions).values({
      orgId, productVariantId: reservation.product_variant_id,
      locationId: reservation.location_id,
      transactionType: "RESERVATION_RELEASE",
      quantityChange: "0", quantityBefore: "0", quantityAfter: "0",
      reason: "reservation_release", createdBy: userId,
      metadata: { reservationId } as Record<string, unknown>,
    });
  }

  async releaseReservation(orgId: string, userId: string, reservationId: number): Promise<void> {
    return this.db.transaction((tx) => this.releaseReservationInTx(tx, orgId, userId, reservationId));
  }

  async consumeReservation(orgId: string, userId: string, reservationId: number): Promise<void> {
    return this.db.transaction(async (tx) => {
      const [reservation] = await tx.execute<{
        id: number; location_id: number | null; product_variant_id: number;
        lot_id: number | null; serial_id: number | null; reserved_qty: string; status: string;
      }>(sql`
        SELECT id, location_id, product_variant_id, lot_id, serial_id, reserved_qty, status
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
          reservedQty: reservation.reserved_qty,
        });
      }

      await tx.insert(invStockTransactions).values({
        orgId, productVariantId: reservation.product_variant_id,
        locationId: reservation.location_id, transactionType: "RESERVATION_CONSUME",
        quantityChange: "0", quantityBefore: "0", quantityAfter: "0",
        reason: "reservation_consume", createdBy: userId,
        metadata: { reservationId } as Record<string, unknown>,
      });
    });
  }

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
      reservedQty: string;
    }>,
  ): Promise<void> {
    if (reservations.length === 0) return;

    const activeIds = reservations.map((r) => r.id);

    await tx.execute(sql`
      UPDATE inv_stock_reservations
      SET status = 'CONSUMED', updated_at = NOW()
      WHERE id = ANY(ARRAY[${sql.join(activeIds.map((id) => sql`${id}`), sql`, `)}]::int[])
        AND org_id = ${orgId}
        AND status = 'ACTIVE'
    `);

    const withLocation = reservations.filter((r) => r.locationId !== null);
    for (const r of withLocation) {
      await releaseCommitted(tx, orgId, {
        productVariantId: r.productVariantId,
        locationId: r.locationId!,
        lotId: r.lotId ?? null,
        serialId: r.serialId ?? null,
        reservedQty: r.reservedQty,
      });
    }

    if (withLocation.length > 0) {
      await tx.insert(invStockTransactions).values(
        withLocation.map((r) => ({
          orgId,
          productVariantId: r.productVariantId,
          locationId: r.locationId,
          transactionType: "RESERVATION_CONSUME" as const,
          quantityChange: "0",
          quantityBefore: "0",
          quantityAfter: "0",
          reason: "reservation_consume",
          createdBy: userId,
          metadata: { reservationId: r.id },
        })),
      );
    }
  }

  async expireStale(orgId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const stale = await tx.execute<{
        id: number; location_id: number | null; product_variant_id: number;
        lot_id: number | null; serial_id: number | null; reserved_qty: string;
      }>(sql`
        SELECT id, location_id, product_variant_id, lot_id, serial_id, reserved_qty
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
          reservedQty: r.reserved_qty,
        });
      }

      return stale.length;
    });
  }
}
