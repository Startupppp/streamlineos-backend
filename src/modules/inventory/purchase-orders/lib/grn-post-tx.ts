import { and, eq, sql } from "drizzle-orm";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { invGrns, invGrnLines, invPoLines, invPurchaseOrders } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { StockEngineService } from "../../stock-engine/stock-engine.service";
import { StockProjectionService } from "../../stock-engine/stock-projection.service";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { InventoryAccountingBridge } from "../../stock-engine/accounting-bridge";
import { ReservationService } from "../../stock-engine/reservation.service";
import { ReceiptInspectionService } from "../../quality/receipt-inspection.service";
import { InvPharmacyService } from "../../products/inv-pharmacy.service";
import { addDec, cmpDec, divDec, mulDec, subDec } from "../../stock-engine/decimal";
import { findCrossDockStagingLocation } from "../../putaway/putaway-destination";
import { emitReceiptPosted } from "./receipt-events";
import { postReceiptJournal } from "./receipt-journal";
import {
  assertLotAcceptable,
  assertSerialsAcceptable,
  resolveLotId,
  resolveSerialIds,
} from "./receipt-lots-serials";
import {
  buildCrossDockLegs,
  resolveCrossDockSoLine,
  type DiscrepancyReason,
  type PendingMovement,
} from "./grn-post-movements";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * What posting a receipt needs from the services around it.
 *
 * A deps bag and a free function rather than a second `@Injectable`, following
 * `so-ship.ts`: the DI graph and every caller stay unchanged, and the
 * transaction stays owned by whoever opened it. This may only ever run inside
 * somebody else\'s transaction, and a service with its own `db` handle is an
 * invitation to forget that.
 */
export interface GrnPostDeps {
  readonly engine: StockEngineService;
  readonly projection: StockProjectionService;
  readonly settingsService: InventorySettingsService;
  readonly audit: InventoryAuditService;
  readonly receiptInspection: ReceiptInspectionService;
  readonly journalPosting: InventoryAccountingBridge;
  readonly pharmacy: InvPharmacyService;
  readonly reservations: ReservationService;
}

/**
 * The post itself, on a transaction the caller owns. `receiveGoods` needs the
 * draft creation and the post to share one claim, so this cannot open its own.
 */
