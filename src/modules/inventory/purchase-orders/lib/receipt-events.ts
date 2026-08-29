import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../../stock-engine/command-events";

export interface ReceiptPostedFacts {
  orgId: string;
  actorUserId: string;
  idempotencyKey: string;
  grnId: number;
  grnNumber: string;
  receivedDate: string;
  locationId: number;
  poId: number;
  poNumber: string;
  vendorId: number;
  warehouseId: number | null;
  lineCount: number;
  acceptedLineCount: number;
  purchaseOrderStatus: "RECEIVED" | "PARTIAL";
}

/**
 * The two events a posted receipt owes, written into the post's own transaction.
 *
 * A5 kept both names on purpose. `inventory.purchase_order.received` is keyed on
 * the order, which is received many times, so it answers "this order has had
 * goods against it" and cannot answer "this delivery arrived";
 * `inventory.receiving.posted` is the delivery. Retiring either would silently
 * kill whatever is subscribed to it, and they key different aggregates so they
 * cannot collide on the outbox's per-aggregate version index.
 *
 * B1 moved both out of document creation and into the post. A draft has received
 * nothing, and a consumer told otherwise would reconcile a supplier's advice note
 * against goods still sitting on the dock.
 */
export async function emitReceiptPosted(
  tx: DbOrTx,
  facts: ReceiptPostedFacts,
): Promise<void> {
  await OutboxWriter.emit(tx, {
    eventId: randomUUID(),
    organizationId: facts.orgId,
    aggregateType: "inv_purchase_order",
    aggregateId: String(facts.poId),
    aggregateVersion: Date.now(),
    eventType: "inventory.purchase_order.received",
    payload: {
      poId: facts.poId,
      poNumber: facts.poNumber,
      grnId: facts.grnId,
      grnNumber: facts.grnNumber,
      lineCount: facts.lineCount,
      actorUserId: facts.actorUserId,
    },
    occurredAt: new Date(),
  });

  await emitInventoryCommandEvent(tx, {
    orgId: facts.orgId,
    eventType: INVENTORY_COMMAND_EVENTS.RECEIVING_POSTED,
    aggregateType: "inv_grn",
    aggregateId: String(facts.grnId),
    actorUserId: facts.actorUserId,
    payload: {
      grnId: facts.grnId,
      grnNumber: facts.grnNumber,
      poId: facts.poId,
      poNumber: facts.poNumber,
      vendorId: facts.vendorId,
      locationId: facts.locationId,
      warehouseId: facts.warehouseId,
      receivedDate: facts.receivedDate,
      lineCount: facts.lineCount,
      acceptedLineCount: facts.acceptedLineCount,
      // The order is closed by this receipt, or it is not. A consumer chasing
      // the supplier needs that without re-reading the order.
      purchaseOrderStatus: facts.purchaseOrderStatus,
      idempotencyKey: facts.idempotencyKey,
    },
  });
}
