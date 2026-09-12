import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  invGrnLineSerials,
  invGrnLines,
  invGrns,
  invLocations,
  invPurchaseOrders,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import { UomConversionService } from "../../stock-engine/uom-conversion.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { InvQuantityCaptureService } from "../../products/inv-quantity-capture.service";
import { HandlingUnitService } from "../../handling-units/handling-unit.service";
import { assertCatchWeightLine } from "../../stock-types/catch-weight";
import type { CreateGrnDraftInput } from "../dto/inv-purchase-orders.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type GrnDraftLine = CreateGrnDraftInput["lines"][number];

/** As much of the purchase order as opening a receipt against it needs. */
export interface ReceivablePo {
  id: number;
  warehouseId: number | null;
  lines: ReadonlyArray<{
    id: number;
    productVariant: {
      id: number;
      productId: number;
      product?: { measureMode?: "PIECES" | "CATCH_WEIGHT" | null } | null;
    };
  }>;
}

/**
 * What opening or editing a draft receipt reads and writes through. Handed over
 * by the service from its own injected collaborators.
 *
 * `resolveDefaultLocationId` is `PoService.resolveLocationId` — the purchase
 * order's warehouse's first active location — passed in rather than imported so
 * this file does not reach back across the module.
 */
export interface GrnDraftDeps {
  readonly db: Db;
  readonly numSeq: NumberSequenceService;
  readonly uom: UomConversionService;
  readonly quantityCapture: InvQuantityCaptureService;
  readonly audit: InventoryAuditService;
  readonly warehouseScope: WarehouseScopeService;
  readonly handlingUnits: HandlingUnitService;
  readonly resolveDefaultLocationId: (
    orgId: string,
    warehouseId: number | null | undefined,
  ) => Promise<number>;
}

/**
 * The purchase order a receipt may be raised against, with the line detail the
 * receipt's own lines are validated from.
 *
 * SENT or PARTIAL only: a DRAFT order has not been placed with anybody and a
 * RECEIVED or CLOSED one is finished, so goods arriving against either is a
 * question rather than a delivery.
 */
