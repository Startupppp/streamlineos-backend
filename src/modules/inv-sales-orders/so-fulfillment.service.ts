import { randomUUID } from "node:crypto";
import { Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invSalesOrders, invSoLines, invStockReservations, invPickLists, invPickListLines,
  invPackages, invPackageLines, invShipments, invShipmentLines, invSerialNumbers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { StockEngineService } from "../inv-stock-engine/stock-engine.service";
import { ReservationService } from "../inv-stock-engine/reservation.service";
import { InventorySettingsService } from "../inv-stock-engine/inventory-settings.service";
import { NumberSequenceService } from "../inv-stock-engine/number-sequence.service";
import { INV_ERRORS } from "../inv-stock-engine/stock-engine.types";
import { JournalPostingService } from "../accounting/journal-posting.service";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { SoCoreService } from "./so-core.service";
import type { ReserveSoInput, PickSoInput, PackSoInput, ShipSoInput } from "./dto/inv-sales-orders.schemas";

@Injectable()
export class SoFulfillmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly reservationService: ReservationService,
    private readonly settingsService: InventorySettingsService,
    private readonly numSeq: NumberSequenceService,
    private readonly journalPosting: JournalPostingService,
    private readonly soCore: SoCoreService,
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
          } catch {
            allReserved = false;
          }
        } else {
          const available = await this.soCore.findAvailableLotForLine(
            orgId, line.productVariantId, data.warehouseId ?? so.warehouseId ?? undefined,
            parseFloat(line.quantity), settings.reservationStrategy, settings.expiryReservationPolicy,
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
          } catch {
            allReserved = false;
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
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);

    return { soId, status: newStatus, allReserved };
  }

  async pickSo(orgId: string, soId: number, userId: string, data: PickSoInput) {
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

    const pickNumber = await this.numSeq.next(orgId, "PICK_LIST");

    const [pickList] = await this.db.insert(invPickLists).values({
      orgId,
      pickNumber,
      soId,
      warehouseId: so.warehouseId,
      status: "COMPLETED",
      createdBy: userId,
    }).returning();

    await this.db.insert(invPickListLines).values(
      data.lines.map((line) => {
        const soLine = so.lines.find((l) => l.id === line.soLineId);
        if (!soLine) throw new BadRequestException(`SO line ${line.soLineId} not found`);
        return {
          pickListId: pickList.id,
          soLineId: line.soLineId,
          productVariantId: soLine.productVariantId,
          locationId: line.locationId,
          lotId: line.lotId,
          serialId: line.serialId,
          quantityToPick: line.quantityPicked.toFixed(4),
          quantityPicked: line.quantityPicked.toFixed(4),
        };
      })
    );

    const orderedQtyMap = new Map(so.lines.map((l) => [l.id, parseFloat(l.quantity)]));
    const pickedMap = new Map<number, number>();
    for (const line of data.lines) {
      pickedMap.set(line.soLineId, (pickedMap.get(line.soLineId) ?? 0) + line.quantityPicked);
    }
    const allPicked = so.lines.every((l) => (pickedMap.get(l.id) ?? 0) >= (orderedQtyMap.get(l.id) ?? 0));

    await this.db.update(invSalesOrders)
      .set({ status: allPicked ? "PICKED" : so.status, updatedAt: new Date() })
      .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);

    return { pickListId: pickList.id, pickNumber, allPicked };
  }

  async packSo(orgId: string, soId: number, userId: string, data: PackSoInput) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "PICKED") {
      throw new BadRequestException("Sales order must be PICKED before packing");
    }

    const settings = await this.settingsService.get(orgId);
    let packageId: number | undefined;

    if (settings.packageRequiredForShipping) {
      const packageNumber = await this.numSeq.next(orgId, "PACKAGE");

      const pickLists = await this.db.query.invPickLists.findMany({
        where: and(eq(invPickLists.orgId, orgId), eq(invPickLists.soId!, soId)),
        with: { lines: true },
      });

      const [pkg] = await this.db.insert(invPackages).values({
        orgId,
        packageNumber,
        weight: data.weight?.toFixed(4),
        dimensionsL: data.dimensionsL?.toFixed(2),
        dimensionsW: data.dimensionsW?.toFixed(2),
        dimensionsH: data.dimensionsH?.toFixed(2),
        status: "CLOSED",
        createdBy: userId,
      }).returning();

      packageId = pkg.id;

      const packageLinesValues = pickLists.flatMap((pl) =>
        pl.lines.map((line) => ({
          packageId: pkg.id,
          productVariantId: line.productVariantId,
          lotId: line.lotId,
          serialId: line.serialId,
          quantity: line.quantityPicked,
        }))
      );

      if (packageLinesValues.length > 0) {
        await this.db.insert(invPackageLines).values(packageLinesValues);
      }
    }

    await this.db.update(invSalesOrders)
      .set({ status: "PACKED", updatedAt: new Date() })
      .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);

    return { soId, status: "PACKED", packageId };
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

    const pickLists = await this.db.query.invPickLists.findMany({
      where: and(
        eq(invPickLists.orgId, orgId),
        eq(invPickLists.soId, soId),
      ),
      with: { lines: true },
    });

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

    if (pickLists.length > 0) {
      for (const pickList of pickLists) {
        for (const line of pickList.lines) {
          const locId = line.locationId;
          if (locId === null || locId === undefined) {
            throw new BadRequestException(`Pick list line ${line.id} is missing a location`);
          }
          if (line.soLineId === null) {
            throw new BadRequestException(`Pick list line ${line.id} is missing a sales order line`);
          }
          movements.push({
            transactionType: "SALE",
            productVariantId: line.productVariantId,
            soLineId: line.soLineId,
            locationId: locId,
            lotId: line.lotId ?? undefined,
            serialId: line.serialId ?? undefined,
            quantityDelta: `-${line.quantityPicked}`,
          });
        }
      }
    } else {
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

      await this.reservationService.consumeReservationsBatch(
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

      return ship;
    });

    await this.engine.invalidateCaches(orgId);

    const cogsTotal = so.lines.reduce((sum, l) => {
      const shippedQty = lineShippedQtyMap.get(l.id) ?? 0;
      return sum + shippedQty * parseFloat(l.costAtTime);
    }, 0);

    if (cogsTotal > 0) {
      await this.journalPosting.persistJournalEntry({
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
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);

    return { shipmentId: shipment.id, shipmentNumber, status: newStatus, isPartial };
  }
}
