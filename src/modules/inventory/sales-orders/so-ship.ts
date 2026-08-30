import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invSalesOrders,
  invSerialNumbers,
  invShipmentLines,
  invShipments,
  invSoLines,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { StockEngineService } from "../stock-engine/stock-engine.service";
import type { ReservationService } from "../stock-engine/reservation.service";
import type { NumberSequenceService } from "../stock-engine/number-sequence.service";
import type { StockProjectionService } from "../stock-engine/stock-projection.service";
import type { ChannelPoolService } from "../stock-engine/channel-pool.service";
import { INV_ERRORS } from "../stock-engine/stock-engine.types";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import { addDec, cmpDec, mulDec } from "../stock-engine/decimal";
import { shelfLines } from "../shipments/packing-reconciliation";
import type { ShipSoInput } from "./dto/inv-sales-orders.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * B7 — the ship command's body, out of `SoFulfillmentService`.
 *
 * Split off because it is the module's one *stock-posting* command and the only
 * one whose ordering is load-bearing end to end: claim, read under lock, post,
 * consume, record, recompute. It sat inside a 700-line service beside three
 * commands that post nothing, where the sequence was impossible to read as a
 * sequence.
 *
 * A function taking its dependencies rather than a second `@Injectable`, so the
 * DI graph and every caller are unchanged and the transaction stays owned by the
 * service that opens it — this may only ever run *inside* somebody else's
 * transaction, and a service with its own `db` handle is an invitation to forget
 * that.
 */
export interface ShipDeps {
  readonly engine: StockEngineService;
  readonly reservations: ReservationService;
  readonly numSeq: NumberSequenceService;
  readonly projection: StockProjectionService;
  /** NEO-1 — draws the ordering channel's claim down as the units actually go. */
  readonly channelPools: ChannelPoolService;
}

/**
 * The two settings shipping consults, structurally rather than as the settings
 * type, so this module does not drag the settings service into its imports for
 * two booleans.
 */
export interface ShipSettings {
  readonly packageRequiredForShipping: boolean;
  readonly allowPartialShipment: boolean;
}

export interface PostShipmentArgs {
  readonly orgId: string;
  readonly soId: number;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly data: ShipSoInput;
  readonly settings: ShipSettings;
  readonly cogs: DeferredCogs;
}

export interface ShipSoResult {
  shipmentId: number;
  shipmentNumber: string;
  status: "SHIPPED" | "PARTIALLY_SHIPPED";
  isPartial: boolean;
}

/** The ship result as it comes back from the idempotency row's stored JSON. */
export function reviveShipResult(stored: unknown): ShipSoResult {
  const row = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const isPartial = row.isPartial === true;
  return {
    shipmentId: Number(row.shipmentId ?? 0),
    shipmentNumber: String(row.shipmentNumber ?? ""),
    // Derived from the one stored fact rather than stored twice: two fields that
    // can disagree is how a replay starts answering something the first run
    // never said.
    status: isPartial ? "PARTIALLY_SHIPPED" : "SHIPPED",
    isPartial,
  };
}

/** One issue the ship command is about to post, at the grain it comes off. */
interface ShipMovement {
  productVariantId: number;
  soLineId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
  quantity: string;
}

interface OutgoingGrain {
  productVariantId: number;
  locationId: number;
  lotId: number | null;
  serialId: number | null;
}

function grainKey(grain: OutgoingGrain): string {
  return `${grain.productVariantId}|${grain.locationId}|${grain.lotId ?? ""}|${grain.serialId ?? ""}`;
}

/**
 * Everything the COGS entry needs, carried out of the transaction.
 *
 * The journal is posted **after** the commit and only on the run that did the
 * work: `postJournalEntry` opens its own connection, so posting it inside would
 * leave an entry behind for a shipment that rolled back, and posting it
 * unconditionally would post it again on every replay of the same key.
 */
export interface DeferredCogs {
  total: string;
  soNumber: string;
}

