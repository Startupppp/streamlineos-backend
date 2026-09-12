import { and, eq, inArray, sql } from "drizzle-orm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  invStockReservations,
  invStockTransactions,
  invStockTransferLines,
  invStockTransfers,
} from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import type { ReservationService } from "../../stock-engine/reservation.service";
import type { CreateTransferInput } from "../dto/inv-stock.schemas";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../../stock-engine/command-events";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The grain a transfer's cost is carried at. Valuation layers are keyed per
 * (variant, location, lot) and know nothing about serials, so a serial is not
 * part of this key.
 */
export function costKey(line: { productVariantId: number; lotId: number | null }): string {
  return `${line.productVariantId}:${line.lotId ?? ""}`;
}

/**
 * The transfer command bodies that run INSIDE a transaction somebody else owns,
 * lifted out of `inv-stock-transfers.service.ts` unchanged.
 *
 * Functions taking their dependencies rather than a second `@Injectable`, which
 * is the shape `so-ship.ts` established here and for its reason: the DI graph
 * and every caller stay unchanged, and the transaction stays owned by the
 * service that opens it. A service with its own `db` handle would be an
 * invitation to forget that these may only run inside one.
 */
export async function createTransferInTx(
    numSeq: NumberSequenceService,

    tx: Tx,
    orgId: string,
    userId: string,
    data: CreateTransferInput,
  ): Promise<number> {
    {
      const referenceNumber = await numSeq.next(orgId, "TRANSFER", tx);
      const [created] = await tx.insert(invStockTransfers).values({
        orgId,
        referenceNumber,
        fromLocationId: data.fromLocationId,
        toLocationId: data.toLocationId,
        fromWarehouseId: data.fromWarehouseId ?? null,
        toWarehouseId: data.toWarehouseId ?? null,
        notes: data.notes,
        createdBy: userId,
      }).returning();

      await tx.insert(invStockTransferLines).values(
        data.lines.map((line) => ({
          orgId,
          transferId: created!.id,
          productVariantId: line.productVariantId,
          quantity: line.quantity.toString(),
          lotId: line.lotId ?? null,
          serialId: line.serialId ?? null,
        }))
      );

      return created!.id;
    }
  }

export async function reserveTransferInTx(
    reservations: ReservationService,

    tx: Tx, orgId: string, userId: string, transferId: number, idempotencyKey: string,
  ) {
    const [locked] = await tx.execute<{
      id: number; status: string; reference_number: string;
      from_location_id: number; to_location_id: number;
      from_warehouse_id: number | null; to_warehouse_id: number | null; org_id: string;
    }>(sql`
      SELECT id, status, reference_number, from_location_id, to_location_id,
             from_warehouse_id, to_warehouse_id, org_id
      FROM inv_stock_transfers
      WHERE id = ${transferId} AND org_id = ${orgId}
      FOR UPDATE
    `);

    if (!locked) throw new NotFoundException("Transfer not found");
    if (locked.status !== "PENDING") throw new BadRequestException("Only PENDING transfers can be reserved");

    const lines = await tx.query.invStockTransferLines.findMany({
      where: eq(invStockTransferLines.transferId, transferId),
    });

    const reservationIds: number[] = [];
    for (const line of lines) {
      const reservation = await reservations.createReservationInTx(tx, orgId, userId, {
        sourceType: "inv_transfer",
        sourceId: transferId.toString(),
        sourceLineId: line.id.toString(),
        productVariantId: line.productVariantId,
        locationId: locked.from_location_id,
        lotId: line.lotId ?? undefined,
        serialId: line.serialId ?? undefined,
        qty: line.quantity,
      });
      reservationIds.push(reservation.id);
    }

    await tx.update(invStockTransfers)
      .set({ status: "RESERVED", reservedAt: new Date() })
      .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

    // A5. One event for the reserve, not one per line: reserving a transfer is
    // a single decision about a single document, and a consumer that saw four
    // of five line events would think the transfer was partly held. The
    // reservation ids ride along so a consumer tracking reservations still
    // learns about the ones this command raised.
    await emitInventoryCommandEvent(tx, {
      orgId,
      eventType: INVENTORY_COMMAND_EVENTS.TRANSFER_RESERVED,
      aggregateType: "inv_stock_transfer",
      aggregateId: String(transferId),
      actorUserId: userId,
      payload: {
        transferId,
        referenceNumber: locked.reference_number,
        fromLocationId: Number(locked.from_location_id),
        toLocationId: Number(locked.to_location_id),
        fromWarehouseId: locked.from_warehouse_id === null ? null : Number(locked.from_warehouse_id),
        toWarehouseId: locked.to_warehouse_id === null ? null : Number(locked.to_warehouse_id),
        lineCount: lines.length,
        reservationIds,
        idempotencyKey,
      },
    });

    return transferId;
  }

  /**
   * Reads back the unit cost the engine derived for each TRANSFER_OUT and stores
   * it on the matching transfer line. Matched on (variant, lot) because a
   * transfer may move several lots of the same variant.
   *
   * A2. A dispatch now writes two rows per line, and the second one is a
   * TRANSFER_IN at the transit location whose cost is the estimated basis this
   * service handed the engine, not the cost the source layers were actually
   * consumed at. Matching it instead of the OUT leg would cost the destination
   * from the waypoint's own inbound number and lose the entire point of
   * carrying the cost across, so the read is pinned to the OUT leg twice over:
   * by transaction type and by source location.
   */
