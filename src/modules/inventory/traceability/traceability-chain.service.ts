import { Inject, Injectable, BadRequestException } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  invLots,
  invSerialNumbers,
  invStockLevels,
  invStockTransactions,
  invGrns,
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
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import type { TraceabilityQueryInput } from "./dto/traceability.schemas";

/** What `StockEngineService` actually writes for a posted goods receipt. */
const GRN_REFERENCE_TYPE = "inv_grn";
const RECEIPT_LIMIT = 50;
const EVENT_LIMIT = 50;

@Injectable()
export class TraceabilityChainService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getChain(orgId: string, query: TraceabilityQueryInput) {
    const { lotId, serialId } = query;
    const cacheKey = lotId != null ? `lot:${lotId}` : `serial:${serialId!}`;

    return this.cache.cachedVersioned(
      `inv:traceability:${orgId}`,
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

  /**
   * D1. The receipts that put this lot on the shelf.
   *
   * This join used to match `reference_type = 'GRN'`, a value the stock engine
   * never writes — it writes `inv_grn` — and it never constrained the GRN to
   * the one the movement actually names. Had the literal matched, every ledger
   * row for the lot would have been paired with every GRN and every GRN line in
   * the organisation: a wrong answer and a cross product at the same time.
   *
   * Resolved in two bounded steps rather than a `reference_id::int` join,
   * because `reference_id` is free text shared with every other document type
   * and a cast the planner may hoist above the type filter fails the whole
   * query on the first non-numeric reference. `inv_grn_lines` is not consulted
   * at all: it carries a lot *number*, not a lot id, so it could never answer
   * "which line was this lot", and the ledger row already holds the quantity
   * that reached this lot — which is the truer figure anyway.
   */
  private async fetchReceipts(orgId: string, lotId: number) {
    const movements = await this.db
      .select({
        transactionId: invStockTransactions.id,
        referenceId: invStockTransactions.referenceId,
        qtyReceived: invStockTransactions.quantityChange,
        receivedAt: invStockTransactions.createdAt,
        correctionOfTransactionId: invStockTransactions.correctionOfTransactionId,
      })
      .from(invStockTransactions)
      .where(
        and(
          eq(invStockTransactions.orgId, orgId),
          eq(invStockTransactions.lotId, lotId),
          eq(invStockTransactions.referenceType, GRN_REFERENCE_TYPE),
          isNotNull(invStockTransactions.referenceId),
        ),
      )
      .orderBy(desc(invStockTransactions.id))
      .limit(RECEIPT_LIMIT);
    if (movements.length === 0) return [];

    const grnIds = [
      ...new Set(
        movements.map((m) => Number(m.referenceId)).filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    if (grnIds.length === 0) return [];

    const [grns, reversedIds] = await Promise.all([
      this.db
        .select({
          grnId: invGrns.id,
          grnNumber: invGrns.grnNumber,
          receivedDate: invGrns.receivedDate,
          poId: invPurchaseOrders.id,
          poNumber: invPurchaseOrders.poNumber,
          vendorId: invVendors.id,
          vendorName: invVendors.name,
          vendorCode: invVendors.code,
        })
        .from(invGrns)
        .innerJoin(invPurchaseOrders, eq(invGrns.poId, invPurchaseOrders.id))
        .innerJoin(invVendors, eq(invPurchaseOrders.vendorId, invVendors.id))
        .where(and(eq(invGrns.orgId, orgId), inArray(invGrns.id, grnIds))),
      this.reversedTransactionIds(
        orgId,
        movements.map((m) => m.transactionId),
      ),
    ]);
    const byId = new Map(grns.map((g) => [g.grnId, g]));

    return movements.flatMap((movement) => {
      const grn = byId.get(Number(movement.referenceId));
      if (!grn) return [];
      return [
        {
          ...grn,
          transactionId: movement.transactionId,
          qtyReceived: movement.qtyReceived,
          receivedAt: movement.receivedAt,
          // A2. A receipt that was reversed is not stock this lot ever held.
          reversed:
            movement.correctionOfTransactionId != null ||
            reversedIds.has(movement.transactionId),
        },
      ];
    });
  }

  /**
   * A2. Which of these movements has since been compensated.
   *
   * Answered from the partial unique index on
   * `(org_id, correction_of_transaction_id)`, so it is one bounded index probe
   * rather than a correlated `EXISTS` per row.
   */
  private async reversedTransactionIds(
    orgId: string,
    transactionIds: readonly number[],
  ): Promise<Set<number>> {
    if (transactionIds.length === 0) return new Set();
    const rows = await this.db
      .select({ correctionOf: invStockTransactions.correctionOfTransactionId })
      .from(invStockTransactions)
      .where(
        and(
          eq(invStockTransactions.orgId, orgId),
          inArray(invStockTransactions.correctionOfTransactionId, [...transactionIds]),
        ),
      );
    return new Set(rows.map((r) => r.correctionOf).filter((id): id is number => id != null));
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

    const events = await this.db.query.invStockTransactions.findMany({
      where: condition,
      orderBy: [desc(invStockTransactions.createdAt)],
      limit: EVENT_LIMIT,
      with: {
        location: { columns: { id: true, name: true, code: true } },
        creator: { columns: { id: true, name: true } },
      },
    });

    // A2. A movement that was compensated, and the compensation itself, are
    // both still facts of the ledger and both belong on the timeline — but a
    // reader who cannot tell them apart reads reversed goods as goods that
    // moved.
    const reversedIds = await this.reversedTransactionIds(
      orgId,
      events.map((e) => e.id),
    );
    return events.map((event) => ({
      ...event,
      reversed: event.correctionOfTransactionId != null || reversedIds.has(event.id),
    }));
  }
}
