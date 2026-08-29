import { randomUUID } from "node:crypto";
import { Inject, Injectable, BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invSalesOrders, invSoLines, invStockReservations, invPickLists, invPickListLines,
  invPackages, invPackageLines, invShipments, invShipmentLines, invSerialNumbers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { INV_ERRORS } from "../stock-engine/stock-engine.types";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import { SoCoreService } from "./so-core.service";
import type { ReserveSoInput, PickSoInput, PackSoInput, ShipSoInput } from "./dto/inv-sales-orders.schemas";
import { addDec, cmpDec } from "../stock-engine/decimal";
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { runIdempotent, revivedScalar } from "../stock-engine/idempotency";

/** The pick result as it comes back from the idempotency row's stored JSON. */
function revivePickResult(stored: unknown): {
  pickListId: number;
  pickNumber: string;
  allPicked: boolean;
} {
  const row = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    pickListId: Number(row.pickListId ?? 0),
    pickNumber: String(row.pickNumber ?? ""),
    allPicked: row.allPicked === true,
  };
}

@Injectable()
export class SoFulfillmentService {
  private readonly logger = new Logger(SoFulfillmentService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly reservationService: ReservationService,
    private readonly settingsService: InventorySettingsService,
    private readonly numSeq: NumberSequenceService,
    private readonly journalPosting: InventoryAccountingBridge,
    private readonly soCore: SoCoreService,
    private readonly projection: StockProjectionService,
  ) {}