export async function postInTx(
  deps: GrnPostDeps,
  tx: Tx,
  orgId: string,
  grnId: number,
  userId: string,
  idempotencyKey: string,
): Promise<number> {
  // The row lock, before anything is read. Two posts of the same receipt
  // otherwise both see a postable status and both move stock; the status
  // check afterwards is only meaningful because the lock is held.
  const [locked] = await tx.execute<{ status: string }>(sql`
    SELECT status FROM inv_grns WHERE id = ${grnId} AND org_id = ${orgId} FOR UPDATE`);
  if (!locked) throw new NotFoundException("Goods receipt not found");
  if (locked.status === "POSTED")
    throw new ConflictException("This goods receipt has already been posted");
  if (locked.status === "CANCELLED")
    throw new BadRequestException("A cancelled goods receipt cannot be posted");

  const grn = await tx.query.invGrns.findFirst({
    where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
    with: { lines: { with: { serials: { columns: { serialNumber: true } } } } },
  });
  if (!grn) throw new NotFoundException("Goods receipt not found");
  if (grn.lines.length === 0)
    throw new BadRequestException("A goods receipt with no lines cannot be posted");
  const locationId = grn.locationId;
  if (locationId === null)
    throw new BadRequestException("This goods receipt has no receiving location");

  const po = await tx.query.invPurchaseOrders.findFirst({
    where: and(eq(invPurchaseOrders.id, grn.poId), eq(invPurchaseOrders.orgId, orgId)),
    with: {
      lines: {
        with: {
          productVariant: {
            with: { product: { columns: { id: true, trackingMethod: true, measureMode: true } } },
          },
        },
      },
    },
  });
  if (!po) throw new NotFoundException("Purchase order not found");
  if (po.status !== "SENT" && po.status !== "PARTIAL") {
    throw new BadRequestException(
      "Purchase order must be SENT or PARTIAL to receive goods",
    );
  }

  const settings = await deps.settingsService.get(orgId);

  // What each line owed at the moment it posts, computed under the row lock in
  // the validation pass and carried to the write pass so both agree.
  const expectedByLine = new Map<
    number,
    { expected: string; discrepancyReason: DiscrepancyReason | null }
  >();

  for (const line of grn.lines) {
    const poLine = po.lines.find((l) => l.id === line.poLineId);
    if (!poLine) throw new BadRequestException(`PO line ${line.poLineId} not found`);

    const [lockedLine] = await tx.execute<{
      quantity: string;
      quantity_received: string;
    }>(sql`
      SELECT quantity, quantity_received
      FROM inv_po_lines
      WHERE id = ${line.poLineId}
        AND po_id = ${po.id}
      FOR UPDATE
    `);
    if (!lockedLine)
      throw new BadRequestException(`PO line ${line.poLineId} not found`);

    // Exact throughout: the old form parsed both sides to floats and added an
    // 0.0001 epsilon to paper over the comparison.
    const remaining = subDec(
      String(lockedLine.quantity),
      String(lockedLine.quantity_received),
    );
    const maxAllowed = addDec(
      remaining,
      mulDec(remaining, divDec(settings.overReceiptTolerancePct, "100")),
    );

    if (cmpDec(line.quantityReceived, maxAllowed) > 0) {
      throw new BadRequestException(
        `Line ${line.poLineId}: received qty ${line.quantityReceived} exceeds allowed max ${maxAllowed} (over-receipt tolerance ${settings.overReceiptTolerancePct}%)`,
      );
    }

    // What the line still owed at this moment, so a short delivery stays
    // legible after the purchase order moves on. An over-receipt is
    // exceptional by definition -- it passed the tolerance gate above -- so it
    // is labelled even when the receiver did not say why.
    const overReceipt = cmpDec(line.quantityReceived, remaining) > 0;
    expectedByLine.set(line.id, {
      expected: remaining,
      discrepancyReason:
        line.discrepancyReason ?? (overReceipt ? ("OVER" as const) : null),
    });

    await assertLotAcceptable(
      tx, orgId, line, poLine.productVariantId, grn.receivedDate, settings.expiryReservationPolicy,
    );

    /**
     * E3. The pharmacy receipt gate, in the validation pass — before the
     * quantity-received writes, before the engine call, before the projection
     * recompute. A refusal here leaves the receipt exactly as it was; the same
     * refusal after any of those would either roll back work already done or,
     * worse, be reached after the ledger had moved.
     *
     * Called unconditionally, with no flag check here. The service reads the
     * pack itself and returns before it touches the SKU when it is off, so a
     * second check at the call site buys nothing and costs the one thing that
     * matters: two places that have to agree on what "the pharmacy pack" means.
     * The one that drifts is always the copy.
     *
     * The rule itself is not restated here either. It lives in the catalogue
     * module because it is a property of the SKU, and the receiving screen asks
     * the same service through `receipt-requirements` so the operator is told
     * at the door rather than discovering it at post.
     */
    await deps.pharmacy.assertReceiptLine(orgId, poLine.productVariantId, {
      mrpPaise: line.mrpPaise,
      purchaseRatePaise: line.purchaseRatePaise,
      lotNumber: line.lotNumber,
      expiryDate: line.expiryDate,
    });

    if (poLine.productVariant.product.trackingMethod === "SERIAL")
      await assertSerialsAcceptable(tx, orgId, line, poLine.productVariantId);
  }

  const movements: PendingMovement[] = [];
  /**
   * NEO-8. The second and third movements of a cross-docked line: out of the
   * receiving dock, into outbound staging. Collected separately and appended
   * after every receipt, because `costFromMovementIndex` may only reference
   * backwards.
   */
  const crossDockLegs: PendingMovement[] = [];

  const crossDocked = grn.lines.filter((l) => l.crossDockSoId !== null);
  const stagingLocationId =
    crossDocked.length === 0
      ? null
      : await findCrossDockStagingLocation(tx, orgId, po.warehouseId ?? 0);
  if (crossDocked.length > 0 && stagingLocationId === null) {
    // Refused rather than defaulted. Putting somebody's goods in a bin nobody
    // chose is worse than telling them the building is not set up for this.
    throw new BadRequestException(
      "This warehouse has no outbound staging location, so these lines cannot be cross-docked",
    );
  }

  for (const line of grn.lines) {
    const poLine = po.lines.find((l) => l.id === line.poLineId)!;
    const trackingMethod = poLine.productVariant.product.trackingMethod;

    const expected = expectedByLine.get(line.id);
    await tx
      .update(invGrnLines)
      .set({
        quantityExpected: expected?.expected ?? null,
        discrepancyReason: expected?.discrepancyReason ?? null,
      })
      .where(and(eq(invGrnLines.id, line.id), eq(invGrnLines.orgId, orgId)));

    // A1. Goods that have arrived are no longer on order, or the bucket only
    // grows and replenishment sees a permanent phantom inbound. It belongs to
    // the post, not the draft: an uncounted delivery is still expected.
    if (po.warehouseId !== null) {
      await deps.projection.addOnOrder(
        tx,
        orgId,
        poLine.productVariantId,
        po.warehouseId,
        `-${line.quantityReceived}`,
      );
    }

    await tx
      .update(invPoLines)
      .set({
        quantityReceived: sql`${invPoLines.quantityReceived} + ${line.quantityReceived}::numeric`,
      })
      .where(and(eq(invPoLines.id, line.poLineId), eq(invPoLines.poId, po.id)));

    /**
     * A refused line stops here, before the lot and the serials. Receiving
     * used to open an `inv_lots` row and mark every scanned unit IN_STOCK
     * before it looked at the quality status, so goods the warehouse had
     * refused became owned units with a location and a batch, blocking those
     * serials from ever being received again and backed by no ledger row. The
     * serials stay on the receipt line either way, which is where the evidence
     * of what was refused belongs.
     */
    if (line.qualityStatus !== "ACCEPTED") continue;

    const lotId =
      trackingMethod === "LOT" && line.lotNumber
        ? await resolveLotId(tx, orgId, poLine.productVariantId, line)
        : undefined;

    if (trackingMethod === "SERIAL") {
      const serialIds = await resolveSerialIds(
        tx,
        orgId,
        poLine.productVariantId,
        locationId,
        lotId,
        line.serials.map((s) => s.serialNumber),
      );
      for (const serialId of serialIds) {
        movements.push({
          transactionType: "GRN",
          productVariantId: poLine.productVariantId,
          locationId,
          lotId: undefined,
          serialId,
          handlingUnitId: line.handlingUnitId ?? null,
          ownership: line.ownership,
          quantityDelta: "1.0000",
          unitCost: poLine.unitCost ?? undefined,
        });
        crossDockLegs.push(
          ...buildCrossDockLegs(line, movements.length - 1, {
            productVariantId: poLine.productVariantId,
            locationId,
            lotId: undefined,
            serialId,
            handlingUnitId: line.handlingUnitId ?? null,
            ownership: line.ownership,
            quantity: "1.0000",
            stagingLocationId,
          }),
        );
      }
    } else {
      movements.push({
        transactionType: "GRN",
        productVariantId: poLine.productVariantId,
        locationId,
        lotId,
        serialId: undefined,
        handlingUnitId: line.handlingUnitId ?? null,
        ownership: line.ownership,
        quantityDelta: line.quantityReceived,
        unitCost: poLine.unitCost ?? undefined,
      });
      crossDockLegs.push(
        ...buildCrossDockLegs(line, movements.length - 1, {
          productVariantId: poLine.productVariantId,
          locationId,
          lotId,
          serialId: undefined,
          handlingUnitId: line.handlingUnitId ?? null,
          ownership: line.ownership,
          quantity: line.quantityReceived,
          stagingLocationId,
        }),
      );
    }
  }

  // NEO-8. Appended after every receipt, not interleaved with them, so the
  // inbound leg a cross-dock inherits its cost from is always already in the
  // list — `costFromMovementIndex` may only reference backwards, and a leg
  // written before its own receipt would be an estimate of a figure the engine
  // is about to compute exactly.
  movements.push(...crossDockLegs);

  const allLines = await tx.query.invPoLines.findMany({
    where: eq(invPoLines.poId, po.id),
  });
  const allReceived = allLines.every(
    (l) => cmpDec(l.quantityReceived, l.quantity) >= 0,
  );
  await tx
    .update(invPurchaseOrders)
    .set({ status: allReceived ? "RECEIVED" : "PARTIAL", updatedAt: new Date() })
    .where(
      and(eq(invPurchaseOrders.id, po.id), eq(invPurchaseOrders.orgId, orgId)),
    );

  if (movements.length > 0) {
    // A derived key: the same key claimed twice in one transaction is a
    // duplicate, not a nesting. Valuation layers are written inside this call.
    await deps.engine.executeInTx(tx, orgId, userId, {
      idempotencyKey: `${idempotencyKey}:stock`,
      sourceType: "inv_grn",
      sourceId: String(grn.id),
      reason: `GRN: ${grn.grnNumber}`,
      movements,
    });
  }

  // NEO-8. The units are at outbound staging and are spoken for, so they are
  // promised to the order that pulled them across the dock immediately. Without
  // this they would sit at a pickable location as ordinary free stock and the
  // next order to ask would be offered them — which is exactly the "ATP never
  // showed them as sellable" the unit is for.
  //
  // Best-effort per line and never fatal: a refusal here means the order it
  // was meant for can no longer take them, which is a commercial problem for
  // somebody to look at, not a reason to unwind a delivery that has physically
  // arrived. The stock is real and posted either way.
  if (stagingLocationId !== null) {
    for (const line of crossDocked) {
      const poLine = po.lines.find((l) => l.id === line.poLineId);
      if (!poLine || line.qualityStatus !== "ACCEPTED") continue;

      /**
       * NEO-8. `source_line_id` on a sales-order reservation means *the sales
       * order line this holds stock for*, and shipping reads it that way:
       * `postShipment` matches each order line against
       * `source_line_id === String(line.id)` and refuses the order outright
       * when it finds nothing. Writing a GRN coordinate here instead produced
       * a reservation the ledger was happy with and the dispatch desk could
       * not use — the cross-dock arrived, stood at staging correctly, and the
       * order it arrived for could never be shipped.
       *
       * Which line, when an order has several for one product, is decided by
       * what is still owed: the first line of that variant that is not already
       * fully held. That is the same question a picker answers by hand.
       */
      const soLineId = await resolveCrossDockSoLine(
        tx,
        orgId,
        line.crossDockSoId!,
        poLine.productVariantId,
      );
      if (soLineId === null) continue;

      try {
        await deps.reservations.createReservationInTx(tx, orgId, userId, {
          sourceType: "inv_sales_order",
          sourceId: String(line.crossDockSoId),
          sourceLineId: String(soLineId),
          productVariantId: poLine.productVariantId,
          locationId: stagingLocationId,
          qty: line.quantityReceived,
        });
      } catch {
        // Recorded by the reservation's own path when it succeeds; a refusal is
        // visible as an unreserved cross-dock on the order.
      }
    }
  }

  await tx
    .update(invGrns)
    .set({ status: "POSTED", postedBy: userId, postedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(invGrns.id, grn.id), eq(invGrns.orgId, orgId)));

  await deps.audit.insert(tx, {
    orgId,
    actorUserId: userId,
    action: "receiving.post",
    resourceType: "inv_grn",
    resourceId: String(grn.id),
    before: { status: locked.status },
    after: { status: "POSTED" },
    metadata: {
      poId: po.id,
      grnNumber: grn.grnNumber,
      lineCount: grn.lines.length,
      movementCount: movements.length,
    },
  });

  await emitReceiptPosted(tx, {
    orgId,
    actorUserId: userId,
    idempotencyKey,
    grnId: grn.id,
    grnNumber: grn.grnNumber,
    receivedDate: grn.receivedDate,
    locationId,
    poId: po.id,
    poNumber: po.poNumber,
    vendorId: po.vendorId,
    warehouseId: po.warehouseId,
    lineCount: grn.lines.length,
    acceptedLineCount: grn.lines.filter((l) => l.qualityStatus === "ACCEPTED").length,
    purchaseOrderStatus: allReceived ? "RECEIVED" : "PARTIAL",
  });

  await postReceiptJournal(deps.journalPosting, orgId, userId, grn, po, grn.lines, tx);

  // D3. Quality owns whether a receipt needs inspecting and what that does to
  // the stock. This module used to insert into a Quality table directly — a
  // §1 boundary violation — and the row it wrote was inert: a PENDING
  // inspection that held nothing, so received goods were sellable before
  // anybody had looked at them.
  //
  // The setting is not consulted here any more either. A plan covering the SKU
  // triggers an inspection on its own, and `inspectionOnReceipt` is the
  // fallback for orgs with no plans; both live behind this call.
  await deps.receiptInspection.raiseForReceiptInTx(tx, orgId, userId, {
    grnId: grn.id,
    grnNumber: grn.grnNumber,
    idempotencyKey,
  });

  return grn.id;
}