export async function postShipment(
  deps: ShipDeps,
  tx: Tx,
  args: PostShipmentArgs,
): Promise<ShipSoResult> {
  const { orgId, soId, userId, idempotencyKey, data, settings, cogs } = args;
  const so = await tx.query.invSalesOrders.findFirst({
    where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
    columns: { id: true, soNumber: true, status: true, warehouseId: true, channelId: true },
    with: {
      lines: {
        columns: { id: true, productVariantId: true, quantity: true, costAtTime: true },
      },
    },
  });
  if (!so) throw new NotFoundException("Sales order not found");

  const allowedStatuses = ["CONFIRMED", "RESERVED", "PARTIALLY_RESERVED", "PICKED", "PACKED"];
  if (!allowedStatuses.includes(so.status)) {
    throw new BadRequestException(`Sales order must be in one of ${allowedStatuses.join(", ")} to ship`);
  }
  if (settings.packageRequiredForShipping && so.status !== "PACKED") {
    throw new BadRequestException("Sales order must be PACKED before shipping (packageRequiredForShipping is enabled)");
  }

  const shelf = await shelfLines(tx, orgId, soId);

  /**
   * Locked, not merely selected.
   *
   * `consumeReservationsBatch` releases `committed` for every reservation it
   * is handed and reports back only the ones it actually flipped — so the list
   * this command hands it has to be a list nobody else can be holding. The
   * `FOR UPDATE` plus the `ACTIVE` predicate is that guarantee: a second ship
   * blocks here, re-reads after the lock and finds the rows CONSUMED.
   */
  const reservations = await tx.execute<{
    id: number;
    source_line_id: string | null;
    location_id: number | null;
    product_variant_id: number;
    lot_id: number | null;
    serial_id: number | null;
    reserved_qty: string;
  }>(sql`
    SELECT id, source_line_id, location_id, product_variant_id, lot_id, serial_id, reserved_qty
      FROM inv_stock_reservations
     WHERE org_id = ${orgId}
       AND source_type = 'inv_sales_order'
       AND source_id = ${String(soId)}
       AND status = 'ACTIVE'
     ORDER BY id
     FOR UPDATE
  `);

  const movements: ShipMovement[] = [];
  for (const line of shelf) {
    // A line closed by an exception can hold zero, and a zero movement is
    // refused by the ledger's non-zero CHECK rather than ignored. Nothing left
    // that shelf, so there is nothing to issue.
    if (cmpDec(line.quantity, "0") === 0) continue;
    if (line.locationId === null) {
      throw new BadRequestException(`Pick list line ${line.pickLineId} is missing a location`);
    }
    movements.push({
      productVariantId: line.productVariantId,
      soLineId: line.soLineId,
      locationId: line.locationId,
      lotId: line.lotId,
      serialId: line.serialId,
      quantity: line.quantity,
    });
  }

  // Nothing was picked: ship straight off the reservations. Keyed on the
  // movement list rather than on the pick-list lookup, so an order whose only
  // pick lines were closed by exceptions still reaches this rather than
  // shipping an empty shipment.
  if (movements.length === 0) {
    for (const line of so.lines) {
      const reservation = reservations.find((r) => r.source_line_id === String(line.id));
      const locationId = reservation?.location_id;
      if (locationId === undefined || locationId === null) {
        throw new BadRequestException(`No pick list or reservation for SO line ${line.id}`);
      }
      movements.push({
        productVariantId: line.productVariantId,
        soLineId: line.id,
        locationId: Number(locationId),
        lotId: reservation?.lot_id === null || reservation?.lot_id === undefined ? null : Number(reservation.lot_id),
        serialId: reservation?.serial_id === null || reservation?.serial_id === undefined ? null : Number(reservation.serial_id),
        quantity: line.quantity,
      });
    }
  }

  // Exact, like the pick's own completeness test. Deciding whether a whole
  // order has shipped on the strength of float comparisons is how an order is
  // marked SHIPPED one unit short and nothing notices.
  const totalOrdered = so.lines.reduce((sum, l) => addDec(sum, l.quantity), "0");
  const totalShipping = movements.reduce((sum, m) => addDec(sum, m.quantity), "0");
  const isPartial = cmpDec(totalShipping, totalOrdered) < 0;

  if (isPartial && !settings.allowPartialShipment) {
    throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK, message: "Partial shipment is not allowed" });
  }

  // Drawn inside the claim, so a refused retry does not burn a shipment
  // number, and a rolled-back one gives its number back with the rest.
  const shipmentNumber = await deps.numSeq.next(orgId, "SHIPMENT", tx);
  const newStatus = isPartial ? "PARTIALLY_SHIPPED" : "SHIPPED";

  await deps.engine.executeInTx(tx, orgId, userId, {
    // Derived rather than shared: the command's own key is already claimed by
    // `runIdempotent` above, and handing the engine the same string would make
    // it collide with that live claim.
    idempotencyKey: `${idempotencyKey}:stock`,
    sourceType: "inv_sales_order",
    sourceId: String(soId),
    reason: `Shipment for SO ${so.soNumber}`,
    movements: movements.map((m) => ({
      transactionType: "SALE",
      productVariantId: m.productVariantId,
      locationId: m.locationId,
      lotId: m.lotId ?? undefined,
      serialId: m.serialId ?? undefined,
      quantityDelta: `-${m.quantity}`,
    })),
  });

  const consumedReservations = await deps.reservations.consumeReservationsBatch(
    tx,
    orgId,
    userId,
    reservations.map((r) => ({
      id: Number(r.id),
      locationId: r.location_id === null ? null : Number(r.location_id),
      productVariantId: Number(r.product_variant_id),
      // Carried through, where they were dropped: `releaseCommitted` matches
      // on the reservation's full grain, so omitting them decremented the
      // no-lot row at that location and left the lot's own `committed`
      // standing for good.
      lotId: r.lot_id === null ? null : Number(r.lot_id),
      serialId: r.serial_id === null ? null : Number(r.serial_id),
      reservedQty: r.reserved_qty,
    })),
  );

  // A5. Shipping is one of the two places a reservation is ever consumed, and
  // the set is the fact — one event for the command, keyed on the command's
  // own idempotency key, rather than one per reservation.
  if (consumedReservations.length > 0) {
    await emitInventoryCommandEvent(tx, {
      orgId,
      eventType: INVENTORY_COMMAND_EVENTS.RESERVATION_CONSUMED,
      aggregateType: "inv_stock_reservation",
      aggregateId: idempotencyKey,
      actorUserId: userId,
      payload: {
        reservationIds: consumedReservations,
        sourceType: "inv_sales_order",
        sourceId: String(soId),
        consumedBy: "sales_order.ship",
      },
    });
  }

  // NEO-1. The claim existed to stop anybody else selling these units; once they
  // have left, there is nothing left to hold. Drawn down here rather than at pick
  // or pack because shipping is the point at which the stock is actually gone —
  // and only for an order that names a channel, since a direct sale holds no pool.
  if (so.channelId != null) {
    const shippedByVariant = new Map<number, string>();
    for (const m of movements) {
      shippedByVariant.set(
        m.productVariantId,
        addDec(shippedByVariant.get(m.productVariantId) ?? "0", m.quantity),
      );
    }
    for (const [productVariantId, qty] of shippedByVariant) {
      await deps.channelPools.consumeInTx(tx, orgId, {
        channelId: so.channelId,
        productVariantId,
        warehouseId: so.warehouseId,
        qty,
      });
    }
  }

  const serialIds = movements.flatMap((m) => (m.serialId === null ? [] : [m.serialId]));
  if (serialIds.length > 0) {
    await tx.update(invSerialNumbers)
      .set({ status: "SHIPPED" })
      .where(and(eq(invSerialNumbers.orgId, orgId), inArray(invSerialNumbers.id, serialIds)));
  }

  const lineShippedQty = new Map<number, string>();
  for (const m of movements)
    lineShippedQty.set(m.soLineId, addDec(lineShippedQty.get(m.soLineId) ?? "0", m.quantity));

  for (const [lineId, shippedQty] of lineShippedQty) {
    await tx.update(invSoLines)
      .set({ quantityShipped: sql`${invSoLines.quantityShipped} + ${shippedQty}::numeric` })
      .where(and(eq(invSoLines.orgId, orgId), eq(invSoLines.id, lineId), eq(invSoLines.soId, soId)));
  }

  const [ship] = await tx.insert(invShipments).values({
    orgId,
    shipmentNumber,
    soId,
    warehouseId: so.warehouseId,
    carrierId: data.carrierId,
    trackingNumber: data.trackingNumber,
    status: "SHIPPED",
    shippedAt: new Date(),
    createdBy: userId,
  }).returning();

  await tx.insert(invShipmentLines).values(
    movements.map((m) => ({
      orgId,
      shipmentId: ship!.id,
      soLineId: m.soLineId,
      productVariantId: m.productVariantId,
      quantity: m.quantity,
      lotId: m.lotId ?? undefined,
      serialId: m.serialId ?? undefined,
    })),
  );

  await tx.update(invSalesOrders)
    .set({ status: newStatus, shippedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

  /**
   * A1. The goods have left, so the bucket that held them empties — last, and
   * in the same transaction as everything it reads.
   *
   * This used to run in its own *earlier* transaction, which was harmless
   * while the bucket was decremented and wrong the moment it became derived:
   * recomputing before the shipment is recorded re-reads a world where nothing
   * has shipped and writes the same figure back, so the tote never empties.
   *
   * Every grain the order stands on, not only the ones that produced a
   * movement. `EXPECTED_OUTGOING` drops the whole order out of its sum once
   * the status leaves the open list, so a grain holding a zero-quantity line
   * of a now-SHIPPED order has to be recomputed too. Substituted rows carry
   * the substitute's variant, which is the row the projection actually credits
   * — the old loop recomputed the *original* variant at the substitute's bin,
   * a row that generally does not exist, and left the swapped-in units
   * outgoing for ever.
   */
  const grains = new Map<string, OutgoingGrain>();
  for (const line of shelf) {
    if (line.locationId === null) continue;
    const grain = {
      productVariantId: line.productVariantId,
      locationId: line.locationId,
      lotId: line.lotId,
      serialId: line.serialId,
    };
    grains.set(grainKey(grain), grain);
  }
  for (const m of movements) {
    const grain = {
      productVariantId: m.productVariantId,
      locationId: m.locationId,
      lotId: m.lotId,
      serialId: m.serialId,
    };
    grains.set(grainKey(grain), grain);
  }
  for (const grain of grains.values())
    await deps.projection.syncOutgoing(tx, orgId, grain);

  await OutboxWriter.emit(tx, {
    eventId: randomUUID(),
    organizationId: orgId,
    aggregateType: "inv_sales_order",
    aggregateId: String(soId),
    aggregateVersion: Date.now(),
    eventType: "inventory.sales_order.fulfilled",
    payload: {
      soId,
      soNumber: so.soNumber,
      shipmentId: ship!.id,
      shipmentNumber,
      isPartial,
      actorUserId: userId,
    },
    occurredAt: new Date(),
  });

  /**
   * A5. The shipment event, from the path that had none.
   *
   * There are two ways to ship in this module. `ShipmentsService.ship` emits
   * `inventory.shipment.dispatched`; this one creates a shipment already
   * SHIPPED and announced only that the *order* was fulfilled — so anything
   * subscribed to shipments (a carrier integration, a customer notification)
   * simply never heard about shipments raised this way. The existing name is
   * reused rather than a new one invented: item 2 forbids retiring it, and two
   * names for one shipment would collide on the outbox's `(org,
   * aggregate_type, aggregate_id, aggregate_version)` index. The order-level
   * event is keyed on the sales order, so the two here are different
   * aggregates and coexist.
   */
  await emitInventoryCommandEvent(tx, {
    orgId,
    eventType: INVENTORY_COMMAND_EVENTS.SHIPMENT_DISPATCHED,
    aggregateType: "inv_shipment",
    aggregateId: String(ship!.id),
    actorUserId: userId,
    payload: {
      shipmentId: ship!.id,
      shipmentNumber,
      soId,
      soNumber: so.soNumber,
      warehouseId: so.warehouseId,
      carrierId: data.carrierId ?? null,
      trackingNumber: data.trackingNumber ?? null,
      lineCount: movements.length,
      isPartial,
      shippedVia: "sales_order.ship",
      idempotencyKey,
    },
  });

  cogs.soNumber = so.soNumber;
  cogs.total = so.lines.reduce(
    (sum, l) => addDec(sum, mulDec(lineShippedQty.get(l.id) ?? "0", l.costAtTime)),
    "0",
  );

  return {
    shipmentId: ship!.id,
    shipmentNumber,
    status: newStatus,
    isPartial,
  };
}
