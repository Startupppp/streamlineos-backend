import { and, eq } from "drizzle-orm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  invStockTransactions,
  invStockTransferLines,
  invStockTransfers,
} from "../../../../db/schema";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../../stock-engine/command-events";
import type { CompleteTransferInput } from "../dto/inv-stock.schemas";
import { assertCommandEnd } from "./transfer-scope";
import { sourceWarehouseId } from "./transfer-commands";
import type { Db } from "../../../../db/drizzle.module";
import type { TransferDeps } from "./transfer-movement";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Complete: the mirror of dispatch — takes the goods off the source warehouse's transit location and puts them in the destination.
 *
 * A function over `TransferDeps` rather than a second `@Injectable`, the shape
 * `so-ship.ts` established here: the DI graph and every caller stay unchanged,
 * and the transaction stays owned by the service that opens it.
 */
export async function completeTransfer(
    deps: TransferDeps,
    orgId: string,
    userId: string,
    transferId: number,
    data: CompleteTransferInput,
    idempotencyKey: string,
  ) {
    /*
     * The DESTINATION end, because completing is a receipt: the goods land in
     * `toLocationId` and the person who answers for that is the keeper there.
     * It is also the end the engine will assert on the arrival movement, so this
     * refuses nothing the engine would have allowed — it simply refuses it
     * before the status is disclosed and before a short receipt can be described
     * back to somebody who cannot see the document.
     */
    await assertCommandEnd(deps.db, deps.warehouseScope, orgId, userId, transferId, "destination");

    const transfer = await deps.db.query.invStockTransfers.findFirst({
      where: and(eq(invStockTransfers.id, transferId), eq(invStockTransfers.orgId, orgId)),
      with: { lines: true },
    });
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "IN_TRANSIT" && transfer.status !== "PENDING" && transfer.status !== "RESERVED") {
      throw new BadRequestException("Transfer cannot be completed in its current status");
    }
    const wasDispatched = transfer.status === "IN_TRANSIT";

    await deps.db.transaction(async (tx: Tx) => {
      const transitLocationId = wasDispatched
        ? await deps.transitLocations.resolve(
            tx, orgId, await sourceWarehouseId(tx, orgId, transfer),
          )
        : null;

      const movements = data.lines.flatMap((completion) => {
        const line = transfer.lines.find((l) => l.id === completion.transferLineId);
        if (!line || completion.quantityReceived <= 0) return [];
        const received = completion.quantityReceived.toFixed(4);
        const arrival = {
          transactionType: "TRANSFER_IN" as const,
          productVariantId: line.productVariantId,
          locationId: transfer.toLocationId,
          quantityDelta: received,
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
          unitCost: line.dispatchedUnitCost ?? undefined,
        };
        if (transitLocationId === null) return [arrival];
        return [
          {
            transactionType: "TRANSFER_OUT" as const,
            productVariantId: line.productVariantId,
            locationId: transitLocationId,
            quantityDelta: `-${received}`,
            lotId: line.lotId ?? undefined,
            serialId: line.serialId ?? undefined,
          },
          arrival,
        ];
      });

      await deps.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey,
        sourceType: "inv_transfer",
        sourceId: transferId.toString(),
        reason: `Complete transfer ${transfer.referenceNumber}`,
        movements,
      });

      /*
        ACC-21. A transfer reaches the ledger once, here, and over EVERY
        movement the transfer wrote — not once per leg.

        Nothing posts at dispatch on purpose. The general ledger has a single
        inventory account with no location dimension, so goods in transit are
        still inventory and the balance sheet is already right while they
        move. Posting the outbound leg on its own would credit inventory
        against the adjustment account and park in-transit goods on the P&L
        until they arrived.

        Here the dispatch pair (source to transit) and this completion pair
        (transit to destination) are netted together by the bridge: an intact
        transfer nets to zero and writes no journal, and any value the legs
        disagree on posts against inventory_adjustment. A short receipt's
        remainder stays on the transit location — still owned, so still
        inventory — until the transit-exit path settles it. The status guard
        above makes completion once per transfer, so this cannot post twice.
      */
      const documentRows = await tx
        .select({ id: invStockTransactions.id })
        .from(invStockTransactions)
        .where(and(
          eq(invStockTransactions.orgId, orgId),
          eq(invStockTransactions.referenceType, "inv_transfer"),
          eq(invStockTransactions.referenceId, transferId.toString()),
        ));

      await deps.glBridge.post(
        orgId,
        userId,
        {
          kind: "transfer",
          documentId: String(transferId),
          transactionIds: documentRows.map((row) => row.id),
          journalDate: new Date().toISOString().slice(0, 10),
          memo: `Transfer ${transfer.referenceNumber}`,
        },
        tx,
      );

      let receivedLineCount = 0;
      for (const completion of data.lines) {
        const line = transfer.lines.find((l) => l.id === completion.transferLineId);
        if (!line) continue;
        receivedLineCount += 1;
        await tx.update(invStockTransferLines)
          .set({ quantityReceived: completion.quantityReceived.toString() })
          .where(and(
            eq(invStockTransferLines.id, completion.transferLineId),
            eq(invStockTransferLines.transferId, transferId),
          ));
      }

      await tx.update(invStockTransfers)
        .set({ status: "COMPLETED", completedAt: new Date() })
        .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

      // A5. As with dispatch, the status guard makes this once-per-acceptance:
      // a completed transfer can no longer be completed.
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.TRANSFER_COMPLETED,
        aggregateType: "inv_stock_transfer",
        aggregateId: String(transferId),
        actorUserId: userId,
        payload: {
          transferId,
          referenceNumber: transfer.referenceNumber,
          fromLocationId: transfer.fromLocationId,
          toLocationId: transfer.toLocationId,
          fromWarehouseId: transfer.fromWarehouseId,
          toWarehouseId: transfer.toWarehouseId,
          lineCount: transfer.lines.length,
          receivedLineCount,
          // A completion that never went through transit is a different event
          // in substance — nothing was ever dispatched — and a consumer
          // reconciling against a dispatch needs to know which it is holding.
          wasDispatched,
          idempotencyKey,
        },
      });
    });

    await deps.engine.invalidateCaches(orgId);
  }
