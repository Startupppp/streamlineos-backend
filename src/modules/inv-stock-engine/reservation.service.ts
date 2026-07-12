import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, lt, sql } from "drizzle-orm";
import { invStockReservations, invStockLevels, invStockTransactions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { InventorySettingsService } from "./inventory-settings.service";
import { INV_ERRORS, type ReservationInput } from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

    if (input.locationId) {
      await (tx as Db).insert(invStockLevels).values({
        orgId, productVariantId: input.productVariantId,
        locationId: input.locationId, lotId: input.lotId ?? null,
        serialId: input.serialId ?? null,
        onHand: "0", committed: "0", onOrder: "0",
        blockedQty: "0", qualityHoldQty: "0", outgoingQty: "0",
      }).onConflictDoNothing();

      const [level] = await (tx as Db).execute<{
        id: number; on_hand: string; committed: string; blocked_qty: string; quality_hold_qty: string;
      }>(sql`
        SELECT id, on_hand, committed, blocked_qty, quality_hold_qty
        FROM inv_stock_levels
        WHERE org_id = ${orgId} AND product_variant_id = ${input.productVariantId}
          AND location_id = ${input.locationId}
          AND (lot_id IS NOT DISTINCT FROM ${input.lotId ?? null})
          AND (serial_id IS NOT DISTINCT FROM ${input.serialId ?? null})
        FOR UPDATE
      `);

      if (!level) throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

      const available = parseFloat(level.on_hand) - parseFloat(level.committed) - parseFloat(level.blocked_qty ?? "0") - parseFloat(level.quality_hold_qty ?? "0");

      if (!settings.allowBackorders && available < parseFloat(input.qty)) {
        throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK });
      }

      await (tx as Db).update(invStockLevels)
        .set({ committed: sql`committed + ${input.qty}::numeric` })
        .where(eq(invStockLevels.id, level.id));
    }

    await (tx as Db).insert(invStockTransactions).values({
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

    const [reservation] = await (tx as Db).insert(invStockReservations).values({
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

  async releaseReservation(orgId: string, userId: string, reservationId: number): Promise<void> {
    return this.db.transaction(async (tx) => {
      const [reservation] = await (tx as Db).execute<{
        id: number; location_id: number | null; product_variant_id: number;
        lot_id: number | null; serial_id: number | null; reserved_qty: string; status: string;
      }>(sql`
        SELECT id, location_id, product_variant_id, lot_id, serial_id, reserved_qty, status
        FROM inv_stock_reservations
        WHERE id = ${reservationId} AND org_id = ${orgId}
        FOR UPDATE
      `);

      if (!reservation || reservation.status !== "ACTIVE") return;

      await (tx as Db).update(invStockReservations)
        .set({ status: "RELEASED" })
        .where(eq(invStockReservations.id, reservationId));

      if (reservation.location_id) {
        await (tx as Db).update(invStockLevels)
          .set({ committed: sql`GREATEST(0, committed - ${reservation.reserved_qty}::numeric)` })
          .where(and(
            eq(invStockLevels.orgId, orgId),
            eq(invStockLevels.productVariantId, reservation.product_variant_id),
            eq(invStockLevels.locationId, reservation.location_id),
          ));
      }

      await (tx as Db).insert(invStockTransactions).values({
        orgId, productVariantId: reservation.product_variant_id,
        locationId: reservation.location_id,
        transactionType: "RESERVATION_RELEASE",
        quantityChange: "0", quantityBefore: "0", quantityAfter: "0",
        reason: "reservation_release", createdBy: userId,
        metadata: { reservationId } as Record<string, unknown>,
      });
    });
  }

  async consumeReservation(orgId: string, userId: string, reservationId: number): Promise<void> {
    return this.db.transaction(async (tx) => {
      const [reservation] = await (tx as Db).execute<{
        id: number; location_id: number | null; product_variant_id: number; reserved_qty: string; status: string;
      }>(sql`
        SELECT id, location_id, product_variant_id, reserved_qty, status
        FROM inv_stock_reservations WHERE id = ${reservationId} AND org_id = ${orgId}
        FOR UPDATE
      `);

      if (!reservation || reservation.status !== "ACTIVE") return;

      await (tx as Db).update(invStockReservations).set({ status: "CONSUMED" }).where(eq(invStockReservations.id, reservationId));

      if (reservation.location_id) {
        await (tx as Db).update(invStockLevels)
          .set({ committed: sql`GREATEST(0, committed - ${reservation.reserved_qty}::numeric)` })
          .where(and(eq(invStockLevels.orgId, orgId), eq(invStockLevels.productVariantId, reservation.product_variant_id), eq(invStockLevels.locationId, reservation.location_id)));
      }

      await (tx as Db).insert(invStockTransactions).values({
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
      reservedQty: string;
    }>,
  ): Promise<void> {
    if (reservations.length === 0) return;

    const activeIds = reservations.map((r) => r.id);

    await (tx as Db).execute(sql`
      UPDATE inv_stock_reservations
      SET status = 'CONSUMED', updated_at = NOW()
      WHERE id = ANY(ARRAY[${sql.join(activeIds.map((id) => sql`${id}`), sql`, `)}]::int[])
        AND org_id = ${orgId}
        AND status = 'ACTIVE'
    `);

    const withLocation = reservations.filter((r) => r.locationId !== null);
    for (const r of withLocation) {
      await (tx as Db).update(invStockLevels)
        .set({ committed: sql`GREATEST(0, committed - ${r.reservedQty}::numeric)` })
        .where(and(
          eq(invStockLevels.orgId, orgId),
          eq(invStockLevels.productVariantId, r.productVariantId),
          eq(invStockLevels.locationId, r.locationId!),
        ));
    }

    if (withLocation.length > 0) {
      await (tx as Db).insert(invStockTransactions).values(
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
    const now = new Date();
    const result = await this.db.update(invStockReservations)
      .set({ status: "EXPIRED" })
      .where(and(eq(invStockReservations.orgId, orgId), eq(invStockReservations.status, "ACTIVE"), lt(invStockReservations.expiresAt, now)));
    const raw: unknown = result;
    if (raw && typeof raw === "object") {
      if ("rowCount" in raw) return Number(raw.rowCount ?? 0);
      if ("count" in raw) return Number(raw.count ?? 0);
    }
    return 0;
  }
}
