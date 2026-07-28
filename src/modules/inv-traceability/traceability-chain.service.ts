import { Inject, Injectable, BadRequestException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  invLots,
  invSerialNumbers,
  invStockLevels,
  invStockTransactions,
  invGrns,
  invGrnLines,
  invPurchaseOrders,
  invVendors,
  invShipments,
  invShipmentLines,
  invVendorReturnLines,
  invVendorReturns,
  invCustomerReturnLines,
  invCustomerReturns,
  invLocations,
  invWarehouses,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { TraceabilityQueryInput } from "./dto/traceability.schemas";

@Injectable()
export class TraceabilityChainService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getChain(orgId: string, query: TraceabilityQueryInput) {
    const { lotId, serialId } = query;
    const cacheKey =
      lotId != null
        ? CACHE_KEYS.invTraceabilityLot(orgId, lotId)
        : CACHE_KEYS.invTraceabilitySerial(orgId, serialId!);

    return this.cache.cached(
      cacheKey,
      async () => this.fetchChain(orgId, lotId, serialId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchChain(orgId: string, lotId: number | undefined, serialId: number | undefined) {
    if (lotId == null && serialId == null) {
      throw new BadRequestException("lotId or serialId is required");
    }

    const [origin, receipts, currentStock, shipmentItems, vendorReturnItems, customerReturnItems, events] =
      await Promise.all([
        this.fetchOrigin(orgId, lotId, serialId),
        lotId != null ? this.fetchReceipts(orgId, lotId) : Promise.resolve([]),
        this.fetchCurrentStock(orgId, lotId, serialId),
        this.fetchShipments(orgId, lotId, serialId),
        lotId != null ? this.fetchVendorReturns(orgId, lotId) : Promise.resolve([]),
        lotId != null ? this.fetchCustomerReturns(orgId, lotId) : Promise.resolve([]),
        this.fetchEvents(orgId, lotId, serialId),
      ]);

    return {
      origin,
      receipts,
      currentStock,
      shipments: shipmentItems,
      returns: [...vendorReturnItems, ...customerReturnItems],
      events,
    };
  }

  private async fetchOrigin(orgId: string, lotId: number | undefined, serialId: number | undefined) {
    if (lotId != null) {
      return this.db.query.invLots.findFirst({
        where: and(eq(invLots.id, lotId), eq(invLots.orgId, orgId)),
        with: { productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } } },
      });
    }
    return this.db.query.invSerialNumbers.findFirst({
      where: and(eq(invSerialNumbers.id, serialId!), eq(invSerialNumbers.orgId, orgId)),
      with: { productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } } },
    });
  }

  private async fetchReceipts(orgId: string, lotId: number) {
    const grnLines = await this.db
      .select({
        grnLineId: invGrnLines.id,
        grnId: invGrns.id,
        grnNumber: invGrns.grnNumber,
        receivedDate: invGrns.receivedDate,
        poId: invPurchaseOrders.id,
        poNumber: invPurchaseOrders.poNumber,
        vendorId: invVendors.id,
        vendorName: invVendors.name,
        vendorCode: invVendors.code,
        qtyReceived: invGrnLines.quantityReceived,
      })
      .from(invStockTransactions)
      .innerJoin(invGrns, and(eq(invGrns.orgId, orgId), eq(invStockTransactions.referenceType, "GRN")))
      .innerJoin(invGrnLines, eq(invGrnLines.grnId, invGrns.id))
      .innerJoin(invPurchaseOrders, eq(invGrns.poId, invPurchaseOrders.id))
      .innerJoin(invVendors, eq(invPurchaseOrders.vendorId, invVendors.id))
      .where(and(eq(invStockTransactions.orgId, orgId), eq(invStockTransactions.lotId, lotId)))
      .limit(50);
    return grnLines;
  }

  private async fetchCurrentStock(orgId: string, lotId: number | undefined, serialId: number | undefined) {
    const condition = lotId != null
      ? and(eq(invStockLevels.orgId, orgId), eq(invStockLevels.lotId, lotId))
      : and(eq(invStockLevels.orgId, orgId), eq(invStockLevels.serialId, serialId!));

    return this.db
      .select({
        locationId: invLocations.id,
        locationName: invLocations.name,
        locationCode: invLocations.code,
        warehouseId: invWarehouses.id,
        warehouseName: invWarehouses.name,
        onHand: invStockLevels.onHand,
        committed: invStockLevels.committed,
        blockedQty: invStockLevels.blockedQty,
      })
      .from(invStockLevels)
      .innerJoin(invLocations, eq(invStockLevels.locationId, invLocations.id))
      .innerJoin(invWarehouses, eq(invLocations.warehouseId, invWarehouses.id))
      .where(condition);
  }

  private async fetchShipments(orgId: string, lotId: number | undefined, serialId: number | undefined) {
    const condition = lotId != null
      ? eq(invShipmentLines.lotId, lotId)
      : eq(invShipmentLines.serialId, serialId!);

    return this.db
      .select({
        shipmentId: invShipments.id,
        shipmentNumber: invShipments.shipmentNumber,
        status: invShipments.status,
        shippedAt: invShipments.shippedAt,
        soId: invShipments.soId,
        quantity: invShipmentLines.quantity,
      })
      .from(invShipmentLines)
      .innerJoin(invShipments, and(eq(invShipmentLines.shipmentId, invShipments.id), eq(invShipments.orgId, orgId)))
      .where(condition)
      .limit(50);
  }

  private async fetchVendorReturns(orgId: string, lotId: number) {
    const lines = await this.db
      .select({
        returnId: invVendorReturns.id,
        returnNumber: invVendorReturns.returnNumber,
        status: invVendorReturns.status,
        type: invVendorReturnLines.reason,
        quantity: invVendorReturnLines.quantity,
        returnType: invVendorReturnLines.reason,
      })
      .from(invVendorReturnLines)
      .innerJoin(invVendorReturns, and(eq(invVendorReturnLines.returnId, invVendorReturns.id), eq(invVendorReturns.orgId, orgId)))
      .where(eq(invVendorReturnLines.lotId, lotId))
      .limit(20);
    return lines.map((l) => ({ ...l, category: "vendor" as const }));
  }

  private async fetchCustomerReturns(orgId: string, lotId: number) {
    const lines = await this.db
      .select({
        returnId: invCustomerReturns.id,
        returnNumber: invCustomerReturns.returnNumber,
        status: invCustomerReturns.status,
        quantity: invCustomerReturnLines.quantity,
        disposition: invCustomerReturnLines.disposition,
      })
      .from(invCustomerReturnLines)
      .innerJoin(invCustomerReturns, and(eq(invCustomerReturnLines.returnId, invCustomerReturns.id), eq(invCustomerReturns.orgId, orgId)))
      .where(eq(invCustomerReturnLines.lotId, lotId))
      .limit(20);
    return lines.map((l) => ({ ...l, category: "customer" as const }));
  }

  private async fetchEvents(orgId: string, lotId: number | undefined, serialId: number | undefined) {
    const condition = lotId != null
      ? and(eq(invStockTransactions.orgId, orgId), eq(invStockTransactions.lotId, lotId))
      : and(eq(invStockTransactions.orgId, orgId), eq(invStockTransactions.serialId, serialId!));

    return this.db.query.invStockTransactions.findMany({
      where: condition,
      orderBy: [desc(invStockTransactions.createdAt)],
      limit: 50,
      with: {
        location: { columns: { id: true, name: true, code: true } },
        creator: { columns: { id: true, name: true } },
      },
    });
  }
}