  async reserveSo(orgId: string, soId: number, userId: string, idempotencyKey: string, data: ReserveSoInput) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: true },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "CONFIRMED" && so.status !== "PARTIALLY_RESERVED") {
      throw new BadRequestException("Sales order must be CONFIRMED or PARTIALLY_RESERVED to reserve stock");
    }

    const settings = await this.settingsService.get(orgId);
    let allReserved = true;

    await this.db.transaction(async (tx) => {
      for (const line of so.lines) {
        const existingReservation = await (tx as Db).query.invStockReservations.findFirst({
          where: and(
            eq(invStockReservations.orgId, orgId),
            eq(invStockReservations.sourceType, "inv_sales_order"),
            eq(invStockReservations.sourceId, String(soId)),
            eq(invStockReservations.sourceLineId, String(line.id)),
            eq(invStockReservations.status, "ACTIVE"),
          ),
        });
        if (existingReservation) continue;

        if (settings.reservationStrategy === "MANUAL") {
          const allocation = data.allocations?.find((a) => a.soLineId === line.id);
          if (!allocation) { allReserved = false; continue; }

          try {
            await this.reservationService.createReservationInTx(tx, orgId, userId, {
              sourceType: "inv_sales_order",
              sourceId: String(soId),
              sourceLineId: String(line.id),
              productVariantId: line.productVariantId,
              locationId: allocation.locationId,
              lotId: allocation.lotId,
              serialId: allocation.serialId,
              qty: allocation.qty.toFixed(4),
            });
          } catch (reserveErr) {
            allReserved = false;
            this.logger.warn(
              `reserveSo: manual reservation failed for SO ${soId} line ${line.id} in org ${orgId}: ${reserveErr instanceof Error ? reserveErr.message : String(reserveErr)}`,
            );
          }
        } else {
          const available = await this.soCore.findAvailableLotForLine(
            orgId, line.productVariantId, data.warehouseId ?? so.warehouseId ?? undefined,
            line.quantity, settings.reservationStrategy, settings.expiryReservationPolicy,
          );

          if (!available) { allReserved = false; continue; }

          try {
            await this.reservationService.createReservationInTx(tx, orgId, userId, {
              sourceType: "inv_sales_order",
              sourceId: String(soId),
              sourceLineId: String(line.id),
              productVariantId: line.productVariantId,
              warehouseId: data.warehouseId ?? so.warehouseId ?? undefined,
              locationId: available.locationId,
              lotId: available.lotId,
              qty: line.quantity,
            });
          } catch (reserveErr) {
            allReserved = false;
            this.logger.warn(
              `reserveSo: auto reservation failed for SO ${soId} line ${line.id} in org ${orgId}: ${reserveErr instanceof Error ? reserveErr.message : String(reserveErr)}`,
            );
          }
        }
      }

      const newStatus = allReserved ? "RESERVED" : "PARTIALLY_RESERVED";
      await (tx as Db).update(invSalesOrders)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));
    });

    const newStatus = allReserved ? "RESERVED" : "PARTIALLY_RESERVED";

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));

    return { soId, status: newStatus, allReserved };
  }

  /**
   * A3. Picking took no idempotency key and ran across three separate
   * transactions — a pick-list insert, then a transaction for the projection,
   * then a line insert, then a status update.
   *
   * So a retry produced a *second* pick list, recorded the same pick again and
   * subtracted the same units from availability twice; and a failure between any
   * two of those steps left the order in a state no single step describes —
   * `outgoing_qty` moved with no lines to explain it, or lines with the bucket
   * untouched. One transaction, claimed once.
   */
  async pickSo(
    orgId: string,
    soId: number,
    userId: string,
    data: PickSoInput,
    idempotencyKey: string,
  ) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: { with: { productVariant: { with: { product: { columns: { id: true, trackingMethod: true } } } } } } },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "RESERVED" && so.status !== "PARTIALLY_RESERVED" && so.status !== "CONFIRMED") {
      throw new BadRequestException("Sales order must be CONFIRMED or RESERVED to pick");
    }

    for (const pickLine of data.lines) {
      const soLine = so.lines.find((l) => l.id === pickLine.soLineId);
      if (!soLine) throw new BadRequestException(`SO line ${pickLine.soLineId} not found`);

      const trackingMethod = soLine.productVariant.product.trackingMethod;
      if (trackingMethod === "SERIAL") {
        if (!pickLine.serialId) {
          throw new BadRequestException(`SO line ${pickLine.soLineId}: SERIAL-tracked product requires serialId per unit`);
        }
      }
    }

    // Exact. Deciding a whole order is picked on the strength of float
    // comparisons is how an order ships one unit short and nothing notices.
    const orderedQtyMap = new Map(so.lines.map((l) => [l.id, String(l.quantity)]));
    const pickedMap = new Map<number, string>();
    for (const line of data.lines) {
      pickedMap.set(
        line.soLineId,
        addDec(pickedMap.get(line.soLineId) ?? "0", line.quantityPicked),
      );
    }
    const allPicked = so.lines.every(
      (l) => cmpDec(pickedMap.get(l.id) ?? "0", orderedQtyMap.get(l.id) ?? "0") >= 0,
    );

    const result = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.sales-orders.pick", soId, lines: data.lines },
        async () => {
          const pickNumber = await this.numSeq.next(orgId, "PICK_LIST", tx);

          const [pickList] = await tx.insert(invPickLists).values({
            orgId,
            pickNumber,
            soId,
            warehouseId: so.warehouseId,
            status: "COMPLETED",
            createdBy: userId,
          }).returning();

          await tx.insert(invPickListLines).values(
            data.lines.map((line) => {
              const soLine = so.lines.find((l) => l.id === line.soLineId);
              if (!soLine) throw new BadRequestException(`SO line ${line.soLineId} not found`);
              return {
                orgId,
                pickListId: pickList!.id,
                soLineId: line.soLineId,
                productVariantId: soLine.productVariantId,
                locationId: line.locationId,
                lotId: line.lotId,
                serialId: line.serialId,
                quantityToPick: line.quantityPicked,
                quantityPicked: line.quantityPicked,
              };
            })
          );

          // A1. `outgoing_qty` had no writer at all, so availability ignored one
          // of its five terms. Recomputed from the pick lines rather than
          // incremented, and at the row's full grain: the earlier version
          // matched (variant, location) only and wrote the same figure to every
          // lot row at that location.
          for (const line of data.lines) {
            const soLine = so.lines.find((l) => l.id === line.soLineId);
            if (!soLine) continue;
            await this.projection.syncOutgoing(tx, orgId, {
              productVariantId: soLine.productVariantId,
              locationId: line.locationId,
              lotId: line.lotId ?? null,
              serialId: line.serialId ?? null,
            });
          }

          await tx.update(invSalesOrders)
            .set({ status: allPicked ? "PICKED" : so.status, updatedAt: new Date() })
            .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

          return { pickListId: pickList!.id, pickNumber, allPicked };
        },
        (stored) => revivePickResult(stored),
      ),
    );

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));

    return result;
  }

  /**
   * A3. Packing took no key, and it creates documents rather than flipping a
   * status: a retry produced a second package, with a second package number and
   * a second set of lines, against the same picked stock. The package, its lines
   * and the order's status now move together or not at all.
   *
   * B6. Nothing here posts stock, and that is deliberate: the goods left the
   * shelf when the picker took them and leave the building on the internal ship
   * command. A movement raised at the bench would subtract the same units twice.
   */
  async packSo(
    orgId: string,
    soId: number,
    userId: string,
    data: PackSoInput,
    idempotencyKey: string,
  ) {
    const settings = await this.settingsService.get(orgId);

    const packageId = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.sales-orders.pack", soId, data },
        async () => {
          // B6. Read and checked *inside* the claim, which is the only place the
          // guard can be both correct and replay-safe. Outside it, a client
          // retrying after a network timeout on a pack that had already
          // committed was refused with "must be PICKED" — the status its own
          // first run had just moved to PACKED — so the key protected nothing on
          // the one path idempotency exists for. Inside, the replay branch
          // returns the stored package before the guard is reached, and a first
          // run that fails the guard rolls the claim back with it.
          const so = await tx.query.invSalesOrders.findFirst({
            where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
            columns: { id: true, status: true },
          });
          if (!so) throw new NotFoundException("Sales order not found");
          if (so.status !== "PICKED") {
            throw new BadRequestException("Sales order must be PICKED before packing");
          }

          let created: number | null = null;

          if (settings.packageRequiredForShipping) {
            const packageNumber = await this.numSeq.next(orgId, "PACKAGE", tx);

            /**
             * B6. Found through the *lines*, not through `inv_pick_lists.so_id`.
             *
             * A wave's header carries a null `so_id` — that is what
             * distinguishes it from a single-order pick — so this lookup
             * returned nothing for a wave-picked order and packing raised an
             * **empty** package: a document asserting that a carton holding
             * three units holds none, closed, and shipped on. B4 found and fixed
             * the identical defect in `shipSo`; this is the same join.
             *
             * Every line still reaches this the same way for a single-order
             * pick, which sets both `so_id` and `so_line_id`; cancelled pick
             * lists are excluded, as they are everywhere else this quantity is
             * read.
             */
            const pickedLines = await tx.execute<{
              product_variant_id: number;
              lot_id: number | null;
              serial_id: number | null;
              quantity_picked: string;
            }>(sql`
              SELECT pll.product_variant_id,
                     pll.lot_id,
                     pll.serial_id,
                     pll.quantity_picked
                FROM inv_pick_list_lines pll
                JOIN inv_pick_lists pl
                  ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
                JOIN inv_so_lines sol
                  ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
               WHERE pll.org_id = ${orgId}
                 AND sol.so_id = ${soId}
                 AND pl.status <> 'CANCELLED'
               ORDER BY pll.id
            `);

            const [pkg] = await tx.insert(invPackages).values({
              orgId,
              packageNumber,
              // B6. The carton knows which order it holds, so the bench can
              // reconcile a scan and the packing queue can be read off the
              // cartons rather than off the order's status.
              soId,
              weight: data.weight?.toFixed(4),
              dimensionsL: data.dimensionsL?.toFixed(2),
              dimensionsW: data.dimensionsW?.toFixed(2),
              dimensionsH: data.dimensionsH?.toFixed(2),
              status: "CLOSED",
              createdBy: userId,
            }).returning();

            created = pkg!.id;

            const packageLinesValues = pickedLines
              // A line closed by an exception can hold zero, and a carton line
              // for nothing is a manifest entry nobody can act on.
              .filter((line) => Number(line.quantity_picked) !== 0)
              .map((line) => ({
                orgId,
                packageId: pkg!.id,
                productVariantId: Number(line.product_variant_id),
                lotId: line.lot_id === null ? null : Number(line.lot_id),
                serialId: line.serial_id === null ? null : Number(line.serial_id),
                quantity: String(line.quantity_picked),
              }));

            if (packageLinesValues.length > 0) {
              await tx.insert(invPackageLines).values(packageLinesValues);
            }
          }

          await tx.update(invSalesOrders)
            .set({ status: "PACKED", updatedAt: new Date() })
            .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

          return created;
        },
        (stored) => {
          const value = revivedScalar(stored);
          return value === null || value === undefined ? null : Number(value);
        },
      ),
    );

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));

    return { soId, status: "PACKED", packageId: packageId ?? undefined };
  }

  async shipSo(orgId: string, soId: number, userId: string, idempotencyKey: string, data: ShipSoInput) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: {
        lines: {
          with: {
            productVariant: { with: { product: { columns: { id: true, trackingMethod: true } } } },
          },
        },
      },
    });
    if (!so) throw new NotFoundException("Sales order not found");

    const allowedStatuses = ["CONFIRMED", "RESERVED", "PARTIALLY_RESERVED", "PICKED", "PACKED"];
    if (!allowedStatuses.includes(so.status)) {
      throw new BadRequestException(`Sales order must be in one of ${allowedStatuses.join(", ")} to ship`);
    }

    const settings = await this.settingsService.get(orgId);

    if (settings.packageRequiredForShipping && so.status !== "PACKED") {
      throw new BadRequestException("Sales order must be PACKED before shipping (packageRequiredForShipping is enabled)");
    }

    /**
     * B4. Found through the *lines*, not through `inv_pick_lists.so_id`.
     *
     * A wave's header carries a null `so_id` — that is what distinguishes it
     * from a single-order pick — so this lookup returned nothing for a
     * wave-picked order and shipping fell through to the reservation branch,
     * issuing from the bin the order reserved rather than the one the picker
     * actually took the goods from. Once picking consumes its reservations
     * (`PickConfirmService`) that branch has nothing left to read at all, and a
     * wave-picked order could not be shipped.
     *
     * Every line still reaches this the same way for a single-order pick, which
     * sets both `so_id` and `so_line_id`; cancelled pick lists are excluded, as
     * they are everywhere else this quantity is read.
     */
    const pickedLines = await this.db.execute<{
      id: number;
      so_line_id: number;
      product_variant_id: number;
      location_id: number | null;
      lot_id: number | null;
      serial_id: number | null;
      quantity_picked: string;
    }>(sql`
      SELECT pll.id,
             pll.so_line_id,
             pll.product_variant_id,
             pll.location_id,
             pll.lot_id,
             pll.serial_id,
             pll.quantity_picked
        FROM inv_pick_list_lines pll
        JOIN inv_pick_lists pl
          ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
        JOIN inv_so_lines sol
          ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
       WHERE pll.org_id = ${orgId}
         AND sol.so_id = ${soId}
         AND pl.status <> 'CANCELLED'
       ORDER BY pll.id
    `);

    const reservations = await this.db.query.invStockReservations.findMany({
      where: and(
        eq(invStockReservations.orgId, orgId),
        eq(invStockReservations.sourceType, "inv_sales_order"),
        eq(invStockReservations.sourceId, String(soId)),
        eq(invStockReservations.status, "ACTIVE"),
      ),
    });

    const movements: Array<{
      transactionType: string;
      productVariantId: number;
      soLineId: number;
      locationId: number;
      lotId?: number;
      serialId?: number;
      quantityDelta: string;
    }> = [];

    if (pickedLines.length > 0) {
      for (const line of pickedLines) {
        // A line closed by an exception can hold zero, and a zero movement is
        // refused by the ledger's non-zero CHECK rather than ignored. Nothing
        // left that shelf, so there is nothing to issue.
        if (Number(line.quantity_picked) === 0) continue;
        const locId = line.location_id;
        if (locId === null) {
          throw new BadRequestException(`Pick list line ${line.id} is missing a location`);
        }
        movements.push({
          transactionType: "SALE",
          productVariantId: Number(line.product_variant_id),
          soLineId: Number(line.so_line_id),
          locationId: Number(locId),
          lotId: line.lot_id === null ? undefined : Number(line.lot_id),
          serialId: line.serial_id === null ? undefined : Number(line.serial_id),
          quantityDelta: `-${line.quantity_picked}`,
        });
      }
    }

    // Nothing was picked: ship straight off the reservations. Keyed on the
    // movement list rather than on the pick-list lookup, so an order whose only
    // pick lines were closed by exceptions still reaches this rather than
    // shipping an empty shipment.
    if (movements.length === 0) {
      for (const line of so.lines) {
        const reservation = reservations.find((r) => r.sourceLineId === String(line.id));
        const locationId = reservation?.locationId;
        if (!locationId) throw new BadRequestException(`No pick list or reservation for SO line ${line.id}`);

        movements.push({
          transactionType: "SALE",
          productVariantId: line.productVariantId,
          soLineId: line.id,
          locationId,
          lotId: reservation?.lotId ?? undefined,
          serialId: reservation?.serialId ?? undefined,
          quantityDelta: `-${line.quantity}`,
        });
      }
    }

    const totalOrderedQty = so.lines.reduce((sum, l) => sum + parseFloat(l.quantity), 0);
    const totalShippingQty = movements.reduce((sum, m) => sum + Math.abs(parseFloat(m.quantityDelta)), 0);
    const isPartial = totalShippingQty < totalOrderedQty;

    if (isPartial && !settings.allowPartialShipment) {
      throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK, message: "Partial shipment is not allowed" });
    }

    const shipmentNumber = await this.numSeq.next(orgId, "SHIPMENT");

    const newStatus = isPartial ? "PARTIALLY_SHIPPED" : "SHIPPED";

    const serialIds = movements.flatMap((m) => m.serialId !== undefined ? [m.serialId] : []);

    const lineShippedQtyMap = new Map<number, number>();
    for (const m of movements) {
      const qty = Math.abs(parseFloat(m.quantityDelta));
      lineShippedQtyMap.set(m.soLineId, (lineShippedQtyMap.get(m.soLineId) ?? 0) + qty);
    }

    const shipment = await this.db.transaction(async (tx) => {
      await this.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey,
        sourceType: "inv_sales_order",
        sourceId: String(soId),
        reason: `Shipment for SO ${so.soNumber}`,
        movements,
      });

      const consumedReservations = await this.reservationService.consumeReservationsBatch(
        tx,
        orgId,
        userId,
        reservations.map((r) => ({
          id: r.id,
          locationId: r.locationId,
          productVariantId: r.productVariantId,
          reservedQty: r.reservedQty,
        })),
      );

      // A5. Shipping is one of the two places a reservation is ever consumed,
      // and the set is the fact — one event for the command, keyed on the
      // command's own idempotency key, rather than one per reservation.
      if (consumedReservations.length > 0) {
        await emitInventoryCommandEvent(tx as Db, {
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

      if (serialIds.length > 0) {
        await (tx as Db).update(invSerialNumbers)
          .set({ status: "SHIPPED" })
          .where(inArray(invSerialNumbers.id, serialIds));
      }

      if (lineShippedQtyMap.size > 0) {
        for (const [lineId, shippedQty] of lineShippedQtyMap) {
          await (tx as Db).update(invSoLines)
            .set({ quantityShipped: sql`${invSoLines.quantityShipped} + ${shippedQty}` })
            .where(and(eq(invSoLines.id, lineId), eq(invSoLines.soId, soId)));
        }
      }


      const [ship] = await (tx as Db).insert(invShipments).values({
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

      await (tx as Db).insert(invShipmentLines).values(
        movements.map((m) => ({
          orgId,
          shipmentId: ship.id,
          soLineId: m.soLineId,
          productVariantId: m.productVariantId,
          quantity: Math.abs(parseFloat(m.quantityDelta)).toFixed(4),
          lotId: m.lotId,
          serialId: m.serialId,
        }))
      );

      await (tx as Db).update(invSalesOrders)
        .set({ status: newStatus, shippedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

      // A1. The goods have left, so the bucket that held them empties — last,
      // and in the same transaction as everything it reads.
      //
      // This used to run in its own *earlier* transaction, which was harmless
      // while the bucket was decremented and wrong the moment it became derived:
      // recomputing before the shipment is recorded re-reads a world where
      // nothing has shipped and writes the same figure back, so the tote never
      // empties. The ordering is load-bearing now, which is exactly the kind of
      // assumption a change of mechanism invalidates in silence.
      for (const line of pickedLines) {
        if (line.location_id === null) continue;
        await this.projection.syncOutgoing(tx, orgId, {
          productVariantId: Number(line.product_variant_id),
          locationId: Number(line.location_id),
          lotId: line.lot_id === null ? null : Number(line.lot_id),
          serialId: line.serial_id === null ? null : Number(line.serial_id),
        });
      }

      await OutboxWriter.emit(tx as Db, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "inv_sales_order",
        aggregateId: String(soId),
        aggregateVersion: Date.now(),
        eventType: "inventory.sales_order.fulfilled",
        payload: {
          soId,
          soNumber: so.soNumber,
          shipmentId: ship.id,
          shipmentNumber,
          isPartial,
          actorUserId: userId,
        },
        occurredAt: new Date(),
      });

      /**
       * A5. The shipment event, from the path that had none.
       *
       * There are two ways to ship in this module. `ShipmentsService.ship`
       * emits `inventory.shipment.dispatched`; this one creates a shipment
       * already SHIPPED and announced only that the *order* was fulfilled — so
       * anything subscribed to shipments (a carrier integration, a customer
       * notification) simply never heard about shipments raised this way. The
       * existing name is reused rather than a new one invented: item 2 forbids
       * retiring it, and two names for one shipment would collide on the
       * outbox's `(org, aggregate_type, aggregate_id, aggregate_version)`
       * index. The order-level event is keyed on the sales order, so the two
       * here are different aggregates and coexist.
       */
      await emitInventoryCommandEvent(tx as Db, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.SHIPMENT_DISPATCHED,
        aggregateType: "inv_shipment",
        aggregateId: String(ship.id),
        actorUserId: userId,
        payload: {
          shipmentId: ship.id,
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

      return ship;
    });

    await this.engine.invalidateCaches(orgId);

    const cogsTotal = so.lines.reduce((sum, l) => {
      const shippedQty = lineShippedQtyMap.get(l.id) ?? 0;
      return sum + shippedQty * parseFloat(l.costAtTime);
    }, 0);

    if (cogsTotal > 0) {
      await this.journalPosting.postJournalEntry({
        orgId,
        entryDate: data.shipDate,
        description: `COGS: ${so.soNumber}`,
        sourceType: "inv_sales_order",
        sourceId: soId.toString(),
        sourceEvent: "ship",
        status: "POSTED",
        createdBy: userId,
        lines: [
          { accountCode: "5000", debit: cogsTotal, credit: 0, description: `COGS - SO ${so.soNumber}` },
          { accountCode: "1300", debit: 0, credit: cogsTotal, description: `Inventory deducted - ${so.soNumber}` },
        ],
      });
    }

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));

    return { shipmentId: shipment.id, shipmentNumber, status: newStatus, isPartial };
  }
}
