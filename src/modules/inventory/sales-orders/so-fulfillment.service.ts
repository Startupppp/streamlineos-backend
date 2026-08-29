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
import { addDec, cmpDec, mulDec } from "../stock-engine/decimal";
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { runIdempotent, revivedScalar } from "../stock-engine/idempotency";
import { shelfLines } from "../shipments/packing-reconciliation";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type InventorySettings = Awaited<ReturnType<InventorySettingsService["get"]>>;

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

export interface ShipSoResult {
  shipmentId: number;
  shipmentNumber: string;
  status: "SHIPPED" | "PARTIALLY_SHIPPED";
  isPartial: boolean;
}

/** The ship result as it comes back from the idempotency row's stored JSON. */
function reviveShipResult(stored: unknown): ShipSoResult {
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
interface DeferredCogs {
  total: string;
  soNumber: string;
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
             * B7. It is now literally the same join — the one `shelfLines` owns
             * — rather than a third copy of it. The copies had already drifted:
             * this one, like shipping's, read `quantity_picked` alone and so
             * packed nothing for a substituted line, putting the swapped-in
             * units in no carton at all.
             */
            const pickedLines = await shelfLines(tx, orgId, soId);

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
              .filter((line) => cmpDec(line.quantity, "0") !== 0)
              .map((line) => ({
                orgId,
                packageId: pkg!.id,
                productVariantId: line.productVariantId,
                lotId: line.lotId,
                serialId: line.serialId,
                quantity: line.quantity,
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

  /**
   * B7 — the one command that moves stock out of the building.
   *
   * Three things were true of this method and are no longer:
   *
   *   **It was not idempotent.** The `Idempotency-Key` reached only
   *   `engine.executeInTx`, which claims it for the *ledger*. Everything else —
   *   the shipment row, its lines, `quantity_shipped`, the serial flips, both
   *   outbox events and the COGS journal — sat outside any claim, so a client
   *   retrying after a timeout on a ship that had already committed got a
   *   replayed (no-op) stock posting wrapped in a **second** shipment, a second
   *   dispatch event and a second set of shipped quantities. The whole command
   *   is claimed now, with the engine handed a derived `:stock` key so its own
   *   claim cannot collide with the command's.
   *
   *   **It was not atomic.** The order, the pick lines and the reservations were
   *   all read on `this.db` *before* the transaction opened. Two concurrent
   *   ships of one order therefore both read the same ACTIVE reservations and
   *   both handed them to `consumeReservationsBatch`, which calls
   *   `releaseCommitted` for every reservation it is *given* rather than every
   *   one it flipped — so `committed` was subtracted twice for the same units.
   *   Every read is inside the transaction now and the reservations are taken
   *   `FOR UPDATE`, which is the guard `PickCompletionService` already uses: the
   *   second ship blocks on the row, re-evaluates `status = 'ACTIVE'` after the
   *   lock, and finds nothing to consume.
   *
   *   **The status guard sat outside the claim** — `packSo`'s sibling bug, where
   *   a retry after a committed pack was refused on the status its own first run
   *   had set. It is inside the claim, so a replay answers before it is reached.
   */
  async shipSo(
    orgId: string,
    soId: number,
    userId: string,
    idempotencyKey: string,
    data: ShipSoInput,
  ): Promise<ShipSoResult> {
    const settings = await this.settingsService.get(orgId);
    const cogs: DeferredCogs = { total: "0", soNumber: "" };

    const result = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.sales-orders.ship", soId, data },
        () => this.shipSoInTx(tx, orgId, soId, userId, idempotencyKey, data, settings, cogs),
        (stored) => reviveShipResult(stored),
      ),
    );

    await this.engine.invalidateCaches(orgId);

    // Only reachable when `work()` ran, so a replay posts nothing; and after the
    // commit, so a rolled-back shipment leaves no entry behind.
    const cogsTotal = Number(cogs.total);
    if (cogsTotal > 0) {
      await this.journalPosting.postJournalEntry({
        orgId,
        entryDate: data.shipDate,
        description: `COGS: ${cogs.soNumber}`,
        sourceType: "inv_sales_order",
        sourceId: soId.toString(),
        sourceEvent: "ship",
        status: "POSTED",
        createdBy: userId,
        lines: [
          { accountCode: "5000", debit: cogsTotal, credit: 0, description: `COGS - SO ${cogs.soNumber}` },
          { accountCode: "1300", debit: 0, credit: cogsTotal, description: `Inventory deducted - ${cogs.soNumber}` },
        ],
      });
    }

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));

    return result;
  }

  private async shipSoInTx(
    tx: Tx,
    orgId: string,
    soId: number,
    userId: string,
    idempotencyKey: string,
    data: ShipSoInput,
    settings: InventorySettings,
    cogs: DeferredCogs,
  ): Promise<ShipSoResult> {
    const so = await tx.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      columns: { id: true, soNumber: true, status: true, warehouseId: true },
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
    const shipmentNumber = await this.numSeq.next(orgId, "SHIPMENT", tx);
    const newStatus = isPartial ? "PARTIALLY_SHIPPED" : "SHIPPED";

    await this.engine.executeInTx(tx, orgId, userId, {
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

    const consumedReservations = await this.reservationService.consumeReservationsBatch(
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
      await this.projection.syncOutgoing(tx, orgId, grain);

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
}
