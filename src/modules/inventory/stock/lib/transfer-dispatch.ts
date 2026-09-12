import { and, eq } from "drizzle-orm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  invStockReservations,
  invStockTransfers,
} from "../../../../db/schema";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../../stock-engine/command-events";
import { assertCommandEnd } from "./transfer-scope";
import { sourceWarehouseId, stampDispatchedCost } from "./transfer-commands";
import type { TransferDeps } from "./transfer-movement";

/**
 * Dispatch: empties the source bin and fills the source warehouse's transit location, two engine movements per line inside one transaction.
 *
 * A function over `TransferDeps` rather than a second `@Injectable`, the shape
 * `so-ship.ts` established here: the DI graph and every caller stay unchanged,
 * and the transaction stays owned by the service that opens it.
 */
export async function dispatchTransfer(
    deps: TransferDeps,
    orgId: string,
    userId: string,
    transferId: number,
    idempotencyKey: string,
  ) {
    /*
     * The movements this posts are already the engine's business — TRANSFER_OUT
     * at the source bin and TRANSFER_IN at the source warehouse's transit
     * location are both inside the source building, so `assertLocationsInScope`
     * would refuse an outsider a moment later and the STOCK was never at risk.
     *
     * What was at risk is everything before that: the header read reports the
     * status of a document the caller may not see, and the transit-location
     * resolve can CREATE a bin in a building they hold nothing in. Refusing here
     * means neither happens, and the refusal is a 404 rather than a status
     * conflict that would describe the document.
     */
    await assertCommandEnd(deps.db, deps.warehouseScope, orgId, userId, transferId, "source");

    const transfer = await deps.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: { lines: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "PENDING" && transfer.status !== "RESERVED") {
      throw new BadRequestException("Only PENDING or RESERVED transfers can be dispatched");
    }

    await deps.db.transaction(async (tx) => {
      // Renamed from `sourceWarehouseId` when the helper moved out of the class:
      // `this.sourceWarehouseId(...)` became `sourceWarehouseId(...)`, so the old
      // local shadowed the function it calls.
      const fromWarehouse = await sourceWarehouseId(tx, orgId, transfer);
      const transitLocationId = await deps.transitLocations.resolve(tx, orgId, fromWarehouse);
      const result = await deps.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey,
        sourceType: "inv_transfer",
        sourceId: transferId.toString(),
        reason: `Dispatch transfer ${transfer.referenceNumber}`,
        // Paired, and the transit receipt inherits the outbound issue's derived
        // cost by index: the goods enter transit at exactly what leaving the
        // source consumed. An estimate read beforehand — average cost, or the
        // oldest open layer — is exact under weighted average but wrong under
        // FIFO as soon as an issue crosses a layer boundary, and understates
        // inventory for the whole journey.
        movements: transfer.lines.flatMap((line, lineIndex) => [
          {
            transactionType: "TRANSFER_OUT" as const,
            productVariantId: line.productVariantId,
            locationId: transfer.fromLocationId,
            quantityDelta: `-${line.quantity}`,
            lotId: line.lotId ?? undefined,
            serialId: line.serialId ?? undefined,
          },
          {
            transactionType: "TRANSFER_IN" as const,
            productVariantId: line.productVariantId,
            locationId: transitLocationId,
            quantityDelta: line.quantity,
            lotId: line.lotId ?? undefined,
            serialId: line.serialId ?? undefined,
            costFromMovementIndex: lineIndex * 2,
          },
        ]),
      });

      // Carry the cost the source layers were actually consumed at onto the
      // line, so completion can rebuild it at the destination. Cost layers are
      // keyed per location, so without this the stock arrives with no basis.
      await stampDispatchedCost(
        tx, orgId, transfer.fromLocationId, transfer.lines, result.transactionIds,
      );

      if (transfer.status === "RESERVED") {
        const activeReservations = await tx
          .select({
            id: invStockReservations.id,
            locationId: invStockReservations.locationId,
            productVariantId: invStockReservations.productVariantId,
            reservedQty: invStockReservations.reservedQty,
          })
          .from(invStockReservations)
          .where(and(
            eq(invStockReservations.orgId, orgId),
            eq(invStockReservations.sourceType, "inv_transfer"),
            eq(invStockReservations.sourceId, transferId.toString()),
            eq(invStockReservations.status, "ACTIVE"),
          ));

        const consumed = await deps.reservationService.consumeReservationsBatch(
          tx, orgId, userId, activeReservations,
        );

        // A5. Reservations are only ever consumed as part of a larger command,
        // so the event hangs off the command's idempotency key rather than any
        // one reservation: the set is the fact, and a per-reservation event
        // would be one per row.
        if (consumed.length > 0) {
          await emitInventoryCommandEvent(tx, {
            orgId,
            eventType: INVENTORY_COMMAND_EVENTS.RESERVATION_CONSUMED,
            aggregateType: "inv_stock_reservation",
            aggregateId: idempotencyKey,
            actorUserId: userId,
            payload: {
              reservationIds: consumed,
              sourceType: "inv_transfer",
              sourceId: String(transferId),
              consumedBy: "transfer.dispatch",
            },
          });
        }
      }

      await tx.update(invStockTransfers)
        .set({ status: "IN_TRANSIT", dispatchedAt: new Date() })
        .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

      // A5. The status guard above refuses anything that is not PENDING or
      // RESERVED, so a replayed dispatch throws before it reaches here and the
      // event lands exactly once per accepted dispatch.
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.TRANSFER_DISPATCHED,
        aggregateType: "inv_stock_transfer",
        aggregateId: String(transferId),
        actorUserId: userId,
        payload: {
          transferId,
          referenceNumber: transfer.referenceNumber,
          fromLocationId: transfer.fromLocationId,
          toLocationId: transfer.toLocationId,
          fromWarehouseId: fromWarehouse,
          toWarehouseId: transfer.toWarehouseId,
          // Where the goods are standing until they arrive. Without it a
          // consumer cannot answer "where is my stock" during the journey.
          transitLocationId,
          lineCount: transfer.lines.length,
          idempotencyKey,
        },
      });
    });

    await Promise.all([
      deps.engine.invalidateCaches(orgId),
      deps.cache.invalidateNamespace(`inv:reservations:list:${orgId}`),
    ]);
  }

  // B1-07: engine.executeInTx + line quantityReceived updates + status update in one transaction.
  // invalidateCaches called after.
  //
  // A2. The mirror of dispatch: TRANSFER_OUT takes the goods off the source
  // warehouse's transit location and TRANSFER_IN puts them in the destination
  // bin, in one command, so on-hand is conserved on arrival exactly as it was on
  // departure.
  //
  // Only what was actually received leaves transit. `quantityReceived` may be
  // less than what was dispatched -- a short receipt is a real event, not an
  // error -- and the shortfall stays standing at the transit location rather
  // than being silently written off. It is on hand, it is not sellable, and it
  // is visible to anyone asking where the missing units went.
  //
  // The transit leg is skipped when the transfer never reached IN_TRANSIT.
  // Completing straight from PENDING or RESERVED posts a destination receipt
  // with no matching issue anywhere -- stock from nowhere -- which is a
  // pre-existing hole in this state machine and not one this change opens or
  // closes; adding a transit issue for goods that were never dispatched would