export async function loadReceivablePo(deps: GrnDraftDeps, orgId: string, poId: number) {
  const po = await deps.db.query.invPurchaseOrders.findFirst({
    where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    with: {
      lines: {
        with: {
          productVariant: {
            columns: { id: true, productId: true },
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
  return po;
}

/** Where the goods are being put, and whether the caller holds that building. */
export async function resolveLocation(
  deps: GrnDraftDeps,
  orgId: string,
  userId: string,
  warehouseId: number | null,
  requested: number | undefined,
): Promise<number> {
  if (requested === undefined) {
    /*
     * The named location below has been asserted since it was written. The
     * DEFAULT was not, and it is the same receipt into the same building: with
     * no `locationId` in the body this falls back to the first active location
     * of the *purchase order's* warehouse, which `loadReceivablePo` looks up on
     * `org_id` alone. So a body naming somebody else's purchase order received
     * goods into somebody else's building, and a draft — which posts no
     * movements — never reached the engine's `assertLocationsInScope` to be
     * refused there.
     *
     * The warehouse rather than the resolved location, because they are the
     * same question here (the default is by construction inside that
     * warehouse) and `assertWarehouseVisible` answers it without a second
     * query. 404, not 403.
     *
     * This refuses no flow that completes today: a receipt that actually posts
     * movements into a warehouse the caller does not hold is already refused
     * by the engine, and an unrestricted caller passes both.
     */
    await deps.warehouseScope.assertWarehouseVisible(orgId, userId, warehouseId);
    return deps.resolveDefaultLocationId(orgId, warehouseId);
  }

  const loc = await deps.db.query.invLocations.findFirst({
    where: and(
      eq(invLocations.id, requested),
      eq(invLocations.orgId, orgId),
      eq(invLocations.isActive, true),
    ),
    columns: { id: true },
  });
  if (!loc) throw new NotFoundException("Location not found or inactive");
  await deps.warehouseScope.assertLocationVisible(orgId, userId, loc.id);
  return loc.id;
}

/**
 * Every rule a receipt line has to satisfy, and the write if it does.
 *
 * All of it refuses before any stock has moved, which is why it lives here
 * rather than on the posting path: a draft is somebody's count of what came off
 * a lorry, and the cheapest place to tell them a serial was scanned twice is
 * while they are still standing at the dock.
 */
export async function insertGrnLines(
  deps: GrnDraftDeps,
  tx: Tx,
  orgId: string,
  grnId: number,
  po: ReceivablePo,
  lines: readonly GrnDraftLine[],
): Promise<void> {
  const seen = new Set<number>();
  for (const line of lines) {
    if (seen.has(line.poLineId))
      throw new BadRequestException(`PO line ${line.poLineId} appears twice on this receipt`);
    seen.add(line.poLineId);

    const poLine = po.lines.find((l) => l.id === line.poLineId);
    if (!poLine) throw new BadRequestException(`PO line ${line.poLineId} not found`);
    if (line.qualityStatus === "REJECTED" && !line.rejectionReason)
      throw new BadRequestException(`Line ${line.poLineId}: a rejected line needs a reason`);

    await deps.quantityCapture.assertEnteredQuantity(
      orgId,
      poLine.productVariant.id,
      line.quantityReceived,
    );

    if (line.handlingUnitId !== undefined) {
      await deps.handlingUnits.assertCanHoldStockInTx(tx, orgId, line.handlingUnitId);
    }

    assertCatchWeightLine(poLine.productVariant.product?.measureMode ?? "PIECES", {
      quantity: line.quantityReceived,
      quantityPieces: line.quantityPieces ?? null,
    });

    const converted = await deps.uom.convert(
      orgId,
      poLine.productVariant.productId,
      line.uomId ?? null,
      line.quantityReceived,
    );

    const [inserted] = await tx
      .insert(invGrnLines)
      .values({
        orgId,
        grnId,
        poLineId: line.poLineId,
        quantityReceived: converted.quantity,
        quantityEntered: converted.quantityEntered,
        uomId: converted.uomId,
        uomFactor: converted.uomFactor,
        qualityStatus: line.qualityStatus,
        rejectionReason: line.rejectionReason,
        discrepancyReason: line.discrepancyReason,
        handlingUnitId: line.handlingUnitId ?? null,
        crossDockSoId: line.crossDockSoId ?? null,
        quantityPieces: line.quantityPieces ?? null,
        ownership: line.ownership ?? "OWNED",
        lotNumber: line.lotNumber,
        expiryDate: line.expiryDate,
        manufactureDate: line.manufactureDate,
        mrpPaise: line.mrpPaise ?? null,
        purchaseRatePaise: line.purchaseRatePaise ?? null,
      })
      .returning({ id: invGrnLines.id });
    if (!inserted) throw new ConflictException("Could not write the receipt line");

    const serials = line.serialNumbers ?? [];
    if (serials.length === 0) continue;
    const unique = [...new Set(serials)];
    if (unique.length !== serials.length)
      throw new BadRequestException(`Line ${line.poLineId}: the same serial was scanned twice`);
    await tx.insert(invGrnLineSerials).values(
      unique.map((serialNumber) => ({ orgId, grnLineId: inserted.id, serialNumber })),
    );
  }
}

/** Open the receipt header, write its lines, and record that it happened. */
export async function createDraftInTx(
  deps: GrnDraftDeps,
  tx: Tx,
  orgId: string,
  userId: string,
  po: ReceivablePo,
  locationId: number,
  receivedDate: string,
  notes: string | undefined,
  lines: readonly GrnDraftLine[],
  asnId: number | null,
): Promise<number> {
  const grnNumber = await deps.numSeq.next(orgId, "GRN", tx);

  const [grn] = await tx
    .insert(invGrns)
    .values({
      orgId,
      poId: po.id,
      grnNumber,
      locationId,
      notes,
      status: "DRAFT",
      asnId,
      createdBy: userId,
      receivedDate,
    })
    .returning({ id: invGrns.id });
  if (!grn) throw new ConflictException("Could not open the goods receipt");

  await insertGrnLines(deps, tx, orgId, grn.id, po, lines);

  await deps.audit.insert(tx, {
    orgId,
    actorUserId: userId,
    action: "receiving.draft",
    resourceType: "inv_grn",
    resourceId: String(grn.id),
    after: { status: "DRAFT" },
    metadata: { poId: po.id, grnNumber, lineCount: lines.length },
  });

  return grn.id;
}
