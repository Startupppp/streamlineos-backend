import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import {
  invCustomerReturnLines,
  invCustomerReturns,
  invLocations,
  invLots,
  invProductVariants,
  invSalesOrders,
  invShipmentLines,
  invShipments,
  invStockLevels,
  invStockTransferLines,
  invStockTransfers,
  invWarehouses,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { addDec } from "../stock-engine/decimal";
import type { RecallSelectionInput } from "./dto/recall-simulation.schemas";

/**
 * The most lots one simulation will resolve.
 *
 * A recall selection is an open question — "everything this vendor sent us" —
 * and an unbounded answer is both a full-table scan and a screen nobody can
 * read. Refusing loudly at the cap is better than silently truncating, because
 * a truncated recall picture is a wrong recall picture.
 */
const MAX_LOTS = 500;

export interface RecallImpactLot {
  lotId: number;
  lotNumber: string;
  productVariantId: number;
  variantSku: string;
  variantName: string;
  status: string;
  manufactureDate: string | null;
  expiryDate: string | null;
}

export interface RecallImpactOnHandRow {
  lotId: number;
  locationId: number;
  locationName: string;
  warehouseId: number;
  warehouseName: string;
  onHand: string;
  qualityHold: string;
}

export interface RecallImpactTransitRow {
  lotId: number;
  transferId: number;
  referenceNumber: string;
  status: string;
  quantity: string;
  fromLocationId: number;
  toLocationId: number;
}

export interface RecallImpactShippedRow {
  lotId: number;
  shipmentId: number;
  shipmentNumber: string;
  status: string;
  shippedAt: string | null;
  salesOrderId: number | null;
  salesOrderNumber: string | null;
  quantity: string;
}

export interface RecallImpactReturnedRow {
  lotId: number;
  returnId: number;
  returnNumber: string;
  status: string;
  quantity: string;
}

export type RecallImpact = {
  /** The question, echoed, so a stored evidence snapshot is self-describing. */
  selection: RecallSelectionInput;
  /**
   * Which warehouses the actor may act in. Part of the evidence because a
   * scoped operator's picture — and the movements the engine will let them
   * post — are both narrower than an unrestricted one's.
   */
  warehouseScope: string;
  lots: RecallImpactLot[];
  onHand: RecallImpactOnHandRow[];
  inTransit: RecallImpactTransitRow[];
  shipped: RecallImpactShippedRow[];
  returned: RecallImpactReturnedRow[];
  totals: {
    lots: number;
    onHand: string;
    onQualityHold: string;
    inTransit: string;
    shipped: string;
    returned: string;
  };
  /**
   * A content hash of everything above. Two simulates of an unchanged picture
   * agree; an execute presenting a stale one is refused.
   */
  evidenceVersion: string;
};

/**
 * D4 — the recall simulator.
 *
 * Read-only, and provably so: every method here reaches the database through
 * `db.select(...)` and nothing else. No `insert`, no `update`, no
 * `transaction`, no raw `execute`. `recall-simulation.spec.ts` hands this
 * service a database whose every writing method throws, which is the only way
 * to state "writes nothing" as something a future edit cannot quietly break.
 *
 * The numbers are chosen to agree with what the rest of the module will
 * actually do:
 *  - `onHand` / `qualityHold` come from `inv_stock_levels`, the same rows the
 *    availability formula reads, and are scoped to the actor's warehouses —
 *    because `StockEngineService.executeInTx` will refuse a movement outside
 *    them, so an unscoped figure would promise a hold the execute cannot post.
 *  - `inTransit` is transfer stock that has left its origin and not arrived;
 *    the allocator already refuses to promise it, so it is reported as its own
 *    line rather than folded into on-hand.
 *  - `shipped` and `returned` are history, named by document, because "who has
 *    it" is the question a recall exists to answer.
 */
@Injectable()
export class RecallSimulationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async simulate(
    orgId: string,
    userId: string,
    selection: RecallSelectionInput,
  ): Promise<RecallImpact> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const lots = await this.resolveLots(orgId, selection);

    if (lots.length === 0) {
      return this.finalise(selection, scope.key, [], [], [], [], []);
    }

    const lotIds = lots.map((l) => l.lotId);

    // One round trip per fact, in parallel — five independent reads over
    // disjoint tables, so serialising them would only add latency.
    const [onHand, inTransit, shipped, returned] = await Promise.all([
      this.readOnHand(orgId, lotIds, scope.location(sql`${invStockLevels.locationId}`)),
      this.readInTransit(orgId, lotIds),
      this.readShipped(orgId, lotIds),
      this.readReturned(orgId, lotIds),
    ]);

    return this.finalise(selection, scope.key, lots, onHand, inTransit, shipped, returned);
  }

  /**
   * The lots a selection names.
   *
   * Every supplied criterion is ANDed. A vendor is expressed as an EXISTS over
   * the posted receipts that created the lot: `inv_grn_lines` records the lot
   * *number* the counter wrote down and resolves it to an `inv_lots` row only
   * at posting time, so the join is (variant, lot number) and it is restricted
   * to POSTED receipts — a draft receipt never created stock and never created
   * the lot.
   */
  private async resolveLots(
    orgId: string,
    selection: RecallSelectionInput,
  ): Promise<RecallImpactLot[]> {
    const conditions: SQL[] = [eq(invLots.orgId, orgId)];

    if (selection.lotIds?.length) conditions.push(inArray(invLots.id, selection.lotIds));
    if (selection.productVariantIds?.length)
      conditions.push(inArray(invLots.productVariantId, selection.productVariantIds));
    if (selection.manufacturedFrom)
      conditions.push(gte(invLots.manufactureDate, selection.manufacturedFrom));
    if (selection.manufacturedTo)
      conditions.push(lte(invLots.manufactureDate, selection.manufacturedTo));
    if (selection.expiryFrom) conditions.push(gte(invLots.expiryDate, selection.expiryFrom));
    if (selection.expiryTo) conditions.push(lte(invLots.expiryDate, selection.expiryTo));
    if (selection.vendorId !== undefined) {
      conditions.push(sql`EXISTS (
        SELECT 1
        FROM inv_grn_lines gl
        JOIN inv_grns g ON g.org_id = gl.org_id AND g.id = gl.grn_id
        JOIN inv_purchase_orders po ON po.org_id = g.org_id AND po.id = g.po_id
        JOIN inv_po_lines pol ON pol.org_id = gl.org_id AND pol.id = gl.po_line_id
        WHERE gl.org_id = ${orgId}
          AND g.status = 'POSTED'
          AND po.vendor_id = ${selection.vendorId}
          AND gl.lot_number = ${invLots.lotNumber}
          AND pol.product_variant_id = ${invLots.productVariantId}
      )`);
    }

    const rows = await this.db
      .select({
        lotId: invLots.id,
        lotNumber: invLots.lotNumber,
        productVariantId: invLots.productVariantId,
        variantSku: invProductVariants.sku,
        variantName: invProductVariants.name,
        status: invLots.status,
        manufactureDate: invLots.manufactureDate,
        expiryDate: invLots.expiryDate,
      })
      .from(invLots)
      .innerJoin(
        invProductVariants,
        and(
          eq(invProductVariants.orgId, invLots.orgId),
          eq(invProductVariants.id, invLots.productVariantId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(invLots.id))
      .limit(MAX_LOTS + 1);

    if (rows.length > MAX_LOTS) {
      throw new BadRequestException(
        `This selection matches more than ${MAX_LOTS} lots. Narrow it by product, date or vendor before simulating.`,
      );
    }
    return rows;
  }

  private readOnHand(
    orgId: string,
    lotIds: number[],
    scopePredicate: SQL,
  ): Promise<RecallImpactOnHandRow[]> {
    return this.db
      .select({
        lotId: sql<number>`${invStockLevels.lotId}`,
        locationId: invStockLevels.locationId,
        locationName: invLocations.name,
        warehouseId: invLocations.warehouseId,
        warehouseName: invWarehouses.name,
        onHand: invStockLevels.onHand,
        // Nullable in the schema with a "0" default, so a level written before
        // the column existed reads as null rather than zero.
        qualityHold: sql<string>`COALESCE(${invStockLevels.qualityHoldQty}, '0')`,
      })
      .from(invStockLevels)
      .innerJoin(
        invLocations,
        and(
          eq(invLocations.orgId, invStockLevels.orgId),
          eq(invLocations.id, invStockLevels.locationId),
        ),
      )
      .innerJoin(
        invWarehouses,
        and(
          eq(invWarehouses.orgId, invLocations.orgId),
          eq(invWarehouses.id, invLocations.warehouseId),
        ),
      )
      .where(
        and(
          eq(invStockLevels.orgId, orgId),
          inArray(invStockLevels.lotId, lotIds),
          scopePredicate,
        ),
      )
      .orderBy(asc(invStockLevels.lotId), asc(invStockLevels.locationId));
  }

  /**
   * Units on a lorry: dispatched from the origin, not yet received at the
   * destination. Reported as `quantity - quantity_received` because a transfer
   * may be received in parts.
   */
  private readInTransit(orgId: string, lotIds: number[]): Promise<RecallImpactTransitRow[]> {
    return this.db
      .select({
        lotId: sql<number>`${invStockTransferLines.lotId}`,
        transferId: invStockTransfers.id,
        referenceNumber: invStockTransfers.referenceNumber,
        status: invStockTransfers.status,
        quantity: sql<string>`(${invStockTransferLines.quantity} - ${invStockTransferLines.quantityReceived})`,
        fromLocationId: invStockTransfers.fromLocationId,
        toLocationId: invStockTransfers.toLocationId,
      })
      .from(invStockTransferLines)
      .innerJoin(
        invStockTransfers,
        and(
          eq(invStockTransfers.orgId, invStockTransferLines.orgId),
          eq(invStockTransfers.id, invStockTransferLines.transferId),
        ),
      )
      .where(
        and(
          eq(invStockTransferLines.orgId, orgId),
          inArray(invStockTransferLines.lotId, lotIds),
          eq(invStockTransfers.status, "IN_TRANSIT"),
          sql`${invStockTransferLines.quantity} > ${invStockTransferLines.quantityReceived}`,
        ),
      )
      .orderBy(asc(invStockTransferLines.lotId), asc(invStockTransfers.id));
  }

  /**
   * Goods already with a customer. DRAFT/PACKED shipments have not left, and
   * CANCELLED ones never will, so neither is a unit anybody has to be told
   * about.
   */
  private readShipped(orgId: string, lotIds: number[]): Promise<RecallImpactShippedRow[]> {
    return this.db
      .select({
        lotId: sql<number>`${invShipmentLines.lotId}`,
        shipmentId: invShipments.id,
        shipmentNumber: invShipments.shipmentNumber,
        status: invShipments.status,
        shippedAt: sql<string | null>`to_char(${invShipments.shippedAt}, 'YYYY-MM-DD"T"HH24:MI:SSZ')`,
        salesOrderId: invShipments.soId,
        salesOrderNumber: sql<string | null>`${invSalesOrders.soNumber}`,
        quantity: invShipmentLines.quantity,
      })
      .from(invShipmentLines)
      .innerJoin(
        invShipments,
        and(
          eq(invShipments.orgId, invShipmentLines.orgId),
          eq(invShipments.id, invShipmentLines.shipmentId),
        ),
      )
      .leftJoin(
        invSalesOrders,
        and(
          eq(invSalesOrders.orgId, invShipments.orgId),
          eq(invSalesOrders.id, invShipments.soId),
        ),
      )
      .where(
        and(
          eq(invShipmentLines.orgId, orgId),
          inArray(invShipmentLines.lotId, lotIds),
          inArray(invShipments.status, ["SHIPPED", "DELIVERED"]),
        ),
      )
      .orderBy(asc(invShipmentLines.lotId), asc(invShipments.id), asc(invShipmentLines.id));
  }

  /**
   * Units already back. Only POSTED returns count: a DRAFT or APPROVED return
   * is a customer's intention, and the goods are still out there.
   */
  private readReturned(orgId: string, lotIds: number[]): Promise<RecallImpactReturnedRow[]> {
    return this.db
      .select({
        lotId: sql<number>`${invCustomerReturnLines.lotId}`,
        returnId: invCustomerReturns.id,
        returnNumber: invCustomerReturns.returnNumber,
        status: invCustomerReturns.status,
        quantity: invCustomerReturnLines.quantity,
      })
      .from(invCustomerReturnLines)
      .innerJoin(
        invCustomerReturns,
        and(
          eq(invCustomerReturns.orgId, invCustomerReturnLines.orgId),
          eq(invCustomerReturns.id, invCustomerReturnLines.returnId),
        ),
      )
      .where(
        and(
          eq(invCustomerReturnLines.orgId, orgId),
          inArray(invCustomerReturnLines.lotId, lotIds),
          eq(invCustomerReturns.status, "POSTED"),
        ),
      )
      .orderBy(asc(invCustomerReturnLines.lotId), asc(invCustomerReturns.id));
  }

  private finalise(
    selection: RecallSelectionInput,
    warehouseScope: string,
    lots: RecallImpactLot[],
    onHand: RecallImpactOnHandRow[],
    inTransit: RecallImpactTransitRow[],
    shipped: RecallImpactShippedRow[],
    returned: RecallImpactReturnedRow[],
  ): RecallImpact {
    // `addDec` rather than a running number: these are 18,4 numerics, and the
    // ledger rules forbid float arithmetic on a stock quantity anywhere,
    // including in a total nobody posts.
    const sum = (values: string[]): string => values.reduce((acc, v) => addDec(acc, v), "0");

    const impact: Omit<RecallImpact, "evidenceVersion"> = {
      selection,
      warehouseScope,
      lots,
      onHand,
      inTransit,
      shipped,
      returned,
      totals: {
        lots: lots.length,
        onHand: sum(onHand.map((r) => r.onHand)),
        onQualityHold: sum(onHand.map((r) => r.qualityHold)),
        inTransit: sum(inTransit.map((r) => r.quantity)),
        shipped: sum(shipped.map((r) => r.quantity)),
        returned: sum(returned.map((r) => r.quantity)),
      },
    };

    return { ...impact, evidenceVersion: evidenceVersionOf(impact) };
  }
}

/**
 * The evidence hash.
 *
 * Over the whole impact — selection, scope, every row and every total — so
 * that anything an execute would act on differently produces a different
 * version. Every query above carries an explicit `ORDER BY`, which is what
 * makes `JSON.stringify` of the result a stable input rather than whatever
 * order the planner happened to return.
 *
 * Deliberately contains no timestamp: an unchanged warehouse must simulate to
 * the same version an hour later, or the conflict check would fire on every
 * execute and teach operators to ignore it.
 */
export function evidenceVersionOf(impact: Omit<RecallImpact, "evidenceVersion">): string {
  return createHash("sha256").update(JSON.stringify(impact)).digest("hex").slice(0, 32);
}