export async function stampDispatchedCost(

    tx: Tx,
    orgId: string,
    fromLocationId: number,
    lines: ReadonlyArray<{ id: number; productVariantId: number; lotId: number | null }>,
    transactionIds: readonly number[],
  ): Promise<void> {
    if (transactionIds.length === 0) return;

    const txns = await tx
      .select({
        productVariantId: invStockTransactions.productVariantId,
        lotId: invStockTransactions.lotId,
        unitCost: invStockTransactions.unitCost,
      })
      .from(invStockTransactions)
      .where(and(
        eq(invStockTransactions.orgId, orgId),
        inArray(invStockTransactions.id, [...transactionIds]),
        eq(invStockTransactions.transactionType, "TRANSFER_OUT"),
        eq(invStockTransactions.locationId, fromLocationId),
      ));

    const costByKey = new Map<string, string>();
    for (const t of txns)
      if (t.unitCost) costByKey.set(`${t.productVariantId}:${t.lotId ?? ""}`, t.unitCost);

    for (const line of lines) {
      const cost = costByKey.get(costKey(line));
      if (!cost) continue;
      await tx.update(invStockTransferLines)
        .set({ dispatchedUnitCost: cost })
        .where(eq(invStockTransferLines.id, line.id));
    }
  }

  /**
   * The warehouse the goods are leaving.
   *
   * `from_warehouse_id` is nullable on the header — a transfer may name only its
   * locations — so the location's own warehouse is the fallback, and the only
   * answer that is always available.
   */
export async function sourceWarehouseId(

    tx: Tx,
    orgId: string,
    transfer: { fromWarehouseId: number | null; fromLocationId: number },
  ): Promise<number> {
    if (transfer.fromWarehouseId !== null) return transfer.fromWarehouseId;
    const [row] = await tx.execute<{ warehouse_id: number }>(sql`
      SELECT warehouse_id FROM inv_locations
      WHERE org_id = ${orgId} AND id = ${transfer.fromLocationId}
      LIMIT 1
    `);
    if (!row) throw new BadRequestException("Transfer source location no longer exists");
    return Number(row.warehouse_id);
  }

export async function cancelTransferInTx(
    reservations: ReservationService,

    tx: Tx,
    orgId: string,
    userId: string,
    transferId: number,
    status: string,
  ): Promise<{ cancelled: number }> {
    if (status === "RESERVED") {
      const activeReservations = await tx
        .select({ id: invStockReservations.id })
        .from(invStockReservations)
        .where(and(
          eq(invStockReservations.orgId, orgId),
          eq(invStockReservations.sourceType, "inv_transfer"),
          eq(invStockReservations.sourceId, transferId.toString()),
          eq(invStockReservations.status, "ACTIVE"),
        ));

      for (const res of activeReservations) {
        await reservations.releaseReservationInTx(tx, orgId, userId, res.id);
      }
    }

    await tx.update(invStockTransfers)
      .set({ status: "CANCELLED" })
      .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

    return { cancelled: transferId };
  }
